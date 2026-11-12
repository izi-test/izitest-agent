// Unit tests for what a test manager follows: a requirement's product risk (lib/requirements.js),
// a campaign's test plan, exit criteria and residual risk (lib/campaigns.js), a bug handled —
// priority, assignee, deferred, duplicate, to retest — and reported by a person, then reproduced
// by a test (lib/bugs.js), a bug sent to Jira (lib/connectors), and the progress report
// (lib/reports.js). The extension and Jira are stand-ins; the database is their own.
// Run with: node --test test/test-management.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'test-management-')), 'test.db');
process.env.IZITEST_HOME = await mkdtemp(join(tmpdir(), 'test-management-home-'));
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTest } = await import('../lib/test-store.js');
const { saveRequirement, getRequirement, listRequirements, linkTest, riskOf } = await import('../lib/requirements.js');
const { startCampaign, getCampaign, updateCampaignPlan, exitCriteriaOf, formatCampaign, htmlReport } = await import('../lib/campaigns.js');
const { reportBug, updateBug, listBugs, linkReproTest, adoptReproTest, reproBrief, reproTestName } = await import('../lib/bugs.js');
const { saveConnectorConfig, sendBug, sentTo, formatBugSent, describeConnectors } = await import('../lib/connectors/index.js');
const { periodOf, progressReport, formatProgress, htmlProgress } = await import('../lib/reports.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;

/** A test that opens a page and checks `selector` shows "Welcome": #ok passes, anything else fails. */
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

const sendCommand = async (_profile, command, params) => {
  if (command === 'replay_sequence') return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 })), durationMs: 5 };
  if (command === 'execute_js') return { result: { value: params.code.includes('#ok') ? 'Welcome' : 'Oops', pageUrl: 'https://shop.test/' } };
  return {};
};

addTest('login', '#ok');
addTest('checkout', '#ko');

test('a requirement\'s product risk: likelihood × impact, kept, removed, and refused when it is no level', () => {
  assert.deepEqual([riskOf('high', 'high'), riskOf('high', 'medium'), riskOf('medium', 'medium'), riskOf('low', 'high'), riskOf('low', 'medium'), riskOf('low', 'low')],
    ['high', 'high', 'medium', 'medium', 'low', 'low']);
  assert.equal(riskOf('high', null), null, 'one of the two not said: no risk');
  const { requirement } = saveRequirement({ key: 'SHOP-1', title: 'One can log in', projectId: project, criteria: ['The dashboard opens'], likelihood: 'low', impact: 'high' });
  assert.deepEqual([requirement.likelihood, requirement.impact, requirement.risk], ['low', 'high', 'medium']);
  // Saved again without them: kept. With null: removed.
  assert.equal(saveRequirement({ key: 'SHOP-1', title: 'One can log in', projectId: project, criteria: ['The dashboard opens'] }).requirement.risk, 'medium');
  assert.equal(saveRequirement({ key: 'SHOP-1', title: 'One can log in', projectId: project, criteria: ['The dashboard opens'], impact: null }).requirement.risk, null);
  assert.throws(() => saveRequirement({ key: 'SHOP-1', title: 'One can log in', projectId: project, criteria: ['The dashboard opens'], impact: 'huge' }), /impact/i);
  saveRequirement({ key: 'SHOP-1', title: 'One can log in', projectId: project, criteria: ['The dashboard opens'], likelihood: 'low', impact: 'high' });
  saveRequirement({ key: 'SHOP-2', title: 'One can pay', projectId: project, criteria: ['The order is paid'], priority: 'high', likelihood: 'high', impact: 'high' });
  saveRequirement({ key: 'SHOP-3', title: 'One can get a refund', projectId: project, criteria: ['The refund is asked'], likelihood: 'medium', impact: 'medium' });
  linkTest('SHOP-1', 'login', { criterion: 1 });
  linkTest('SHOP-2', 'checkout', { criterion: 1 });
  assert.deepEqual(listRequirements({ projectId: project }).map((r) => [r.key, r.risk]).sort(), [['SHOP-1', 'medium'], ['SHOP-2', 'high'], ['SHOP-3', 'medium']]);
  assert.equal(getRequirement('SHOP-2').risk, 'high');
});

