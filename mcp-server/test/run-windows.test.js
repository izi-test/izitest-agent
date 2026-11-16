// Unit tests for the window a run or a recording opened in the user's Chrome, closed once it is
// over when the user chose so (lib/run-windows.js, Settings → Browser windows): after a run that
// passed, or after any; once a recording is saved. Left open by default; never a debug run's,
// nor a tab of the user's; a failed run an agent repairs keeps its window. The dashboard's run
// goes through the real bridge, on a free port, to a stand-in for the extension; an agent's
// tools over MCP to a stand-in too. On a database of their own, thrown away after.
// Run with: node --test test/run-windows.test.js

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_HOME = await mkdtemp(join(tmpdir(), 'run-windows-home-'));
process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'run-windows-db-')), 'test.db');
delete process.env.IZITEST_CHROME_PATH;
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { windowSettings, setWindowSettings, closesAfterRun, DEFAULT_WINDOWS } = await import('../lib/run-windows.js');
const { saveTest } = await import('../lib/test-store.js');
const { startWebSocketServer, closeWebSocket, waitForProfile } = await import('../lib/websocket.js');
const { apiRouter } = await import('../lib/api.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');
const { activeDebugControllers } = await import('../lib/debug-controller.js');

const TAB = 9;
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

saveTest({ name: 'passes', steps: [{ command: 'navigate', params: { url: 'https://shop.test/' } }] });
saveTest({ name: 'fails', steps: [{ command: 'navigate', params: { url: 'https://shop.test/broken' } }] });

/**
 * What the extension is asked: replays answered — the one of a "broken" page fails, as the
 * extension does it: each step told as it is played (`progress`), then the error —; every
 * window IziTest opened closed.
 */
function extensionAnswers() {
  const closed = [];
  const answer = (command, params, progress = () => {}) => {
    if (command === 'replay_sequence') {
      const broken = params.steps.some((s) => String(s.params?.url).includes('broken'));
      const results = params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: broken ? 'failed' : 'success', tabId: TAB, ...(broken ? { error: 'Page not found' } : {}) }));
      for (const stepResult of results) progress({ type: 'step_complete', stepResult });
      if (broken) throw Object.assign(new Error('Step 1 failed: Page not found'), { results });
      return { results };
    }
    if (command === 'navigate') return { tabId: TAB, windowId: 1, url: params.url };
    if (command === 'close_window') { closed.push(params.tabId); return { closed: true, windowId: 1, tabIds: [params.tabId] }; }
    return {};
  };
  return { answer, closed };
}

beforeEach(() => setWindowSettings({ ...DEFAULT_WINDOWS }));

test('the choice: left open unless set; after_run keep, passed or always; after_recording true or false', () => {
  db.prepare("DELETE FROM settings WHERE key = 'windows'").run();
  assert.deepEqual(windowSettings(), { after_run: 'keep', after_recording: false });
  assert.deepEqual(setWindowSettings({ after_run: 'passed' }), { after_run: 'passed', after_recording: false });
  assert.deepEqual(setWindowSettings({ after_recording: true }), { after_run: 'passed', after_recording: true }, 'what is not given stays');
  for (const wrong of [{ after_run: 'sometimes' }, { after_run: true }, { after_recording: 'yes' }]) {
    assert.throws(() => setWindowSettings(wrong), /after_run is one of|after_recording is true or false/);
  }
  assert.deepEqual(windowSettings(), { after_run: 'passed', after_recording: true }, 'a wrong value changes nothing');

  assert.deepEqual([true, false].map((passed) => closesAfterRun(passed, { after_run: 'keep' })), [false, false]);
  assert.deepEqual([true, false].map((passed) => closesAfterRun(passed, { after_run: 'passed' })), [true, false]);
  assert.deepEqual([true, false].map((passed) => closesAfterRun(passed, { after_run: 'always' })), [true, true]);
});

// ── The dashboard: the real bridge, the extension a stand-in ──

const freePort = () => new Promise((resolve) => {
  const server = createNetServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const port = await freePort();
startWebSocketServer(port);
after(() => closeWebSocket());
await tick(100);

const browser = extensionAnswers();
const chrome = await new Promise((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://izitest' });
  socket.on('open', () => { socket.send(JSON.stringify({ type: 'register', profileId: 'main' })); resolve(socket); });
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== 'command') return;
    const progress = (data) => socket.send(JSON.stringify({ type: 'progress', id: msg.id, data }));
    try {
      socket.send(JSON.stringify({ type: 'result', id: msg.id, result: browser.answer(msg.command, msg.params ?? {}, progress) }));
    } catch (err) {
      socket.send(JSON.stringify({ type: 'result', id: msg.id, error: err.message }));
    }
  });
});
after(() => chrome.close());
await waitForProfile('main', 2000);

