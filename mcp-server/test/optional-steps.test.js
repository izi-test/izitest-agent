// A step that may not be done — a cookie banner only shown sometimes —: when it fails on a
// replay, its failure is told and the test goes on; the test passes if the rest does. Kept with
// the step, set by an agent, exported as Playwright. On a database of its own; the extension is a
// stand-in that does what it does: an optional step that fails is "skipped", the others go on.
// Run with: node --test test/optional-steps.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'optional-steps-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { saveTest, loadTest, setStepOptional } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { generatePlaywrightPlain } = await import('../lib/codegen/playwright-plain.js');

const banner = { command: 'click', params: { selector: '#accept-cookies' }, intent: 'Accept the cookies', optional: true };
const shop = (name, check = 'Welcome') => saveTest({
  name,
  steps: [
    { command: 'navigate', params: { url: 'https://shop.test/' }, intent: 'Open the shop' },
    banner,
    { command: 'click', params: { selector: '#login' }, intent: 'Open the login' },
    { command: 'assert', params: {}, intent: 'The page greets', assertion: { type: 'text_contains', selector: 'h1', expected: check } },
  ],
});

/** The extension, the banner not shown: the optional click fails, is "skipped", and the others go on. */
function noBanner() {
  const sent = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'execute_js') return { result: { value: 'Welcome Bob', pageUrl: 'https://shop.test/' } };
    if (command !== 'replay_sequence') return {};
    sent.push(params.steps.map((s) => ({ command: s.command, optional: !!s.optional })));
    return { results: params.steps.map((s, i) => (s.optional
      ? { step: i + 1, command: s.command, status: 'skipped', optional: true, error: 'Optional step not done: Element not found: #accept-cookies', tabId: 3 }
      : { step: i + 1, command: s.command, status: 'success', tabId: 3 })) };
  };
  return { sendCommand, sent };
}

test('kept with the step: saved, read back, and set by an agent', () => {
  shop('kept');
  assert.equal(loadTest('kept').steps[1].optional, true);
  assert.equal(loadTest('kept').steps[2].optional, undefined);
  assert.deepEqual(setStepOptional('kept', 3, true), { command: 'click', intent: 'Open the login' });
  assert.equal(loadTest('kept').steps[2].optional, true);
  setStepOptional('kept', 3, false);
  assert.equal(loadTest('kept').steps[2].optional, undefined);
  assert.equal(setStepOptional('kept', 9, true), null);
});

test('the banner not shown: the test passes, and tells the optional step not done', async () => {
  shop('banner gone');
  const { sendCommand, sent } = noBanner();
  const run = await executeTest('banner gone', {}, null, null, true, sendCommand, 'test');
  assert.deepEqual(sent[0][1], { command: 'click', optional: true }, 'the extension is told the step is optional');
  assert.equal(run.assertionsPassed, 1);
  assert.deepEqual(run.optionalNotDone, [{ step: 2, error: 'Optional step not done: Element not found: #accept-cookies' }]);
  const rows = db.prepare('SELECT step_order, status FROM execution_steps WHERE execution_id = ? ORDER BY step_order').all(run.executionId);
  assert.deepEqual(rows.map((r) => r.status), ['success', 'skipped', 'success', 'success']);
  assert.equal(db.prepare('SELECT status FROM test_executions WHERE id = ?').get(run.executionId).status, 'success');
});

test('an optional check that does not hold is told; a required one fails the test', async () => {
  saveTest({ name: 'optional check', steps: [
    { command: 'navigate', params: { url: 'https://shop.test/' } },
    { command: 'assert', params: {}, intent: 'The promo banner shows', optional: true, assertion: { type: 'text_contains', selector: 'h1', expected: 'Promo' } },
    { command: 'click', params: { selector: '#login' } },
    { command: 'assert', params: {}, intent: 'The page greets', assertion: { type: 'text_contains', selector: 'h1', expected: 'Welcome' } },
  ] });
  const run = await executeTest('optional check', {}, null, null, true, noBanner().sendCommand, 'test');
  assert.equal(run.assertionsFailed, 0, 'not counted as failed');
  assert.equal(run.assertionsPassed, 1);
  assert.match(run.optionalNotDone[0].error, /^Optional check not met: /);
  const check = db.prepare('SELECT status FROM execution_steps WHERE execution_id = ? AND step_order = 2').get(run.executionId);
  assert.equal(check.status, 'skipped');

  shop('required check', 'Goodbye');
  const failed = await executeTest('required check', {}, null, null, true, noBanner().sendCommand, 'test').catch((err) => err);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failedStep, 4);
});

test('exported to Playwright, an optional step is in a try: its failure does not fail the test', () => {
  shop('exported');
  const code = generatePlaywrightPlain(loadTest('exported'));
  assert.match(code, /\/\/ Optional: if this step fails, the test goes on\.\n\s*try \{\n\s*await page\.(?:click|locator)\([^\n]*accept-cookies[^\n]*\n\s*\} catch \{\}/);
});
