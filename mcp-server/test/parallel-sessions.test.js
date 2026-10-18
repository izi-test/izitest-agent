// Two agents driving the browser at the same time must never touch each other's window,
// snapshot refs or recording. Real MCP SDK over in-memory transports, fake browser.
// Run with: node --test test/parallel-sessions.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBrowserTools } from '../lib/tools/browser.js';
import { scopeToolsToSession } from '../lib/tools/session-scope.js';
import { resolveSession, dropConnection } from '../lib/session.js';

let connectionCounter = 0;

/**
 * A fake browser that hands out one window per newWindow navigate and records every
 * command it receives, so a test can assert which tab each call landed on.
 */
function fakeBrowser() {
  const received = [];
  let nextTab = 100;
  const handle = async (command, params) => {
    received.push({ command, ...params });
    if (command === 'navigate') {
      if (params.newWindow) {
        nextTab += 1;
        return { tabId: nextTab, windowId: nextTab * 10, url: params.url, title: `page ${params.url}` };
      }
      return { tabId: params.tabId, windowId: params.tabId * 10, url: params.url, title: `page ${params.url}` };
    }
    if (command === 'snapshot') {
      return { tree: `tree for tab ${params.tabId}`, title: 't', url: 'u', refs: { e1: { selector: `#tab-${params.tabId}` } } };
    }
    return { ok: true, tabId: params.tabId };
  };
  return { received, handle };
}

async function connectAgent(browser) {
  const connectionId = `parallel-test-${++connectionCounter}`;
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, {
    sendCommand: (profile, command, params) => browser.handle(command, params),
    getProfiles: () => new Map(),
  });
  unscope();

  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);

  return {
    client,
    connectionId,
    session: (name) => resolveSession(connectionId, name),
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => { await client.close(); dropConnection(connectionId); },
  };
}

test('two connections each get their own window on their first navigate', async () => {
  const browser = fakeBrowser();
  const a = await connectAgent(browser);
  const b = await connectAgent(browser);

  await a.call('navigate', { url: 'https://a.example' });
  await b.call('navigate', { url: 'https://b.example' });

  assert.notEqual(a.session().lastTabId, b.session().lastTabId);

  const navigates = browser.received.filter((c) => c.command === 'navigate');
  assert.equal(navigates.length, 2);
  // Both opened a window of their own instead of reusing whatever tab was there.
  assert.ok(navigates.every((n) => n.newWindow === true));

  await a.close();
  await b.close();
});

test('a command without tabId stays in its own session\'s window', async () => {
  const browser = fakeBrowser();
  const a = await connectAgent(browser);
  const b = await connectAgent(browser);

  await a.call('navigate', { url: 'https://a.example' });
  await b.call('navigate', { url: 'https://b.example' });
  const tabA = a.session().lastTabId;
  const tabB = b.session().lastTabId;

  // Neither agent passes a tabId — the old code sent these to whichever tab was active.
  await a.call('click', { text: 'Buy' });
  await b.call('fill', { selector: '#q', value: 'hello' });

  const click = browser.received.find((c) => c.command === 'click');
  const fill = browser.received.find((c) => c.command === 'fill');
  assert.equal(click.tabId, tabA);
  assert.equal(fill.tabId, tabB);

  await a.close();
  await b.close();
});

test('snapshot refs do not leak from one session into the other', async () => {
  const browser = fakeBrowser();
  const a = await connectAgent(browser);
  const b = await connectAgent(browser);

  await a.call('navigate', { url: 'https://a.example' });
  await b.call('navigate', { url: 'https://b.example' });
  await a.call('snapshot', { purposeFilter: 'click' });
  await b.call('snapshot', { purposeFilter: 'click' });

  assert.equal(a.session().refMap.e1.selector, `#tab-${a.session().lastTabId}`);
  assert.equal(b.session().refMap.e1.selector, `#tab-${b.session().lastTabId}`);
  assert.notEqual(a.session().refMap.e1.selector, b.session().refMap.e1.selector);

  await a.close();
  await b.close();
});

test('concurrent calls from two agents keep their own session context', async () => {
  const browser = fakeBrowser();
  const a = await connectAgent(browser);
  const b = await connectAgent(browser);

  await a.call('navigate', { url: 'https://a.example' });
  await b.call('navigate', { url: 'https://b.example' });
  const tabA = a.session().lastTabId;
  const tabB = b.session().lastTabId;

  // Interleaved in flight, not one after the other: this is what AsyncLocalStorage has
  // to get right for the session context to survive an await.
  await Promise.all([
    a.call('click', { text: 'A1' }),
    b.call('click', { text: 'B1' }),
    a.call('click', { text: 'A2' }),
    b.call('click', { text: 'B2' }),
  ]);

  const clicks = browser.received.filter((c) => c.command === 'click');
  for (const c of clicks) {
    assert.equal(c.tabId, c.text.startsWith('A') ? tabA : tabB, `${c.text} went to the wrong tab`);
  }

  await a.close();
  await b.close();
});

