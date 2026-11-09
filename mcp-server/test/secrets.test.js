// Unit tests for the secrets of a project (lib/secrets.js): kept encrypted with a key of this
// machine; written {{secret.NAME}} in a step, typed by the server while recording and at each run;
// never told back — not to the agent recording (a tool's answer, its brief), not in the logs, not
// in a run's record, not in exported code. The extension is a stand-in. On a database and a key
// of their own, thrown away after.
// Run with: node --test test/secrets.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = await mkdtemp(join(tmpdir(), 'secrets-'));
process.env.IZITEST_DB_PATH = join(dir, 'test.db');
process.env.IZITEST_SECRET_KEY_FILE = join(dir, 'secret.key');
delete process.env.IZITEST_SECRET_KEY;
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveSecret, listSecrets, deleteSecret, secretValue, secretLines, redact, redactToolResults } = await import('../lib/secrets.js');
const { log } = await import('../lib/logger.js');
const { computeVariables } = await import('../lib/values.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { generateTestCode } = await import('../lib/codegen/index.js');
const { AGENT_TOOLS } = await import('../lib/agent/tools.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');
const { apiRouter } = await import('../lib/api.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
const other = db.prepare("INSERT INTO projects (name) VALUES ('Other') RETURNING id").get().id;
const PASSWORD = 'S3cr3t!"pw';

test('kept encrypted with a key of this machine, made once (0600); listed without its value', async () => {
  const saved = saveSecret(project, 'SHOP_PASSWORD', { value: PASSWORD, description: 'Password of the test account' });
  assert.deepEqual({ ...saved, updated_at: undefined }, { name: 'SHOP_PASSWORD', description: 'Password of the test account', updated_at: undefined, from_environment: false });
  const row = db.prepare("SELECT value FROM secrets WHERE name = 'SHOP_PASSWORD'").get();
  assert.match(row.value, /^v1:/);
  assert.ok(!row.value.includes(PASSWORD) && !row.value.includes(Buffer.from(PASSWORD).toString('base64')), 'not in the database as it is');
  assert.equal((await stat(process.env.IZITEST_SECRET_KEY_FILE)).mode & 0o777, 0o600);
  assert.equal(secretValue(project, 'SHOP_PASSWORD'), PASSWORD);
  assert.equal(secretValue(other, 'SHOP_PASSWORD'), undefined, "another project's");
  assert.deepEqual(listSecrets(project).map(Object.keys), [['name', 'description', 'updated_at', 'from_environment']], 'never its value');
  assert.deepEqual(secretLines(project), ['- SHOP_PASSWORD: Password of the test account']);
});

test('replaced, described, deleted; a bad name, a missing value, an unknown project refused', () => {
  saveSecret(project, 'TOKEN', { value: 'first-token' });
  saveSecret(project, 'TOKEN', { value: 'second-token' });
  assert.equal(secretValue(project, 'TOKEN'), 'second-token');
  saveSecret(project, 'TOKEN', { description: 'API token' });
  assert.equal(secretValue(project, 'TOKEN'), 'second-token', 'its value kept when only described');
  assert.equal(listSecrets(project).find((s) => s.name === 'TOKEN').description, 'API token');
  assert.match(saveSecret(project, '2FA', { value: 'x' }).error, /letters, digits and _/);
  assert.match(saveSecret(project, 'NEW_ONE', {}).error, /needs a value/);
  assert.match(saveSecret(project, 'TOKEN', { value: '' }).error, /empty/);
  assert.match(saveSecret(9999, 'X', { value: 'y' }).error, /No project 9999/);
  assert.equal(deleteSecret(project, 'TOKEN'), true);
  assert.equal(deleteSecret(project, 'TOKEN'), false);
  assert.equal(secretValue(project, 'TOKEN'), undefined);
});

test('a value copied to another secret does not decrypt there; the environment gives its own', () => {
  saveSecret(project, 'COPY', { value: 'anything-here' });
  const sealed = db.prepare("SELECT value FROM secrets WHERE name = 'SHOP_PASSWORD'").get().value;
  db.prepare("UPDATE secrets SET value = ? WHERE name = 'COPY'").run(sealed);
  assert.throws(() => secretValue(project, 'COPY'), /cannot be read with this machine's key/);
  deleteSecret(project, 'COPY');

  process.env.IZITEST_SECRET_SHOP_PASSWORD = 'from-the-ci';
  try {
    assert.equal(secretValue(project, 'SHOP_PASSWORD'), 'from-the-ci');
    assert.equal(listSecrets(project)[0].from_environment, true);
  } finally {
    delete process.env.IZITEST_SECRET_SHOP_PASSWORD;
  }
});

test('redact puts the reference back: in a text, an object, inside JSON, a log line; a short value or an image left', () => {
  saveSecret(project, 'PIN', { value: '123' });
  assert.equal(redact(`typed ${PASSWORD} in #password`), 'typed {{secret.SHOP_PASSWORD}} in #password');
  assert.equal(redact(JSON.stringify({ value: PASSWORD })), '{"value":"{{secret.SHOP_PASSWORD}}"}', 'escaped as JSON writes it');
  assert.deepEqual(redact({ steps: [{ value: PASSWORD, n: 3 }], image: { type: 'image', data: PASSWORD } }),
    { steps: [{ value: '{{secret.SHOP_PASSWORD}}', n: 3 }], image: { type: 'image', data: PASSWORD } });
  assert.equal(redact('code 123'), 'code 123', 'too short to be told apart');
  deleteSecret(project, 'PIN');

  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    log(`fill #password ${PASSWORD}`);
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(lines, ['[IziTest] fill #password {{secret.SHOP_PASSWORD}}\n']);
});

test('{{secret.NAME}} is worked out with the secrets of the project; one it lacks, or none to read from, is told', () => {
  const secrets = (name) => secretValue(project, name);
  assert.deepEqual(computeVariables({ pw: '{{secret.SHOP_PASSWORD}}' }, { secrets }).values, { pw: PASSWORD });
  assert.deepEqual(computeVariables({ pw: '{{secret.NOPE}}' }, { secrets }).problems, ['{{pw}} — {{secret.NOPE}}: no secret named "NOPE"']);
  assert.match(computeVariables({ pw: '{{secret.SHOP_PASSWORD}}' }).problems[0], /a secret belongs to a project/);
});

/** An agent connected over MCP, with the browser and recording tools behind redaction, the extension a stand-in. */
async function agent(sendCommand) {
  const connectionId = 'secrets-agent';
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  redactToolResults(server);
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

test('recording: {{secret.NAME}} typed by the server, the agent told its reference only, the step keeping it', async () => {
  const typed = [];
  const { call, close } = await agent(async (_profile, command, params) => {
    if (command === 'fill') typed.push(params.value);
    // A page that shows what was typed: the agent reads the reference, not the value.
    if (command === 'extract') return { text: `Password: ${typed.at(-1)}` };
    return { tabId: 7, windowId: 70, pageUrl: 'https://shop.test/login' };
  });
  assert.match(await call('fill', { selector: '#password', value: '{{secret.SHOP_PASSWORD}}' }),
    /secret belongs to a project.*start_recording with project_id\); one it lacks, ask the user for it with ask_user/);
  await call('start_recording', { name: 'login with a secret', project_id: project });
  await call('navigate', { url: 'https://shop.test/login' });
  const filled = await call('fill', { selector: '#password', value: '{{secret.SHOP_PASSWORD}}' });
  assert.deepEqual(typed, [PASSWORD], 'typed by the server');
  assert.ok(!filled.includes(PASSWORD));
  const read = await call('extract', { selector: '#shown' });
  assert.match(read, /Password: \{\{secret\.SHOP_PASSWORD\}\}/);
  assert.ok(!read.includes(PASSWORD));
  assert.match(await call('fill', { selector: '#password', value: '{{secret.NOPE}}' }), /no secret named "NOPE"/);
  await call('stop_recording');
  await close();

  const saved = loadTest('login with a secret');
  assert.ok(!JSON.stringify(saved).includes(PASSWORD), 'the test keeps the reference');
  assert.match(JSON.stringify(saved), /\{\{secret\.SHOP_PASSWORD\}\}/);
});

test('a run types the secret, and keeps its reference in its record; exported code reads the environment', async () => {
  saveTest({
    name: 'replayed with a secret', variables: { pw: { type: 'text', defaultValue: '{{secret.SHOP_PASSWORD}}' } },
    steps: [
      { command: 'fill', params: { selector: '#password', value: '{{pw}}' } },
      { command: 'fill', params: { selector: '#again', value: '{{secret.SHOP_PASSWORD}}' } },
    ],
  });
  db.prepare("UPDATE tests SET project_id = ? WHERE name = 'replayed with a secret'").run(project);
  const typed = [];
  const events = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      typed.push(...params.steps.map((s) => s.params.value));
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'failed', error: `Could not type ${s.params.value}`, tabId: 9 })) };
    }
    return {};
  };
  const run = await executeTest('replayed with a secret', {}, null, null, true, sendCommand, 'test', (event) => events.push(event));
  assert.deepEqual(typed, [PASSWORD, PASSWORD], 'typed by the server');
  const record = db.prepare('SELECT variables, error FROM test_executions WHERE id = ?').get(run.executionId);
  const steps = db.prepare('SELECT error FROM execution_steps WHERE execution_id = ?').all(run.executionId);
  for (const kept of [JSON.stringify(run), JSON.stringify(events), JSON.stringify(record), JSON.stringify(steps)]) {
    assert.ok(!kept.includes(PASSWORD), `not kept nor told: ${kept.slice(0, 200)}`);
  }
  assert.equal(JSON.parse(record.variables).pw, '{{secret.SHOP_PASSWORD}}');

  const exported = JSON.stringify(generateTestCode(loadTest('replayed with a secret'), 'playwright-plain'));
  assert.ok(!exported.includes(PASSWORD), 'never in the code');
  assert.match(exported, /secrets: \(name\) => process\.env\[name\]/, 'the environment variable of its name');
  assert.doesNotMatch(JSON.stringify(generateTestCode({ name: 'plain', steps: [{ command: 'fill', params: { selector: '#d', value: '{{today}}' } }] }, 'playwright-plain')),
    /process\.env/, 'a test with no secret reads no environment');
});

