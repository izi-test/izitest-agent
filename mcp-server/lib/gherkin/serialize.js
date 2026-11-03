// Serialize a izitest-agent test into a Gherkin .feature document.
// The Gherkin is computed on the fly from test_steps — nothing is stored.

import { db, parseJson } from '../db.js';
import { isFragileSelector, isPositionalSelector, lastTag } from '../codegen/locators.js';
import { elementKey } from '../elements.js';

export function serializeTestToFeature(test, projectId) {
  const definitions = db.prepare(
    'SELECT * FROM step_definitions WHERE project_id = ?'
  ).all(projectId).map(r => ({
    ...r,
    params_template: parseJson(r.params_template) || {},
    steps_template: parseJson(r.steps_template) || null,
  }));
  return serializeTestToFeatureWith(test, definitions);
}

// Pure version — takes pre-loaded definitions. Used by tests and by the
// API layer when definitions are already in memory.
export function serializeTestToFeatureWith(test, definitions, options = {}) {
  const lines = [];
  lines.push(`Feature: ${test.name}`);
  if (test.description) {
    for (const l of String(test.description).split('\n')) lines.push(`  ${l}`);
  }
  lines.push('');
  lines.push(`  Scenario: ${test.name}`);

  let lastKeyword = null;
  for (const { keyword, phrase } of scenarioPhrases(test, definitions, options)) {
    lines.push(`    ${keyword === lastKeyword ? 'And' : keyword} ${phrase}`);
    lastKeyword = keyword;
  }

  return lines.join('\n') + '\n';
}

/**
 * The scenario's phrases, in order, each with the test steps it stands for: one step, or
 * the run of steps a business step groups. Saving an edited feature uses it to give an
 * unchanged phrase back its steps (see reconcile.js).
 * `singleStep(step)` gives the step a phrase is rendered from when no business step groups
 * it — the Cucumber export puts a stable target in its selector there.
 */
export function scenarioPhrases(test, definitions, { singleStep = (step) => step } = {}) {
  // Split into composite and single definitions.
  const composites = definitions.filter(d => d.steps_template);
  const singles = definitions.filter(d => !d.steps_template);

  // Most specific templates first: definitions with more leaves in their
  // params_template win over generic fallbacks when both can match a step. On a tie,
  // the one with more fixed text wins, then the project's own over a built-in default:
  // "I search a house in {string}" on url "https://…/{0}/maison" beats "I am on {string}".
  const sortedSingles = [...singles].sort(
    (a, b) => templateComplexity(b.params_template) - templateComplexity(a.params_template)
      || literalLength(b.params_template) - literalLength(a.params_template)
      || Number(!!a.is_default) - Number(!!b.is_default)
  );
  // Longer composites first — greedier match wins.
  const sortedComposites = [...composites].sort(
    (a, b) => b.steps_template.length - a.steps_template.length
  );

  const steps = test.steps || [];
  const phrases = [];
  let i = 0;

  while (i < steps.length) {
    // Try composite match first — check if next N steps match a composite definition.
    const composite = tryMatchComposite(steps, i, sortedComposites);
    if (composite) {
      // `business`: the business step it reads as (business-steps.js tells its proposals apart by it).
      phrases.push({ keyword: composite.keyword, phrase: composite.phrase, steps: steps.slice(i, i + composite.consumed), business: composite.id });
      i += composite.consumed;
      continue;
    }

    // Fall back to single-step matching.
    const rendered = renderStepPhrase(singleStep(steps[i]), sortedSingles);
    phrases.push({ keyword: rendered.keyword, phrase: rendered.phrase, steps: [steps[i]] });
    i++;
  }

  return phrases;
}

function tryMatchComposite(steps, startIndex, composites) {
  for (const def of composites) {
    const tpls = def.steps_template;
    if (startIndex + tpls.length > steps.length) continue;

    // Try explicit link first: if the first step points at this composite definition
    if (steps[startIndex].step_definition_id && steps[startIndex].step_definition_id === def.id) {
      const args = extractCompositeArgs(steps, startIndex, tpls);
      if (args) {
        return {
          id: def.id,
          keyword: def.keyword,
          phrase: renderPattern(def.pattern, args),
          consumed: tpls.length,
        };
      }
    }

    // Implicit match: every sub-step command and params must match the template
    const args = extractCompositeArgs(steps, startIndex, tpls);
    if (!args) continue;

    return {
      id: def.id,
      keyword: def.keyword,
      phrase: renderPattern(def.pattern, args),
      consumed: tpls.length,
    };
  }
  return null;
}