test('exit criteria as given: only what is asked, percentages checked', () => {
  assert.equal(exitCriteriaOf(null), null);
  assert.equal(exitCriteriaOf({ high_requirements_passing: false, min_coverage: 0, min_pass_rate: '' }), null);
  assert.deepEqual(exitCriteriaOf({ high_requirements_passing: true, no_open_high_bug: true, min_coverage: '80', min_pass_rate: 99.6 }),
    { high_requirements_passing: true, no_open_high_bug: true, min_coverage: 80, min_pass_rate: 100 });
  assert.throws(() => exitCriteriaOf({ min_pass_rate: 120 }), /min_pass_rate: a percentage from 0 to 100/);
});

let campaignId;

test('a campaign with a plan: its verdict against each exit criterion, and the risk it leaves', async () => {
  const { campaign, finished } = startCampaign({
    projectId: project, version: '1.0', objective: ' Version 1.0 can go to production ', scopeNote: 'Refunds are out: not built yet',
    exitCriteria: { high_requirements_passing: true, min_pass_rate: 50, min_coverage: 100 },
  }, { sendCommand });
  assert.equal(campaign.exit.verdict, 'pending', 'no verdict while it runs');
  await finished;
  const c = getCampaign(campaign.id);
  campaignId = c.id;
  assert.equal(c.objective, 'Version 1.0 can go to production');
  assert.equal(c.scope_note, 'Refunds are out: not built yet');
  assert.deepEqual(c.exit_criteria, { high_requirements_passing: true, min_coverage: 100, min_pass_rate: 50 });
  assert.equal(c.exit.verdict, 'not_met');
  const by = Object.fromEntries(c.exit.criteria.map((x) => [x.id, x]));
  assert.deepEqual([by.high_requirements_passing.met, by.high_requirements_passing.actual, by.high_requirements_passing.failing], [false, '0 of 1', ['SHOP-2']]);
  assert.deepEqual([by.min_pass_rate.met, by.min_pass_rate.actual], [true, '50% (1 of 2)']);
  assert.equal(by.min_coverage.met, true, 'every criterion of the requirements it checks had a test run');
  // SHOP-2 fails (high risk), SHOP-3 has no test at all (medium): both are left at risk, the riskiest first. SHOP-1 passes.
  assert.deepEqual(c.residual_risk.map((r) => [r.key, r.risk, r.status]), [['SHOP-2', 'high', 'failing'], ['SHOP-3', 'medium', 'not_covered']]);
  const text = formatCampaign(c);
  assert.match(text, /Objective: Version 1\.0 can go to production/);
  assert.match(text, /✗ Every requirement of high priority or high risk passes \(all\): 0 of 1 — SHOP-2/);
  const page = htmlReport(c);
  assert.match(page, /Test plan/);
  assert.match(page, /not met/);
  assert.match(page, /SHOP-3/);
});

