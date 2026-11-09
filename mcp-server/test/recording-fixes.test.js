// Unit tests for what the agent writing the expense-notes tests ran into while recording: the last
// action sent with stop_recording, lost; the variable names given with record_step, ignored; a
// variable recording made, that add_test_variable would not name; and a login step failing on a
// page already logged in, that the triage could not explain. On a database of their own.
// Run with: node --test test/recording-fixes.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'recording-fixes-')), 'test.db');
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { createAdHocSession, currentSession } = await import('../lib/session.js');
const { scopeToolsToSession, settleActions } = await import('../lib/tools/session-scope.js');
const { recordAction } = await import('../lib/recording.js');
const { variabilizeInput } = await import('../lib/variable-detection.js');
const { addTestVariable } = await import('../lib/test-variable.js');
const { diagnoseFailure, isLoginStep, looksLoggedIn } = await import('../lib/triage.js');

test('stop_recording sent with an action, in the same message: the action is recorded first', async () => {
  const session = createAdHocSession('rec');
  session.recording = { name: 't', steps: [], startedAt: Date.now() };
  const handlers = {};
  const server = { tool: (name, _description, _shape, handler) => { handlers[name] = handler; } };
  scopeToolsToSession(server, () => session);
  server.tool('wait', 'd', { selector: {} }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    recordAction(currentSession(), 'wait', { selector: '#row' });
    return { content: [] };
  });
  server.tool('stop_recording', 'd', {}, async () => {
    await settleActions(currentSession());
    return { steps: currentSession().recording.steps.length };
  });
  const [, stopped] = await Promise.all([handlers.wait({}), handlers.stop_recording({})]);
  assert.equal(stopped.steps, 1, 'the wait is in the test');
  assert.equal(session.inFlight.size, 0);
  assert.match(session.recording.steps[0]._actionId, /^act_\d+$/, 'the step knows its action, for record_step');
});

test('a wait for an element at the end is kept — it checks what the test did; one of a time only is not, and is told', async () => {
  const { cleanRecoverySteps } = await import('../lib/tools/test.js');
  const created = [
    { command: 'navigate', params: { url: 'http://127.0.0.1:5173/' } },
    { command: 'click', params: { selector: '[data-testid=note-save]' } },
    { command: 'wait', params: { selector: 'tr[data-description="Taxi"]' } },
  ];
  assert.deepEqual(cleanRecoverySteps(created), { steps: created, removed: [] });
  const settled = [...created, { command: 'wait', params: { ms: 1500 } }];
  const { steps, removed } = cleanRecoverySteps(settled);
  assert.equal(steps.length, 3);
  assert.deepEqual(removed, ['a wait of 1500 ms at the end (it checks nothing)']);
  const again = [created[0], created[1], { command: 'navigate', params: { url: 'http://127.0.0.1:5173/' } }];
  assert.deepEqual(cleanRecoverySteps(again).removed, ['a navigate repeated (http://127.0.0.1:5173/)']);
});

test('the name given with record_step is the variable\'s; skip_variable keeps the value fixed', () => {
  const named = { command: 'fill', params: { selector: '[data-testid=login-email]', value: 'employe@example.com' }, _variableNameOverride: 'email' };
  const used = new Set();
  assert.equal(variabilizeInput(named, 1, used), true);
  assert.deepEqual([named.variable.name, named.params.value], ['email', '{{email}}']);
  const again = { command: 'fill', params: { selector: '#e2', value: 'x@y.z' }, _variableNameOverride: 'email' };
  variabilizeInput(again, 2, used);
  assert.equal(again.variable.name, 'email_2', 'still unique');
  const fixed = { command: 'fill', params: { selector: '#q', value: 'transport' }, _skipVariable: true };
  assert.equal(variabilizeInput(fixed, 3, used), false);
  assert.equal(fixed.params.value, 'transport');
});