function extractCompositeArgs(steps, startIndex, tpls) {
  const args = [];
  for (let j = 0; j < tpls.length; j++) {
    if (!matchSubStep(tpls[j], steps[startIndex + j], args)) return null;
  }
  if (args.some(a => a === undefined)) return null;
  return args;
}

/**
 * A sub-step of a business step against a recorded step: same command, same parameters, on
 * the same element. Both recorded with their page, the element is the one of their keys
 * (lib/elements.js), whatever the selectors say: the "Save" of another page is another
 * element, even with the same selector. Otherwise, the selector aside when it is weak — an
 * ID the page generates at each load, or a position: two recordings of the same click on
 * Bien'ici's "Jardin" hold two different label[for="<uuid>"], and the element is known by
 * what both recordings agree on.
 */
function matchSubStep(tpl, step, args) {
  if (step.command !== tpl.command) return false;
  const actual = normalizeParams(step);
  const expected = tpl.params ?? {};
  const selector = expected.selector;
  const parameterised = typeof selector === 'string' && /\{\d+\}/.test(selector);
  const { selector: _expected, ...expectedRest } = expected;
  const { selector: _actual, ...actualRest } = actual;

  const ours = parameterised ? null : elementKey(tpl);
  const theirs = ours && elementKey(step);
  if (ours && theirs) return ours === theirs && walk(expectedRest, actualRest, args);

  if (typeof selector !== 'string' || parameterised || selector === actual.selector) {
    return walk(expected, actual, args);
  }
  return walk(expectedRest, actualRest, args) && sameElement(tpl, step, selector, actual.selector);
}

const isWeakSelector = (selector) => isFragileSelector(selector) || isPositionalSelector(selector);

/**
 * Whether two different selectors, one of them weak, name the same element: same test ID,
 * a stable CSS locator in common, or the same tag and accessible name. Two stable selectors
 * that differ are two elements. A box's name attribute is shared by its whole group
 * (name="interests"): it says nothing about which box.
 */
function sameElement(tpl, step, tplSelector, stepSelector) {
  if (!isWeakSelector(tplSelector) && !isWeakSelector(stepSelector ?? '')) return false;
  const ours = tpl.locators ?? [];
  const theirs = step.locators ?? [];
  const valueOf = (locators, type) => locators.find(l => l.type === type)?.value;

  const testid = valueOf(ours, 'testid');
  if (testid && testid === valueOf(theirs, 'testid')) return true;

  const role = ours.find(l => l.type === 'role' && l.name);
  if (role && theirs.some(l => l.type === 'role' && l.value === role.value && l.name === role.name)) return true;

  const isToggle = step.params?.checked !== undefined || tpl.params?.checked !== undefined;
  const stableCss = (locators) => locators
    .filter(l => ['css', 'attribute'].includes(l.type) && l.value && !isWeakSelector(l.value) && !(isToggle && /\[name=/.test(l.value)))
    .map(l => l.value);
  const theirCss = new Set(stableCss(theirs));
  if (stableCss(ours).some(css => theirCss.has(css))) return true;

  const name = valueOf(ours, 'aria');
  return !!name && name === valueOf(theirs, 'aria') && lastTag(tplSelector) === lastTag(stepSelector);
}

function renderStepPhrase(step, definitions) {
  // Case 1 — explicit link via step_definition_id
  if (step.step_definition_id) {
    const def = definitions.find(d => d.id === step.step_definition_id);
    if (def) {
      const args = extractArgs(def.params_template, normalizeParams(step));
      if (args) return { keyword: def.keyword, phrase: renderPattern(def.pattern, namingElement(def.params_template, args, step)) };
    }
  }

  // Case 2 — implicit match by command + template shape
  for (const def of definitions) {
    if (def.command !== step.command) continue;
    const args = extractArgs(def.params_template, normalizeParams(step));
    if (args) return { keyword: def.keyword, phrase: renderPattern(def.pattern, namingElement(def.params_template, args, step)) };
  }

  // Case 3 — fallback: use intent or raw command
  const keyword = fallbackKeyword(step.command);
  const phrase = step.intent
    ? `"${String(step.intent).replace(/"/g, '\\"')}"`
    : `${step.command} ${JSON.stringify(step.params || {})}`;
  return { keyword, phrase };
}

/**
 * The arguments of a phrase, its element named instead of its selector when the step has one
 * (`element`, given by element-store.js's withElementNames): I click on "Save profile". The
 * name reads back as the element (parse.js).
 */
function namingElement(template, args, step) {
  const slot = step.element ? /^\{(\d+)\}$/.exec(template?.selector ?? '')?.[1] : undefined;
  if (slot === undefined) return args;
  const named = [...args];
  named[Number(slot)] = step.element;
  return named;
}

function normalizeParams(step) {
  // For assert steps the data lives in `step.assertion`, not `step.params`.
  if (step.command === 'assert') {
    return step.assertion || step.params || {};
  }
  return step.params || {};
}

function fallbackKeyword(command) {
  if (command === 'navigate') return 'Given';
  if (command === 'assert') return 'Then';
  return 'When';
}

// ─── Template matching ──────────────────────────────────────────────

function extractArgs(template, actual) {
  const args = [];
  if (!walk(template, actual, args)) return null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === undefined) return null;
  }
  return args;
}

