// Unit tests for where an assertion is checked: in its place in the test when an action
// follows it — on the page the steps before led to —, after the last action otherwise. Checked
// after the last action, one on an employee's page before the test went to a manager's read the
// manager's page, and failed. The extension is a stand-in whose page is the last one navigated
// to. On a database of its own, thrown away after.
// Run with: node --test test/assertion-order.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'assertion-order-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '300';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { saveTest } = await import('../lib/test-store.js');
const { executeTest, actionPlan, assertionsInPlace } = await import('../lib/test-execute.js');

/** The extension, stood in for: the segments it played, and a page saying whose it is. */
function extension() {
  const segments = [];
  const checkedOn = [];
  let page = 'blank';
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      segments.push(params.steps.map((s) => s.command));
      for (const s of params.steps) if (s.command === 'navigate') page = s.params.url.split('/').pop();
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 })) };
    }
    if (command === 'execute_js') {
      checkedOn.push(page);
      return { result: { value: `Signed in as ${page}`, pageUrl: `https://app.test/${page}` } };
    }
    return {};
  };
  return { sendCommand, segments, checkedOn };
}

const says = (expected) => ({ command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#who', expected } });
const go = (where) => ({ command: 'navigate', params: { url: `https://app.test/${where}` } });

test('an assertion with an action after it is checked in its place; the last ones after the last action', () => {
  const steps = [go('employee'), says('employee'), go('manager'), { command: 'click', params: { selector: '#approve' } }, says('manager'), says('Signed')];
  const inPlace = assertionsInPlace(steps);
  assert.deepEqual([...inPlace], [1]);
  assert.deepEqual(actionPlan(steps, null, inPlace).actions.map((s) => s._originalStepNumber), [1, 2, 3, 4]);
  assert.deepEqual(actionPlan(steps, null).actions.map((s) => s._originalStepNumber), [1, 3, 4], 'without them: the actions only');
  assert.equal(actionPlan(steps, 2, inPlace).startIndex, 1, 'started on it: from it');
});

test('a check on the employee page, then the manager page: each on its own page', async () => {
  saveTest({
    name: 'two_pages', variables: {},
    steps: [go('employee'), says('employee'), go('manager'), { command: 'click', params: { selector: '#approve' } }, says('manager')],
  });
  const { sendCommand, segments, checkedOn } = extension();
  const result = await executeTest('two_pages', {}, null, null, true, sendCommand, 'test');
  assert.deepEqual(segments, [['navigate'], ['navigate', 'click']], 'played up to the assertion, then the rest');
  assert.deepEqual(checkedOn, ['employee', 'manager']);
  assert.equal(result.assertionsPassed, 2);
  const rows = db.prepare('SELECT step_order, status FROM execution_steps WHERE execution_id = ? ORDER BY step_order').all(result.executionId);
  assert.deepEqual(rows.map((r) => r.status), ['success', 'success', 'success', 'success', 'success']);
});

test('a check that fails in its place stops the test there, told as the failed step', async () => {
  saveTest({
    name: 'wrong_page', variables: {},
    steps: [go('employee'), says('manager'), go('manager'), says('manager')],
  });
  const { sendCommand, segments } = extension();
  const err = await executeTest('wrong_page', {}, null, null, true, sendCommand, 'repair').catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /expected text for selector "#who" to contain "manager"/);
  assert.equal(err.failedStep, 2);
  assert.equal(err.assertionsFailed, 1);
  assert.deepEqual(segments, [['navigate']], 'nothing played after it');
  const rows = db.prepare('SELECT status FROM execution_steps WHERE execution_id = ? ORDER BY step_order').all(err.executionId);
  assert.deepEqual(rows.map((r) => r.status), ['success', 'failed', 'pending', 'pending']);
});

test('a test with its assertions at the end is played in one go, as before', async () => {
  saveTest({ name: 'at_the_end', variables: {}, steps: [go('employee'), go('manager'), says('manager'), says('Signed')] });
  const { sendCommand, segments } = extension();
  const result = await executeTest('at_the_end', {}, null, null, true, sendCommand, 'test');
  assert.deepEqual(segments, [['navigate', 'navigate']]);
  assert.equal(result.assertionsPassed, 2);
});

test('a replay that stops on its own (timed out, its browser gone) is told why', async () => {
  saveTest({ name: 'browser_gone', variables: {}, steps: [go('employee'), says('employee')] });
  const sendCommand = async (_profile, command) => {
    if (command === 'replay_sequence') throw new Error('The browser of profile "headless-2" disconnected while it ran replay_sequence');
    return {};
  };
  const err = await executeTest('browser_gone', {}, null, null, true, sendCommand, 'repair').catch((e) => e);
  assert.match(err.message, /disconnected while it ran replay_sequence/);
  assert.match(db.prepare('SELECT error FROM test_executions WHERE id = ?').get(err.executionId).error, /disconnected/);
});
