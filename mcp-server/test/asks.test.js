// Unit tests for what an agent asks the person who started it (lib/asks.js, ask_user): a value a
// test needs and nobody gave. The agent waits, call after call; the person answers in the
// dashboard; a secret answered is kept in the project and only its reference goes back to the
// agent. A dashboard run is told its questions; one given up, or unanswered in time, tells the
// agent to stop. On a database and a key of their own, thrown away after.
// Run with: node --test test/asks.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = await mkdtemp(join(tmpdir(), 'asks-'));
process.env.IZITEST_DB_PATH = join(dir, 'test.db');
process.env.IZITEST_SECRET_KEY_FILE = join(dir, 'secret.key');
process.env.IZITEST_ASK_WAIT_MS = '100';
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { secretValue, listSecrets, redactToolResults } = await import('../lib/secrets.js');
const { createAsk, answerAsk, cancelAsk, pendingAsks, followAsks, cancelAsksOfRun, askUser } = await import('../lib/asks.js');
const { registerAskTools } = await import('../lib/tools/ask.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection, setConnectionRun } = await import('../lib/session.js');
const { apiRouter } = await import('../lib/api.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Tiime') RETURNING id").get().id;
const PASSWORD = 'Pa55word-of-test';

/** An agent connected over MCP for a dashboard run, with ask_user and the recording tools. */
async function agent(connectionId, runId = null) {
  if (runId) setConnectionRun(connectionId, runId);
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  redactToolResults(server);
  const sendCommand = async () => ({ tabId: 3, windowId: 30 });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerTestTools(server, { sendCommand });
  registerAskTools(server);
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { text: result.content[0].text, isError: result.isError === true };
    },
    close: async () => { await client.close(); dropConnection(connectionId); },
  };
}

test('asked during a recording: waits, the dashboard run is told; answered, a secret is kept and only its reference goes back', async () => {
  const told = [];
  const stop = followAsks('run-aaaaaaaaaaaa', (event) => told.push(event));
  const { call, close } = await agent('asks-agent', 'run-aaaaaaaaaaaa');
  await call('start_recording', { name: 'login tiime', project_id: project });
  const first = await call('ask_user', {
    why: 'To log in to Tiime as the test user',
    fields: [{ name: 'email', label: 'E-mail of the test account' }, { name: 'TIIME_PASSWORD', label: 'Its password', secret: true }],
  });
  assert.equal(first.isError, false);
  const id = /request_id "(ask-[0-9a-f]{12})"/.exec(first.text)?.[1];
  assert.ok(id, first.text);
  assert.match(first.text, /has not answered yet[\s\S]*do nothing else meanwhile/);

  const [waiting] = pendingAsks();
  assert.deepEqual({ ...waiting, created_at: undefined, expires_at: undefined }, {
    id, project_id: project, project_name: 'Tiime', run_id: 'run-aaaaaaaaaaaa', why: 'To log in to Tiime as the test user',
    fields: [{ name: 'email', label: 'E-mail of the test account', secret: false }, { name: 'TIIME_PASSWORD', label: 'Its password', secret: true }],
    status: 'pending', created_at: undefined, expires_at: undefined,
  });
  assert.deepEqual(told.map((e) => e.type), ['ask'], 'the run that asked is told');

  assert.match(answerAsk(id, { email: 'qa@tiime.test' }).error, /Still to give: Its password/);
  const again = call('ask_user', { request_id: id });
  assert.deepEqual(answerAsk(id, { email: ' qa@tiime.test ', TIIME_PASSWORD: PASSWORD }), { ok: true });
  const answered = await again;
  assert.equal(answered.text, [
    'The user answered.',
    "- TIIME_PASSWORD: kept in the project's secrets. Type {{secret.TIIME_PASSWORD}} where it goes: IziTest types its value, you never see it.",
    '- email: qa@tiime.test',
  ].join('\n'));
  assert.equal(secretValue(project, 'TIIME_PASSWORD'), PASSWORD);
  assert.equal(listSecrets(project)[0].description, 'Its password', 'its label describes it');
  assert.deepEqual(told.map((e) => e.type), ['ask', 'ask_done']);
  assert.deepEqual(pendingAsks(), []);
  assert.match(answerAsk(id, {}).error, /answered already/);
  assert.equal((await call('ask_user', { request_id: id })).text.split('\n')[0], 'The user answered.', 'read again while kept');
  stop();
  await call('stop_recording');
  await close();
});

