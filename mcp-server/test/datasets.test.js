// Unit tests for the datasets of a project (lib/datasets.js): a CSV, a JSON list or an Excel
// sheet read as a table of values; a test bound to one plays one row per run, each column a
// variable over its defaults, and a campaign plays every row, each told apart; any test reads a
// value of one ({{users[2].email}}); the exported code carries them. The agent creating a test
// is told them, and a recording plays one. The extension is a stand-in. On a database of their
// own, thrown away after.
// Run with: node --test test/datasets.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'datasets-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { parseDataset, saveDataset, listDatasets, bindDataset, datasetOfTest, deleteDataset, nameOf, datasetLines, datasetVariables, withColumnsOf } = await import('../lib/datasets.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { startCampaign, getCampaign, junitReport } = await import('../lib/campaigns.js');
const { generateTestCode } = await import('../lib/codegen/index.js');
const { defaultStepDefinitions } = await import('../lib/gherkin/default-step-definitions.js');
const { projectBrief } = await import('../lib/requirement-design.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
const other = db.prepare("INSERT INTO projects (name) VALUES ('Other') RETURNING id").get().id;
const USERS_CSV = 'email;password;name\nbob@x.dev;pw1;Bob\nann@x.dev;"p;w2";Ann\n';

test('a CSV, a JSON list, an Excel sheet: columns named as variables, every value a text', async () => {
  assert.deepEqual(parseDataset({ filename: 'u.csv', content: 'E-mail,Mot de passe,Rôle\nbob@x.dev,secret,admin\n\n' }),
    { columns: ['e_mail', 'mot_de_passe', 'role'], rows: [{ e_mail: 'bob@x.dev', mot_de_passe: 'secret', role: 'admin' }] });
  assert.deepEqual(parseDataset({ filename: 'u.json', content: '{"users": [{"email": "a@x", "age": 30}, {"email": "b@x", "tags": ["x"]}]}' }),
    { columns: ['email', 'age', 'tags'], rows: [{ email: 'a@x', age: '30', tags: '' }, { email: 'b@x', age: '', tags: '["x"]' }] });
  const xlsx = await readFile(new URL('./fixtures/users.xlsx', import.meta.url));
  assert.deepEqual(parseDataset({ filename: 'users.xlsx', content: xlsx }).rows[1], { e_mail: 'ann@x.dev', mot_de_passe: 'pw2', role: 'user' });
  assert.throws(() => parseDataset({ filename: 'u.csv', content: 'email\n' }), /No row of values/);
  assert.throws(() => parseDataset({ filename: 'u.json', content: '[1, 2]' }), /list of objects/);
  assert.equal(nameOf('Utilisateurs de test.csv'), 'Utilisateurs_de_test');
});

test('saved in a project, replaced by its name; a test is bound to one of its own project only', () => {
  const { dataset } = saveDataset(project, { filename: 'users.csv', content: USERS_CSV });
  assert.deepEqual([dataset.name, dataset.columns, dataset.row_count], ['users', ['email', 'password', 'name'], 2]);
  assert.equal(dataset.rows[1].password, 'p;w2', 'a quoted value keeps its delimiter');
  assert.equal(saveDataset(project, { name: 'users', rows: [{ email: 'carl@x.dev', password: 'pw3', name: 'Carl' }, ...dataset.rows] }).dataset.row_count, 3, 'replaced');
  saveDataset(project, { name: 'users', filename: 'users.csv', content: USERS_CSV });
  assert.equal(saveDataset(project, { name: '2nd', rows: [{ a: '1' }] }).status, 400);
  assert.equal(saveDataset(other, { name: 'theirs', rows: [{ a: '1' }] }).dataset.name, 'theirs');

  saveTest({ name: 'login', variables: {}, steps: [] });
  db.prepare("UPDATE tests SET project_id = ? WHERE name = 'login'").run(project);
  assert.equal(bindDataset('login', 'theirs').status, 404, "a dataset of another project is not found by name");
  const theirs = listDatasets(other)[0];
  assert.equal(bindDataset('login', theirs.id).status, 400);
  assert.equal(bindDataset('login', 'users').dataset.name, 'users');
  assert.deepEqual(listDatasets(project).find((d) => d.name === 'users').used_by, ['login']);
  assert.equal(bindDataset('login', null).dataset, null);
  assert.equal(datasetOfTest('login'), null);
});

/** The extension, stood in for: the values typed, and a page that says back every one typed (runs may go side by side). */
function extension() {
  const typed = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      typed.push(params.steps.filter((s) => s.command === 'fill').map((s) => s.params.value));
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 9 })) };
    }
    if (command === 'execute_js') return { result: { value: `Welcome ${typed.flat().join(' ')}`, pageUrl: 'https://shop.test/' } };
    if (command === 'close_window') return {};
    return {};
  };
  return { sendCommand, typed };
}

