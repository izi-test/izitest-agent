// A check made while a test is recorded: the next step of the recording, right after the
// action whose result it checks. Checks added once the test was saved were all checked on
// its last page and put at its end: on a replay, the actions ran one after the other
// without waiting for what each brought — a tab clicked 0.4 s after another stopped the
// first from loading, and the check of its content, at the end, failed. Where it belongs,
// a check holds the replay there until what it checks shows (up to the project's wait).

import { linkAssertionToVariables } from './test-variable.js';
import { withColumnsOf } from './datasets.js';
import { getRequirement } from './requirements.js';

/** Whether add_assertion on `testName` goes to the recording under way rather than to a saved test. */
export function checksRecording(recording, testName) {
  return !!recording && recording.name === testName;
}

/**
 * What a recording checks against a requirement: the one it was started for. A check of it
 * made while recording may be saved failing (non_conformity), as on the saved test.
 */
export function recordingRequirements(recording) {
  const ref = recording?.link?.requirement;
  const found = ref ? getRequirement(ref) : null;
  return found ? [{ id: found.id, key: found.key, title: found.title }] : [];
}

/**
 * Record `assertion` as the recording's next step. `{ step, after }`: its number, and the step
 * it comes right after (what the agent is told it checks the result of).
 */
export function recordCheck(session, { assertion, intent, page }) {
  const recording = session.recording;
  const before = recording.steps.at(-1) ?? null;
  recording.steps.push({ command: 'assert', params: {}, assertion, intent, ...(page && { page }) });
  const step = recording.steps.length;
  import('./websocket.js').then(({ pushOverlayState }) => {
    pushOverlayState(null, { mode: 'recording', updateOnly: true, step, stepName: intent }, session.lastTabId ?? null);
  }).catch(() => {});
  return { step, after: before ? `step ${step - 1}${before.intent ? ` (${before.intent})` : ` (${before.command})`}` : null };
}

/**
 * The checks of a recording, linked at save time to the variables it found: "Welcome Bob"
 * after typing Bob checks {{name}}, so a replay with other values checks those. Playing a
 * dataset (`row`), what its row shows is its column's too. Returns the variables with the
 * columns the checks name, and what was linked.
 */
export function linkRecordedChecks(steps, variables, row = null) {
  const fromDataset = row ? Object.fromEntries(Object.entries(row).map(([column, value]) => [column, { type: 'text', defaultValue: String(value ?? '') }])) : {};
  let all = variables;
  const linked = [];
  // The suggestions picked after typing (variable-detection.js): the checks around them follow them too.
  const suggestions = steps.filter((step) => step.variable?.suggestionOf && step.variable.name).map((step) => step.variable);
  steps.forEach((step, i) => {
    if (step.command !== 'assert' || !step.assertion) return;
    const { assertion, linked: names } = linkAssertionToVariables(step.assertion, { ...fromDataset, ...all });
    // What it expects is a picked suggestion — a search term —: the page writes it its own way
    // ("Bananes Prix Bas" for "banane"), compared whatever the case.
    let next = names.some((name) => suggestions.some((suggestion) => suggestion.name === name)) && TEXT_CHECKS.has(assertion.type)
      ? { ...assertion, ignoreCase: true } : assertion;
    const following = [];
    for (const { name, defaultValue } of suggestions) {
      const followed = followSuggestion(next, name, defaultValue);
      if (followed) { next = followed; following.push(name); }
    }
    const linkedNames = [...new Set([...names, ...following])];
    if (!linkedNames.length) return;
    step.assertion = next;
    all = withColumnsOf(all, fromDataset, next.expected);
    linked.push({ step: i + 1, names: linkedNames });
  });
  return { variables: all, linked };
}

