// Unit tests for the rows a test keeps of its own (lib/datasets.js testRows, its Data tab's
// table): each column a variable of the test; a run per row — run_test, the dashboard's run
// (executeRows), a campaign —, each run saying which row it played and its values, a password
// hidden, a secret never in clear; computed values in a row; its Gherkin a Scenario Outline with
// two rows or more, saved back as its rows (lib/gherkin/outline.js); its exported code. The
// extension is a stand-in. On a database of their own, thrown away after.
// Run with: node --test test/test-rows.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = await mkdtemp(join(tmpdir(), 'test-rows-'));
process.env.IZITEST_DB_PATH = join(dir, 'test.db');
process.env.IZITEST_SECRET_KEY_FILE = join(dir, 'secret.key');
delete process.env.IZITEST_SECRET_KEY;
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTestRows, testRows, rowsOfTest, rowsToPlay, saveDataset, bindDataset, codeData } = await import('../lib/datasets.js');
const { saveSecret } = await import('../lib/secrets.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { executeTest, executeRows } = await import('../lib/test-execute.js');
const { startCampaign, getCampaign, junitReport, formatCampaign } = await import('../lib/campaigns.js');
const { generateTestCode } = await import('../lib/codegen/index.js');
const { seedProjectStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { withExamples, HIDDEN_CELL } = await import('../lib/gherkin/outline.js');
const { serializeTestToFeatureWith } = await import('../lib/gherkin/serialize.js');
const { featurePhrases, examplesOf } = await import('../lib/gherkin/parse.js');
const { defaultStepDefinitions } = await import('../lib/gherkin/default-step-definitions.js');
const { AGENT_TOOLS } = await import('../lib/agent/tools.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');
const { apiRouter } = await import('../lib/api.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
const french = db.prepare("INSERT INTO projects (name, language) VALUES ('Boutique', 'fr') RETURNING id").get().id;
seedProjectStepDefinitions(project);
seedProjectStepDefinitions(french);
saveSecret(project, 'PW', { value: 'S3cret-of-bob' });
const tool = (name) => AGENT_TOOLS.find((t) => t.name === name);
const DEFAULTS = defaultStepDefinitions('en').map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));

/** A contact form: a name, a quantity, a total computed from it, a password. */
function contactTest(name, projectId = project) {
  saveTest({
    name,
    variables: {
      first_name: { type: 'text', defaultValue: 'Nobody' },
      qty: { type: 'text', defaultValue: '1' },
      total: { type: 'text', defaultValue: '{{qty * 2}}' },
      password: { type: 'text', defaultValue: 'pw-default' },
    },
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test/contact' } },
      { command: 'fill', params: { selector: '#first', value: '{{first_name}}' } },
      { command: 'fill', params: { selector: '#qty', value: '{{qty}}' } },
      { command: 'fill', params: { selector: '#total', value: '{{total}}' } },
      { command: 'fill', params: { selector: '#password', value: '{{password}}' } },
    ],
  });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(projectId, name);
}

/** The extension, stood in for: the values typed, a run each; `failWhen(values)` fails one. */
function extension(failWhen = () => false) {
  const typed = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      const values = params.steps.filter((s) => s.command === 'fill').map((s) => s.params.value);
      typed.push(values);
      const results = params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 9 }));
      if (failWhen(values)) {
        results[results.length - 1] = { ...results.at(-1), status: 'failed', error: 'No element #password' };
        throw Object.assign(new Error(`Step ${results.length} failed`), { results });
      }
      return { results };
    }
    if (command === 'execute_js') return { result: { value: '', pageUrl: 'https://shop.test/' } };
    return {};
  };
  return { sendCommand, typed };
}

