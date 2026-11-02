// Why a test failed, and what would repair it — worked out the moment it fails, on the page
// it failed on: the replay window stays where the failure left it.
//
// A failure is one of a few things, and a QA team does not act the same on each:
//   test_drift      the page changed its markup and the element is there under another
//                   selector, or the text an assertion reads is in another element: the test
//                   broke, the app may well work. Repair: point the step at it again.
//   timing          the element is there now, where the step looked: it showed up after the
//                   step gave up. Repair: wait for it first.
//   changed_value   an assertion reads another value than the one expected: a regression, or
//                   an intended change (new wording) — for a person to judge. Repair: expect
//                   the new value, if the change is intended.
//   disabled        the element is there but disabled: a field the form needs may be missing
//                   or refused.
//   app_regression  nothing like the element is on the page, and the page shows an error or a
//                   request failed: most likely the app.
//   environment     the page did not load: a network error, the server failed the page itself.
//   unknown         none of these: a person, or the agent, looks at the page.
//
// Nothing is changed here: a repair is a proposal (lib/repairs.js), checked by replaying the
// test with it and saved only when someone accepts it.

import { log } from './logger.js';

export const CAUSES = {
  test_drift: 'The test broke: the page changed, the element is still there',
  timing: 'Timing: the element showed up after the step gave up',
  changed_value: 'The page shows another value: a regression, or an intended change',
  disabled: 'The element is there but disabled',
  app_regression: 'Suspected app regression: the page fails where the test used to pass',
  non_conformity: 'Non-conformity: the app does not do what the requirement asks',
  environment: 'Environment: the page did not load',
  unknown: 'No cause found',
};

// Roles a fill or a select can act on: a button with the same name is not the field.
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'slider', 'date', 'color']);
// Assertions whose expected value can simply become what the page shows now.
const REPLACEABLE_EXPECTATIONS = new Set(['text_equals', 'attribute_equals', 'title_equals', 'url_equals', 'element_count']);
const MAX_CONTAINS_LENGTH = 80;
const TRIAGE_BUDGET_MS = 8000;
const TIMING_RECHECK_MS = 1500;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** What a failed step tells of itself: an action whose element was not found, an assertion that failed… */
export function failureKind(step, error = '') {
  if (step?.command === 'assert') {
    const type = step.assertion?.type;
    if (type === 'visual_match') return 'visual';
    if (['no_console_errors', 'no_failed_requests', 'link_ok', 'no_a11y_violations'].includes(type)) return 'oracle';
    if (/not found/i.test(error) || error === 'null') return 'assertion_missing';
    if ((type === 'element_exists' || type === 'element_visible') && error === 'false') return 'assertion_missing';
    return 'assertion_value';
  }
  if (step?.command === 'navigate' || /net::ERR|chrome-error|ERR_NAME_NOT_RESOLVED|Navigation timeout/i.test(error)) return 'navigation';
  if (/Where to drop it was not found/.test(error)) return 'drop_not_found';
  if (/found but disabled|inert/.test(error)) return 'disabled';
  if (/covered at its centre|covered by/i.test(error)) return 'covered';
  if (/locators failed|not found|No element|Failed to resolve/i.test(error)) return 'not_found';
  return 'other';
}

/**
 * What the recording knows of a step's element: its role and name, placeholder, text, test ID,
 * and every selector it was found by. `side: 'target'` for where a drag drops.
 */
export function identityOf(step, side = 'element') {
  const params = step?.params ?? {};
  const locators = (side === 'target' ? params.targetLocators : step?.locators) ?? [];
  const value = (type) => locators.find(l => l.type === type)?.value ?? null;
  const role = locators.find(l => l.type === 'role' && l.name);
  const selector = side === 'target' ? params.target : params.selector;
  return {
    role: role?.value ?? null,
    name: role?.name ?? value('aria') ?? value('label') ?? null,
    placeholder: value('placeholder'),
    text: value('text'),
    testid: value('testid'),
    selectors: [selector, ...locators.filter(l => ['css', 'testid', 'attribute'].includes(l.type)).map(l => l.value)].filter(Boolean),
  };
}