function walk(tpl, actual, args) {
  if (typeof tpl === 'string') {
    return matchTemplateString(tpl, actual, args);
  }
  if (Array.isArray(tpl)) {
    if (!Array.isArray(actual) || actual.length !== tpl.length) return false;
    return tpl.every((v, i) => walk(v, actual[i], args));
  }
  if (tpl && typeof tpl === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    for (const key of Object.keys(tpl)) {
      if (!walk(tpl[key], actual[key], args)) return false;
    }
    return true;
  }
  return tpl === actual;
}

function matchTemplateString(tpl, actual, args) {
  // Pure placeholder "{N}" — capture the value, but only if actually present
  const pure = tpl.match(/^\{(\d+)\}$/);
  if (pure) {
    if (actual == null) return false;
    args[Number(pure[1])] = String(actual);
    return true;
  }

  // No placeholder — literal match
  if (!tpl.includes('{')) {
    return tpl === (actual == null ? '' : String(actual));
  }

  // Mixed template "{0}000" → compile to regex with capture groups
  if (actual == null) return false;
  const parts = tpl.split(/(\{\d+\})/);
  const indices = [];
  let regexSrc = '^';
  for (const part of parts) {
    const m = part.match(/^\{(\d+)\}$/);
    if (m) {
      indices.push(Number(m[1]));
      regexSrc += '(.+)';
    } else {
      regexSrc += escapeRegex(part);
    }
  }
  regexSrc += '$';

  const match = new RegExp(regexSrc).exec(String(actual));
  if (!match) return false;
  for (let i = 0; i < indices.length; i++) {
    args[indices[i]] = match[i + 1];
  }
  return true;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Characters of a template that are not placeholders.
function literalLength(tpl) {
  if (tpl == null) return 0;
  if (typeof tpl !== 'object') return String(tpl).replace(/\{\d+\}/g, '').length;
  return Object.values(tpl).reduce((a, v) => a + literalLength(v), 0);
}

function templateComplexity(tpl) {
  if (tpl == null) return 0;
  if (typeof tpl !== 'object') return 1;
  if (Array.isArray(tpl)) return tpl.reduce((a, v) => a + templateComplexity(v), 0);
  return Object.values(tpl).reduce((a, v) => a + templateComplexity(v), 0);
}

// ─── Pattern rendering ──────────────────────────────────────────────

function renderPattern(pattern, args) {
  let i = 0;
  return pattern.replace(/\{(string|int|float|word)\}/g, (_, type) => {
    const val = args[i++] ?? '';
    if (type === 'string') return quoteString(val);
    return String(val);
  });
}

// A {string} argument: in single quotes when it holds double quotes and no single one —
// 'input[name="darkMode"]' reads better than "input[name=\"darkMode\"]". Cucumber takes both.
function quoteString(val) {
  const text = String(val);
  if (text.includes('"') && !text.includes("'")) return `'${text}'`;
  return `"${text.replace(/"/g, '\\"')}"`;
}
