// Unit tests for connectors (lib/connectors): what makes one, how each is described to the
// dashboard and the agents, and GitHub Issues — a second source of requirements beside Jira:
// read by an issue search (pull requests left out), by their keys (one missing told), or again
// from their links; criteria from the "Acceptance criteria" list, else the task list; priority
// from a label. GitHub is a stand-in answering as its REST API does. On a database of their own.
// Run with: node --test test/connectors.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'connectors-')), 'test.db');
delete process.env.GITHUB_TOKEN;
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const {
  registerConnector, describeConnectors, connectorsFor, saveConnectorConfig, connectorConfig, testConnector, importFromConnector,
} = await import('../lib/connectors/index.js');
const { getRequirement, saveRequirement } = await import('../lib/requirements.js');

test('a connector: an id of its own, a name, a test, and at least one role', () => {
  const role = { requirements: { read: async () => ({ records: [] }) } };
  assert.throws(() => registerConnector({ id: 'Notion!', name: 'Notion', test: () => '', ...role }), /lowercase letters/);
  assert.throws(() => registerConnector({ id: 'manual', name: 'Manual', test: () => '', ...role }), /of IziTest's own/);
  assert.throws(() => registerConnector({ id: 'notion', test: () => '', ...role }), /needs a name and a test/);
  assert.throws(() => registerConnector({ id: 'notion', name: 'Notion', test: () => '' }), /does nothing/);
  assert.deepEqual(connectorsFor('requirements').map((c) => c.id), ['jira', 'github']);
  assert.deepEqual(connectorsFor('results').map((c) => c.id), ['xray']);
  assert.throws(() => saveRequirement({ title: 'x', source: 'Not A Source' }), /No such source/);
  assert.equal(saveRequirement({ title: 'From Notion', source: 'notion' }).requirement.source, 'notion', "any connector's id is a source");
});

test('each described: what it does, its fields, its settings with the secrets masked', () => {
  saveConnectorConfig('jira', { baseUrl: 'https://shop.atlassian.net', email: 'qa@example.com', apiToken: 'token-1234567890' });
  const [jira, xray, github] = describeConnectors();
  assert.deepEqual(jira.settings.fields.map((f) => [f.name, f.type, f.env]), [['baseUrl', 'url', 'JIRA_BASE_URL'], ['email', 'text', 'JIRA_EMAIL'], ['apiToken', 'secret', 'JIRA_API_TOKEN']]);
  assert.deepEqual([jira.config.apiToken, jira.requirements.query.label, jira.requirements.scopes, jira.coverage.where, jira.results], ['toke••••••••7890', 'JQL query', true, 'a comment on each story', undefined]);
  assert.deepEqual([xray.config, xray.results.what, xray.results.options.map((o) => o.name)], [null, 'Test Execution', ['project_key', 'test_plan_key']]);
  assert.deepEqual([github.config, github.requirements.keys, github.requirements.scopes], [{ from: 'default' }, 'owner/name#12', false], 'no token needed: set as it is');
});

/** GitHub's REST API: issues of acme/shop, a search, the rate limit; what it was asked. */
function gitHub({ limited = false } = {}) {
  const calls = [];
  const issue = (number, fields) => ({
    number, html_url: `https://github.com/acme/shop/issues/${number}`, repository_url: 'https://api.github.com/repos/acme/shop', labels: [], body: '', ...fields,
  });
  const issues = {
    12: issue(12, { title: 'Refund an order', labels: [{ name: 'priority: high' }, { name: 'story' }], body: 'As a buyer I want my money back.\n\n- [ ] Refused after 14 days\n- [x] Shown in the history' }),
    14: issue(14, { title: 'Pay by card', body: 'Card payments.\n\n## Acceptance criteria\n- A declined card shows "Payment refused"\n\n## Tasks\n- [ ] Wire the gateway' }),
    15: issue(15, { title: 'Bump the deps', pull_request: { url: 'x' } }),
  };
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ path: pathname, q: searchParams.get('q'), auth: init.headers.Authorization ?? null });
    const reply = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (limited) return reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60' });
    if (pathname === '/rate_limit') return reply(200, { resources: { core: { remaining: 57, limit: 60 } } });
    if (pathname === '/user') return init.headers.Authorization === 'Bearer ghp_good-token' ? reply(200, { login: 'octo' }) : reply(401, { message: 'Bad credentials' });
    if (pathname === '/search/issues') return reply(200, { total_count: 3, items: Object.values(issues) });
    const number = /^\/repos\/acme\/shop\/issues\/(\d+)$/.exec(pathname)?.[1];
    return number && issues[number] ? reply(200, issues[number]) : reply(404, { message: 'Not Found' });
  };
  return { fetch, calls, issues };
}

