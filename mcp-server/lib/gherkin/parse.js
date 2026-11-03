// Parse a .feature document back into izitest-agent test_steps.
// Any unresolved phrase produces a clear error so the user can fix the Gherkin.

import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import { CucumberExpression, ParameterType, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';

const gherkinParser = new Parser(
  new AstBuilder(IdGenerator.uuid()),
  new GherkinClassicTokenMatcher()
);
const registry = new ParameterTypeRegistry();

// In the feature IziTest edits, a parameter bound to a variable of the test reads
// "pour {{budget}} euros", which {int} does not match. Numeric parameters accept a
// variable here; the Cucumber export puts real values in (Scenario Outline).
const VARIABLE_ARG = '\\{\\{[A-Za-z_]\\w*\\}\\}';
const NUMERIC_OR_VARIABLE = { int: ['-?\\d+', VARIABLE_ARG], float: ['-?\\d*\\.?\\d+', VARIABLE_ARG] };
for (const [type, regexps] of Object.entries(NUMERIC_OR_VARIABLE)) {
  registry.defineParameterType(new ParameterType(`izitest_${type}`, regexps, String, (s) => s, false, false));
}
const withVariableArgs = (pattern) => pattern.replace(/\{(int|float)\}/g, '{izitest_$1}');

// Takes the definitions loaded by the caller. A test's own feature, edited, goes through
// reconcile.js instead, which keeps the steps of the phrases left as they were.
// `targets`: the elements of the project by name (element-store.js's elementTargets) — a
// phrase naming one where a selector goes acts on it.
export function parseFeatureToStepsWith(featureText, definitions, { targets } = {}) {
  const compiled = compileDefinitions(definitions);
  const testSteps = [];
  const errors = [];
  let lastResolvedKeyword = null;

  for (const { text: phrase, keyword: rawKeyword, line } of featurePhrases(featureText)) {
    const parsed = stepsForPhrase(phrase, effectiveKeyword(rawKeyword, lastResolvedKeyword), compiled, testSteps.length, targets);
    if (!parsed) {
      errors.push(unresolved(line, rawKeyword, phrase));
      continue;
    }
    for (const s of parsed.steps) testSteps.push(s);
    lastResolvedKeyword = parsed.keyword;
  }

  if (errors.length) throw unresolvedError(errors);
  return testSteps;
}

/** The scenario's phrases as written: text, keyword ("Given", "And"…), line. */
export function featurePhrases(featureText) {
  const doc = gherkinParser.parse(featureText);
  const feature = doc.feature;
  if (!feature) throw new Error('No Feature found in document');

  const scenarioChild = feature.children.find(c => c.scenario);
  if (!scenarioChild) throw new Error('No Scenario found in Feature');
  return scenarioChild.scenario.steps.map(step => ({
    text: step.text,
    keyword: step.keyword.trim(),
    line: step.location.line,
  }));
}

export function compileDefinitions(definitions) {
  return definitions.map(d => ({
    def: d,
    expression: new CucumberExpression(withVariableArgs(d.pattern), registry),
  }));
}

/** "And", "But" and "*" carry on the keyword before them. */
export function effectiveKeyword(rawKeyword, lastResolvedKeyword) {
  return (rawKeyword === 'And' || rawKeyword === 'But' || rawKeyword === '*') ? lastResolvedKeyword : rawKeyword;
}

/**
 * The test steps one phrase stands for, and the keyword of the definition it matched;
 * null when no definition matches it.
 */
export function stepsForPhrase(phrase, keyword, compiled, startIndex = 0, targets = null) {
  const match = findMatchingDefinition(phrase, compiled, keyword);
  if (!match) return null;
  return { steps: buildTestSteps(match.def, match.args, phrase, startIndex, targets), keyword: match.def.keyword };
}

export function unresolved(line, rawKeyword, phrase) {
  return `Line ${line}: no step definition matches "${rawKeyword} ${phrase}"`;
}

export function unresolvedError(errors) {
  const err = new Error(`Unresolved Gherkin steps:\n${errors.join('\n')}`);
  err.code = 'GHERKIN_UNRESOLVED';
  err.errors = errors;
  return err;
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

function buildTestSteps(def, args, phrase, startIndex, targets) {
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
      // Built from a recording, the sub-step keeps its locators (replay falls back on them)
      // and its page (its element is known by it).
      if (tpl.locators) step.locators = tpl.locators;
      if (tpl.page) step.page = tpl.page;
      return onElement(step, tpl.params, params, targets);
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
  return [onElement(step, def.params_template, params, targets)];
}

/**
 * A step whose selector, given by the phrase, is the name of an element of the project: the
 * step acts on that element, as the latest step recorded on it found it — its selector, its
 * locators, its page.
 */
function onElement(step, template, params, targets) {
  const target = targets && /^\{\d+\}$/.test(template?.selector ?? '') ? targets.get(params.selector) : null;
  if (!target) return step;
  params.selector = target.selector;
  return {
    ...step,
    ...(target.locators?.length && { locators: structuredClone(target.locators) }),
    page: target.page,
  };
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
