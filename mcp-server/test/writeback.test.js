// Unit tests for writing back through connectors (lib/connectors): a story's coverage as
// IziTest's comment on it (Jira) — added, then updated, added again once deleted — and a campaign
// sent to Xray as a Test Execution, each test a Generic test linked to the stories it covers;
// sent again, the same Test Execution given its results again (not its fields). Jira and Xray are
// stand-ins answering as their REST APIs do. On a database of their own.
// Run with: node --test test/writeback.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'writeback-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTest } = await import('../lib/test-store.js');
const { saveRequirement, linkTest } = await import('../lib/requirements.js');
const { coverageComment, adfToText } = await import('../lib/connectors/jira.js');
const { connectorConfig, maskedConfig, saveConnectorConfig, testConnector, sendCoverage, sendResults, formatResults, formatCoverage, sentTo } = await import('../lib/connectors/index.js');
const { getRequirement } = await import('../lib/requirements.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
for (const [name, description] of [['login', 'Log in with a good password'], ['refund', ''], ['search', '']]) {
  saveTest({ name, description, variables: {}, steps: [{ command: 'navigate', params: { url: 'https://shop.test' }, intent: 'Open the shop' }] });
}
saveRequirement({ key: 'SHOP-1', title: 'Buying works', source: 'jira', projectId: project, criteria: ['One can log in', 'One can get a refund'] });
saveRequirement({ key: 'REQ-1', title: 'Search works', source: 'manual', projectId: project, criteria: ['One can search'] });
linkTest('SHOP-1', 'login', { criterion: 1 });
linkTest('SHOP-1', 'refund', { criterion: 2 });
linkTest('REQ-1', 'search', { criterion: 1 });

/** A campaign gone to its end: login passed, refund failed (a non-conformity), search not run. */
function campaign() {
  const id = db.prepare(`INSERT INTO campaigns (name, project_id, scope, scope_key, version, tests, status, created_at, finished_at)
    VALUES ('Shop', ?, '{}', 'project:1', '1.2', '["login","refund","search"]', 'done', '2026-11-02T10:00:00.000Z', '2026-11-02T10:05:00.000Z') RETURNING id`)
    .get(project).id;
  const run = (name, values) => db.prepare(`INSERT INTO test_executions (test_id, test_name, status, started_at, finished_at, duration_ms, total_steps,
      failed_step, error, triage, trigger, campaign_id) VALUES ((SELECT id FROM tests WHERE name = ?), ?, ?, ?, ?, ?, 3, ?, ?, ?, 'campaign', ?)`)
    .run(name, name, ...values, id);
  run('login', ['success', '2026-11-02T10:00:01.250Z', '2026-11-02T10:00:05.000Z', 3750, null, null, null]);
  run('refund', ['failed', '2026-11-02T10:00:01.500Z', '2026-11-02T10:00:09.000Z', 7500, 2, 'Assertion failed: "Refunded" expected',
    JSON.stringify({ cause: 'non_conformity', confidence: 'high', summary: 'The refund is refused' })]);
  return id;
}

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A Jira site's comments: what it was asked, and its comments by issue. */
function jira() {
  const calls = [];
  const comments = new Map();
  let next = 10001;
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, body: init.body ? JSON.parse(init.body) : null });
    const [, key, id] = /^\/rest\/api\/3\/issue\/([^/]+)\/comment(?:\/(\d+))?$/.exec(pathname) ?? [];
    if (!key) return reply(404, { errorMessages: ['No route'] });
    if (init.method === 'POST') {
      const comment = { id: String(next++), body: JSON.parse(init.body).body };
      comments.set(comment.id, { key, ...comment });
      return reply(201, comment);
    }
    if (!comments.has(id)) return reply(404, { errorMessages: ['Can not find a comment for the id'] });
    comments.get(id).body = JSON.parse(init.body).body;
    return reply(200, { id });
  };
  return { fetch, calls, comments };
}

/** Xray Cloud: its token for the API key, its Test Executions; what it was sent. */
function xray() {
  const calls = [];
  const executions = new Set();
  let next = 100;
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const body = JSON.parse(init.body);
    calls.push({ path: pathname, body, auth: init.headers.Authorization });
    if (pathname === '/api/v2/authenticate') {
      return body.client_id === 'id' && body.client_secret === 'secret-123456' ? reply(200, 'tok-1') : new Response('Invalid client credentials', { status: 401 });
    }
    if (init.headers.Authorization !== 'Bearer tok-1') return reply(401, { error: 'Invalid token' });
    if (body.testExecutionKey && !executions.has(body.testExecutionKey)) return reply(400, { error: `Test Execution with key ${body.testExecutionKey} not found.` });
    const key = body.testExecutionKey ?? `SHOP-${next++}`;
    executions.add(key);
    return reply(200, { id: '1', key, self: `https://shop.atlassian.net/rest/api/2/issue/${key}` });
  };
  return { fetch, calls, executions };
}