test('GitHub issues read as requirements: by a search, pull requests left out; criteria and priority from the issue', async () => {
  const github = gitHub();
  const result = await importFromConnector('github', { query: 'repo:acme/shop label:story' }, github);
  assert.equal(github.calls[0].q, 'repo:acme/shop label:story is:issue', 'issues only');
  assert.deepEqual(result.items.map((i) => [i.key, i.title, i.priority, i.source, i.url, i.criteria]), [
    ['SHOP-12', 'Refund an order', 'high', 'github', 'https://github.com/acme/shop/issues/12', ['Refused after 14 days', 'Shown in the history']],
    ['SHOP-14', 'Pay by card', 'medium', 'github', 'https://github.com/acme/shop/issues/14', ['A declined card shows "Payment refused"']],
  ], 'its task list as criteria; the "Acceptance criteria" list first when it has one');
  assert.equal(result.saved, false);
  assert.equal(getRequirement('SHOP-12'), null, 'a dry run saves nothing');
  await importFromConnector('github', { query: 'repo:acme/shop is:pr' }, github);
  assert.equal(github.calls.at(-1).q, 'repo:acme/shop is:pr', 'a search saying what it wants is left as it is');
});

test('by their keys, one missing told; saved, then read again from their links: a change seen', async () => {
  const github = gitHub();
  const result = await importFromConnector('github', { keys: ['acme/shop#12', 'acme/shop#99', 'acme/shop#15'], dryRun: false }, github);
  assert.deepEqual(result.items.map((i) => i.key), ['SHOP-12']);
  assert.deepEqual(result.warnings, ['acme/shop#99 is not on GitHub, or a token is needed to see it', 'acme/shop#15 is a pull request, not an issue']);
  assert.equal(getRequirement('SHOP-12').source, 'github');
  github.issues[12].title = 'Refund an order within 14 days';
  const again = await importFromConnector('github', { sync: true }, github);
  assert.deepEqual(again.items.map((i) => [i.key, i.status]), [['SHOP-12', 'changed']]);
  assert.equal(github.calls.at(-1).path, '/repos/acme/shop/issues/12', 'read again from its link');
  await assert.rejects(importFromConnector('github', { keys: ['shop-12'] }, github), /Not GitHub issues: shop-12 \(e\.g\. owner\/name#12\)/);
  await assert.rejects(importFromConnector('github', {}, github), /Say which issues: a search, or their keys/);
});

test('without a token, public repositories and the rate limit; with one, its account; the limit reached said plainly', async () => {
  assert.deepEqual(await testConnector('github', null, gitHub()), { success: true, text: 'Reads public repositories without a token: 57 of 60 requests left this hour.' });
  const saved = saveConnectorConfig('github', { token: 'ghp_good-token' });
  assert.deepEqual(saved, { token: 'ghp_••••••oken', from: 'settings' });
  const github = gitHub();
  assert.deepEqual(await testConnector('github', null, github), { success: true, text: 'Reads as octo.' });
  assert.equal(github.calls[0].auth, 'Bearer ghp_good-token');
  assert.match((await testConnector('github', { token: 'bad' }, gitHub())).error, /GitHub refused the token/);
  assert.equal(saveConnectorConfig('github', { token: '' }).from, 'default', 'removed: public repositories again');
  assert.equal(connectorConfig('github').token, undefined);
  await assert.rejects(importFromConnector('github', { query: 'repo:acme/shop' }, gitHub({ limited: true })), /GitHub's limit of requests is reached \(60 an hour without a token\): set a token, or wait/);
  await assert.rejects(importFromConnector('xray', { query: 'x' }), /Xray holds no requirements to read/);
  await assert.rejects(importFromConnector('notion-x', { query: 'x' }), /No connector "notion-x": jira, xray, github/);
});
