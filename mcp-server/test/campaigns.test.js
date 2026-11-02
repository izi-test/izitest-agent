// Unit tests for campaigns (lib/campaigns.js): the tests a scope stands for, a campaign run a
// few at a time — each test in its window, closed after —, stopped, compared with the last
// one of the same tests, its requirements criterion by criterion, and its JUnit and HTML
// reports. The extension is a stand-in: a replay succeeds, and the page shows "Welcome" in
// #ok and "Oops" anywhere else. On a database of their own, thrown away after.
// Run with: node --test test/campaigns.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'campaigns-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTest, deleteTest } = await import('../lib/test-store.js');
const { saveRequirement, linkTest } = await import('../lib/requirements.js');
const {
  testsOfScope, startCampaign, stopCampaign, getCampaign, listCampaigns, closeInterruptedCampaigns, formatCampaign, junitReport, htmlReport,
} = await import('../lib/campaigns.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;

/** A test that opens a page and checks `selector` shows "Welcome". */
function addTest(name, selector) {
  saveTest({
    name, variables: {},
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test' }, intent: 'Open the shop' },
      { command: 'assert', params: {}, intent: `${selector} says Welcome`, assertion: { type: 'text_contains', selector, expected: 'Welcome' } },
    ],
  });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
}

/** The extension, stood in for: what it was asked, and a replay that waits for `gate` when given one. */
function extension({ gate } = {}) {
  const calls = [];
  let nextTab = 100;
  const sendCommand = async (_profile, command, params) => {
    calls.push({ command, params });
    if (command === 'replay_sequence') {
      if (gate) await gate();
      const tabId = nextTab++;
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId })), durationMs: 5 };
    }
    if (command === 'execute_js') return { result: params.code.includes('#ok') ? 'Welcome' : 'Oops' };
    return {};
  };
  return { sendCommand, calls };
}

addTest('login', '#ok');
addTest('search', '#ok');
addTest('checkout', '#ko');

test('the tests a scope stands for: a list, a requirement\'s, a project\'s', () => {
  assert.deepEqual(testsOfScope({ tests: ['login', 'login', 'search'] }), ['login', 'search']);
  assert.throws(() => testsOfScope({ tests: ['login', 'nope'] }), /No test "nope"/);
  assert.deepEqual(testsOfScope({ projectId: project }), ['checkout', 'login', 'search']);
  const { requirement } = saveRequirement({ key: 'SHOP-1', title: 'Buying works', projectId: project, criteria: ['One can log in', 'One can pay', 'One can get a refund'] });
  linkTest(requirement.key, 'login', { criterion: 1 });
  linkTest(requirement.key, 'checkout', { criterion: 2 });
  assert.deepEqual(testsOfScope({ requirement: 'SHOP-1' }).sort(), ['checkout', 'login']);
  assert.throws(() => testsOfScope({}), /needs its tests/);
  assert.throws(() => startCampaign({ projectId: 999 }, extension()), /No test to run/);
});