test('the plan changed after the run changes the verdict; what is not given is kept', () => {
  const eased = updateCampaignPlan(campaignId, { exit_criteria: { min_pass_rate: 50 } });
  assert.equal(eased.exit.verdict, 'met');
  assert.equal(eased.objective, 'Version 1.0 can go to production', 'kept');
  const none = updateCampaignPlan(campaignId, { exit_criteria: null, scope_note: '' });
  assert.deepEqual([none.exit, none.exit_criteria, none.scope_note], [null, null, null]);
  assert.throws(() => updateCampaignPlan(campaignId, { exit_criteria: { min_coverage: -1 } }), /min_coverage/);
  assert.throws(() => updateCampaignPlan(9999, { objective: 'x' }), /No campaign #9999/);
  updateCampaignPlan(campaignId, { exit_criteria: { no_open_high_bug: true } });
});

test('a bug reported by a person: kept as told, with no test yet, and a brief for the agent to reproduce it', () => {
  assert.throws(() => reportBug({ title: ' ' }), /needs a title/);
  assert.throws(() => reportBug({ title: 'x', severity: 'blocker' }), /No such severity/);
  assert.throws(() => reportBug({ title: 'x', requirement: 'NOPE-1' }), /No requirement NOPE-1/);
  const bug = reportBug({
    title: 'The total forgets the delivery fee', description: 'Add a book to the basket, choose home delivery: the total stays at the price of the book.',
    expected: 'The total adds the 4.90 fee', pageUrl: 'https://shop.test/basket', severity: 'high', priority: 'high', assignee: ' Lina ', projectId: project, requirement: 'shop-2',
  });
  assert.deepEqual([bug.source, bug.kind, bug.status, bug.severity, bug.priority, bug.assignee, bug.repro_test ?? null], ['report', 'reported', 'open', 'high', 'high', 'Lina', null]);
  assert.deepEqual(bug.details.requirements.map((r) => r.key), ['SHOP-2']);
  const brief = reproBrief(bug);
  assert.match(brief, new RegExp(`record the path as the test "bug_${bug.id}_repro"`));
  assert.match(brief, /What was expected: The total adds the 4\.90 fee/);
  assert.match(brief, /Project: Shop/);
  assert.match(brief, /Check the expected behaviour, never the faulty one/);
});

test('a reported bug gets its test: named after it, adopted; a test that does not exist is refused', () => {
  const bug = listBugs({ status: 'open', projectId: project }).find((b) => b.source === 'report');
  assert.throws(() => linkReproTest(bug.id, 'nope'), /No test "nope": record it first/);
  assert.equal(adoptReproTest('login'), null, 'not a bug\'s name');
  assert.equal(adoptReproTest(reproTestName(bug)), null, 'not recorded yet');
  addTest(reproTestName(bug), '#ko');
  assert.equal(adoptReproTest(reproTestName(bug)).repro_test, `bug_${bug.id}_repro`);
  assert.equal(adoptReproTest(reproTestName(bug)), null, 'it has its test already');
  assert.equal(linkReproTest(bug.id, null).repro_test, null);
  assert.equal(updateBug(bug.id, { repro_test: 'checkout' }).repro_test, 'checkout');
});

test('a bug handled: priority, assignee, to retest, deferred, duplicate of another, reopened', () => {
  const bug = listBugs({ status: 'open', projectId: project }).find((b) => b.source === 'report');
  const other = reportBug({ title: 'Delivery fee missing from the total', projectId: project });
  assert.deepEqual((({ priority, assignee, severity }) => [priority, assignee, severity])(updateBug(bug.id, { priority: 'medium', assignee: '', severity: 'medium' })), ['medium', null, 'medium']);
  assert.throws(() => updateBug(bug.id, { priority: 'urgent' }), /No such priority/);
  assert.throws(() => updateBug(bug.id, { severity: null }), /A bug has a severity/);
  assert.throws(() => updateBug(bug.id, { status: 'closed' }), /No such status/);
  assert.equal(updateBug(bug.id, { status: 'to_retest' }).status, 'to_retest');
  assert.equal(updateBug(bug.id, { status: 'deferred' }).status, 'deferred');
  // A duplicate needs its original; it is not one of itself, nor of its own duplicate.
  assert.throws(() => updateBug(other.id, { status: 'duplicate' }), /Say which bug it is a duplicate of/);
  assert.throws(() => updateBug(other.id, { duplicate_of: other.id }), /cannot be a duplicate of itself/);
  assert.throws(() => updateBug(other.id, { duplicate_of: 9999 }), /No bug #9999/);
  const duplicate = updateBug(other.id, { duplicate_of: bug.id });
  assert.deepEqual([duplicate.status, duplicate.duplicate_of], ['duplicate', bug.id]);
  assert.throws(() => updateBug(bug.id, { duplicate_of: other.id }), /already a duplicate/);
  assert.equal(updateBug(other.id, { status: 'open' }).duplicate_of, null, 'reopened: a duplicate no more');
  updateBug(other.id, { duplicate_of: bug.id });
  // Fixed keeps when; reopened forgets it.
  assert.ok(updateBug(bug.id, { status: 'fixed' }).fixed_at);
  assert.equal(updateBug(bug.id, { status: 'open', severity: 'high' }).fixed_at, null);
  assert.throws(() => updateBug(9999, { status: 'open' }), /No bug #9999/);
});

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('a bug sent to Jira: a dry run first, then an issue created, and the same one updated after', async () => {
  assert.ok(describeConnectors().find((c) => c.id === 'jira').bugs, 'Jira takes bugs');
  await assert.rejects(sendBug('xray', 1), /takes no bugs/);
  saveConnectorConfig('jira', { baseUrl: 'https://shop.atlassian.net', email: 'qa@example.com', apiToken: 'token' });
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST' && pathname === '/rest/api/3/issue') return reply(201, { id: '1', key: 'SHOP-77' });
    if (init.method === 'PUT' && pathname === '/rest/api/3/issue/SHOP-77') return new Response(null, { status: 204 });
    return reply(404, { errorMessages: ['No route'] });
  };
  const bug = listBugs({ status: 'open', projectId: project }).find((b) => b.source === 'report');
  await assert.rejects(sendBug('jira', 9999, {}, { fetch }), /No bug #9999/);
  const dry = await sendBug('jira', bug.id, { options: { project_key: 'shop' } }, { fetch });
  assert.deepEqual([dry.sent, dry.target, dry.type, dry.updates], [false, 'SHOP', 'Bug', false]);
  assert.match(dry.title, /The total forgets the delivery fee/);
  assert.match(dry.text, /The total adds the 4\.90 fee/);
  assert.match(formatBugSent(dry), /Dry run — would create a Bug in SHOP\. Nothing sent/);
  assert.equal(calls.length, 0, 'a dry run asks Jira nothing');
  const sent = await sendBug('jira', bug.id, { options: { project_key: 'SHOP' }, dryRun: false }, { fetch });
  assert.deepEqual([sent.sent, sent.action, sent.ref, sent.url], [true, 'created', 'SHOP-77', 'https://shop.atlassian.net/browse/SHOP-77']);
  assert.deepEqual([calls[0].method, calls[0].path, calls[0].body.fields.project.key, calls[0].body.fields.issuetype.name], ['POST', '/rest/api/3/issue', 'SHOP', 'Bug']);
  assert.deepEqual(sentTo(bug.id, 'bug').map((s) => [s.connector, s.ref, s.url]), [['jira', 'SHOP-77', 'https://shop.atlassian.net/browse/SHOP-77']]);
  // Sent again: the same issue, updated — no project to say.
  const again = await sendBug('jira', bug.id, { dryRun: false }, { fetch });
  assert.deepEqual([again.action, again.ref], ['updated', 'SHOP-77']);
  assert.deepEqual([calls.at(-1).method, calls.at(-1).path], ['PUT', '/rest/api/3/issue/SHOP-77']);
  assert.equal(calls.at(-1).body.fields.project, undefined, 'an update moves nothing');
});

test('the progress report: runs, requirements by risk, bugs and their trend, the risk left, what to do next', () => {
  assert.deepEqual(periodOf({ from: '2026-01-01', to: '2026-01-07' }), { from: '2026-01-01T00:00:00.000Z', to: '2026-01-07T23:59:59.999Z', days: 7 });
  assert.throws(() => periodOf({ from: '2026-02-01', to: '2026-01-01' }));
  assert.throws(() => progressReport({ projectId: 9999 }), /No project #9999/);
  const r = progressReport({ projectId: project });
  assert.equal(r.project.name, 'Shop');
  assert.deepEqual([r.runs.total, r.runs.passed, r.runs.failed, r.runs.pass_rate, r.runs.tests], [2, 1, 1, 50, 2]);
  assert.deepEqual(r.campaigns.map((c) => [c.id, c.total, c.passed, c.pass_rate]), [[campaignId, 2, 1, 50]]);
  assert.deepEqual([r.requirements.total, r.requirements.passing, r.requirements.failing, r.requirements.not_covered], [3, 1, 1, 1]);
  assert.deepEqual(r.requirements.by_risk, { high: { total: 1, passing: 0 }, medium: { total: 2, passing: 1 }, low: { total: 0, passing: 0 } });
  assert.deepEqual(r.residual_risk.map((x) => x.key), ['SHOP-2', 'SHOP-3']);
  // The reported bug is open and high; its duplicate is counted neither as opened nor as unresolved.
  const reported = r.bugs.list.filter((b) => b.title === 'The total forgets the delivery fee');
  assert.equal(reported.length, 1);
  assert.ok(!r.bugs.list.some((b) => b.title === 'Delivery fee missing from the total'));
  assert.equal(r.bugs.unresolved, r.bugs.list.length);
  assert.ok(r.bugs.by_severity.high >= 1);
  assert.equal(r.bugs.trend.length, r.period.days);
  assert.equal(r.bugs.trend.at(-1).unresolved, r.bugs.unresolved, 'the trend ends where the bugs stand');
  assert.ok(r.next.length > 0);
  const text = formatProgress(r);
  assert.match(text, /Shop/);
  assert.match(text, /SHOP-2/);
  const page = htmlProgress(r);
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /The total forgets the delivery fee/);
  assert.ok(!/<script/i.test(page), 'a page that runs nothing: it opens anywhere');
  // A period before anything: nothing ran, nothing was opened.
  const before = progressReport({ projectId: project, from: '2020-01-01', to: '2020-01-31' });
  assert.deepEqual([before.runs.total, before.campaigns.length, before.bugs.opened], [0, 0, 0]);
});
