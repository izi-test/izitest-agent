// Unit tests for the diagnosis of a failed run and the repairs it proposes: the element found
// again under another selector, the element that was only late, a value that changed, the
// page that says something went wrong. A fake browser stands for the page the run failed on.
// Run with: node --test test/triage.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failureKind, identityOf, pickCandidate, relocatedStep, newExpectation, causeWithoutCandidate, diagnoseFailure, formatTriage, nameSimilarity,
} from '../lib/triage.js';
import { actionPlan } from '../lib/test-execute.js';
import { withRepair, repairDiff } from '../lib/repairs.js';

// izitest-test.html's login form, recorded: "Sign in" clicked.
const SIGN_IN = {
  command: 'click', intent: 'Se connecter',
  params: { selector: '#login-form > div:nth-of-type(3) > button:nth-of-type(1)' },
  locators: [
    { type: 'aria', value: 'Sign in' },
    { type: 'css', value: '#login-form > div:nth-of-type(3) > button:nth-of-type(1)' },
    { type: 'role', value: 'button', name: 'Sign in' },
  ],
};
const ref = (role, name, selector, more = []) => ({ role, name, selector, locators: [{ type: 'css', value: selector }, ...more] });

test('what a failure is, from its step and its error', () => {
  assert.equal(failureKind(SIGN_IN, 'All 3 locators failed:\naria="Sign in" (not found)'), 'not_found');
  assert.equal(failureKind(SIGN_IN, 'All 2 locators failed:\ncss="#go" (found but disabled/inert)'), 'disabled');
  assert.equal(failureKind({ command: 'drag' }, 'Where to drop it was not found: all 3 locators failed'), 'drop_not_found');
  assert.equal(failureKind({ command: 'navigate' }, 'net::ERR_CONNECTION_REFUSED'), 'navigation');
  const check = (type) => ({ command: 'assert', assertion: { type } });
  assert.equal(failureKind(check('text_contains'), '(element not found)'), 'assertion_missing');
  assert.equal(failureKind(check('element_exists'), 'false'), 'assertion_missing');
  assert.equal(failureKind(check('text_equals'), 'Mon avis'), 'assertion_value');
  assert.equal(failureKind(check('visual_match'), '3.2% diff'), 'visual');
  assert.equal(failureKind(check('text_contains'), "Error: Cannot read properties of null (reading 'result')"), 'assertion_error');
});

test('the element found again: same name and role, under a new selector', () => {
  const identity = identityOf(SIGN_IN);
  assert.deepEqual([identity.role, identity.name], ['button', 'Sign in']);
  const page = [ref('heading', 'Sign in', 'h3.title'), ref('button', 'Clear', '#clear-login'), ref('button', 'Sign in', '#signin-btn')];
  const { best, confidence } = pickCandidate(identity, page, 'click');
  assert.equal(best.candidate.selector, '#signin-btn');
  assert.equal(confidence, 'high');
  assert.equal(best.sameSelector, false);
});

test('a button reworded is the same button: its words mostly the same, its role the same', () => {
  const create = { command: 'click', params: { selector: '#submit-btn' }, locators: [{ type: 'role', value: 'button', name: 'Create account' }] };
  const page = [ref('textbox', 'Email address', '#user-email'), ref('button', 'Create my account', '#create-account'), ref('link', 'Terms', '#terms')];
  const { best, confidence } = pickCandidate(identityOf(create), page, 'click');
  assert.equal(best.candidate.selector, '#create-account');
  assert.equal(confidence, 'medium');
  assert.deepEqual(best.why, ['similar name', 'same role']);
  assert.equal(nameSimilarity('Create account', 'Create my account'), 2 / 3);
  assert.equal(nameSimilarity('Sign in', 'Clear'), 0);
});

test('an assertion that reads another value while the page reports an error: the app, no value to accept', async () => {
  const triage = await diagnoseFailure({
    stored: { steps: [CHECK] }, tabId: 1, sendCommand: fakePage({ alerts: ['alert: Signup failed'] }),
    failed: { step: 1, error: 'x', assertionResult: { passed: false, actual: '' }, recheck: async () => ({ passed: false }) },
  });
  assert.equal(triage.cause, 'app_regression');
  assert.deepEqual(triage.proposals, []);
});

test('two elements as like it as each other: none is picked', () => {
  const identity = identityOf({ command: 'click', params: { selector: '#x' }, locators: [{ type: 'role', value: 'button', name: 'Clear' }] });
  const { best, ambiguous } = pickCandidate(identity, [ref('button', 'Clear', '#a'), ref('button', 'Clear', '#b')], 'click');
  assert.equal(best, null);
  assert.equal(ambiguous, true);
});

test('a field is found by its placeholder, not taken for a button of the same name', () => {
  const email = { command: 'fill', params: { selector: '#email', value: '{{email}}' }, locators: [{ type: 'aria', value: 'Email' }, { type: 'placeholder', value: 'you@example.com' }] };
  const page = [ref('button', 'Email', '#email-me'), ref('textbox', 'E-mail', '#login-email', [{ type: 'placeholder', value: 'you@example.com' }])];
  assert.equal(pickCandidate(identityOf(email), page, 'fill').best.candidate.selector, '#login-email');
});

