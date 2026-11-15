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
const { saveTest: saveTestOnly } = await import('../lib/test-store.js');
const { createProject } = await import('../lib/projects.js');
// The tests here are those of a project that opens bugs by itself (auto_bugs; off by default).
const shop = createProject({ name: 'Bugs by themselves', auto_bugs: true });
const saveTest = (test) => {
  const id = saveTestOnly(test);
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(shop.id, test.name);
  return id;
};
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

// An identity portal, 2026-11-12: on every page, requests fail that say nothing of a test's failure —
// the manifest in 404, Pendo's and Cloudflare's analytics a proxy blocks, the app's own
// personalizations in 404. 8 bugs were opened in a day for failures of the test or of its replay,
// each titled after one of them ("REQ-38 not met: GET /manifest.json answered 404") and rated high.
const { stepsHash } = await import('../lib/bugs.js');
const PORTAL = 'https://portal-int.idcloud.example';
const PORTAL_STEPS = [
  { command: 'navigate', params: { url: `${PORTAL}/ECM/` }, intent: 'Open the portal' },
  { command: 'click', params: { selector: 'a.create-user' }, intent: 'Open Create User Request' },
];

/** The portal, stood in for: the replay loses the link while `lost`; the same requests fail either way. */
function portal({ alerts = [] } = {}) {
  const state = { lost: false };
  const noise = () => {
    const t = Date.now();
    return [
      { method: 'GET', url: `${PORTAL}/manifest.json?host_version_cache=ea788f4ff9`, status: 404, resourceType: 'manifest', timestamp: t + 1 },
      { method: 'GET', url: 'https://cdn.pendo.io/agent/static/null/pendo.js', status: 0, statusText: 'net::ERR_CONNECTION_RESET', resourceType: 'script', timestamp: t + 2 },
      { method: 'GET', url: 'https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092', status: 0, resourceType: 'script', timestamp: t + 3 },
      { method: 'GET', url: `${PORTAL}/ECMv6/api/idw/personalizations/1`, status: 404, resourceType: 'fetch', timestamp: t + 4 },
    ].reverse();
  };
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      const results = params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 9 }));
      const click = params.steps.findIndex((s) => s.command === 'click');
      if (state.lost && click >= 0) {
        results[click] = { ...results[click], status: 'failed', error: 'Element not found: Create User Request' };
        throw Object.assign(new Error(`Step ${click + 1} failed`), { results });
      }
      return { results };
    }
    if (command === 'network_requests') return { requests: noise() };
    if (command === 'snapshot') return { url: `${PORTAL}/ECM/workflowmanagement/createupdateuserrequestfirststep`, title: 'PORTAL', digest: alerts, refs: {} };
    return {};
  };
  return { sendCommand, state };
}

test('PORTAL: requests that failed on the last passing run of the same steps too open no bug', async () => {
  saveTest({ name: 'portal_create_user', variables: {}, steps: PORTAL_STEPS });
  const { sendCommand, state } = portal();
  const passed = await run('portal_create_user', sendCommand);
  assert.equal(passed.ok, true);
  const kept = JSON.parse(db.prepare('SELECT footprint FROM test_executions WHERE id = ?').get(passed.executionId).footprint);
  assert.deepEqual(kept.failed, ['GET /*/api/idw/personalizations/* 404', 'GET /agent/static/null/pendo.js 0', 'GET /beacon.min.js/* 0', 'GET /manifest.json 404'], 'the requests that failed while it passed');
  assert.equal(kept.steps_hash, stepsHash(PORTAL_STEPS));

  state.lost = true;
  const failed = await run('portal_create_user', sendCommand);
  assert.equal(failed.ok, false);
  assert.deepEqual([failed.triage.cause, failed.triage.confidence], ['unknown', 'low']);
  assert.deepEqual(failed.triage.evidence.page.failedRequests, []);
  assert.match(failed.triage.evidence.page.ignoredRequests.at(-1).ignored, new RegExp(`failed the same way on run #${passed.executionId}, which passed`));
  assert.equal(failed.bug, undefined);
  assert.equal(listBugs({ status: 'all' }).filter((b) => b.repro_test === 'portal_create_user').length, 0);
});

test('PORTAL, steps changed since the last pass: the app\'s API in 404 counts again — the bug is titled by it, not by the manifest, and not rated high for the analytics', async () => {
  saveTest({ name: 'portal_changed', variables: {}, steps: PORTAL_STEPS });
  const { sendCommand, state } = portal();
  assert.equal((await run('portal_changed', sendCommand)).ok, true);
  // The link's selector changed: what failed on the run before is not known of these steps.
  saveTest({ name: 'portal_changed', variables: {}, steps: [PORTAL_STEPS[0], { ...PORTAL_STEPS[1], params: { selector: 'a#create-user' } }] });
  state.lost = true;
  const failed = await run('portal_changed', sendCommand);
  assert.deepEqual([failed.triage.cause, failed.triage.confidence], ['app_regression', 'medium']);
  const bug = getBug(failed.bug.id);
  assert.equal(bug.title, 'GET /*/api/idw/personalizations/* answered 404');
  assert.equal(bug.severity, 'medium', 'Pendo and Cloudflare with no answer are other sites\': they made it high');
  assert.deepEqual(bug.details.failed_requests.map((r) => r.status), [404]);
});

test('PORTAL, the page says something went wrong: a bug titled by its step, never by a request set aside', async () => {
  saveTest({ name: 'portal_alert', variables: {}, steps: PORTAL_STEPS });
  const { sendCommand, state } = portal({ alerts: ['alert: An error occurred'] });
  assert.equal((await run('portal_alert', sendCommand)).ok, true);
  state.lost = true;
  const failed = await run('portal_alert', sendCommand);
  assert.deepEqual([failed.triage.cause, failed.triage.confidence], ['app_regression', 'medium']);
  const bug = getBug(failed.bug.id);
  assert.equal(bug.title, 'step 2 (Open Create User Request) fails');
  assert.deepEqual([bug.severity, bug.details.failed_requests], ['medium', []]);
});