const httpServer = createServer((req, res) => apiRouter(req, res, new URL(req.url, 'http://127.0.0.1')).then(() => {
  if (!res.writableEnded) { res.writeHead(404); res.end(); }
}));
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
after(() => httpServer.close());
const call = (path, init = {}) => fetch(`http://127.0.0.1:${httpServer.address().port}${path}`, {
  ...init, headers: { 'Content-Type': 'application/json' }, body: init.body && JSON.stringify(init.body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A run from the dashboard, to its end — a debug one let go on at once —; the windows closed after it. */
async function dashboardRun(name, body = {}) {
  browser.closed.length = 0;
  const started = fetch(`http://127.0.0.1:${httpServer.address().port}/api/tests/${name}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (body.debug) {
    for (let i = 0; i < 100 && !activeDebugControllers.size; i++) await tick();
    for (const controller of activeDebugControllers.values()) controller.continueAll();
  }
  const res = await started;
  const events = (await res.text()).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));
  await tick(100); // its window is closed after the run is told
  return { status: events.find((e) => e.type === 'execution_completed') ? 'passed' : 'failed', closed: [...browser.closed] };
}

test('the dashboard\'s settings: read, changed, a wrong value refused', async () => {
  assert.deepEqual((await call('/api/settings/windows')).body, { after_run: 'keep', after_recording: false });
  const changed = await call('/api/settings/windows', { method: 'PUT', body: { after_run: 'always' } });
  assert.deepEqual([changed.status, changed.body], [200, { after_run: 'always', after_recording: false }]);
  const refused = await call('/api/settings/windows', { method: 'PUT', body: { after_recording: 1 } });
  assert.deepEqual([refused.status, refused.body.error], [400, 'after_recording is true or false']);
  assert.deepEqual((await call('/api/settings/windows')).body, { after_run: 'always', after_recording: false });
});

test('a run from the dashboard leaves its window open by default; set so, it closes after a run that passed, or after any', async () => {
  assert.deepEqual(await dashboardRun('passes'), { status: 'passed', closed: [] });
  assert.deepEqual(await dashboardRun('fails'), { status: 'failed', closed: [] });

  setWindowSettings({ after_run: 'passed' });
  assert.deepEqual(await dashboardRun('passes'), { status: 'passed', closed: [TAB] });
  assert.deepEqual(await dashboardRun('fails'), { status: 'failed', closed: [] }, 'a failed run\'s stays open, to be looked at');

  setWindowSettings({ after_run: 'always' });
  assert.deepEqual(await dashboardRun('passes'), { status: 'passed', closed: [TAB] });
  assert.deepEqual(await dashboardRun('fails'), { status: 'failed', closed: [TAB] });
});

test('never a tab of the user\'s a run played in, nor a debug run\'s window', async () => {
  setWindowSettings({ after_run: 'always' });
  assert.deepEqual((await dashboardRun('passes', { new_window: false })).closed, [], 'played in the user\'s tab');
  assert.deepEqual((await dashboardRun('passes', { debug: true })).closed, [], 'debug: watched step by step');
});

// ── An agent's tools, over MCP, the extension a stand-in ──

let connections = 0;
async function agent() {
  const connectionId = `run-windows-agent-${++connections}`;
  const { answer, closed } = extensionAnswers();
  const sendCommand = async (_profile, command, params, _timeout, onProgress) => answer(command, params ?? {}, onProgress ?? undefined);
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, { sendCommand, getProfiles: () => new Map() });
  registerTestTools(server, { sendCommand });
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    closed,
    session: () => resolveSession(connectionId),
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text,
    close: async () => { await client.close(); dropConnection(connectionId); },
  };
}

test('run_test: a passed run\'s window closes as the user chose, or as close_window says; a failed run\'s stays open — repaired there', async () => {
  const { call: run, closed, close } = await agent();
  try {
    assert.doesNotMatch(await run('run_test', { name: 'passes' }), /window was closed/);
    assert.deepEqual(closed, [], 'left open by default');
    assert.match(await run('run_test', { name: 'passes', close_window: true }), /Its window was closed \(close_window\)/);
    assert.deepEqual(closed, [TAB]);

    setWindowSettings({ after_run: 'always' });
    closed.length = 0;
    const passed = await run('run_test', { name: 'passes' });
    assert.match(passed, /Its window was closed \(as the user chose: Settings → Browser windows\)\. To add an assertion on the page it ended on, run it again with close_window: false\./);
    assert.deepEqual(closed, [TAB]);
    assert.doesNotMatch(await run('run_test', { name: 'fails' }), /window was closed/);
    assert.deepEqual(closed, [TAB], 'failed: kept, the agent repairs the step there');
    await run('run_test', { name: 'passes', close_window: false });
    await run('run_test', { name: 'passes', new_window: false });
    assert.deepEqual(closed, [TAB], 'close_window: false keeps it; played in the current tab, never closed');
  } finally {
    await close();
  }
});

test('a recording\'s window closes once the test is saved, when the user chose so; the next navigate opens a new one', async () => {
  const { call: run, closed, session, close } = await agent();
  try {
    const record = async (name) => {
      await run('start_recording', { name });
      await run('navigate', { url: 'https://shop.test/' });
      assert.equal(session().lastTabId, TAB);
      return run('stop_recording');
    };
    assert.doesNotMatch(await record('kept open'), /window was closed/);
    assert.deepEqual(closed, [], 'left open by default');

    setWindowSettings({ after_recording: true });
    const saved = await record('closed after');
    assert.match(saved, /Test "closed after" saved with 1 steps[\s\S]*\nIts window was closed, as the user chose \(Settings → Browser windows\): the next navigate opens a new one\./);
    assert.deepEqual(closed, [TAB]);
    assert.equal(session().lastTabId, undefined, 'its tabs forgotten');
  } finally {
    await close();
  }
});
