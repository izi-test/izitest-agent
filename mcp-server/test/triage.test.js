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

test('a request that failed, then answered: no error of the page; one still failing is', async () => {
  const { failuresOf } = await import('../lib/triage.js');
  // As the extension lists them: the most recent first, with their time.
  const at = (t, method, path, status) => ({ method, url: `http://127.0.0.1:5173${path}`, status, timestamp: t });
  const requests = [
    at(6, 'GET', '/favicon.ico', 404),
    at(5, 'POST', '/api/notes', 500),
    at(4, 'GET', '/api/report', 503),
    at(3, 'GET', '/api/report', 200),
    at(2, 'POST', '/api/auth/login', 200),
    at(1, 'GET', '/api/auth/me', 401),
  ];
  assert.deepEqual(failuresOf(requests).map((r) => `${r.method} ${r.url} ${r.status}`), [
    'GET http://127.0.0.1:5173/api/report 503',
    'POST http://127.0.0.1:5173/api/notes 500',
  ], 'the 401 before the login is not; a 503 after a 200 of the same URL still is');
  // Logged out for good: every later request of the site refused too.
  assert.equal(failuresOf([at(2, 'GET', '/api/notes', 401), at(1, 'GET', '/api/auth/me', 401)]).length, 2);
});

test('the requirement now says what the page shows: the test is behind it, not the app', async () => {
  const { againstRequirements } = await import('../lib/triage.js');
  const changed = {
    cause: 'changed_value', confidence: 'low', summary: 'Expected "Brouillon", the page shows "À soumettre"',
    evidence: { expected: 'Brouillon', actual: 'À soumettre' },
    proposals: [{ kind: 'expect', needs_review: true, summary: 'Expect "À soumettre" in step 12, if this change is intended' }],
  };
  const requirement = (text) => [{ key: 'NDF-1', title: 'Notes', criteria: [{ number: 3, text }] }];
  const now = againstRequirements(changed, requirement('Un employé crée une note : elle apparaît avec le statut « À soumettre ».'));
  assert.equal(now.cause, 'test_outdated');
  assert.equal(now.confidence, 'high');
  assert.match(now.summary, /NDF-1 criterion 3 says "À soumettre" now: the test is behind its requirement/);
  assert.deepEqual(now.proposals.map((p) => [p.kind, p.needs_review, p.summary]), [['expect', false, 'Expect "À soumettre" in step 12, as NDF-1 says']]);
  // The requirement still says the expected value: the app does not do what it asks.
  const before = againstRequirements(changed, requirement('Un employé crée une note : elle apparaît avec le statut Brouillon.'));
  assert.equal(before.cause, 'non_conformity');
  assert.deepEqual(before.proposals, []);
  // A word of the value inside another word is not the value.
  assert.equal(againstRequirements({ ...changed, evidence: { expected: 'Brouillon', actual: 'mise' } }, requirement('Une note soumise')).cause, 'non_conformity');
});

test('the expense-notes case, end to end: a 401 before the login is no error, the requirement says the new label', async () => {
  const STATUS = { command: 'assert', params: {}, intent: 'La note créée a le statut À soumettre', assertion: { type: 'text_equals', selector: '[data-testid=note-status]', expected: 'Brouillon' } };
  const page = fakePage({
    refs: [ref('generic', 'À soumettre', '[data-testid=note-status]')],
    requests: [
      { method: 'GET', url: 'http://127.0.0.1:5173/api/notes', status: 201, timestamp: 3 },
      { method: 'POST', url: 'http://127.0.0.1:5173/api/auth/login', status: 200, timestamp: 2 },
      { method: 'GET', url: 'http://127.0.0.1:5173/api/auth/me', status: 401, timestamp: 1 },
    ],
  });
  const triage = await diagnoseFailure({
    stored: { name: 'ndf', steps: [{ command: 'navigate', params: { url: 'http://127.0.0.1:5173/' } }, STATUS] }, tabId: 1, sendCommand: page,
    failed: { step: 2, error: 'x', assertionResult: { passed: false, actual: 'À soumettre' }, recheck: async () => ({ passed: false }) },
    requirements: [{ key: 'NDF-1', title: 'Notes', criteria: [{ number: 3, text: 'Elle apparaît dans sa liste avec le statut « À soumettre ».' }] }],
  });
  assert.equal(triage.cause, 'test_outdated');
  assert.deepEqual(triage.evidence.page.failedRequests, [], 'the 401 was the session checked before the login');
  assert.doesNotMatch(triage.summary, /reports an error/);
  assert.equal(triage.proposals[0].change.step.assertion.expected, 'À soumettre');
});

// The expense-notes cap bug: a note of exactly the cap (200 €) refused at submit (POST …/submit
// in 400). The test waits for its row as submitted, then checks it on the manager's page.
const ROW = 'tr[data-testid=review-row][data-description="{{description}}"]';
const SUBMIT_REFUSED = { method: 'POST', url: 'http://127.0.0.1:5173/api/notes/111/submit', status: 400, resourceType: 'fetch', timestamp: 2 };
const NDF_2 = [{ key: 'NDF-2', title: 'Plafonds par catégorie', criteria: [{ number: 3, text: "Une note d'un montant égal au plafond se soumet sans justification." }] }];

