// The steps to save when a test's feature is edited (the dashboard's Gherkin tab).
//
// Parsing the whole feature afresh rebuilt every step from its phrase, and a phrase says
// only what its step definition holds: a list variable ({{option}}, which item to pick),
// the intents, the locators replay falls back on, what only a recording knows (a box
// clicked through its label, a VRT baseline) were all lost on any save, even with nothing
// edited. A test holding a step no phrase covers (execute_js, a visual check) could not be
// saved at all: its fallback phrase did not parse.
//
// So the edited phrases are compared with the ones the test gave: a phrase left as it was
// keeps the very steps it came from; an edited one is parsed, and where its command and
// target did not change, it keeps the locators, intent and list variable of the step it
// replaces.

import { scenarioPhrases } from './serialize.js';
import { featurePhrases, compileDefinitions, effectiveKeyword, stepsForPhrase, unresolved, unresolvedError } from './parse.js';

// Parameters a phrase cannot say, set by recording: kept on an edited step with the same target.
const RECORDING_ONLY_PARAMS = ['viaLabel', 'baselinePath'];

/**
 * The steps of `test` once its feature reads `featureText`; throws like the parser on a
 * phrase nothing matches. `test` as its feature was shown, its elements named; `targets`,
 * the elements of its project by name (parse.js).
 */
export function stepsForEditedFeature(featureText, definitions, test, { targets } = {}) {
  const before = scenarioPhrases(test, definitions);
  const after = featurePhrases(featureText);
  const matched = commonPhrases(before.map(p => p.phrase), after.map(p => p.text));
  const keptBefore = new Set(matched.values());

  const compiled = compileDefinitions(definitions);
  const steps = [];
  const errors = [];
  let lastKeyword = null;
  let previous = -1; // index in `before` of the last phrase kept as it was

  for (const [i, { text, keyword, line }] of after.entries()) {
    const kept = matched.get(i);
    if (kept !== undefined) {
      steps.push(...before[kept].steps.map(step => structuredClone(step)));
      lastKeyword = before[kept].keyword;
      previous = kept;
      continue;
    }

    const parsed = stepsForPhrase(text, effectiveKeyword(keyword, lastKeyword), compiled, steps.length, targets);
    if (!parsed) {
      errors.push(unresolved(line, keyword, text));
      continue;
    }
    // The phrase it most likely replaces: the next one of `before` not kept as it was.
    const replaced = before[previous + 1] && !keptBefore.has(previous + 1) ? before[previous + 1] : null;
    if (replaced) previous += 1;
    steps.push(...(replaced ? carryOver(replaced.steps, parsed.steps) : parsed.steps));
    lastKeyword = parsed.keyword;
  }

  if (errors.length) throw unresolvedError(errors);
  return steps;
}

/**
 * Which phrases of `after` are phrases of `before` left as they were: the longest common
 * subsequence, as a Map from index in `after` to index in `before`.
 */
function commonPhrases(before, after) {
  const n = before.length;
  const m = after.length;
  const lengths = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const matched = new Map();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (before[i] === after[j]) {
      matched.set(j, i);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

const targetOf = (step) => step.params?.selector ?? step.params?.label ?? step.params?.url ?? null;

/** The parsed steps of an edited phrase, with what the Gherkin cannot say taken from the steps it replaces. */
function carryOver(oldSteps, newSteps) {
  if (oldSteps.length !== newSteps.length) return newSteps;
  return newSteps.map((step, i) => {
    const old = oldSteps[i];
    if (old.command !== step.command || targetOf(old) !== targetOf(step)) return step;

    const params = { ...step.params };
    for (const key of RECORDING_ONLY_PARAMS) {
      if (old.params?.[key] !== undefined && params[key] === undefined) params[key] = old.params[key];
    }
    // A list variable picks among the items of the same list; a typed one only while its
    // {{placeholder}} is still in the step.
    const keepsVariable = old.variable
      && (old.variable.listContext || JSON.stringify(step.params ?? {}).includes(`{{${old.variable.name}}}`));
    return {
      ...step,
      params,
      ...(old.locators && { locators: structuredClone(old.locators) }),
      ...(old.page && { page: old.page }),
      ...(old.intent && { intent: old.intent }),
      ...(keepsVariable && { variable: structuredClone(old.variable) }),
    };
  });
}
