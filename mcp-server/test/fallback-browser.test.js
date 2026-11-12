// Unit tests for where a command naming no browser goes when no Chrome with the extension is
// connected (a company laptop that blocks extensions): to IziTest's browser without windows.
// The bridge runs on a free port; its extensions are WebSocket clients; the fallback browser is
// a stand-in (the real one starts Chrome for Testing, lib/headless.js).
// Run with: node --test test/fallback-browser.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const {
  startWebSocketServer, closeWebSocket, sendCommand, waitForProfile, routeProfile,
  setFallbackBrowser, markWindowedSeen, hasWindowedProfile,
} = await import('../lib/websocket.js');

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** An extension: registers, then answers each command with the name of its profile. */
function extension(port, profileId, headless) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://izitest' });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', profileId, headless }));
      resolve(ws);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command') ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { answeredBy: profileId } }));
    });
  });
}

const port = await freePort();
startWebSocketServer(port);
after(() => closeWebSocket());
await new Promise((resolve) => setTimeout(resolve, 100));

/** A fallback browser that starts "headless" when asked, counting how often it was asked. */
function standIn() {
  const state = { asked: 0, ws: null };
  setFallbackBrowser(async () => {
    state.asked += 1;
    if (!state.ws) {
      state.ws = await extension(port, 'headless', true);
      await waitForProfile('headless', 2000);
    }
    return 'headless';
  });
  return state;
}

test('no Chrome with the extension for a while: what names no browser goes to the browser without windows, started for it', async () => {
  const fallback = standIn();
  markWindowedSeen(Date.now() - 60_000);
  assert.equal(hasWindowedProfile(), false);
  assert.deepEqual(await sendCommand(undefined, 'navigate', { url: 'https://app.test' }), { answeredBy: 'headless' });
  assert.equal(fallback.asked, 1, 'started once');
  assert.deepEqual(await sendCommand(undefined, 'snapshot', {}), { answeredBy: 'headless' }, 'the next commands follow it');
  fallback.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('the user\'s Chrome connected moments ago: it is waited for, the session does not move to another browser', async () => {
  const fallback = standIn();
  markWindowedSeen(Date.now() - 5_000);
  assert.equal(await routeProfile(undefined), undefined);
  assert.equal(fallback.asked, 0);
});

test('with the user\'s Chrome connected, it is the one; a profile named is the one named', async () => {
  const fallback = standIn();
  markWindowedSeen(Date.now() - 60_000);
  const main = await extension(port, 'main', false);
  await waitForProfile('main', 2000);
  assert.deepEqual(await sendCommand(undefined, 'get_tabs', {}), { answeredBy: 'main' });
  assert.equal(await routeProfile('somewhere'), 'somewhere');
  assert.equal(fallback.asked, 0, 'never started');
  main.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await routeProfile(undefined), undefined, 'just closed: still waited for');
});

test('no browser without windows installed: the error says how to have one', async () => {
  setFallbackBrowser(async () => null);
  markWindowedSeen(Date.now() - 60_000);
  await assert.rejects(sendCommand(undefined, 'navigate', { url: 'https://app.test' }), /Settings → Headless browser → Install/);
});