test('rows of its own: each column a variable of the test, every value a text; none, and the test plays its defaults', () => {
  contactTest('contact rows');
  assert.equal(rowsOfTest('contact rows'), null);
  assert.deepEqual(rowsToPlay('contact rows'), [null], 'no row: one run');

  const saved = saveTestRows('contact rows', [{ first_name: 'Ann', qty: 3 }, { first_name: 'Bob', qty: null }]);
  assert.deepEqual(saved.rows, [{ first_name: 'Ann', qty: '3' }, { first_name: 'Bob', qty: '' }]);
  assert.match(saveTestRows('contact rows', [{ city: 'Paris' }]).error, /\{\{city\}\}: no variable of the test — each column is one of its variables \(\{\{first_name\}\}/);
  assert.equal(saveTestRows('contact rows', { first_name: 'Ann' }).status, 400);
  assert.equal(saveTestRows('no such test', []).status, 404);
  assert.deepEqual(testRows('contact rows').length, 2, 'what was refused changed nothing');

  const played = rowsOfTest('contact rows');
  assert.deepEqual([played.own, played.columns, played.row_count], [true, ['first_name', 'qty', 'total', 'password'], 2]);
  assert.deepEqual(rowsToPlay('contact rows'), [1, 2]);
  assert.deepEqual(rowsToPlay('contact rows', 2), [2]);

  // Bound to a dataset, the test plays the dataset's rows; its own wait until it is unbound.
  saveDataset(project, { name: 'people', rows: [{ first_name: 'Carl' }, { first_name: 'Dan' }, { first_name: 'Eve' }] });
  bindDataset('contact rows', 'people');
  assert.deepEqual([rowsOfTest('contact rows').name, rowsOfTest('contact rows').row_count], ['people', 3]);
  bindDataset('contact rows', null);
  assert.equal(rowsOfTest('contact rows').row_count, 2);

  assert.deepEqual(saveTestRows('contact rows', []).rows, []);
  assert.equal(rowsOfTest('contact rows'), null, 'rows removed');
});

test('a run per row, one after the other: its values over the defaults, computed ones too; each run says its row and its values, a password hidden, a secret never in clear', async () => {
  contactTest('contact run');
  saveTestRows('contact run', [
    { first_name: 'Ann', qty: '3', password: 'pw-of-ann' },
    { first_name: 'Bob', password: '{{secret.PW}}' },
    { first_name: 'Cid', total: '{{qty * 10}}' },
  ]);
  const { sendCommand, typed } = extension((values) => values[0] === 'Bob');
  const events = [];
  const { rows, outcomes } = await executeRows('contact run', { onRow: (e) => events.push(e.type) },
    (row) => executeTest('contact run', {}, null, null, true, sendCommand, 'test', null, null, row ? { row } : {}));

  assert.deepEqual(rows, [1, 2, 3]);
  assert.deepEqual(typed, [['Ann', '3', '6', 'pw-of-ann'], ['Bob', '1', '2', 'S3cret-of-bob'], ['Cid', '1', '10', 'pw-default']],
    'a value a row leaves out is the default; a computed one works out with the row\'s values; the secret is typed');
  assert.deepEqual(outcomes.map((o) => [o.row, o.status]), [[1, 'success'], [2, 'failed'], [3, 'success']], 'a failed row does not stop the next');
  assert.deepEqual(outcomes.map((o) => o.label), ['row 1 — Ann, 3', 'row 2 — Bob, {{secret.PW}}', 'row 3 — Cid, {{qty * 10}}']);
  assert.deepEqual(events, ['rows_started', 'row_started', 'row_finished', 'row_started', 'row_finished', 'row_started', 'row_finished']);

  const runs = db.prepare('SELECT data_row, data_values, variables FROM test_executions WHERE test_name = ? ORDER BY id').all('contact run');
  assert.deepEqual(runs.map((r) => r.data_row), [1, 2, 3]);
  assert.deepEqual(JSON.parse(runs[0].data_values), { first_name: 'Ann', qty: '3', password: '(hidden)' }, 'the row as played, a password hidden');
  assert.deepEqual(JSON.parse(runs[1].data_values), { first_name: 'Bob', password: '{{secret.PW}}' }, 'a secret by its name');
  assert.ok(!JSON.stringify(runs).includes('S3cret-of-bob'), 'the secret\'s value is kept nowhere');

  // The row asked, only; stopped, the rows after are not played.
  const one = await executeRows('contact run', { row: 3 }, (row) => executeTest('contact run', {}, null, null, true, sendCommand, 'test', null, null, { row }));
  assert.deepEqual(one.outcomes.map((o) => o.row), [3]);
  let played = 0;
  const stopped = await executeRows('contact run', { stopped: () => played >= 1 }, async (row) => { played += 1; return { executionId: row }; });
  assert.deepEqual(stopped.outcomes.map((o) => o.row), [1]);
  // Debugged, or resumed at a step: one row, the first unless told.
  assert.deepEqual((await executeRows('contact run', { one: true }, async () => ({}))).rows, [null]);
  await assert.rejects(executeTest('contact run', {}, null, null, true, sendCommand, 'test', null, null, { row: 4 }), /The test has 3 row\(s\), numbered from 1: no row 4/);
});

/** An agent connected over MCP, with the browser and test tools, the extension a stand-in. */
async function agent(sendCommand) {
  const connectionId = 'test-rows-agent';
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

test('run_test plays every row, each told, a failed one with how to repair it; row plays one; list_tests says how many', async () => {
  contactTest('contact mcp');
  saveTestRows('contact mcp', [{ first_name: 'Ann' }, { first_name: 'Bob' }]);
  const { sendCommand, typed } = extension((values) => values[0] === 'Ann');
  const { call, close } = await agent(sendCommand);
  const all = await call('run_test', { name: 'contact mcp' });
  assert.match(all, /^Test "contact mcp" played 2 rows of its rows, a run each: 1 passed, 1 failed\./);
  assert.match(all, /- row 1 — Ann of its rows: FAILED \(execution #\d+\) — No element #password/);
  assert.match(all, /- row 2 — Bob of its rows: passed \(execution #\d+\)/);
  assert.match(all, /run_test\(name="contact mcp", row=1\) plays that row alone and stops there/, 'the page is no longer where row 1 failed');

  const alone = await call('run_test', { name: 'contact mcp', row: 1 });
  assert.match(alone, /TEST EXECUTION FAILED \(execution #\d+\), row 1 — Ann of its rows/);
  assert.match(alone, /run_test\(name="contact mcp", start_step=6, row=1\)/, 'resumed on that row');
  assert.match(await call('run_test', { name: 'contact mcp', row: 2 }), /executed successfully \(execution #\d+\), row 2 — Bob of its rows\./);
  assert.equal(typed.length, 4);
  assert.match(await call('list_tests'), /- contact mcp: [^\n]*\n {4}Variables: [^\n]*\n {4}Rows: 2 of its rows — run_test plays every row, a run each/);
  await close();
});

test('a campaign plays each row of a test\'s own; its reports show the row played and its values', async () => {
  contactTest('contact campaign');
  saveTestRows('contact campaign', [{ first_name: 'Ann', password: 'pw-ann' }, { first_name: 'Bob' }]);
  const { sendCommand } = extension();
  const { campaign, finished } = startCampaign({ tests: ['contact campaign'] }, { sendCommand });
  assert.equal(campaign.total, 2);
  assert.deepEqual(campaign.runs.map((r) => r.row_label), ['row 1 — Ann, (hidden)', 'row 2 — Bob'], 'not run yet: the rows as they are');
  await finished;
  const done = getCampaign(campaign.id);
  assert.deepEqual(done.runs.map((r) => [r.label, r.status, r.row_values]), [
    ['contact campaign [row 1]', 'passed', { first_name: 'Ann', password: '(hidden)' }],
    ['contact campaign [row 2]', 'passed', { first_name: 'Bob' }],
  ]);
  const junit = junitReport(done);
  assert.match(junit, /<testcase name="contact campaign \[row 1\]"[^>]*>\n {6}<properties>\n {8}<property name="data_row" value="1"\/>\n {8}<property name="data_values" value="first_name = Ann, password = \(hidden\)"\/>/);
  assert.ok(!junit.includes('pw-ann'));
  if (typeof formatCampaign === 'function') assert.ok(!formatCampaign(done).includes('pw-ann'));
});

test('its Gherkin: a Scenario Outline with two rows or more, the Examples its rows; one row or none, a Scenario', () => {
  const t = { name: 'contact', variables: loadTestVariables(), steps: [
    { command: 'navigate', params: { url: 'https://shop.test/contact' } },
    { command: 'fill', params: { selector: '#first', value: '{{first_name}}' } },
    { command: 'fill', params: { selector: '#password', value: '{{password}}' } },
  ] };
  const feature = serializeTestToFeatureWith(t, DEFAULTS);
  const rows = [{ first_name: 'Ann', qty: '3', password: 'pw-ann' }, { first_name: 'B|o\\b', password: '{{secret.PW}}' }];
  const outline = withExamples(feature, { rows, variables: t.variables });
  assert.match(outline, /^Feature: contact\n\n {2}Scenario Outline: contact\n {4}Given I am on "https:\/\/shop\.test\/contact"\n {4}When I fill "#first" with "<first_name>"\n {4}And I fill "#password" with "<password>"\n\n {4}Examples:\n/);
  assert.match(outline, /\n {6}\| first_name \| password \| qty \|\n {6}\| Ann \| \(hidden\) \| 3 \|\n {6}\| B\\\|o\\\\b \| \{\{secret\.PW\}\} \| 1 \|\n$/,
    'the steps\' variables first, then the rows\' other columns; | and \\ escaped; a password hidden, a secret by its name; a value left out, the default');
  assert.equal(withExamples(feature, { rows: rows.slice(0, 1), variables: t.variables }), feature, 'one row: a Scenario');
  assert.equal(withExamples(feature, { rows: [], variables: t.variables }), feature);

  // Read back: <name> is {{name}} again, each line of the Examples a row.
  assert.deepEqual(featurePhrases(outline).map((p) => p.text).slice(1), ['I fill "#first" with "{{first_name}}"', 'I fill "#password" with "{{password}}"']);
  assert.deepEqual(examplesOf(outline).rows, [{ first_name: 'Ann', password: HIDDEN_CELL, qty: '3' }, { first_name: 'B|o\\b', password: '{{secret.PW}}', qty: '1' }]);
  assert.equal(examplesOf(feature), null);
  assert.throws(() => examplesOf(outline.replace('| first_name | password | qty |', '| first_name | first_name | qty |')), /the column "first_name" is twice/);

  const fr = withExamples(serializeTestToFeatureWith({ ...t, language: 'fr' }, defaultStepDefinitions('fr').map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }))), { rows, variables: t.variables, language: 'fr' });
  assert.match(fr, /^# language: fr\nFonctionnalité: contact\n\n {2}Plan du scénario: contact\n[\s\S]*\n\n {4}Exemples:\n {6}\| first_name \| password \| qty \|\n/);
  assert.equal(examplesOf(fr).rows.length, 2);
});

function loadTestVariables() {
  return { first_name: { type: 'text', defaultValue: 'Nobody' }, qty: { type: 'text', defaultValue: '1' }, password: { type: 'text', defaultValue: 'pw-default' } };
}

/** The API, served on a port of its own. */
async function api(fn) {
  const server = createServer((req, res) => apiRouter(req, res, new URL(req.url, 'http://127.0.0.1')).then(() => {
    if (!res.writableEnded) { res.writeHead(404); res.end(); }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn((path, init = {}) => fetch(`${base}${path}`, {
      ...init, headers: { 'Content-Type': 'application/json' }, body: init.body && JSON.stringify(init.body),
    }).then(async (r) => ({ status: r.status, text: await r.clone().text(), body: await r.json().catch(() => null) })));
  } finally {
    server.close();
  }
}

test('the dashboard: rows saved and shown with the test; its Gherkin edited saves its rows; its runs say the row played', async () => {
  contactTest('contact api');
  const url = `/api/tests/${encodeURIComponent('contact api')}`;
  await api(async (call) => {
    assert.match((await call(`${url}/rows`, { method: 'PUT', body: { rows: [{ town: 'x' }] } })).body.error, /\{\{town\}\}: no variable/);
    const saved = await call(`${url}/rows`, { method: 'PUT', body: { rows: [{ first_name: 'Ann', password: 'pw-ann' }, { first_name: 'Bob', qty: '2' }] } });
    assert.equal(saved.status, 200);
    const { test: shown } = (await call(url)).body;
    assert.deepEqual(shown.rows, [{ first_name: 'Ann', password: 'pw-ann' }, { first_name: 'Bob', qty: '2' }], 'its own rows, to edit');
    assert.deepEqual(shown.played_rows, { source: 'test', name: null, columns: ['first_name', 'qty', 'total', 'password'], row_count: 2, row_labels: ['row 1 — Ann, (hidden)', 'row 2 — Bob, 2'] });
    assert.equal(shown.data_rows, undefined);

    // The Gherkin shown: a Scenario Outline. Saved as it is: the same steps, the same rows.
    const feature = (await call(`${url}/feature`)).text;
    assert.match(feature, /Scenario Outline: contact api[\s\S]*When I fill "#first" with "<first_name>"[\s\S]*Examples:\n {6}\| first_name \| qty \| total \| password \|\n {6}\| Ann \| 1 \| \{\{qty \* 2\}\} \| \(hidden\) \|\n {6}\| Bob \| 2 \| \{\{qty \* 2\}\} \| \(hidden\) \|\n$/);
    const steps = loadTest('contact api').steps;
    const same = await call(`${url}/feature`, { method: 'PUT', body: { feature } });
    assert.deepEqual([same.status, same.body.row_count], [200, 2]);
    assert.deepEqual(loadTest('contact api').steps, steps);
    assert.deepEqual(testRows('contact api'), [
      { first_name: 'Ann', qty: '1', total: '{{qty * 2}}', password: 'pw-ann' },
      { first_name: 'Bob', qty: '2', total: '{{qty * 2}}' },
    ], 'a hidden password keeps its value, or stays the default; another value the row left out is now written in it, the default');

    // A row added in the Examples, a column too: a variable of the test.
    const edited = feature.replace('<first_name>"', '<first_name> <last_name>"')
      .replace('| first_name | qty | total | password |', '| first_name | qty | total | password | last_name |')
      .replace(/\| Ann \| 1 \| \{\{qty \* 2\}\} \| \(hidden\) \|/, '| Ann | 1 | {{qty * 2}} | (hidden) | Lee |')
      .replace(/\| Bob \| 2 \| \{\{qty \* 2\}\} \| \(hidden\) \|\n$/, '| Bob | 2 | {{qty * 2}} | (hidden) | Ray |\n      | Cid | 5 | 9 | new-pw | Zed |\n');
    const more = await call(`${url}/feature`, { method: 'PUT', body: { feature: edited } });
    assert.deepEqual([more.status, more.body.row_count, more.body.variables_added], [200, 3, ['last_name']]);
    assert.equal(loadTest('contact api').steps[1].params.value, '{{first_name}} {{last_name}}');
    assert.equal(loadTest('contact api').variables.last_name.defaultValue, 'Lee');
    assert.deepEqual(testRows('contact api')[2], { first_name: 'Cid', qty: '5', total: '9', password: 'new-pw', last_name: 'Zed' });

    // Back to a Scenario: its rows are gone.
    const scenario = (await call(`${url}/feature`)).text
      .replace('Scenario Outline:', 'Scenario:').replace(/\n\n {4}Examples:[\s\S]*$/, '\n').replaceAll(/<(\w+)>/g, '{{$1}}');
    const plain = await call(`${url}/feature`, { method: 'PUT', body: { feature: scenario } });
    assert.deepEqual([plain.status, plain.body.row_count], [200, 0]);
    assert.deepEqual(testRows('contact api'), []);

    // Bound to a dataset, its Examples are the dataset's: changed there, not here.
    saveDataset(project, { name: 'buyers', rows: [{ first_name: 'Al' }, { first_name: 'Bo' }] });
    bindDataset('contact api', 'buyers');
    const bound = (await call(`${url}/feature`)).text;
    assert.match(bound, /\| Al \|/);
    assert.equal((await call(`${url}/feature`, { method: 'PUT', body: { feature: bound } })).status, 200, 'unchanged: saved');
    const refused = await call(`${url}/feature`, { method: 'PUT', body: { feature: bound.replace('| Al |', '| Alf |') } });
    assert.match(refused.body.error, /Its rows are those of the dataset "buyers": change them in Datasets/);
    bindDataset('contact api', null);

    // A run says the row it played, and its values.
    saveTestRows('contact api', [{ first_name: 'Ann', password: 'pw-ann' }, { first_name: 'Bob' }]);
    const { sendCommand } = extension();
    await executeTest('contact api', {}, null, null, true, sendCommand, 'test', null, null, { row: 2 });
    const [run] = (await call(`${url}/executions`)).body.executions;
    assert.deepEqual([run.data_row, run.data_values], [2, { first_name: 'Bob' }]);
    assert.deepEqual((await call(`/api/executions/${run.id}`)).body.execution.data_values, { first_name: 'Bob' });
  });
});

test('an agent: a test from a Scenario Outline has its Examples as rows; save_test_rows; a variable renamed takes its column along; the code carries the rows', async () => {
  const gherkin = [
    'Feature: search',
    '  Scenario Outline: search',
    '    Given I am on "https://shop.test/<city>"',
    '    When I fill "#q" with "<what>"',
    '',
    '    Examples:',
    '      | city | what |',
    '      | paris | bread |',
    '      | lyon | cheese |',
  ].join('\n');
  const created = tool('create_test_from_gherkin').handler({ project_id: project, gherkin, test_name: 'search rows' });
  assert.equal(created.data.rows, 2);
  const t = loadTest('search rows');
  assert.deepEqual(t.steps.map((s) => s.params.url ?? s.params.value), ['https://shop.test/{{city}}', '{{what}}']);
  assert.deepEqual(Object.fromEntries(Object.entries(t.variables).map(([k, v]) => [k, v.defaultValue])), { city: 'paris', what: 'bread' });
  assert.deepEqual(testRows('search rows'), [{ city: 'paris', what: 'bread' }, { city: 'lyon', what: 'cheese' }]);

  assert.match(tool('save_test_rows').handler({ test_name: 'search rows', rows: [{ town: 'x' }] }).error, /\{\{town\}\}: no variable/);
  assert.deepEqual(tool('save_test_rows').handler({ test_name: 'search rows', rows: [{ city: 'nice', what: 'socca' }, { city: 'lille' }] }).data,
    { test: 'search rows', rows: 2, columns: ['city', 'what'] });

  const renamed = tool('add_test_variable').handler({ test_name: 'search rows', step: 2, param: 'value', name: 'product' });
  assert.equal(renamed.data.renamed_from, 'what');
  assert.deepEqual(testRows('search rows'), [{ city: 'nice', product: 'socca' }, { city: 'lille' }]);

  const withRows = { ...loadTest('search rows'), ...codeData(loadTest('search rows')) };
  const [spec] = generateTestCode(withRows, 'playwright-plain').files;
  assert.match(spec.content, /for \(const \[index, ROW\] of DATASETS\['rows'\]\.entries\(\)\) \{\n {2}test\(`search rows — row \$\{index \+ 1\}`/);
  const feature = generateTestCode(withRows, 'playwright-cucumber', () => DEFAULTS).files.find((f) => f.path.endsWith('.feature')).content;
  assert.match(feature, /Examples:\n {6}\| city \| product \|\n {6}\| nice \| socca \|\n {6}\| lille \| bread \|\n$/, 'the Cucumber export: an Examples line per row, the default where a row has none');

  const asGherkin = tool('get_test_as_gherkin').handler({ project_id: project, test_name: 'search rows' }).data.feature;
  assert.match(asGherkin, /Scenario Outline: search rows[\s\S]*\| city \| product \|\n {6}\| nice \| socca \|\n {6}\| lille \| bread \|\n$/);
});

test('how a test with rows last did: the last run of each row counted — one failing, it failed; the list, its page and its requirement say so', async () => {
  const { lastRunOfTest } = await import('../lib/test-status.js');
  const { saveRequirement, linkTest, getRequirement, formatRequirement } = await import('../lib/requirements.js');
  contactTest('contact status');
  const id = db.prepare('SELECT id FROM tests WHERE name = ?').get('contact status').id;
  assert.equal(lastRunOfTest(id), null, 'never run');

  // Without rows: its last run, as it is.
  const { sendCommand } = extension((values) => values[0] === 'Ann');
  await executeTest('contact status', {}, null, null, true, sendCommand, 'test');
  assert.deepEqual([lastRunOfTest(id).status, lastRunOfTest(id).rows], ['success', undefined]);

  // Row 1 fails, row 2 passes, row 3 not run yet: the test failed — its last run alone said passed.
  saveTestRows('contact status', [{ first_name: 'Ann' }, { first_name: 'Bob' }, { first_name: 'Cid' }]);
  const play = (row) => executeTest('contact status', {}, null, null, true, sendCommand, 'test', null, null, { row }).catch(() => {});
  await play(1);
  await play(2);
  assert.equal(db.prepare('SELECT status FROM test_executions WHERE test_id = ? ORDER BY id DESC LIMIT 1').get(id).status, 'success');
  assert.deepEqual([lastRunOfTest(id).status, lastRunOfTest(id).rows], ['failed', { total: 3, played: 2, failed: [1] }]);
  await play(2);
  assert.equal(lastRunOfTest(id).status, 'failed', 'row 2 played again: row 1 still fails');

  const requirement = saveRequirement({ key: 'ROWS-1', title: 'Contact', criteria: ['The form is sent'], projectId: project });
  assert.ok(requirement);
  linkTest('ROWS-1', 'contact status', { criterion: 1 });
  const shown = getRequirement('ROWS-1');
  assert.equal(shown.coverage.status, 'failing');
  assert.match(formatRequirement(shown), /test "contact status" — failed \(row 1 of 3\)/);

  await api(async (call) => {
    const listed = (await call(`/api/tests?project_id=${project}`)).body.tests.find((t) => t.name === 'contact status');
    assert.deepEqual([listed.last_status, listed.last_rows], ['failed', { total: 3, played: 2, failed: [1] }]);
    assert.equal(listed.has_rows, undefined);
    assert.equal((await call('/api/tests/contact%20status/last-run')).body.last_run.status, 'failed');
    const plain = (await call(`/api/tests?project_id=${project}`)).body.tests.find((t) => t.name === 'contact rows');
    assert.equal(plain.last_rows, undefined, 'no rows: as before');
  });

  // Row 1 fixed: played alone, it passes — the test passes, row 3 still not run. A repair being checked is not counted.
  const fixed = extension();
  await executeTest('contact status', {}, null, null, true, fixed.sendCommand, 'test', null, null, { row: 1 });
  assert.deepEqual([lastRunOfTest(id).status, lastRunOfTest(id).rows], ['success', { total: 3, played: 2, failed: [] }]);
  await executeTest('contact status', {}, null, null, true, sendCommand, 'repair', null, null, { row: 1 }).catch(() => {});
  assert.equal(lastRunOfTest(id).status, 'failed');
  assert.equal(lastRunOfTest(id, { excludeTriggers: ['repair', 'explore'] }).status, 'success');
  assert.equal(getRequirement('ROWS-1').coverage.status, 'passing');

  // Rows removed: its last run again.
  saveTestRows('contact status', []);
  assert.equal(lastRunOfTest(id).rows, undefined);
});
