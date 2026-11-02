// Unit tests for Jira (lib/jira.js): the connection kept, Atlassian documents read as text,
// stories read by a JQL query (page after page), by their keys (one that does not exist
// told), or again (sync) to see which changed — imported as requirements. The Jira site is a
// stand-in answering as Jira Cloud's REST API v3 does. On a database of their own.
// Run with: node --test test/jira.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'jira-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const {
  jiraConfig, maskedJiraConfig, saveJiraConfig, siteOf, jiraClient, testJira, jiraProjects, adfToText, importFromJira,
} = await import('../lib/jira.js');
const { getRequirement } = await import('../lib/requirements.js');

const text = (t) => ({ type: 'text', text: t });
const paragraph = (...content) => ({ type: 'paragraph', content });
const list = (type, ...items) => ({ type, content: items.map((item) => ({ type: 'listItem', content: Array.isArray(item) ? item : [paragraph(text(item))] })) });
const doc = (...content) => ({ type: 'doc', version: 1, content });

/** Jira's stories, as the stand-in site holds them. */
function stories() {
  return {
    'SHOP-1': {
      summary: 'Refund an order', priority: { name: 'Highest' }, customfield_10050: null,
      description: doc(
        paragraph(text('As a buyer I want my money back.')),
        { type: 'heading', attrs: { level: 3 }, content: [text('Acceptance criteria')] },
        list('bulletList', 'Refused after 14 days', 'The refund shows in the history'),
      ),
    },
    'SHOP-2': {
      summary: 'Pay by card', priority: { name: 'Low' }, description: doc(paragraph(text('Card payments.'))),
      customfield_10050: doc(list('orderedList', 'A declined card shows "Payment refused"', 'The order stays unpaid')),
    },
  };
}

/** A Jira Cloud site: its REST API v3, answering as the real one does; what it was asked. */
function site({ token = 'good-token', issues = stories() } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: pathname + search, body });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (init.headers.Authorization !== `Basic ${Buffer.from(`qa@example.com:${token}`).toString('base64')}`) return new Response('', { status: 401 });
    if (pathname === '/rest/api/3/myself') return reply(200, { displayName: 'QA Bot', accountId: 'abc' });
    if (pathname === '/rest/api/3/field') return reply(200, [{ id: 'summary', name: 'Summary' }, { id: 'customfield_10050', name: 'Acceptance Criteria', custom: true }]);
    if (pathname === '/rest/api/3/project/search') {
      const types = (...names) => names.map((name) => ({ name, subtask: name === 'Sous-tâche' }));
      return reply(200, { values: [{ key: 'OPS', name: 'Ops', issueTypes: types('Tâche', 'Sous-tâche') }, { key: 'SHOP', name: 'Shop', issueTypes: types('Epic', 'Story', 'Sous-tâche') }] });
    }
    if (pathname === '/rest/api/3/search/jql') {
      const keys = /key in \(([^)]*)\)/.exec(body.jql)?.[1].split(',').map((k) => k.trim());
      const missing = keys?.find((k) => !issues[k]);
      if (missing) return reply(400, { errorMessages: [`An issue with key '${missing}' does not exist for field 'key'.`] });
      const found = (keys ?? Object.keys(issues)).map((key) => ({ key, fields: Object.fromEntries(body.fields.map((f) => [f, issues[key][f]])) }));
      // One issue a page: the second is reached by the token.
      const at = body.nextPageToken ? Number(body.nextPageToken) : 0;
      return reply(200, { issues: found.slice(at, at + 1), ...(at + 1 < found.length ? { nextPageToken: String(at + 1), isLast: false } : { isLast: true }) });
    }
    return reply(404, { errorMessages: [`No ${pathname}`] });
  };
  return { fetch, calls, issues };
}

const CONFIG = { baseUrl: 'https://shop.atlassian.net', email: 'qa@example.com', apiToken: 'good-token' };