const SITE = { baseUrl: 'https://shop.atlassian.net', email: 'qa@example.com', apiToken: 'token' };
const KEY = { clientId: 'id', clientSecret: 'secret-123456' };
saveConnectorConfig('jira', SITE);
const commentRef = () => db.prepare("SELECT ref FROM connector_refs WHERE connector = 'jira' AND kind = 'requirement' AND item_id = (SELECT id FROM requirements WHERE key = 'SHOP-1')").get()?.ref;

test('a story\'s coverage as a comment: where it stands, each criterion, its tests and how they did', () => {
  const body = coverageComment(getRequirement('SHOP-1'), { now: new Date('2026-11-02T12:00:00Z') });
  assert.equal(adfToText(body), [
    'IziTest — ⏳ Not run yet · 2/2 criteria covered, 2 tests',
    '- … 1. One can log in — login: not run yet',
    '- … 2. One can get a refund — refund: not run yet',
    'Updated by IziTest on 2026-11-02 12:00 UTC.',
  ].join('\n'));
  assert.equal(adfToText(coverageComment(getRequirement('REQ-1'), { now: new Date(0) })).split('\n')[1], '- … 1. One can search — search: not run yet');
});

test('commented on Jira: a campaign\'s stories only, a dry run first; added, then updated, added again once deleted', async () => {
  const id = campaign();
  const dry = await sendCoverage('jira', { campaignId: id });
  assert.equal(dry.sent, false);
  assert.deepEqual(dry.items.map((c) => [c.key, c.action, c.status]), [['SHOP-1', 'add', 'failing']], 'REQ-1 is not from Jira: left out');
  assert.match(formatCoverage(dry), /^Dry run — nothing sent; dry_run: false sends a comment on each story:\nSHOP-1: would add IziTest's:\n {4}IziTest — ❌ Failing/);
  assert.match(dry.items[0].text, /^IziTest — ❌ Failing · 2\/2 criteria covered, 2 tests\n- ✓ 1\. One can log in — login: passed \(2026-11-02\)\n- ✗ 2\. One can get a refund — refund: failed \(2026-11-02\)\nCampaign #\d+ "Shop" \(1\.2\): 1\/3 passed\. Updated by IziTest on /);

  const site = jira();
  const sent = await sendCoverage('jira', { campaignId: id, dryRun: false }, site);
  assert.deepEqual(sent.items.map((c) => [c.action, c.url]), [['added', 'https://shop.atlassian.net/browse/SHOP-1?focusedCommentId=10001']]);
  assert.equal(site.comments.get('10001').body.content[0].content[0].text, 'IziTest — ❌ Failing');
  const again = await sendCoverage('jira', { keys: ['shop-1'], dryRun: false }, site);
  assert.deepEqual([again.items[0].action, site.calls.at(-1).method, site.calls.at(-1).path], ['updated', 'PUT', '/rest/api/3/issue/SHOP-1/comment/10001']);
  site.comments.clear();
  const readded = await sendCoverage('jira', { keys: ['SHOP-1'], dryRun: false }, site);
  assert.deepEqual([readded.items[0].action, commentRef()], ['added', '10002'], 'deleted in Jira: a new one, kept');

  const told = await sendCoverage('jira', { keys: ['REQ-1', 'NOPE-9'] });
  assert.deepEqual(told.warnings, ['REQ-1 was not imported from Jira: nothing sent', 'NOPE-9: no such requirement in IziTest']);
  await assert.rejects(sendCoverage('jira', {}), /their keys, or a campaign/);
  await assert.rejects(sendCoverage('jira', { campaignId: 999 }), /No campaign #999/);
  await assert.rejects(sendCoverage('xray', { campaignId: id }), /Xray is not told the coverage of requirements/);
  db.prepare("DELETE FROM requirements WHERE key = 'GONE-1'").run();
  const gone = saveRequirement({ key: 'GONE-1', title: 'Gone', source: 'jira' }).requirement;
  db.prepare("INSERT INTO connector_refs (connector, kind, item_id, ref) VALUES ('jira', 'requirement', ?, '9')").run(gone.id);
  db.prepare('DELETE FROM requirements WHERE id = ?').run(gone.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM connector_refs WHERE kind = 'requirement' AND item_id = ?").get(gone.id).n, 0, 'a requirement deleted takes its ref along');
});

test('the Xray API key kept: the secret masked when read, kept when given back masked; the environment as a fallback', async () => {
  assert.equal(connectorConfig('xray'), null);
  await assert.rejects(sendResults('xray', campaign(), { dryRun: false }), /Xray is not set: Settings → Connectors → Xray \(or XRAY_CLIENT_ID, XRAY_CLIENT_SECRET\)/);
  process.env.XRAY_CLIENT_ID = 'env-id';
  process.env.XRAY_CLIENT_SECRET = 'env-secret';
  assert.equal(maskedConfig('xray').from, 'env');
  const saved = saveConnectorConfig('xray', KEY);
  assert.deepEqual(saved, { clientId: 'id', clientSecret: 'secr•••••3456', from: 'settings' });
  saveConnectorConfig('xray', { clientId: 'id', clientSecret: saved.clientSecret });
  assert.equal(connectorConfig('xray').clientSecret, 'secret-123456', 'masked: the saved one kept');
  assert.throws(() => saveConnectorConfig('xray', { clientId: 'id', clientSecret: '' }), /Xray needs: Client secret/);
  assert.equal(saveConnectorConfig('xray', { clientId: '' }).from, 'env', 'removed: the environment again');
  delete process.env.XRAY_CLIENT_ID;
  delete process.env.XRAY_CLIENT_SECRET;
  saveConnectorConfig('xray', KEY);

  assert.deepEqual(await testConnector('xray', null, xray()), { success: true, text: 'Xray takes this API key (https://xray.cloud.getxray.app).' });
  assert.match((await testConnector('xray', { ...KEY, clientSecret: 'bad' }, xray())).error, /Xray refused the API key/);
});

test('a campaign sent to Xray: a dry run first; a Test Execution, each test Generic and linked to its stories; sent again, the same one', async () => {
  const id = campaign();
  const dry = await sendResults('xray', id);
  assert.equal(dry.sent, false);
  assert.equal(dry.target, 'SHOP', 'the project of the stories its tests cover');
  assert.deepEqual(dry.payload.info, {
    project: 'SHOP', summary: 'IziTest — Shop (1.2)', startDate: '2026-11-02T10:00:00Z', finishDate: '2026-11-02T10:05:00Z',
    description: `IziTest campaign #${id}: 1/3 passed, 1 failed, 1 not run.\nNon-conformities: refund.`,
  });
  assert.deepEqual(dry.payload.tests.map((t) => [t.testInfo.summary, t.testInfo.definition, t.testInfo.requirementKeys ?? null, t.status, t.start ?? null]), [
    ['Log in with a good password', 'izitest:login', ['SHOP-1'], 'PASSED', '2026-11-02T10:00:01Z'],
    ['refund', 'izitest:refund', ['SHOP-1'], 'FAILED', '2026-11-02T10:00:01Z'],
    ['search', 'izitest:search', null, 'TODO', null],
  ]);
  assert.equal(dry.payload.tests[1].comment, 'Failed at step 2/3 in 8s: Assertion failed: "Refunded" expected\n\nTriage: non_conformity (high) — The refund is refused');
  assert.match(formatResults(dry), /^Dry run — would create a Test Execution in SHOP: 1 PASSED, 1 FAILED, 1 TODO\. Nothing sent[\s\S]*\n- refund: FAILED — covers SHOP-1\n[\s\S]*Generic test of Xray/);

  const server = xray();
  const sent = await sendResults('xray', id, { options: { test_plan_key: 'shop-40' }, dryRun: false }, server);
  assert.deepEqual([sent.ref, sent.updates, sent.url], ['SHOP-100', false, 'https://shop.atlassian.net/browse/SHOP-100']);
  assert.equal(server.calls.at(-1).body.info.testPlanKey, 'SHOP-40');
  assert.deepEqual(sentTo(id), [{ connector: 'xray', name: 'Xray', ref: 'SHOP-100', url: 'https://shop.atlassian.net/browse/SHOP-100' }]);
  const again = await sendResults('xray', id, { dryRun: false }, server);
  assert.deepEqual([again.ref, again.updates, server.calls.at(-1).body.testExecutionKey], ['SHOP-100', true, 'SHOP-100']);
  assert.deepEqual([server.calls.at(-1).body.info, server.calls.at(-1).body.tests.length], [undefined, 3], 'its results again, not its fields');
  await sendResults('xray', id, { options: { test_plan_key: 'SHOP-41' }, dryRun: false }, server);
  assert.deepEqual(server.calls.at(-1).body.info, { testPlanKey: 'SHOP-41' }, 'only the Test Plan it is added to');
  assert.equal(server.calls.filter((c) => c.path === '/api/v2/authenticate').length, 3, 'one token a send');
  server.executions.clear();
  const recreated = await sendResults('xray', id, { dryRun: false }, server);
  assert.equal(recreated.ref, 'SHOP-101', 'its Test Execution deleted since: a new one');
  assert.equal(server.calls.at(-1).body.info.project, 'SHOP', 'created whole');

  assert.equal((await sendResults('xray', id, { options: { project_key: 'qa' } })).target, 'QA');
  await assert.rejects(sendResults('xray', id, { options: { project_key: 'not a key' } }), /Not a Jira project key/);
  await assert.rejects(sendResults('xray', 999), /No campaign #999/);
  await assert.rejects(sendResults('jira', id), /Jira takes no campaign results/);
  db.prepare("UPDATE requirements SET source = 'manual' WHERE key = 'SHOP-1'").run();
  await assert.rejects(sendResults('xray', id), /say which Jira project/);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  assert.deepEqual(sentTo(id), [], 'a campaign deleted takes its ref along');
});
