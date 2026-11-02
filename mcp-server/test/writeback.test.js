// Unit tests for writing back to Jira and Xray: a story's coverage as IziTest's comment on it
// (lib/jira.js) — added, then updated, added again once deleted — and a campaign sent to Xray
// (lib/xray.js) as a Test Execution, each test a Generic test linked to the stories it covers;
// sent again, the same Test Execution given its results again (not its fields). Jira and Xray are stand-ins answering as their REST APIs
// do. On a database of their own.
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
const { jiraClient, commentOnJira, coverageComment, adfToText } = await import('../lib/jira.js');
const { xrayConfig, maskedXrayConfig, saveXrayConfig, xrayClient, testXray, exportToXray, formatXrayExport } = await import('../lib/xray.js');
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
  const dry = await commentOnJira({ campaignId: id });
  assert.equal(dry.sent, false);
  assert.deepEqual(dry.comments.map((c) => [c.key, c.action, c.status]), [['SHOP-1', 'add', 'failing']], 'REQ-1 is not from Jira: left out');
  assert.match(dry.comments[0].text, /^IziTest — ❌ Failing · 2\/2 criteria covered, 2 tests\n- ✓ 1\. One can log in — login: passed \(2026-11-02\)\n- ✗ 2\. One can get a refund — refund: failed \(2026-11-02\)\nCampaign #\d+ "Shop" \(1\.2\): 1\/3 passed\. Updated by IziTest on /);

  const site = jira();
  const sent = await commentOnJira({ campaignId: id, dryRun: false }, { client: jiraClient(SITE, site) });
  assert.deepEqual(sent.comments.map((c) => [c.action, c.url]), [['added', 'https://shop.atlassian.net/browse/SHOP-1?focusedCommentId=10001']]);
  assert.equal(site.comments.get('10001').body.content[0].content[0].text, 'IziTest — ❌ Failing');
  const again = await commentOnJira({ keys: ['shop-1'], dryRun: false }, { client: jiraClient(SITE, site) });
  assert.deepEqual([again.comments[0].action, site.calls.at(-1).method, site.calls.at(-1).path], ['updated', 'PUT', '/rest/api/3/issue/SHOP-1/comment/10001']);
  site.comments.clear();
  const readded = await commentOnJira({ keys: ['SHOP-1'], dryRun: false }, { client: jiraClient(SITE, site) });
  assert.deepEqual([readded.comments[0].action, getRequirement('SHOP-1').jira_comment_id], ['added', '10002'], 'deleted in Jira: a new one, kept');

  const told = await commentOnJira({ keys: ['REQ-1', 'NOPE-9'] });
  assert.deepEqual(told.warnings, ['REQ-1 was not imported from Jira: no comment', 'NOPE-9: no such requirement in IziTest']);
  await assert.rejects(commentOnJira({}), /their keys, or a campaign/);
  await assert.rejects(commentOnJira({ campaignId: 999 }), /No campaign #999/);
});

test('the Xray API key kept: the secret masked when read, kept when given back masked; the environment as a fallback', async () => {
  assert.equal(xrayConfig(), null);
  process.env.XRAY_CLIENT_ID = 'env-id';
  process.env.XRAY_CLIENT_SECRET = 'env-secret';
  assert.equal(maskedXrayConfig().from, 'env');
  const saved = saveXrayConfig(KEY);
  assert.deepEqual(saved, { clientId: 'id', clientSecret: 'secr•••••3456', from: 'settings' });
  saveXrayConfig({ clientId: 'id', clientSecret: saved.clientSecret });
  assert.equal(xrayConfig().clientSecret, 'secret-123456', 'masked: the saved one kept');
  assert.throws(() => saveXrayConfig({ clientId: 'id', clientSecret: '' }), /needs the client secret/);
  assert.equal(saveXrayConfig({ clientId: '' }), null);
  assert.equal(xrayConfig().from, 'env', 'removed: the environment again');
  delete process.env.XRAY_CLIENT_ID;
  delete process.env.XRAY_CLIENT_SECRET;

  assert.deepEqual(await testXray(xrayClient(KEY, { fetch: xray().fetch, baseUrl: 'https://xray.test' })), { url: 'https://xray.test' });
  await assert.rejects(testXray(xrayClient({ ...KEY, clientSecret: 'bad' }, xray())), /Xray refused the API key/);
  assert.throws(() => xrayClient(null), /No Xray API key set/);
});

test('a campaign sent to Xray: a dry run first; a Test Execution, each test Generic and linked to its stories; sent again, the same one', async () => {
  const id = campaign();
  const dry = await exportToXray(id);
  assert.equal(dry.sent, false);
  assert.equal(dry.project, 'SHOP', 'the project of the stories its tests cover');
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
  assert.match(formatXrayExport(dry), /^Dry run — would create a Test Execution in SHOP: 1 PASSED, 1 FAILED, 1 TODO\. Nothing sent/);

  const server = xray();
  const client = xrayClient(KEY, server);
  const sent = await exportToXray(id, { testPlanKey: 'shop-40', dryRun: false }, { client });
  assert.deepEqual([sent.execution, sent.updates], ['SHOP-100', false]);
  assert.equal(server.calls.at(-1).body.info.testPlanKey, 'SHOP-40');
  const again = await exportToXray(id, { dryRun: false }, { client });
  assert.deepEqual([again.execution, again.updates, server.calls.at(-1).body.testExecutionKey], ['SHOP-100', true, 'SHOP-100']);
  assert.deepEqual([server.calls.at(-1).body.info, server.calls.at(-1).body.tests.length], [undefined, 3], 'its results again, not its fields');
  await exportToXray(id, { testPlanKey: 'SHOP-41', dryRun: false }, { client });
  assert.deepEqual(server.calls.at(-1).body.info, { testPlanKey: 'SHOP-41' }, 'only the Test Plan it is added to');
  assert.equal(server.calls.filter((c) => c.path === '/api/v2/authenticate').length, 1, 'one token for the client');
  server.executions.clear();
  const recreated = await exportToXray(id, { dryRun: false }, { client });
  assert.equal(recreated.execution, 'SHOP-101', 'its Test Execution deleted since: a new one');
  assert.equal(server.calls.at(-1).body.info.project, 'SHOP', 'created whole');

  assert.equal((await exportToXray(id, { projectKey: 'qa' })).project, 'QA');
  await assert.rejects(exportToXray(id, { projectKey: 'not a key' }), /Not a Jira project key/);
  await assert.rejects(exportToXray(999), /No campaign #999/);
  db.prepare("UPDATE requirements SET source = 'manual' WHERE key = 'SHOP-1'").run();
  await assert.rejects(exportToXray(id), /say which Jira project/);
});
