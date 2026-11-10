// Unit tests for the bugs a test's run meets (lib/bugs.js): a failure the diagnosis puts on the
// app opens one in the Bugs page; the same failure seen again is the same bug; the test passing
// again, unchanged, marks it fixed. The extension is a stand-in; the database is one of their
// own, thrown away after.
// Run with: node --test test/run-bugs.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'run-bugs-')), 'test.db');
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { saveTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { listBugs, getBug, isAppBug, runBugTitle, formatBug, setBugStatus } = await import('../lib/bugs.js');
const { saveRequirement, linkTest } = await import('../lib/requirements.js');

// A note of exactly the cap, refused at submit: the test waits in vain for it as submitted.
const STEPS = [
  { command: 'navigate', params: { url: 'http://127.0.0.1:5173/' } },
  { command: 'click', params: { selector: '[data-testid=note-submit]' }, intent: 'Soumettre la note' },
  { command: 'wait', params: { selector: '[data-status=submitted]' }, intent: 'La note est soumise' },
];

/** The app, stood in for: the note refused (POST …/submit in 400) while `broken`, submitted when not. */
function app() {
  const state = { broken: true };
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      const results = params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 }));
      const wait = params.steps.findIndex((s) => s.command === 'wait');
      if (state.broken && wait >= 0) {
        results[wait] = { ...results[wait], status: 'failed', error: 'Waited 10 s for [data-status=submitted]: not found' };
        throw Object.assign(new Error(`Step ${wait + 1} failed`), { results });
      }
      return { results };
    }
    if (command === 'network_requests') {
      return { requests: state.broken ? [{ method: 'POST', url: 'http://127.0.0.1:5173/api/notes/137/submit', status: 400, resourceType: 'fetch', timestamp: 1 }] : [] };
    }
    if (command === 'snapshot') return { url: 'http://127.0.0.1:5173/', title: 'Notes de frais', digest: [], refs: {} };
    return {};
  };
  return { sendCommand, state };
}

const run = (name, sendCommand, trigger = 'test') => executeTest(name, {}, null, null, false, sendCommand, trigger).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, ...e, message: e.message }));

test('a failure put on the app opens a bug; seen again, the same; its test passing again, fixed', async () => {
  saveTest({ name: 'cap_equal', variables: {}, steps: STEPS });
  const { sendCommand, state } = app();

  const first = await run('cap_equal', sendCommand);
  assert.equal(first.ok, false);
  assert.equal(first.triage.cause, 'app_regression');
  assert.deepEqual([first.bug.isNew, first.bug.kind, first.bug.status], [true, 'regression', 'open']);
  const bug = getBug(first.bug.id);
  assert.equal(bug.source, 'test');
  assert.equal(bug.repro_test, 'cap_equal');
  assert.equal(bug.title, 'POST /api/notes/*/submit answered 400');
  assert.equal(bug.details.step.order, 3);
  assert.equal(db.prepare('SELECT bug_id FROM test_executions WHERE id = ?').get(first.executionId).bug_id, bug.id, 'the run is linked to it');

  const again = await run('cap_equal', sendCommand);
  assert.deepEqual([again.bug.id, again.bug.isNew, again.bug.occurrences], [bug.id, false, 2], 'the same bug, seen twice');
  assert.equal(listBugs({ status: 'open' }).filter((b) => b.repro_test === 'cap_equal').length, 1);

  state.broken = false;
  const fixedRun = await run('cap_equal', sendCommand);
  assert.equal(fixedRun.ok, true);
  assert.deepEqual(fixedRun.bugs, { fixed: [bug.id], changed: [] });
  assert.deepEqual([getBug(bug.id).status, getBug(bug.id).fixed_execution_id], ['fixed', fixedRun.executionId]);

  // Broken again: the bug opens again, not a new one.
  state.broken = true;
  const back = await run('cap_equal', sendCommand);
  assert.deepEqual([back.bug.id, back.bug.reopened, getBug(bug.id).status, getBug(bug.id).fixed_execution_id], [bug.id, true, 'open', null]);
});