// The checks that compare a text: those that may ignore its case.
const TEXT_CHECKS = new Set(['text_contains', 'text_not_contains', 'text_equals', 'title_contains', 'title_equals', 'url_contains', 'url_equals']);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The value whole, never a piece of a word ("chocolat", not the "chocolat" of "chocolaterie").
const wholeWord = (value, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(value)}(?![\\p{L}\\p{N}])`, flags);

/**
 * A check following a suggestion picked after typing (`{{name}}`, picked "chocolat"): where it
 * names it in its selector — in the value of an attribute, a[href="/recherche?text=chocolat"] —,
 * and in what it expects when the page writes it otherwise ("Chocolat" in the title: compared
 * whatever the case, `ignoreCase`). Replayed with "banane", it checks "banane". The check, or null
 * when it does not name it.
 */
export function followSuggestion(assertion, name, value) {
  if (typeof value !== 'string' || value.trim().length < 3) return null;
  const placeholder = `{{${name}}}`;
  let next = assertion;
  if (typeof next.selector === 'string' && !next.selector.includes(placeholder)) {
    const selector = next.selector.replace(/(["'])((?:\\.|(?!\1).)*)\1/g, (_, quote, inner) => quote + inner.replace(wholeWord(value, 'gu'), placeholder) + quote);
    if (selector !== next.selector) next = { ...next, selector };
  }
  if (typeof next.expected === 'string' && !next.expected.includes(placeholder)
      && wholeWord(value, 'iu').test(next.expected) && !wholeWord(value, 'u').test(next.expected)) {
    next = { ...next, expected: next.expected.replace(wholeWord(value, 'giu'), placeholder), ignoreCase: true };
  }
  // Its plural, in a text a check expects to contain: the title "Chocolats pas cher" for
  // "chocolat". The check is then that the text holds the suggestion — "chocolat" is in
  // "Chocolats", "banane" in "Votre recherche banane". Never another word made of it ("Chocolaterie").
  if (PLURAL_CHECKS.has(next.type) && typeof next.expected === 'string' && !next.expected.includes(placeholder)
      && plural(value, 'iu').test(next.expected)) {
    next = { ...next, expected: next.expected.replace(plural(value, 'giu'), placeholder), ignoreCase: true };
  }
  // In a URL, the suggestion is a query value, or the start of one: /search?q=laptop for "laptop
  // computers" (the URL writes laptop+computers). Compared on the URL decoded, whatever the case.
  if (URL_CHECKS.has(next.type) && typeof next.expected === 'string' && !next.expected.includes(placeholder)) {
    const wanted = value.toLocaleLowerCase();
    const expected = next.expected.replace(/([=/])([^&#?/=]+)/g, (whole, sep, token) => {
      const piece = decodeUrlPiece(token).toLocaleLowerCase();
      const startsIt = piece.length >= 3 && wanted.startsWith(piece) && (wanted.length === piece.length || !/[\p{L}\p{N}]/u.test(wanted[piece.length]));
      return startsIt ? `${sep}${placeholder}` : whole;
    });
    if (expected !== next.expected) next = { ...next, expected, ignoreCase: true };
  }
  // A query value alone (redirect_keywords={{text_choice}}, however it was linked): the URL holds
  // the suggestion. The name is how the site took this value — Auchan sends a word it knows to its
  // aisle (?redirect_keywords=chocolat), any other to its search (?text=banane) —, not what is checked.
  if (next.type === 'url_contains' && typeof next.expected === 'string'
      && new RegExp(`^[?&]?[^=&?#/]+=${escapeRegex(placeholder)}$`).test(next.expected)) {
    next = { ...next, expected: placeholder, ignoreCase: true };
  }
  return next === assertion ? null : next;
}

// The checks a plural of the suggestion is followed in: what a text holds, not what it is.
const PLURAL_CHECKS = new Set(['text_contains', 'title_contains']);
// The value with a plural's ending (s, x, es), whole: "Chocolats" for "chocolat".
const plural = (value, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(value)}(?:s|x|es)(?![\\p{L}\\p{N}])`, flags);

const URL_CHECKS = new Set(['url_contains', 'url_equals']);
const decodeUrlPiece = (token) => {
  try {
    return decodeURIComponent(token.replace(/\+/g, ' '));
  } catch {
    return token;
  }
};