test('a campaign runs its tests a few at a time, each in its window, closed after; the report says how each did', async () => {
  const { sendCommand, calls } = extension();
  const { campaign, finished } = startCampaign({ projectId: project, version: '1.0', concurrency: 2 }, { sendCommand });
  assert.equal(campaign.running, true);
  assert.equal(campaign.name, 'Shop');
  await finished;
  const done = getCampaign(campaign.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.runs.map((t) => [t.name, t.status]), [['checkout', 'failed'], ['login', 'passed'], ['search', 'passed']]);
  assert.deepEqual([done.totals.passed, done.totals.failed, done.total], [2, 1, 3]);
  assert.match(done.runs[0].error, /Assertion failed|Welcome/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM test_executions WHERE campaign_id = ? AND trigger = 'campaign'").get(done.id).n, 3);
  // Each replay in a new window, in the campaign's own session; each window closed.
  const replays = calls.filter((c) => c.command === 'replay_sequence');
  assert.ok(replays.every((c) => c.params.newWindow === true && c.params.sessionId === `a:campaign-${done.id}-${c.params.sessionId.split('-').pop()}`));
  assert.deepEqual(calls.filter((c) => c.command === 'close_window').map((c) => c.params.tabId).sort(), [100, 101, 102]);
  // SHOP-1, from this campaign's runs: criterion 1 passing, 2 failing, 3 with no test.
  assert.deepEqual(done.requirements.map((r) => [r.key, r.status, r.criteria.map((c) => c.status)]), [['SHOP-1', 'failing', ['passing', 'failing', 'not_covered']]]);
  assert.equal(done.changes, null, 'the first campaign of these tests');
});

test('compared with the last campaign of the same tests: what regressed, what was fixed', async () => {
  // checkout now passes, search now fails.
  db.prepare(`UPDATE test_steps SET assertion = json_set(assertion, '$.selector', '#ok') WHERE test_id = (SELECT id FROM tests WHERE name = 'checkout') AND command = 'assert'`).run();
  db.prepare(`UPDATE test_steps SET assertion = json_set(assertion, '$.selector', '#ko') WHERE test_id = (SELECT id FROM tests WHERE name = 'search') AND command = 'assert'`).run();
  const { campaign, finished } = startCampaign({ projectId: project, version: '1.1' }, extension());
  await finished;
  const second = getCampaign(campaign.id);
  assert.deepEqual(second.changes.regressed, ['search']);
  assert.deepEqual(second.changes.fixed, ['checkout']);
  assert.equal(second.changes.since.version, '1.0');
  assert.match(formatCampaign(second), /Campaign #\d+ "Shop" — version 1\.1 — done: 2 passed, 1 failed \(3 test\(s\), 3 at a time, \d+s\)\nSince campaign #\d+ \(version 1\.0\): REGRESSED search; fixed checkout\nFailed:\n {2}search — step 2\/2: /);
  assert.match(formatCampaign(second), /Requirements:\n {2}SHOP-1 — Buying works: not covered \(1: passing, 2: passing, 3: not covered\)/);
  const listed = listCampaigns({ projectId: project });
  assert.deepEqual(listed.map((c) => c.version), ['1.1', '1.0']);
  assert.deepEqual(listed[0].failed, ['search']);
});

test('stopped: the test running finishes, the others are not started', async () => {
  let release, begin;
  const waiting = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { begin = resolve; });
  const gate = () => { begin(); return waiting; };
  const { campaign, finished } = startCampaign({ tests: ['login', 'search', 'checkout'], concurrency: 1 }, extension({ gate }));
  assert.throws(() => stopCampaign(999), /not running/);
  await begun;
  stopCampaign(campaign.id);
  release();
  await finished;
  const stopped = getCampaign(campaign.id);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.runs.map((t) => t.status), ['passed', 'skipped', 'skipped']);
  assert.match(junitReport(stopped), /<testcase name="search" classname="izitest" time="0\.000">\n {6}<skipped message="not run: the campaign was stopped"\/>/);
});

test('a test gone before its turn: told as an error, the others run', async () => {
  addTest('gone', '#ok');
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { campaign, finished } = startCampaign({ tests: ['login', 'gone'], concurrency: 1 }, extension({ gate: () => waiting }));
  deleteTest('gone');
  release();
  await finished;
  const run = getCampaign(campaign.id);
  assert.deepEqual(run.runs.map((t) => [t.status, t.error]), [['passed', null], ['error', 'Test "gone" not found.']]);
});

test('JUnit for a CI: a failure with its step and cause, requirements as properties, the XML escaped', async () => {
  const { campaign, finished } = startCampaign({ tests: ['checkout', 'search'], version: '2.0 <beta>', name: 'Nightly & co' }, extension());
  await finished;
  const xml = junitReport(getCampaign(campaign.id));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites name="IziTest" tests="2" failures="1" errors="0" skipped="0" time="[\d.]+">/);
  assert.match(xml, /<testsuite name="Nightly &amp; co \(2\.0 &lt;beta&gt;\)"/);
  assert.match(xml, /<property name="version" value="2\.0 &lt;beta&gt;"\/>/);
  assert.match(xml, /<testcase name="checkout" classname="izitest" time="[\d.]+">\n {6}<properties>\n {8}<property name="requirement" value="SHOP-1"\/>\n {6}<\/properties>\n {4}<\/testcase>/);
  assert.match(xml, /<testcase name="search"[^>]*>\n {6}<failure message="Step 2\/2: [^"]*" type="[a-z_]+">/);
});

test('the HTML report escapes what tests and pages say', async () => {
  addTest('<script>alert(1)</script>', '#ko');
  const { campaign, finished } = startCampaign({ tests: ['<script>alert(1)</script>'] }, extension());
  await finished;
  const page = htmlReport(getCampaign(campaign.id));
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /<title>Campaign #\d+ — 1 test<\/title>/);
});

test('campaigns left running by a stopped server are marked interrupted', () => {
  const { id } = db.prepare("INSERT INTO campaigns (name, scope, scope_key, tests) VALUES ('x', '{}', 'k', '[\"login\"]') RETURNING id").get();
  closeInterruptedCampaigns();
  const interrupted = getCampaign(id);
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.runs.map((t) => t.status), ['skipped']);
});