test('a test changed since it met the bug passes: the bug stays open, for a person to check', async () => {
  saveTest({ name: 'cap_changed', variables: {}, steps: STEPS });
  const { sendCommand, state } = app();
  const failed = await run('cap_changed', sendCommand);
  // The wait that failed taken out: the test passes, and checks nothing of the submit any more.
  saveTest({ name: 'cap_changed', variables: {}, steps: STEPS.slice(0, 2) });
  state.broken = false;
  const passed = await run('cap_changed', sendCommand);
  assert.deepEqual(passed.bugs, { fixed: [], changed: [failed.bug.id] });
  const bug = getBug(failed.bug.id);
  assert.equal(bug.status, 'open');
  assert.equal(bug.details.passed_after_change, passed.executionId);
  assert.match(formatBug(bug), /passed in run #\d+, but was changed since the bug was seen: check by hand/);
});

test('a dismissed bug stays dismissed when seen again; a repair being checked opens none', async () => {
  saveTest({ name: 'cap_dismissed', variables: {}, steps: STEPS });
  const { sendCommand } = app();
  const first = await run('cap_dismissed', sendCommand);
  setBugStatus(first.bug.id, 'dismissed');
  const again = await run('cap_dismissed', sendCommand);
  assert.deepEqual([again.bug.id, again.bug.status, again.bug.occurrences], [first.bug.id, 'dismissed', 2]);

  saveTest({ name: 'cap_repair', variables: {}, steps: STEPS });
  const checked = await run('cap_repair', sendCommand, 'repair');
  assert.equal(checked.ok, false);
  assert.equal(checked.bug, undefined);
  assert.equal(listBugs({ status: 'all' }).filter((b) => b.repro_test === 'cap_repair').length, 0);
});

test('a test that checks a requirement: a non-conformity, titled by the criterion it breaks', async () => {
  saveTest({ name: 'cap_required', variables: {}, steps: STEPS });
  const { requirement } = saveRequirement({ key: 'NDF-2', title: 'Plafonds', criteria: ["Une note d'un montant égal au plafond se soumet sans justification."] });
  linkTest(requirement.key, 'cap_required', { criterion: 1 });
  const { sendCommand } = app();
  const failed = await run('cap_required', sendCommand);
  assert.equal(failed.triage.cause, 'non_conformity');
  const bug = getBug(failed.bug.id);
  assert.deepEqual([bug.kind, bug.severity], ['non_conformity', 'high']);
  assert.equal(bug.title, 'NDF-2 criterion 1 not met: POST /api/notes/*/submit answered 400');
  assert.doesNotMatch(bug.details.summary, /the test checks/, "the criteria are kept apart, not said again");
  assert.deepEqual(bug.details.requirements, [{ key: 'NDF-2', title: 'Plafonds', criteria: [{ number: 1, text: "Une note d'un montant égal au plafond se soumet sans justification." }] }]);
});

test('only a failure put on the app, with a reason to, is a bug; its title says what went wrong', () => {
  assert.equal(isAppBug({ cause: 'app_regression', confidence: 'medium' }), true);
  assert.equal(isAppBug({ cause: 'non_conformity', confidence: 'medium' }), true);
  assert.equal(isAppBug({ cause: 'app_regression', confidence: 'low' }), false, 'nothing on the page says the app failed');
  for (const cause of ['test_drift', 'timing', 'changed_value', 'test_outdated', 'session_state', 'environment', 'unknown']) {
    assert.equal(isAppBug({ cause, confidence: 'high' }), false, cause);
  }
  const value = { cause: 'non_conformity', evidence: { expected: '42,50', actual: '05/11/2026 Transport 42,00 € Taxi' } };
  assert.equal(runBugTitle({ triage: value, requirements: [{ key: 'NDF-1', criteria: [{ number: 3 }] }], stepOrder: 13 }),
    'NDF-1 criterion 3 not met: expected "42,50", the page shows "05/11/2026 Transport 42,00 € Taxi"');
  assert.equal(runBugTitle({ triage: { cause: 'app_regression', evidence: {} }, stepOrder: 4, intent: 'La note est soumise' }), 'step 4 (La note est soumise) fails');
});