test('a question is refused without what it needs: why, fields, a project for a secret', async () => {
  assert.match(createAsk({ fields: [{ name: 'x' }] }).error, /why is needed/);
  assert.match(createAsk({ why: 'w', fields: [] }).error, /fields is needed/);
  assert.match(createAsk({ why: 'w', fields: [{ name: 'my password' }] }).error, /letters, digits and _/);
  assert.match(createAsk({ why: 'w', fields: [{ name: 'a' }, { name: 'a' }] }).error, /asked twice/);
  assert.match(createAsk({ why: 'w', fields: [{ name: 'PW', secret: true }] }).error, /A secret is kept in a project/);
  assert.match(createAsk({ why: 'w', projectId: 9999, fields: [{ name: 'a' }] }).error, /No project 9999/);
  const { text, isError } = await askUser({ why: 'w', fields: [{ name: 'PW', secret: true }] });
  assert.equal(isError, true);
  assert.match(text, /pass project_id, or call start_recording/);
});

test('given up, or unanswered in time, the agent is told to stop; a run over gives up its questions', async () => {
  const { call, close } = await agent('asks-other');
  const first = await call('ask_user', { why: 'A code', fields: [{ name: 'code' }] });
  const id = /request_id "([^"]+)"/.exec(first.text)[1];
  assert.equal(pendingAsks()[0].run_id, null, 'not a dashboard run: shown on every page');
  assert.deepEqual(cancelAsk(id), { ok: true });
  const declined = await call('ask_user', { request_id: id });
  assert.equal(declined.isError, true);
  assert.match(declined.text, /^The user did not give these values\. Stop here: close the recording window with close_window, save nothing/);
  assert.match((await call('ask_user', { request_id: 'ask-000000000000' })).text, /No question ask-000000000000/);

  process.env.IZITEST_ASK_TIMEOUT_MS = '50';
  try {
    const late = await call('ask_user', { why: 'Another code', fields: [{ name: 'code' }] });
    assert.match(late.text, /^Nobody answered in time\. Stop here/);
  } finally {
    delete process.env.IZITEST_ASK_TIMEOUT_MS;
  }
  await close();

  const { ask } = createAsk({ why: 'w', runId: 'run-bbbbbbbbbbbb', fields: [{ name: 'a' }] });
  cancelAsksOfRun('run-bbbbbbbbbbbb');
  assert.equal(ask.status, 'cancelled');
});

test('the API: the questions waiting, an answer, a refusal', async () => {
  const server = createServer((req, res) => apiRouter(req, res, new URL(req.url, 'http://127.0.0.1')).then(() => {
    if (!res.writableEnded) { res.writeHead(404); res.end(); }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const { ask } = createAsk({ why: 'An API key', projectId: project, fields: [{ name: 'API_KEY', secret: true }] });
    assert.deepEqual((await call('/api/asks')).body.asks.map((a) => a.id), [ask.id]);
    assert.equal((await call(`/api/asks/${ask.id}/answer`, { values: {} })).status, 400);
    assert.deepEqual((await call(`/api/asks/${ask.id}/answer`, { values: { API_KEY: 'key-1234' } })).body, { answered: true });
    assert.equal(secretValue(project, 'API_KEY'), 'key-1234');
    const { ask: second } = createAsk({ why: 'w', fields: [{ name: 'a' }] });
    assert.deepEqual((await call(`/api/asks/${second.id}/cancel`, {})).body, { cancelled: true });
    assert.deepEqual((await call('/api/asks')).body.asks, []);
  } finally {
    server.close();
  }
});