test('a variable recording made is renamed, everywhere the test uses it, and given its default', () => {
  const recorded = {
    name: 'ndf', variables: { input_9: { type: 'text', defaultValue: 'Taxi e2e-rec1', step: 2 }, input_2: { type: 'text', defaultValue: 'a@b.c', step: 1 } },
    steps: [
      { command: 'fill', params: { selector: '#email', value: '{{input_2}}' }, variable: { name: 'input_2', type: 'text', defaultValue: 'a@b.c' } },
      { command: 'fill', params: { selector: '#desc', value: '{{input_9}}' }, variable: { name: 'input_9', type: 'text', defaultValue: 'Taxi e2e-rec1' } },
      { command: 'wait', params: { selector: 'tr[data-description="{{input_9}}"]' }, intent: 'Wait for {{ input_9 }}' },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#list', expected: '{{input_9 | upper}} ({{input_2}})' } },
    ],
  };
  const { test: renamed, renamed: from, error } = addTestVariable(recorded, { step: 2, param: 'value', name: 'description', defaultValue: 'Taxi e2e-{{unique}}', description: 'Unique at each run' });
  assert.equal(error, undefined);
  assert.equal(from, 'input_9');
  assert.deepEqual(Object.keys(renamed.variables).sort(), ['description', 'input_2']);
  assert.equal(renamed.variables.description.defaultValue, 'Taxi e2e-{{unique}}');
  assert.equal(renamed.variables.description.description, 'Unique at each run');
  assert.equal(renamed.steps[1].params.value, '{{description}}');
  assert.equal(renamed.steps[1].variable.name, 'description');
  assert.equal(renamed.steps[2].params.selector, 'tr[data-description="{{description}}"]');
  assert.equal(renamed.steps[2].intent, 'Wait for {{ description }}');
  assert.equal(renamed.steps[3].assertion.expected, '{{description | upper}} ({{input_2}})');
  assert.match(addTestVariable(recorded, { step: 2, param: 'value', name: 'input_2' }).error, /\{\{input_2\}\} is already a variable of test "ndf"/);
  assert.equal(addTestVariable(recorded, { step: 2, param: 'value', name: 'input_9', defaultValue: 'x-{{unique}}' }).test.variables.input_9.defaultValue, 'x-{{unique}}', 'its own name: only its default');
});

test('a login step failing on a page that offers to log out: the browser was already logged in', async () => {
  const steps = [
    { command: 'navigate', params: { url: 'http://127.0.0.1:5173/' } },
    { command: 'fill', params: { selector: '[data-testid=login-email]', value: '{{email}}' }, locators: [{ type: 'css', value: '[data-testid=login-email]' }] },
    { command: 'fill', params: { selector: '[data-testid=login-password]', value: '{{secret.EMPLOYEE_PASSWORD}}' } },
    { command: 'click', params: { selector: '[data-testid=login-submit]' } },
    { command: 'fill', params: { selector: '#note-amount', value: '64' } },
  ];
  assert.equal(isLoginStep(steps, 2), true);
  assert.equal(isLoginStep(steps, 5), false);
  const loggedIn = { e1: { role: 'button', name: 'Se déconnecter', selector: '[data-testid=logout-button]' }, e2: { role: 'textbox', name: 'Montant', selector: '#note-amount' } };
  assert.equal(looksLoggedIn(loggedIn).name, 'Se déconnecter');
  assert.equal(looksLoggedIn({ ...loggedIn, e3: { role: 'textbox', name: 'Mot de passe', selector: '#password' } }), null, 'a login form shown');

  const page = async (_profile, command) => {
    if (command === 'network_requests') return { requests: [] };
    if (command === 'snapshot') return { url: 'http://127.0.0.1:5173/', title: 'Notes', digest: [], refs: loggedIn };
    throw new Error(command);
  };
  const triage = await diagnoseFailure({
    stored: { name: 'ndf', steps }, tabId: 1, sendCommand: page,
    failed: { step: 2, error: 'All 1 locators failed:\ncss="[data-testid=login-email]" (not found)' },
  });
  assert.equal(triage.cause, 'session_state');
  assert.match(triage.summary, /already logged in.*Se déconnecter|Se déconnecter.*already logged in/s);
  assert.deepEqual(triage.proposals, []);
});
