// Tests for the close_window MCP tool: real MCP SDK over an in-memory transport,
// real session state, fake browser. No network, no DB.
// Run with: node --test test/close-window.test.js

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBrowserTools } from '../lib/tools/browser.js';
import { scopeToolsToSession } from '../lib/tools/session-scope.js';
import { resolveSession, dropConnection } from '../lib/session.js';

let client;
let calls;
let session;
let connectionId;
let connectionCounter = 0;

async function connect(extension) {
  calls = [];
  connectionId = `close-window-test-${++connectionCounter}`;
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, {
    sendCommand: async (profile, command, params) => { calls.push({ command, params }); return extension(command, params); },
    getProfiles: () => new Map(),
  });
  unscope();

  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  session = resolveSession(connectionId);
}

const closeWindow = async (args = {}) => {
  const res = await client.callTool({ name: 'close_window', arguments: args });
  return { text: res.content[0].text, isError: !!res.isError };
};

afterEach(async () => {
  await client?.close();
  client = null;
  dropConnection(connectionId);
});

test('closes the working window of the last navigate, then forgets its tabs', async () => {
  await connect(() => ({ closed: true, windowId: 9, tabIds: [101, 102] }));
  session.adoptTab(101, 9);

  const res = await closeWindow();
  assert.equal(res.isError, false);
  assert.match(res.text, /Closed the working window \(2 tabs\)/);
  assert.deepEqual(calls, [{ command: 'close_window', params: { tabId: 101, sessionId: session.id, liveSessions: [session.id] } }]);
  assert.equal(session.lastTabId, undefined); // next navigate opens a fresh window
});

test('closes the session\'s own window whether or not a profile is passed', async () => {
  await connect(() => ({ closed: true, windowId: 9, tabIds: [103] }));
  session.adoptTab(103, 9); // navigate called without `profile`...
  const res = await closeWindow({ profile: 'profile-1' }); // ...close_window with it
  assert.equal(res.isError, false);
  assert.equal(calls[0].params.tabId, 103);
});

test('refuses — and says so — when the window is not one IziTest Agent opened', async () => {
  await connect(() => ({ closed: false, reason: 'not_owned', windowId: 1, tabCount: 12 }));
  const res = await closeWindow({ tabId: 555 });
  assert.equal(res.isError, true);
  assert.match(res.text, /no ownership record for \(12 tab\(s\)\)/);
  assert.match(res.text, /Nothing was closed/);
});

test('refuses to close the working window of another session, and names it', async () => {
  await connect(() => ({ closed: false, reason: 'other_session', windowId: 7, tabCount: 2, owner: 's:recherche-B' }));
  const res = await closeWindow({ tabId: 404 });
  assert.equal(res.isError, true);
  assert.match(res.text, /working window of session s:recherche-B/);
  assert.match(res.text, /another agent is using it/);
});

test('an orphaned window — its session is gone — can be closed by anyone', async () => {
  // Otherwise a working window left behind by a disconnected agent could be closed by
  // nobody and would pile up. The extension decides from the live-session list.
  await connect(() => ({ closed: true, windowId: 8, tabIds: [808] }));
  const res = await closeWindow({ tabId: 808 });
  assert.equal(res.isError, false);
  const live = calls[0].params.liveSessions;
  assert.ok(Array.isArray(live), 'close_window must tell the extension which sessions are alive');
  assert.ok(live.includes(session.id));
});

test('nothing to close when no window was opened in this session', async () => {
  await connect(() => { throw new Error('must not be called'); });
  const res = await closeWindow();
  assert.equal(res.isError, false);
  assert.match(res.text, /Nothing to close: no working window/);
  assert.equal(calls.length, 0);
});

test('a window already closed by hand is reported and forgotten', async () => {
  await connect(() => ({ closed: false, reason: 'gone' }));
  session.adoptTab(777, 9);
  const res = await closeWindow({ profile: 'profile-1' });
  assert.match(res.text, /tab 777 no longer exists/);
  assert.equal(session.lastTabId, undefined);
});

test('an extension build without close_window gets an actionable message', async () => {
  await connect(() => { throw new Error('Unknown command: close_window'); });
  const res = await closeWindow({ tabId: 101 });
  assert.equal(res.isError, true);
  assert.match(res.text, /needs a newer build of the IziTest Agent extension/);
});
