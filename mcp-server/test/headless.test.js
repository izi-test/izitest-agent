// Unit tests for the Chrome without windows (lib/headless.js) and its place among the profiles
// (lib/websocket.js): started with no window, this extension only and a profile of its own; a
// run asked headless goes to it; and a command that names no profile never does, even when it
// connected first — the agents keep working in the user's Chrome. The bridge is a real one, on
// a free port; its extensions are two WebSocket clients.
// Run with: node --test test/headless.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const { chromeArgs, inHeadless, HEADLESS_PROFILE } = await import('../lib/headless.js');
const { startWebSocketServer, closeWebSocket, sendCommand, waitForProfile, isHeadlessProfile } = await import('../lib/websocket.js');

test('Chrome is started without a window, with this extension only, in a profile of its own', () => {
  const args = chromeArgs({ profileDir: '/tmp/p', extensionDir: '/repo/extension/dist' });
  assert.equal(args[0], '--headless');
  assert.ok(args.includes('--user-data-dir=/tmp/p'));
  assert.ok(args.includes('--load-extension=/repo/extension/dist'));
  assert.ok(args.includes('--disable-extensions-except=/repo/extension/dist'));
  assert.ok(args.includes('--silent-debugger-extension-api'));
  assert.ok(args.includes('--disable-background-timer-throttling'), 'nothing of it is slowed down for being out of sight');
});

test('a run asked headless sends what names no profile to the headless Chrome, and what names one where it says', async () => {
  const calls = [];
  const run = inHeadless(async (profile, command, params, timeout) => { calls.push([profile, command, params, timeout]); });
  await run(undefined, 'replay_sequence', { steps: [] }, 60000);
  await run('main', 'get_tabs', {});
  assert.deepEqual(calls, [[HEADLESS_PROFILE, 'replay_sequence', { steps: [] }, 60000], ['main', 'get_tabs', {}, undefined]]);
});

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

test('a command naming no profile goes to a Chrome with windows, even when the headless one connected first', async () => {
  const port = await freePort();
  startWebSocketServer(port);
  after(() => closeWebSocket());
  await new Promise((resolve) => setTimeout(resolve, 100));

  const headless = await extension(port, HEADLESS_PROFILE, true);
  await waitForProfile(HEADLESS_PROFILE, 2000);
  assert.equal(isHeadlessProfile(HEADLESS_PROFILE), true);
  assert.equal(await waitForProfile(undefined, 200), null, 'the headless Chrome alone is no default');

  const main = await extension(port, 'main', false);
  await waitForProfile('main', 2000);
  assert.deepEqual(await sendCommand(undefined, 'get_tabs', {}), { answeredBy: 'main' });
  assert.deepEqual(await sendCommand(HEADLESS_PROFILE, 'get_tabs', {}), { answeredBy: HEADLESS_PROFILE }, 'named, it answers');

  headless.close();
  main.close();
});