function loginTest(name) {
  saveTest({
    name, variables: { email: { type: 'text', defaultValue: 'nobody@x.dev' }, greeting: { type: 'text', defaultValue: 'Hi' } },
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test/login' } },
      { command: 'fill', params: { selector: '#email', value: '{{email}}' } },
      { command: 'fill', params: { selector: '#password', value: '{{password}}' } },
      { command: 'fill', params: { selector: '#admin', value: '{{users[1].name}}' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#welcome', expected: '{{email}}' } },
    ],
  });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
  bindDataset(name, 'users');
}

test('a bound test plays a row: the first unless told, its columns over the defaults; the run says which', async () => {
  loginTest('login rows');
  const { sendCommand, typed } = extension();
  const first = await executeTest('login rows', {}, null, null, true, sendCommand, 'test');
  const second = await executeTest('login rows', {}, null, null, true, sendCommand, 'test', null, null, { row: 2 });
  assert.deepEqual(typed, [['bob@x.dev', 'pw1', 'Bob'], ['ann@x.dev', 'p;w2', 'Bob']], 'a value of a dataset read by name ({{users[1].name}})');
  assert.equal(second.values.greeting, 'Hi', 'a variable no column has keeps its default');
  assert.deepEqual(db.prepare('SELECT data_row FROM test_executions WHERE id IN (?, ?) ORDER BY id').all(first.executionId, second.executionId).map((r) => r.data_row), [1, 2]);
  await assert.rejects(executeTest('login rows', {}, null, null, true, sendCommand, 'test', null, null, { row: 3 }), /has 2 row\(s\), numbered from 1: no row 3/);
  const overridden = await executeTest('login rows', { email: 'me@x.dev' }, null, null, true, sendCommand, 'test', null, null, { row: 2 });
  assert.equal(overridden.values.email, 'me@x.dev', 'a value given to the run wins over the row');
});

test('a campaign plays every row of a bound test, each told apart in its report', async () => {
  loginTest('login campaign');
  saveTest({ name: 'plain', variables: {}, steps: [{ command: 'navigate', params: { url: 'https://shop.test' } }] });
  db.prepare("UPDATE tests SET project_id = ? WHERE name = 'plain'").run(project);
  const { sendCommand } = extension();
  const { campaign, finished } = startCampaign({ tests: ['login campaign', 'plain'] }, { sendCommand });
  assert.equal(campaign.total, 3);
  await finished;
  const done = getCampaign(campaign.id);
  assert.deepEqual(done.runs.map((r) => [r.label, r.row, r.status]), [
    ['login campaign [row 1]', 1, 'passed'], ['login campaign [row 2]', 2, 'passed'], ['plain', null, 'passed'],
  ]);
  assert.match(junitReport(done), /<testcase name="login campaign \[row 2\]"/);

  deleteDataset(listDatasets(project).find((d) => d.name === 'users').id);
  assert.equal(datasetOfTest('login campaign'), null, 'its dataset deleted, the test runs once');
  saveDataset(project, { filename: 'users.csv', content: USERS_CSV });
});

test('the exported code carries the rows: a Playwright test per row, an Examples row per row', () => {
  const datasets = { users: [{ email: 'bob@x.dev', password: 'pw1' }, { email: 'ann@x.dev', password: 'pw|2' }] };
  const t = {
    name: 'login', project_id: project, dataset: 'users', datasets, variables: { email: { defaultValue: 'x@x' } },
    steps: [{ command: 'fill', params: { selector: '#email', value: '{{email}}' } }, { command: 'fill', params: { selector: '#password', value: '{{password}}' } }],
  };
  const [spec] = generateTestCode(t, 'playwright-plain').files;
  assert.match(spec.content, /for \(const \[index, ROW\] of DATASETS\['users'\]\.entries\(\)\) \{\n {2}test\(`login — row \$\{index \+ 1\}`/);
  assert.match(spec.content, /computeVariables\(\{ \.\.\.DEFAULTS, \.\.\.ROW \}, \{ language: 'en', datasets: \(name\) => DATASETS\[name\] \}\)/);

  const definitions = defaultStepDefinitions('en').map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const feature = generateTestCode(t, 'playwright-cucumber', () => definitions).files.find((f) => f.path.endsWith('.feature')).content;
  assert.match(feature, /Examples:\n {6}\| email \| password \|\n {6}\| bob@x\.dev \| pw1 \|\n {6}\| ann@x\.dev \| pw\\\|2 \|\n$/);
});

test('the agent creating a test is told the datasets: a value taken from one, not made up', () => {
  const lines = datasetLines(project);
  assert.deepEqual(lines, ['- users: email, password, name — 2 row(s); row 1: email "bob@x.dev", password "pw1", name "Bob"']);
  const brief = projectBrief({ id: project, name: 'Shop' }, { datasets: lines });
  assert.match(brief, new RegExp(`Pass project_id: ${project} to start_recording`));
  assert.match(brief, /tables of values to test with \(rows numbered from 1\):\n- users: email[\s\S]*rather than\nmake one up: type \{\{users\[1\]\.email\}\}/);
  assert.match(brief, /pass dataset: "users" to start_recording too and type \{\{email\}\}/);
  assert.doesNotMatch(projectBrief({ id: project, name: 'Shop' }), /datasets/, 'none, nothing said');
  assert.deepEqual(datasetLines(null), []);
});

/** An agent connected over MCP, with the browser and recording tools, the extension a stand-in. */
async function agent(sendCommand) {
  const connectionId = 'datasets-agent';
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, { sendCommand, getProfiles: () => new Map() });
  registerTestTools(server, { sendCommand });
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text,
    close: async () => { await client.close(); dropConnection(connectionId); },
  };
}

test('a recording plays a dataset: {{email}} types its row 1, the test saved in the project, bound to it', async () => {
  const typed = [];
  const { call, close } = await agent(async (_profile, command, params) => {
    if (command === 'fill') typed.push(params.value);
    if (command === 'execute_js') return { result: { value: 'Welcome Bob', pageUrl: 'https://shop.test/home' } };
    return { tabId: 5, windowId: 50, pageUrl: 'https://shop.test/login' };
  });
  assert.match(await call('start_recording', { name: 'played', dataset: 'users' }), /A dataset belongs to a project: pass its project_id/);
  assert.match(await call('start_recording', { name: 'played', project_id: project, dataset: 'clients' }), /No dataset "clients" in project \d+: its datasets are users/);
  assert.match(await call('start_recording', { name: 'played', project_id: project, dataset: 'users' }),
    /It plays the dataset "users" \(2 rows\): type \{\{email\}\}, \{\{password\}\}, \{\{name\}\} — the values of its row 1 now/);
  await call('navigate', { url: 'https://shop.test/login' });
  await call('fill', { selector: '#email', value: '{{email}}' });
  await call('fill', { selector: '#password', value: 'pw1' });
  await call('fill', { selector: '#name', value: '{{users[2].name}}' });
  await call('fill', { selector: '#qty', value: '1' });
  assert.deepEqual(typed, ['bob@x.dev', 'pw1', 'Ann', '1'], 'its row 1, and a value of any row, typed live');
  assert.match(await call('stop_recording'), /Bound to the dataset "users": it runs once per row of it \(2 rows\)/);
  await call('add_assertion', { test_name: 'played', assertion_type: 'text_contains', selector: '#welcome', expected: 'Bob' });
  await close();

  const saved = loadTest('played');
  assert.equal(saved.project_id, project);
  assert.equal(datasetOfTest('played').name, 'users');
  assert.deepEqual(saved.steps.filter((s) => s.command === 'fill').map((s) => s.params.value), ['{{email}}', '{{password}}', '{{name_2}}', '{{qty}}'],
    "a value of row 1, written {{password}} or not, is its column's; a field of the same name as a column is another variable");
  assert.deepEqual([saved.variables.email.defaultValue, saved.variables.password.defaultValue, saved.variables.name_2.defaultValue], ['bob@x.dev', 'pw1', '{{users[2].name}}']);
  assert.equal(saved.steps.at(-1).assertion.expected, '{{name}}', 'what its row shows, not typed, is checked as its column');
  assert.equal(saved.variables.name.defaultValue, 'Bob');
  assert.deepEqual(withColumnsOf({ qty: {} }, datasetVariables('played'), 'Hi {{name}}, {{qty}} {{zzz}}'), { qty: {}, name: { type: 'text', defaultValue: 'Bob' } },
    'a column written {{name}} in the expected value is declared too');

  const { sendCommand, typed: replayed } = extension();
  const run = await executeTest('played', {}, null, null, true, sendCommand, 'test', null, null, { row: 2 });
  assert.deepEqual(replayed, [['ann@x.dev', 'p;w2', 'Ann', '1']], 'each row at run');
  assert.equal(run.assertionsPassed, 1, 'Ann checked on row 2');
});

test('a recording of a project reads its datasets; one with none says nothing of them', async () => {
  const typed = [];
  const { call, close } = await agent(async (_profile, command, params) => {
    if (command === 'fill') typed.push(params.value);
    return { tabId: 6, windowId: 60 };
  });
  assert.match(await call('start_recording', { name: 'one user', project_id: project }), /The datasets of the project — take a value from one rather than make one up, as \{\{users\[1\]\.email\}\}:\n- users: email/);
  await call('fill', { selector: '#email', value: '{{users[2].email}}' });
  assert.deepEqual(typed, ['ann@x.dev']);
  await call('stop_recording');
  assert.equal(datasetOfTest('one user'), null, 'bound to none');
  assert.equal(loadTest('one user').variables.email.defaultValue, '{{users[2].email}}', 'read at each run');

  const empty = db.prepare("INSERT INTO projects (name) VALUES ('Empty') RETURNING id").get().id;
  assert.doesNotMatch(await call('start_recording', { name: 'bare', project_id: empty }), /dataset/);
  await call('stop_recording');
  await close();
});
