// A failed test opens a bug by itself only when its project says so (auto_bugs, off by default):
// otherwise a person reads the run and reports the bug from it. A test that reproduces a reported
// bug still shows that bug, and a bug is still marked fixed when its test passes again.
// On a database of its own; the extension is a stand-in.
// Run with: node --test test/manual-bugs.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'manual-bugs-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
process.env.IZITEST_RUN_VIDEO = 'off';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { createProject, autoBugsFor } = await import('../lib/projects.js');
const { saveTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { recordRunBug, getBug } = await import('../lib/bugs.js');

/** A shop whose welcome message is gone: the diagnosis puts it on the app. */
function shopTest(name, projectId) {
  saveTest({ name, steps: [
    { command: 'navigate', params: { url: 'https://shop.test/' }, intent: 'Open the shop' },
    { command: 'assert', params: {}, intent: 'The shop greets', assertion: { type: 'text_contains', selector: 'h1', expected: 'Welcome' } },
  ] });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(projectId, name);
}
const extension = async (_p, command, params) => {
  if (command === 'execute_js') return { result: { value: 'Server error 500', pageUrl: 'https://shop.test/' } };
  if (command === 'replay_sequence') return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 4 })) };
  return {};
};
const run = (name) => executeTest(name, {}, null, null, true, extension, 'test').catch((err) => err);
const bugsOf = (projectId) => db.prepare('SELECT * FROM bugs WHERE project_id = ?').all(projectId);
// The diagnosis, as the triage gives it for a page that shows something else.
const onTheApp = { cause: 'app_regression', confidence: 'medium', summary: 'The page shows an error', evidence: { expected: 'Welcome', actual: 'Server error 500', page: { url: 'https://shop.test/' } } };

test('a new project opens no bug by itself; ticked, it does', () => {
  const manual = createProject({ name: 'Manual shop' });
  assert.equal(autoBugsFor(manual.id), false, 'off by default');
  assert.equal(recordRunBug({ testName: 'x', projectId: manual.id, executionId: 1, stepOrder: 2, triage: onTheApp, auto: autoBugsFor(manual.id) }), null);
  const auto = createProject({ name: 'Auto shop', auto_bugs: true });
  assert.equal(autoBugsFor(auto.id), true);
});

test('a failed run of a manual project opens no bug, and says one may be reported; reported from it, it is linked', async () => {
  const project = createProject({ name: 'Shop' });
  shopTest('greets', project.id);
  const failed = await run('greets');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.bug, undefined);
  assert.deepEqual(bugsOf(project.id), []);

  // Reported by a person: from what the run knows, whatever its diagnosis.
  const triage = { cause: 'test_drift', confidence: 'medium', summary: 'h1 is not on the page', evidence: { expected: 'Welcome', actual: 'Server error 500', page: { url: 'https://shop.test/' } } };
  const reported = recordRunBug({ testName: 'greets', projectId: project.id, executionId: failed.executionId, stepOrder: 2, triage, manual: true });
  assert.equal(reported.isNew, true);
  assert.equal(getBug(reported.bug.id).repro_test, 'greets', 'its test confirms the fix when it passes');
  assert.equal(db.prepare('SELECT bug_id FROM test_executions WHERE id = ?').get(failed.executionId).bug_id, reported.bug.id);
});

test('a project that opens bugs by itself still does, when the diagnosis puts the failure on the app', () => {
  const project = createProject({ name: 'Auto shop 2', auto_bugs: true });
  shopTest('greets auto', project.id);
  const opened = recordRunBug({ testName: 'greets auto', projectId: project.id, executionId: 9001, stepOrder: 2, triage: onTheApp, auto: autoBugsFor(project.id) });
  assert.equal(opened.isNew, true);
  assert.equal(recordRunBug({ testName: 'greets auto', projectId: project.id, executionId: 9002, stepOrder: 2, triage: { ...onTheApp, cause: 'test_drift' }, auto: true }), null,
    'not when the diagnosis puts it on the test');
});