test('the very element, there now under a recorded selector: it was late', () => {
  const page = [ref('button', 'Sign in', '#login-form > div:nth-of-type(3) > button:nth-of-type(1)')];
  assert.equal(pickCandidate(identityOf(SIGN_IN), page, 'click').best.sameSelector, true);
});

test('a relocated step keeps its role and name only while they still hold', () => {
  const same = relocatedStep(SIGN_IN, ref('button', 'Sign in', '#signin-btn'));
  assert.equal(same.params.selector, '#signin-btn');
  assert.deepEqual(same.locators.map(l => l.type), ['css', 'role']);
  const renamed = relocatedStep(SIGN_IN, ref('button', 'Log in', '#login-btn'));
  assert.deepEqual(renamed.locators.at(-1), { type: 'role', value: 'button', name: 'Log in' }, 'the element\'s own, for the next diagnosis');
  assert.equal(relocatedStep(SIGN_IN, ref('generic', 'Card', '.card')).locators.some(l => l.type === 'role'), false);
  const drag = { command: 'drag', params: { selector: '#a', target: '#old', targetLocators: [] } };
  assert.deepEqual(relocatedStep(drag, ref('generic', 'Done', '#done'), 'target').params, { selector: '#a', target: '#done', targetLocators: [{ type: 'css', value: '#done' }] });
});

test('the expected value a person may accept: never a variable\'s, never a long text read by "contains"', () => {
  assert.equal(newExpectation({ type: 'text_equals', expected: 'Mon avis' }, ' Votre avis '), 'Votre avis');
  assert.equal(newExpectation({ type: 'element_count', expected: '2' }, '3'), '3');
  assert.equal(newExpectation({ type: 'text_contains', expected: 'Merci' }, 'Merci beaucoup'), 'Merci beaucoup');
  assert.equal(newExpectation({ type: 'text_contains', expected: 'cost' }, 'x'.repeat(200)), null);
  assert.equal(newExpectation({ type: 'text_equals', expected: '{{reason}}' }, 'autre'), null);
});

test('with nothing like the element on the page, the page\'s own signals decide', () => {
  assert.equal(causeWithoutCandidate('not_found', { failedRequests: [{ resourceType: 'document', status: 502 }] }).cause, 'environment');
  assert.equal(causeWithoutCandidate('navigation', {}).cause, 'environment');
  assert.equal(causeWithoutCandidate('not_found', { alerts: ['alert: Server error'] }).cause, 'app_regression');
  assert.equal(causeWithoutCandidate('not_found', { failedRequests: [{ resourceType: 'fetch', status: 500 }] }).cause, 'app_regression');
  assert.equal(causeWithoutCandidate('disabled', {}).cause, 'disabled');
  assert.equal(causeWithoutCandidate('not_found', {}).cause, 'unknown');
});

/** The page a run failed on: `refs` answer a snapshot's search, `requests` the network log. */
function fakePage({ refs = [], alerts = [], requests = [], url = 'http://127.0.0.1:8777/app.html' } = {}) {
  return async (_profile, command, params) => {
    if (command === 'network_requests') return { requests };
    if (command === 'snapshot' && params.searchText) {
      const needle = params.searchText.toLowerCase();
      return { refs: Object.fromEntries(refs.filter(r => r.name.toLowerCase().includes(needle)).map((r, i) => [`e${i + 1}`, r])) };
    }
    if (command === 'snapshot') return { url, title: 'App', digest: alerts, refs: Object.fromEntries(refs.map((r, i) => [`e${i + 1}`, r])) };
    throw new Error(`unexpected ${command}`);
  };
}

