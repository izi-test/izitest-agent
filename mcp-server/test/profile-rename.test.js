// Unit tests for a profile renamed in the extension's popup: the extension registers again, under
// its new name, over the socket it already has. Its former name must stop being a profile: kept,
// it stayed listed until the server restarted and, once that browser was closed, a command naming
// no profile waited for it instead of going to the browser that is there.
// The bridge runs on a free port; its extensions are WebSocket clients.
// Run with: node --test test/profile-rename.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const {
  startWebSocketServer, closeWebSocket, sendCommand, waitForProfile, getProfiles, hasWindowedProfile,
} = await import('../lib/websocket.js');

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const port = await freePort();
startWebSocketServer(port);
// A test that fails leaves its browsers open: closed here, or the bridge never ends.
const sockets = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  closeWebSocket();
});
await new Promise((resolve) => setTimeout(resolve, 100));

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const listed = () => [...getProfiles().keys()];

/**
 * A browser with the extension: registers as `profileId`, then answers each command with the name
 * it has now and its `tag` (which browser it is, whatever it is named).
 */
function extension(profileId, tag = '') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://izitest' });
    sockets.push(ws);
    const browser = {
      name: profileId,
      /** What the popup's Save does (extension/src/background.ts, setProfileId). */
      async rename(to) {
        browser.name = to;
        ws.send(JSON.stringify({ type: 'register', profileId: to }));
        await waitForProfile(to, 2000);
        await settle();
      },
      async close() {
        ws.close();
        await settle();
      },
    };
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'register', profileId, headless: false, userAgent: 'test' }));
      await waitForProfile(profileId, 2000);
      await settle();
      resolve(browser);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command') ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { profile: browser.name, tag } }));
    });
  });
}

test('a profile renamed in the popup: its former name is no longer a profile', async () => {
  const browser = await extension('profile-1700000000001');
  assert.deepEqual(listed(), ['profile-1700000000001']);
  await browser.rename('admin');
  assert.deepEqual(listed(), ['admin']);
  assert.equal((await sendCommand('admin', 'get_tabs', {})).profile, 'admin');
  await browser.close();
  assert.deepEqual(listed(), [], 'closed: nothing is left of it');
  assert.equal(hasWindowedProfile(), false);
});

test('renamed, closed, then opened again: what names no profile goes to it', async () => {
  const first = await extension('profile-1700000000002');
  await first.rename('admin');
  await first.close();
  const again = await extension('admin', 'opened again');
  assert.deepEqual(listed(), ['admin']);
  assert.deepEqual(await sendCommand(undefined, 'get_tabs', {}), { profile: 'admin', tag: 'opened again' });
  await again.close();
});

test('the first browser that connected, renamed: still where a command naming no profile goes', async () => {
  const admin = await extension('profile-1700000000003', 'first');
  const customer = await extension('profile-1700000000004', 'second');
  await admin.rename('admin');
  assert.deepEqual(listed(), ['admin', 'profile-1700000000004']);
  assert.deepEqual(await sendCommand(undefined, 'get_tabs', {}), { profile: 'admin', tag: 'first' });
  await customer.rename('customer');
  assert.deepEqual(listed(), ['admin', 'customer']);
  assert.deepEqual(await sendCommand('customer', 'get_tabs', {}), { profile: 'customer', tag: 'second' });
  assert.deepEqual(await sendCommand(undefined, 'get_tabs', {}), { profile: 'admin', tag: 'first' });
  await admin.close();
  await customer.close();
  assert.deepEqual(listed(), []);
});

test('a browser renamed to the name another one has: the name goes to it, as when it registers', async () => {
  const holder = await extension('admin', 'holder');
  const renamed = await extension('profile-1700000000005', 'renamed');
  await renamed.rename('admin');
  assert.deepEqual(listed(), ['admin']);
  assert.deepEqual(await sendCommand('admin', 'get_tabs', {}), { profile: 'admin', tag: 'renamed' });
  await holder.close();
  assert.deepEqual(listed(), ['admin'], 'the browser that lost the name closing takes nothing away');
  await renamed.close();
  assert.deepEqual(listed(), []);
});

test('a browser whose name another one took over, renamed: the name stays to the one that took it', async () => {
  const older = await extension('shared', 'older');
  const newer = await extension('shared', 'newer');
  await older.rename('other');
  assert.deepEqual(listed().sort(), ['other', 'shared']);
  assert.deepEqual(await sendCommand('shared', 'get_tabs', {}), { profile: 'shared', tag: 'newer' });
  assert.deepEqual(await sendCommand('other', 'get_tabs', {}), { profile: 'other', tag: 'older' });
  await older.close();
  await newer.close();
  assert.deepEqual(listed(), []);
});

test('registering again under the same name changes nothing', async () => {
  const browser = await extension('admin', 'same');
  await browser.rename('admin');
  assert.deepEqual(listed(), ['admin']);
  assert.deepEqual(await sendCommand(undefined, 'get_tabs', {}), { profile: 'admin', tag: 'same' });
  await browser.close();
  assert.deepEqual(listed(), []);
});