/**
 * How alike two names are, 0 to 1: the words they share among all their words. "Create
 * account" and "Create my account" share 2 of 3 — a button reworded, not another button.
 */
export function nameSimilarity(a, b) {
  const words = (s) => new Set(norm(s).match(/[\p{L}\p{N}]+/gu) ?? []);
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter(w => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/**
 * How much an element of the page now (a snapshot ref: role, name, selector, locators) looks
 * like the one a step recorded. `sameSelector` when it is found by a selector the step had:
 * the very element, there now.
 */
export function scoreCandidate(identity, candidate, command) {
  const locators = candidate.locators ?? [];
  const value = (type) => locators.find(l => l.type === type)?.value;
  let score = 0;
  const why = [];
  const name = norm(candidate.name);
  const wanted = norm(identity.name);
  if (wanted && name) {
    if (name === wanted) { score += 4; why.push('same name'); }
    else if (name.includes(wanted) || wanted.includes(name) || nameSimilarity(name, wanted) >= 0.5) { score += 2; why.push('similar name'); }
  }
  if (identity.role && candidate.role === identity.role) { score += 2; why.push('same role'); }
  if (identity.placeholder && norm(value('placeholder')) === norm(identity.placeholder)) { score += 4; why.push('same placeholder'); }
  if (identity.text && norm(value('text')) === norm(identity.text)) { score += 2; why.push('same text'); }
  if (identity.testid && value('testid') === identity.testid) { score += 5; why.push('same test ID'); }
  const sameSelector = identity.selectors.includes(candidate.selector) || locators.some(l => identity.selectors.includes(l.value));
  if (sameSelector) { score += 5; why.push('same selector'); }
  if ((command === 'fill' || command === 'select') && candidate.role && !FIELD_ROLES.has(candidate.role)) { score -= 3; why.push('not a field'); }
  return { score, why, sameSelector };
}

/**
 * The element of the page that is the recorded one, if one clearly is: a score of 4 or more
 * (a same name), 2 ahead of the next. Confidence high from a same name and role (or better).
 */
export function pickCandidate(identity, candidates, command) {
  const scored = candidates
    .map(candidate => ({ candidate, ...scoreCandidate(identity, candidate, command) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < 4) return { best: null, scored };
  if (second && best.score - second.score < 2) return { best: null, scored, ambiguous: true };
  return { best, scored, confidence: best.score >= 6 ? 'high' : 'medium' };
}

// Roles getByRole finds by name: worth recording with a repaired step.
const NAMED_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox', 'textbox', 'searchbox', 'heading', 'slider', 'spinbutton', 'treeitem']);

/**
 * The step pointed at `candidate`: its selector and locators, and its role and name — the
 * recorded ones while they still hold, else the element's own: the next diagnosis of this
 * step knows what it is looking for.
 */
export function relocatedStep(step, candidate, side = 'element') {
  if (side === 'target') {
    return { ...step, params: { ...step.params, target: candidate.selector, targetLocators: candidate.locators ?? [] } };
  }
  const kept = (step.locators ?? []).filter(l => l.type === 'role' && l.name && norm(l.name) === norm(candidate.name));
  const own = NAMED_ROLES.has(candidate.role) && candidate.name ? [{ type: 'role', value: candidate.role, name: candidate.name }] : [];
  return {
    ...step,
    params: { ...step.params, selector: candidate.selector },
    locators: [...(candidate.locators ?? []), ...(kept.length ? kept : own)],
  };
}

/**
 * The expected value an assertion would need to pass on what the page shows: null when that
 * is not for a machine to say — a variable's value, or a long text read by "contains".
 */
export function newExpectation(assertion, actual) {
  if (!assertion || actual == null || /\{\{/.test(String(assertion.expected ?? ''))) return null;
  const shown = String(actual).trim();
  if (REPLACEABLE_EXPECTATIONS.has(assertion.type)) return shown;
  if (['text_contains', 'title_contains', 'url_contains'].includes(assertion.type) && shown && shown.length <= MAX_CONTAINS_LENGTH) return shown;
  return null;
}

/** The cause of a failure the page gave no candidate for: the page's own signals decide. */
export function causeWithoutCandidate(kind, signals = {}) {
  const pageFailed = (signals.failedRequests ?? []).some(r => r.resourceType === 'document' && r.status >= 500);
  if (kind === 'navigation' || pageFailed || /^chrome-error:/.test(signals.url ?? '')) return { cause: 'environment', confidence: 'high' };
  if (kind === 'disabled') return { cause: 'disabled', confidence: 'high' };
  if ((signals.alerts ?? []).length || (signals.failedRequests ?? []).length) return { cause: 'app_regression', confidence: 'medium' };
  return { cause: 'unknown', confidence: 'low' };
}

// ─── On the page ───────────────────────────────────────────────────────

/**
 * Diagnose a failed run, on the tab it failed in. `stored` is the test as saved ({{variables}}
 * left in), `failed` the failed step's result ({ step, error, assertionResult }), `values`
 * what the run filled in. Bounded: past the budget the cause is unknown, never a hang.
 */
export async function diagnoseFailure({ stored, failed, tabId, sendCommand, values = {}, history = {}, requirements = [] }) {
  const work = diagnose({ stored, failed, tabId, sendCommand, values, history })
    .then((diagnosis) => stored.steps[failed.step - 1]?.command === 'assert' ? againstRequirements(diagnosis, requirements) : diagnosis);
  const late = new Promise(resolve => setTimeout(() => resolve({
    cause: 'unknown', confidence: 'low', summary: 'The diagnosis took too long and was stopped', evidence: {}, proposals: [],
  }), TRIAGE_BUDGET_MS));
  return Promise.race([work.catch(err => {
    log(`Triage failed: ${err.message}`);
    return { cause: 'unknown', confidence: 'low', summary: `The diagnosis could not run: ${err.message}`, evidence: {}, proposals: [] };
  }), late]);
}

/**
 * A test that checks a requirement, failing on what the page shows: the app does not do what
 * the requirement asks. Its expected value comes from the requirement, not from the app: no
 * repair offers to expect what the page shows instead. A selector that broke (test_drift) or
 * a page that was slow (timing) are still the test's.
 */
export function againstRequirements(diagnosis, requirements) {
  if (!requirements?.length || !['changed_value', 'app_regression'].includes(diagnosis.cause)) return diagnosis;
  const what = requirements.map((r) => `${r.key} (${r.title}${r.criteria.length ? `, criterion ${r.criteria.map((c) => `${c.number}: ${c.text}`).join('; ')}` : ''})`).join(', ');
  return {
    ...diagnosis,
    cause: 'non_conformity',
    confidence: 'medium',
    summary: `${diagnosis.summary} — the test checks ${what}`,
    evidence: { ...diagnosis.evidence, requirements: requirements.map((r) => r.key) },
    proposals: diagnosis.proposals.filter((proposal) => proposal.kind !== 'expect'),
  };
}

async function diagnose({ stored, failed, tabId, sendCommand, history }) {
  const stepOrder = failed.step;
  const step = stored.steps[stepOrder - 1];
  const error = failed.error ?? failed.assertionResult?.actual ?? '';
  const kind = failureKind(step, failed.assertionResult ? String(failed.assertionResult.actual ?? '') : error);
  const { refs, ...page } = tabId ? await pageSignals(tabId, sendCommand) : {};
  page.refs = refs;
  const evidence = { step: { order: stepOrder, command: step?.command, intent: step?.intent ?? null, error }, page: { ...page, refs: undefined }, history };
  const result = (cause, confidence, summary, proposals = []) => ({ cause, confidence, summary, evidence, proposals });

  if (!step) return result('unknown', 'low', `Step ${stepOrder} is not in the test any more`);
  if (kind === 'visual') return result('changed_value', 'low', 'The screenshot differs from the baseline: look at both before accepting it');
  // A check of what the page does wrong on its own (a bug's test): the page has the bug.
  if (kind === 'oracle') return result('app_regression', 'high', `The page still has the bug this step checks for: ${failed.assertionResult?.actual ?? error}`);

  if (kind === 'not_found' || kind === 'drop_not_found') {
    const side = kind === 'drop_not_found' ? 'target' : 'element';
    const identity = identityOf(step, side);
    // Every element of the page that can be acted on: a name searched for would miss a
    // button reworded ("Create account" → "Create my account").
    const candidates = Object.values(page.refs ?? {}).filter(info => info?.selector);
    const { best, confidence, ambiguous, scored } = pickCandidate(identity, candidates, step.command);
    evidence.candidates = scored.slice(0, 3).map(({ candidate, score, why }) => ({ selector: candidate.selector, role: candidate.role, name: candidate.name, score, why }));
    const what = side === 'target' ? 'where to drop it' : 'the element';
    if (best?.sameSelector) {
      return result('timing', 'medium', `The step gave up on ${what}, which is on the page now (${best.candidate.selector})`, [{
        kind: 'wait', step_order: stepOrder,
        summary: `Wait for ${best.candidate.selector} before step ${stepOrder}`,
        change: { op: 'insert', step_order: stepOrder, step: { command: 'wait', params: { selector: best.candidate.selector }, intent: `Wait for ${best.candidate.name || best.candidate.selector}` } },
      }]);
    }
    if (best) {
      const name = best.candidate.name ? `"${best.candidate.name}" ` : '';
      return result('test_drift', confidence, `None of the step's locators finds ${what} any more; the page has ${name}at ${best.candidate.selector} (${best.why.join(', ')})`, [{
        kind: 'relocate', step_order: stepOrder,
        summary: `Find ${what} of step ${stepOrder} at ${best.candidate.selector}`,
        change: { op: 'replace', step_order: stepOrder, step: relocatedStep(step, best.candidate, side) },
      }]);
    }
    const { cause, confidence: c } = causeWithoutCandidate(kind, page);
    const why = ambiguous ? 'several elements of the page look like it, none clearly' : 'nothing on the page looks like it';
    return result(cause, c, `${what[0].toUpperCase()}${what.slice(1)} of step ${stepOrder} is not found, and ${why}`);
  }

  if (kind === 'assertion_missing' || kind === 'assertion_value') {
    const assertion = step.assertion ?? {};
    const expected = failed.hydratedExpected ?? assertion.expected;
    const actual = failed.assertionResult?.actual;
    if (kind === 'assertion_missing') {
      // The text the assertion looks for, elsewhere on the page: the selector broke.
      const candidates = tabId && expected ? await candidatesFor([String(expected)], tabId, sendCommand, { interactiveOnly: false }) : [];
      const holder = candidates
        .filter(c => c.selector && norm(c.name).includes(norm(expected)))
        .sort((a, b) => String(a.name).length - String(b.name).length)[0];
      evidence.candidates = candidates.slice(0, 3).map(c => ({ selector: c.selector, role: c.role, name: c.name }));
      if (holder) {
        return result('test_drift', 'medium', `${assertion.selector} is not on the page, but "${expected}" is, in ${holder.selector}`, [{
          kind: 'relocate', step_order: stepOrder,
          summary: `Check ${holder.selector} in step ${stepOrder}`,
          change: { op: 'replace', step_order: stepOrder, step: { ...step, assertion: { ...assertion, selector: holder.selector } } },
        }]);
      }
      const { cause, confidence } = causeWithoutCandidate(kind, page);
      return result(cause === 'unknown' ? 'app_regression' : cause, cause === 'unknown' ? 'low' : confidence,
        `${assertion.selector ?? 'The element'} is not on the page${expected ? `, nor is "${expected}"` : ''}`);
    }
    // Asked again a moment later: the page may only have been slow to show it.
    if (tabId && failed.recheck) {
      await new Promise(resolve => setTimeout(resolve, TIMING_RECHECK_MS));
      const again = await failed.recheck().catch(() => null);
      if (again?.passed) {
        return result('timing', 'medium', `The assertion passes ${TIMING_RECHECK_MS / 1000} s later: the page was still updating`, [{
          kind: 'wait', step_order: stepOrder,
          summary: `Wait ${TIMING_RECHECK_MS / 1000} s before step ${stepOrder}`,
          change: { op: 'insert', step_order: stepOrder, step: { command: 'wait', params: { ms: TIMING_RECHECK_MS }, intent: 'Wait for the page to settle' } },
        }]);
      }
    }
    if (/\{\{/.test(String(assertion.expected ?? ''))) {
      return result('app_regression', 'medium', `The page does not show the value the test typed ("${expected}"): it was not kept, or shown elsewhere`);
    }
    // The page reports an error: not a value to accept.
    if (page.alerts?.length || page.failedRequests?.length) {
      return result('app_regression', 'medium', `Expected ${JSON.stringify(expected)}, the page shows ${JSON.stringify(actual)}, and it reports an error`);
    }
    const next = newExpectation(assertion, actual);
    return result('changed_value', 'low', `Expected ${JSON.stringify(expected)}, the page shows ${JSON.stringify(actual)}`, next == null ? [] : [{
      kind: 'expect', step_order: stepOrder, needs_review: true,
      summary: `Expect ${JSON.stringify(next)} in step ${stepOrder}, if this change is intended`,
      change: { op: 'replace', step_order: stepOrder, step: { ...step, assertion: { ...assertion, expected: next } } },
    }]);
  }

  const { cause, confidence } = causeWithoutCandidate(kind, page);
  const what = kind === 'covered' ? 'Something covers the element' : kind === 'navigation' ? 'The page did not load' : `Step ${stepOrder} failed`;
  return result(kind === 'covered' ? 'unknown' : cause, confidence, `${what}: ${error}`);
}

/** The page where the run stopped: address, alerts and dialogs it shows, requests that failed. */
async function pageSignals(tabId, sendCommand) {
  const [snap, network] = await Promise.all([
    sendCommand(undefined, 'snapshot', { tabId, interactiveOnly: true, compact: true, format: 'text', textDigest: true }).catch(() => null),
    sendCommand(undefined, 'network_requests', { tabId, limit: 300 }).catch(() => null),
  ]);
  const alerts = (snap?.digest ?? []).filter(line => /^(alert|alertdialog):/.test(line)).slice(0, 5);
  const failedRequests = (network?.requests ?? [])
    .filter(r => (r.status >= 400 || r.status === 0) && !/favicon/.test(r.url))
    .slice(0, 5)
    .map(({ method, url, status, resourceType }) => ({ method, url, status, resourceType }));
  return { url: snap?.url ?? null, title: snap?.title ?? null, alerts, failedRequests, refs: snap?.refs ?? {} };
}

/** Elements of the page that match one of `terms`: snapshot refs, with their role, name and locators. */
async function candidatesFor(terms, tabId, sendCommand, { interactiveOnly }) {
  const found = new Map();
  for (const searchText of terms.slice(0, 3)) {
    const snap = await sendCommand(undefined, 'snapshot', { tabId, interactiveOnly, compact: true, format: 'text', searchText }).catch(() => null);
    for (const [ref, info] of Object.entries(snap?.refs ?? {})) if (info?.selector && !found.has(ref)) found.set(ref, info);
  }
  return [...found.values()];
}

/** The diagnosis as the agent reads it after a failed run_test. */
export function formatTriage(triage) {
  const lines = [`Cause: ${triage.cause} (${triage.confidence} confidence) — ${CAUSES[triage.cause] ?? ''}`, triage.summary];
  const { page = {}, history } = triage.evidence ?? {};
  if (page.url) lines.push(`Page: ${page.url}${page.title ? ` — "${page.title}"` : ''}`);
  if (page.alerts?.length) lines.push(`The page says: ${page.alerts.join(' | ')}`);
  if (page.failedRequests?.length) {
    lines.push(`Failed requests: ${page.failedRequests.map(r => `${r.method} ${r.url} → ${r.status || 'no response'}`).join(', ')}`);
  }
  if (history?.passes) lines.push(`Passed ${history.passes} time(s) before, last on ${history.lastPass}`);
  for (const proposal of triage.proposals ?? []) {
    lines.push(`Proposed repair #${proposal.id} (${proposal.kind})${proposal.needs_review ? ', for a person to judge' : ''}: ${proposal.summary}`);
  }
  return lines.join('\n');
}