test('named sessions split one connection into separate windows', async () => {
  const browser = fakeBrowser();
  const a = await connectAgent(browser); // e.g. two subagents sharing a parent's connection

  await a.call('navigate', { url: 'https://one.example', session: 'sub-1' });
  await a.call('navigate', { url: 'https://two.example', session: 'sub-2' });

  const one = a.session('sub-1');
  const two = a.session('sub-2');
  assert.notEqual(one.lastTabId, two.lastTabId);

  await a.call('click', { text: 'in one', session: 'sub-1' });
  const click = browser.received.find((c) => c.command === 'click');
  assert.equal(click.tabId, one.lastTabId);

  // And the connection's own default session is a third, still-unused one.
  assert.equal(a.session().lastTabId, undefined);

  const closed = await a.call('close_session', { name: 'sub-1' });
  assert.match(closed.content[0].text, /closed/i);

  await a.close();
});

test('close_session reports when there is no such session', async () => {
  const browser = fakeBrowser();
  const a = await connectAgent(browser);
  const res = await a.call('close_session', { name: 'never-opened' });
  assert.match(res.content[0].text, /No session named "never-opened"/);
  await a.close();
});

test('five sessions starting at once each get a distinct window, and each closes its own', async () => {
  // The shape reported live: 3 connections plus 2 named sessions on one of them, all
  // navigating simultaneously. Window bookkeeping used to lose records under this.
  const browser = fakeBrowser();
  const a = await connectAgent(browser);
  const b = await connectAgent(browser);
  const c = await connectAgent(browser);

  const starts = [
    () => a.call('navigate', { url: 'https://1.example' }),
    () => b.call('navigate', { url: 'https://2.example' }),
    () => c.call('navigate', { url: 'https://3.example' }),
    () => c.call('navigate', { url: 'https://4.example', session: 'sourceur-A' }),
    () => c.call('navigate', { url: 'https://5.example', session: 'sourceur-B' }),
  ];
  await Promise.all(starts.map((start) => start()));

  const sessions = [a.session(), b.session(), c.session(), c.session('sourceur-A'), c.session('sourceur-B')];
  const tabs = sessions.map((s) => s.lastTabId);
  const windows = sessions.map((s) => s.windowId);

  assert.equal(new Set(tabs).size, 5, `expected 5 distinct tabs, got ${tabs}`);
  assert.equal(new Set(windows).size, 5, `expected 5 distinct windows, got ${windows}`);
  // list_sessions showed "window=-" for every session when navigate did not report it back.
  assert.ok(windows.every((w) => typeof w === 'number'), `every session must know its window, got ${windows}`);

  const listed = (await a.call('list_sessions')).content[0].text;
  for (const windowId of windows) assert.match(listed, new RegExp(`window=${windowId}\\b`));

  // Each one closes its own window, and only its own.
  browser.received.length = 0;
  await Promise.all([
    a.call('close_window'),
    b.call('close_window'),
    c.call('close_window'),
    c.call('close_session', { name: 'sourceur-A' }),
    c.call('close_session', { name: 'sourceur-B' }),
  ]);

  const closed = browser.received.filter((r) => r.command === 'close_window').map((r) => r.tabId).sort();
  assert.deepEqual(closed, [...tabs].sort(), 'each session must close exactly its own tab');

  await a.close();
  await b.close();
  await c.close();
});

test('a session with no window is told to navigate first, not handed the foreground tab', async () => {
  // The extension refuses and says why (see extension/test/resolve-tab.test.mjs); the
  // server must surface that instead of swallowing it.
  const browser = fakeBrowser();
  browser.handle = async (command, params) => {
    if (params.tabId === undefined) {
      throw new Error('This session has no window of its own yet, so there is no tab to act on. Call navigate() first');
    }
    return { ok: true };
  };
  const a = await connectAgent(browser);

  const res = await a.call('snapshot', { purposeFilter: 'click' });
  assert.ok(res.isError, 'a snapshot before any navigate must fail, not read the user\'s page');
  assert.match(res.content[0].text, /Call navigate\(\) first/);

  await a.close();
});