test('the connection kept: the token masked when read, kept when given back masked; the environment as a fallback', () => {
  assert.equal(jiraConfig(), null);
  process.env.JIRA_BASE_URL = 'https://env.atlassian.net/';
  process.env.JIRA_EMAIL = 'env@example.com';
  process.env.JIRA_API_TOKEN = 'env-token-123456';
  assert.deepEqual(jiraConfig(), { baseUrl: 'https://env.atlassian.net', email: 'env@example.com', apiToken: 'env-token-123456', from: 'env' });
  const saved = saveJiraConfig({ baseUrl: 'https://shop.atlassian.net/jira/software/projects/SHOP/boards/1', email: 'qa@example.com', apiToken: 'good-token' });
  assert.deepEqual(saved, { baseUrl: 'https://shop.atlassian.net', email: 'qa@example.com', apiToken: 'good••oken', from: 'settings' });
  saveJiraConfig({ baseUrl: 'https://shop.atlassian.net', email: 'qa@example.com', apiToken: saved.apiToken });
  assert.equal(jiraConfig().apiToken, 'good-token', 'masked: the saved one kept');
  assert.throws(() => siteOf('http://shop.atlassian.net'), /over https/);
  assert.throws(() => siteOf('shop'), /Not a Jira site address/);
  assert.throws(() => saveJiraConfig({ baseUrl: 'https://x.atlassian.net', email: '', apiToken: 't' }), /needs the account's email/);
  assert.equal(saveJiraConfig({ baseUrl: '' }), null);
  assert.equal(maskedJiraConfig().from, 'env', 'removed: the environment again');
  delete process.env.JIRA_BASE_URL;
  saveJiraConfig(CONFIG);
});

test('who the connection reads as, the projects and a query for their stories; a refused token said plainly', async () => {
  assert.deepEqual(await testJira(jiraClient(CONFIG, site())), { user: 'QA Bot', site: 'https://shop.atlassian.net' });
  assert.deepEqual(await jiraProjects(jiraClient(CONFIG, site())), [
    { key: 'OPS', name: 'Ops', jql: 'project = OPS AND issuetype in standardIssueTypes() ORDER BY key' },
    { key: 'SHOP', name: 'Shop', jql: 'project = SHOP AND issuetype = Story ORDER BY key' },
  ], "a project's stories to start from; without a Story type, its issues but sub-tasks");
  await assert.rejects(testJira(jiraClient({ ...CONFIG, apiToken: 'bad' }, site())), /refused the email and API token/);
  assert.throws(() => jiraClient(null), /No Jira site set/);
});

test('an Atlassian document as text: lines, list items (nested, tasks), a table, a mention', () => {
  const adf = doc(
    paragraph(text('Hello '), { type: 'mention', attrs: { text: '@Ana' } }, { type: 'hardBreak' }, text('next line')),
    list('bulletList', 'one', [paragraph(text('two')), list('bulletList', 'two-a')]),
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('todo')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph(text('A'))] }, { type: 'tableCell', content: [paragraph(text('B'))] }] }] },
    { type: 'codeBlock', content: [text('npm test')] },
    paragraph({ type: 'inlineCard', attrs: { url: 'https://x.test' } }),
  );
  assert.equal(adfToText(adf), 'Hello @Ana\nnext line\n- one\n- two\n  - two-a\n- [x] done\n- [ ] todo\nA | B\nnpm test\nhttps://x.test');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText('plain'), 'plain');
});

test('stories a query finds, page after page: criteria from their field, else from the description', async () => {
  const jira = site();
  const result = await importFromJira({ jql: 'project = SHOP ORDER BY key' }, { client: jiraClient(CONFIG, jira) });
  assert.deepEqual(result.items.map((i) => [i.key, i.status, i.priority, i.source, i.url, i.criteria]), [
    ['SHOP-1', 'new', 'high', 'jira', 'https://shop.atlassian.net/browse/SHOP-1', ['Refused after 14 days', 'The refund shows in the history']],
    ['SHOP-2', 'new', 'low', 'jira', 'https://shop.atlassian.net/browse/SHOP-2', ['A declined card shows "Payment refused"', 'The order stays unpaid']],
  ]);
  assert.equal(result.items[0].description, 'As a buyer I want my money back.');
  const searches = jira.calls.filter((c) => c.path === '/rest/api/3/search/jql');
  assert.deepEqual(searches.map((c) => c.body.nextPageToken ?? null), [null, '1'], 'the second page by its token');
  assert.deepEqual(searches[0].body.fields, ['summary', 'description', 'priority', 'issuetype', 'status', 'customfield_10050']);
  assert.equal(result.saved, false);
  assert.equal(getRequirement('SHOP-1'), null, 'a dry run saves nothing');
});

test('saved, then read again (sync): unchanged — until the story changes in Jira', async () => {
  const jira = site();
  const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
  await importFromJira({ jql: 'project = SHOP', projectId: project, dryRun: false }, { client: jiraClient(CONFIG, jira) });
  assert.deepEqual([getRequirement('SHOP-2').source, getRequirement('SHOP-2').project_id, getRequirement('SHOP-2').criteria.length], ['jira', project, 2]);
  const again = await importFromJira({ sync: true, projectId: project }, { client: jiraClient(CONFIG, jira) });
  assert.deepEqual(again.items.map((i) => i.status), ['unchanged', 'unchanged']);
  assert.match(jira.calls.at(-2).body.jql, /^key in \(SHOP-1, SHOP-2\) ORDER BY key$/);
  jira.issues['SHOP-1'].summary = 'Refund an order within 14 days';
  const changed = await importFromJira({ sync: true }, { client: jiraClient(CONFIG, jira) });
  assert.deepEqual(changed.items.map((i) => [i.key, i.status]), [['SHOP-1', 'changed'], ['SHOP-2', 'unchanged']]);
});

test('by their keys: one that is not in Jira is told, the others read', async () => {
  const result = await importFromJira({ keys: ['shop-2', 'SHOP-99'] }, { client: jiraClient(CONFIG, site()) });
  assert.deepEqual(result.items.map((i) => i.key), ['SHOP-2']);
  assert.deepEqual(result.warnings, ['SHOP-99 is not in Jira, or this account cannot see it']);
  await assert.rejects(importFromJira({ keys: ['nope'] }, { client: jiraClient(CONFIG, site()) }), /Not Jira keys: NOPE/);
  await assert.rejects(importFromJira({}, { client: jiraClient(CONFIG, site()) }), /a JQL query, or their keys/);
  db.prepare("DELETE FROM requirements WHERE source = 'jira'").run();
  await assert.rejects(importFromJira({ sync: true }, { client: jiraClient(CONFIG, site()) }), /No requirement imported from Jira yet/);
});