test('a click whose button moved: test drift, and a repair that points the step at it', async () => {
  const stored = { name: 't', steps: [{ command: 'navigate', params: { url: 'x' } }, SIGN_IN] };
  const triage = await diagnoseFailure({
    stored, tabId: 1, failed: { step: 2, error: 'All 3 locators failed:\naria="Sign in" (not found)' },
    sendCommand: fakePage({ refs: [ref('button', 'Sign in', '#signin-btn'), ref('heading', 'Sign in', 'h3')] }),
    history: { passes: 4, lastPass: '2026-11-01T10:00:00Z' },
  });
  assert.equal(triage.cause, 'test_drift');
  assert.equal(triage.confidence, 'high');
  const [repair] = triage.proposals;
  assert.equal(repair.kind, 'relocate');
  assert.deepEqual(repair.change.op, 'replace');
  assert.equal(repair.change.step.params.selector, '#signin-btn');
  assert.match(formatTriage({ ...triage, proposals: [{ id: 7, ...repair }] }), /Cause: test_drift \(high confidence\)[\s\S]*Passed 4 time\(s\) before[\s\S]*Proposed repair #7 \(relocate\)/);
});

test('a click whose button is gone while the API fails: a suspected regression, nothing to repair', async () => {
  const triage = await diagnoseFailure({
    stored: { steps: [SIGN_IN] }, tabId: 1, failed: { step: 1, error: 'All 3 locators failed' },
    sendCommand: fakePage({ alerts: ['alert: Something went wrong'], requests: [{ method: 'POST', url: 'http://x/api/login', status: 500, resourceType: 'fetch' }] }),
  });
  assert.equal(triage.cause, 'app_regression');
  assert.deepEqual(triage.proposals, []);
  assert.deepEqual(triage.evidence.page.failedRequests, [{ method: 'POST', url: 'http://x/api/login', status: 500, resourceType: 'fetch' }]);
});

const CHECK = { command: 'assert', intent: 'Le titre est enregistré', assertion: { type: 'text_equals', selector: '#inline-title', expected: 'Mon avis' } };

test('an assertion that passes a moment later: timing, and a wait before it', async () => {
  const triage = await diagnoseFailure({
    stored: { steps: [SIGN_IN, CHECK] }, tabId: 1, sendCommand: fakePage(),
    failed: { step: 2, error: 'Assertion failed', assertionResult: { passed: false, actual: '' }, recheck: async () => ({ passed: true }) },
  });
  assert.equal(triage.cause, 'timing');
  assert.deepEqual(triage.proposals[0].change, { op: 'insert', step_order: 2, step: { command: 'wait', params: { ms: 1500 }, intent: 'Wait for the page to settle' } });
});

test('an assertion that reads another value: for a person to judge, a repair offered to accept it', async () => {
  const triage = await diagnoseFailure({
    stored: { steps: [SIGN_IN, CHECK] }, tabId: 1, sendCommand: fakePage(),
    failed: { step: 2, error: 'Assertion failed', assertionResult: { passed: false, actual: 'Votre avis' }, recheck: async () => ({ passed: false }) },
  });
  assert.equal(triage.cause, 'changed_value');
  assert.equal(triage.proposals[0].needs_review, true);
  assert.equal(triage.proposals[0].change.step.assertion.expected, 'Votre avis');
});

test('an assertion on a typed value the page does not show: the app, not the test', async () => {
  const typed = { ...CHECK, assertion: { ...CHECK.assertion, expected: '{{title}}' } };
  const triage = await diagnoseFailure({
    stored: { steps: [typed] }, tabId: 1, sendCommand: fakePage(),
    failed: { step: 1, error: 'x', hydratedExpected: 'Mon avis', assertionResult: { passed: false, actual: 'Sans titre' } },
  });
  assert.equal(triage.cause, 'app_regression');
  assert.deepEqual(triage.proposals, []);
});

test('an assertion whose element moved: the text it reads is found elsewhere', async () => {
  const triage = await diagnoseFailure({
    stored: { steps: [CHECK] }, tabId: 1,
    sendCommand: fakePage({ refs: [ref('generic', 'Card Mon avis Edit', '.card'), ref('heading', 'Mon avis', '#review-title')] }),
    failed: { step: 1, error: 'x', assertionResult: { passed: false, actual: '(element not found)' } },
  });
  assert.equal(triage.cause, 'test_drift');
  assert.equal(triage.proposals[0].change.step.assertion.selector, '#review-title');
});

test('the steps the extension plays carry their number in the test, assertions in between', () => {
  const steps = [{ command: 'navigate' }, { command: 'assert' }, { command: 'click' }, { command: 'assert' }, { command: 'fill' }];
  const plan = actionPlan(steps, 3);
  assert.deepEqual(plan.actions.map(s => s._originalStepNumber), [1, 3, 5]);
  assert.equal(plan.startIndex, 1);
  assert.equal(actionPlan(steps, 2).startIndex, 1, 'started on an assertion: from the next action');
  assert.equal(actionPlan(steps).startIndex, 0);
});

test('a repair, made on a copy: a step replaced, or a wait inserted before one', () => {
  const stored = { name: 't', steps: [SIGN_IN, CHECK] };
  const insert = { step_order: 2, change: { op: 'insert', step_order: 2, step: { command: 'wait', params: { ms: 1500 } } }, before: CHECK };
  assert.deepEqual(withRepair(stored, insert).steps.map(s => s.command), ['click', 'wait', 'assert']);
  assert.equal(stored.steps.length, 2, 'the saved test is not touched');
  assert.deepEqual(repairDiff(insert), ['insert before step 2: wait {"ms":1500}']);
  const replace = { step_order: 1, before: SIGN_IN, change: { op: 'replace', step_order: 1, step: relocatedStep(SIGN_IN, ref('button', 'Sign in', '#signin-btn')) } };
  assert.equal(withRepair(stored, replace).steps[0].params.selector, '#signin-btn');
  assert.deepEqual(repairDiff(replace), ['selector: "#login-form > div:nth-of-type(3) > button:nth-of-type(1)" → "#signin-btn"']);
});
