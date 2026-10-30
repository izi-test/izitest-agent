// Parse a .feature document back into izitest-agent test_steps.
// Any unresolved phrase produces a clear error so the user can fix the Gherkin.

import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';
import { db, parseJson } from '../db.js';

const gherkinParser = new Parser(
  new AstBuilder(IdGenerator.uuid()),
  new GherkinClassicTokenMatcher()
);
const registry = new ParameterTypeRegistry();

export function parseFeatureToSteps(featureText, projectId) {
  const definitions = db.prepare(
    'SELECT * FROM step_definitions WHERE project_id = ?'
  ).all(projectId).map(r => ({
    ...r,
    params_template: parseJson(r.params_template) || {},
    steps_template: parseJson(r.steps_template) || null,
  }));
  return parseFeatureToStepsWith(featureText, definitions);
}

// Pure version — takes pre-loaded definitions. Used by tests and by callers
// that already have the catalogue in memory.
export function parseFeatureToStepsWith(featureText, definitions) {
  const doc = gherkinParser.parse(featureText);
  const feature = doc.feature;
  if (!feature) throw new Error('No Feature found in document');

  const scenarioChild = feature.children.find(c => c.scenario);
  if (!scenarioChild) throw new Error('No Scenario found in Feature');
  const scenario = scenarioChild.scenario;

  const compiled = definitions.map(d => ({
    def: d,
    expression: new CucumberExpression(d.pattern, registry),
  }));

  const testSteps = [];
  const errors = [];
  let lastResolvedKeyword = null;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const phrase = step.text;
    const rawKeyword = step.keyword.trim(); // "Given", "When", "Then", "And", "But"
    const effectiveKeyword = (rawKeyword === 'And' || rawKeyword === 'But' || rawKeyword === '*')
      ? lastResolvedKeyword
      : rawKeyword;

    const match = findMatchingDefinition(phrase, compiled, effectiveKeyword);
    if (!match) {
      errors.push(`Line ${step.location.line}: no step definition matches "${rawKeyword} ${phrase}"`);
      continue;
    }

    const expanded = buildTestSteps(match.def, match.args, phrase, testSteps.length);
    for (const s of expanded) testSteps.push(s);
    lastResolvedKeyword = match.def.keyword;
  }

  if (errors.length) {
    const err = new Error(`Unresolved Gherkin steps:\n${errors.join('\n')}`);
    err.code = 'GHERKIN_UNRESOLVED';
    err.errors = errors;
    throw err;
  }

  return testSteps;
}

function findMatchingDefinition(phrase, compiled, effectiveKeyword) {
  // Prefer a match whose keyword aligns with the phrase's effective keyword.
  // Fall back to a match regardless of keyword if nothing aligns — user might
  // be mixing Given/When/Then loosely and we don't want to block them.
  let fallback = null;
  for (const { def, expression } of compiled) {
    const result = expression.match(phrase);
    if (!result) continue;
    const args = result.map(a => a.getValue(null));
    if (effectiveKeyword && def.keyword === effectiveKeyword) {
      return { def, args };
    }
    if (!fallback) fallback = { def, args };
  }
  return fallback;
}

function buildTestSteps(def, args, phrase, startIndex) {
  // Composite definition — expand into multiple test_steps
  if (def.steps_template) {
    return def.steps_template.map((tpl, j) => {
      const params = hydrateTemplate(tpl.params, args);
      const step = {
        step_order: startIndex + j + 1,
        command: tpl.command,
        params: tpl.command === 'assert' ? {} : params,
        intent: j === 0 ? phrase : null,
        step_definition_id: j === 0 ? def.id : null,
      };
      if (tpl.command === 'assert') {
        step.assertion = params;
      }
      return step;
    });
  }

  // Single definition
  const params = hydrateTemplate(def.params_template, args);
  const step = {
    step_order: startIndex + 1,
    command: def.command,
    params: def.command === 'assert' ? {} : params,
    intent: phrase,
    step_definition_id: def.id,
  };
  if (def.command === 'assert') {
    step.assertion = params;
  }
  return [step];
}

function hydrateTemplate(tpl, args) {
  if (typeof tpl === 'string') {
    return tpl.replace(/\{(\d+)\}/g, (_, i) => {
      const v = args[Number(i)];
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.map(v => hydrateTemplate(v, args));
  if (tpl && typeof tpl === 'object') {
    const out = {};
    for (const k of Object.keys(tpl)) out[k] = hydrateTemplate(tpl[k], args);
    return out;
  }
  return tpl;
}