test('the values a selector took in the run: the record the step looks at', async () => {
  const { pinnedValues, reported } = await import('../lib/triage.js');
  assert.deepEqual(pinnedValues(`${ROW} [data-testid=review-status]`, 'tr[data-testid=review-row][data-description="Train e2e-l8a"] [data-testid=review-status]'),
    [{ name: 'description', value: 'Train e2e-l8a' }]);
  assert.deepEqual(pinnedValues('#total', '#total'), [], 'no variable');
  assert.deepEqual(pinnedValues(ROW, '#other'), [], 'not the same selector');
  assert.deepEqual(pinnedValues('[data-id="{{id}}"]', '[data-id="7"]'), [], 'too short to tell a record by');
  assert.equal(reported({ failedRequests: [SUBMIT_REFUSED] }), ' — and POST /api/notes/111/submit answered 400');
  assert.equal(reported({ alerts: ['alert: Note hors plafond'] }), ' — and the page says "Note hors plafond"');
  assert.equal(reported({}), '');
});

test('a wait for what never came, while a request was refused: the app, and the requirement it breaks', async () => {
  const WAIT = { command: 'wait', params: { selector: 'tr[data-testid=note-row][data-description="{{description}}"][data-status=submitted]' } };
  const triage = await diagnoseFailure({
    stored: { steps: [{ command: 'click', params: { selector: '[data-testid=note-submit]' } }, WAIT] }, tabId: 1,
    sendCommand: fakePage({ refs: [ref('button', 'Soumettre', 'tr:nth-of-type(1) [data-testid=note-submit]')], requests: [SUBMIT_REFUSED] }),
    failed: {
      step: 2, error: 'Waited 10 s for tr[data-testid=note-row][data-description="Train e2e-l8a"][data-status=submitted]: not found',
      hydratedSelector: 'tr[data-testid=note-row][data-description="Train e2e-l8a"][data-status=submitted]',
      onPage: async () => true, // the note's row is there, not submitted
    },
    requirements: NDF_2,
  });
  assert.equal(triage.cause, 'non_conformity');
  assert.match(triage.summary, /^Step 2 waited for tr\[data-testid=note-row\]\[data-description="\{\{description\}\}"\]\[data-status=submitted\], which never came, and nothing on the page looks like it — and POST \/api\/notes\/111\/submit answered 400 — the test checks NDF-2 \(Plafonds par catégorie, criterion 3: /);
  assert.deepEqual(triage.proposals, []);
  // Without a requirement: a suspected regression, still nothing to repair.
  const alone = await diagnoseFailure({
    stored: { steps: [{ command: 'click', params: {} }, WAIT] }, tabId: 1, sendCommand: fakePage({ requests: [SUBMIT_REFUSED] }),
    failed: { step: 2, error: 'Waited 10 s for x: not found', onPage: async () => true },
  });
  assert.deepEqual([alone.cause, alone.confidence, alone.proposals], ['app_regression', 'medium', []]);
});

test('an assertion on the row of a note the page does not show: not another row\'s status, the app', async () => {
  const STATUS = { command: 'assert', assertion: { type: 'text_equals', selector: `${ROW} [data-testid=review-status]`, expected: 'Soumise' } };
  // Before waits failed: the replay went on to the manager's page, where other notes are "Soumise".
  const badges = [1, 2, 3].map((n) => ref('generic', 'Soumise', `[data-testid="review-table"] tbody > tr:nth-of-type(${n}) > td:nth-of-type(6) > span.badge`));
  const asked = [];
  const triage = await diagnoseFailure({
    stored: { steps: [STATUS] }, tabId: 1, sendCommand: fakePage({ refs: badges, requests: [SUBMIT_REFUSED] }),
    failed: {
      step: 1, error: 'x', assertionResult: { passed: false, actual: '(element not found)' },
      hydratedSelector: 'tr[data-testid=review-row][data-description="Train e2e-l8a"] [data-testid=review-status]',
      onPage: async (value) => { asked.push(value); return false; },
    },
  });
  assert.deepEqual(asked, ['Train e2e-l8a']);
  assert.equal(triage.cause, 'app_regression');
  assert.equal(triage.confidence, 'medium');
  assert.match(triage.summary, /looks for "Train e2e-l8a" \(\{\{description\}\}\), a value of this run, and the page does not show it — and POST \/api\/notes\/111\/submit answered 400$/);
  assert.deepEqual(triage.proposals, [], 'no repair pointing it at the first row of the table');
});

test('the text an assertion reads, in several elements alike: none is picked', async () => {
  const badges = [1, 2, 3].map((n) => ref('generic', 'Soumise', `tbody > tr:nth-of-type(${n}) .badge`));
  const STATUS = { command: 'assert', assertion: { type: 'text_equals', selector: '#note-status', expected: 'Soumise' } };
  const triage = await diagnoseFailure({
    stored: { steps: [STATUS] }, tabId: 1, sendCommand: fakePage({ refs: badges }),
    failed: { step: 1, error: 'x', assertionResult: { passed: false, actual: '(element not found)' } },
  });
  assert.equal(triage.cause, 'unknown');
  assert.equal(triage.summary, '#note-status is not on the page; "Soumise" is, in 3 elements alike, none clearly the one it read');
  assert.deepEqual(triage.proposals, []);
  // The record the step looks at is on the page, and one element alone shows the text: moved.
  const pinned = { command: 'assert', assertion: { type: 'text_equals', selector: `${ROW} .status`, expected: 'Soumise' } };
  const moved = await diagnoseFailure({
    stored: { steps: [pinned] }, tabId: 1, sendCommand: fakePage({ refs: [ref('generic', 'Soumise', `${ROW.replace('{{description}}', 'Train e2e-l8a')} .state`)] }),
    failed: {
      step: 1, error: 'x', assertionResult: { passed: false, actual: '(element not found)' },
      hydratedSelector: 'tr[data-testid=review-row][data-description="Train e2e-l8a"] .status', onPage: async () => true,
    },
  });
  assert.equal(moved.cause, 'test_drift');
  assert.equal(moved.proposals[0].kind, 'relocate');
});