test('an agent is told the names of the secrets, never a value: get_project_context, a dataset of passwords', () => {
  const context = AGENT_TOOLS.find((t) => t.name === 'get_project_context').handler({ project_id: project }).data;
  assert.deepEqual(context.secrets, [{ name: 'SHOP_PASSWORD', description: 'Password of the test account', write: '{{secret.SHOP_PASSWORD}}' }]);
  assert.ok(!JSON.stringify(context).includes(PASSWORD));
});

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
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })));
  } finally {
    server.close();
  }
}

test('the API lists names, adds and replaces values, deletes; never sends one back; a preview shows dots', async () => {
  await api(async (call) => {
    const added = await call(`/api/projects/${other}/secrets/API_KEY`, { method: 'PUT', body: { value: 'key-of-other', description: 'Their key' } });
    assert.equal(added.status, 200);
    assert.deepEqual(Object.keys(added.body.secret), ['name', 'description', 'updated_at', 'from_environment']);
    assert.equal(secretValue(other, 'API_KEY'), 'key-of-other');
    const listed = await call(`/api/projects/${other}/secrets`);
    assert.deepEqual(listed.body.secrets.map((s) => s.name), ['API_KEY']);
    assert.ok(!JSON.stringify(listed.body).includes('key-of-other'));
    assert.equal((await call(`/api/projects/${other}/secrets/bad-name`, { method: 'PUT', body: { value: 'x' } })).status, 400);
    const preview = await call('/api/values/preview', { method: 'POST', body: { project_id: other, values: { k: '{{secret.API_KEY}}', n: '{{secret.NONE}}' } } });
    assert.equal(preview.body.values.k, '••••••');
    assert.match(preview.body.problems[0], /no secret named "NONE"/);
    assert.equal((await call(`/api/projects/${other}/secrets/API_KEY`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(`/api/projects/${other}/secrets/API_KEY`, { method: 'DELETE' })).status, 404);
  });
});

test('the key file is the one of this test', async () => {
  assert.equal((await readFile(process.env.IZITEST_SECRET_KEY_FILE, 'utf8')).trim().length, 44, '32 bytes in base64');
});
