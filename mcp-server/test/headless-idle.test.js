// Unit tests for the headless Chrome stopped when it has nothing to do (lib/headless.js, idle
// stop): left running between two runs, it was some 750 MB of the user's computer for nothing.
// Stopped after the minutes set without work — no command under way or sent since, no run,
// campaign or recording in it —, the live view's upkeep no work; started again by a command
// that names it. The bridge is a real one, on a free port; the headless Chrome is a WebSocket
// client standing in for its extension, its "stop" the test closing it. IziTest's home is a
// temporary one: no Chrome for Testing is installed there, and no pid of a real one is read.
// Run with: node --test test/headless-idle.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

process.env.IZITEST_HOME = await mkdtemp(join(tmpdir(), 'headless-idle-home-'));
process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'headless-idle-db-')), 'test.db');
delete process.env.IZITEST_CHROME_PATH;
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const {
  stopWhenIdle, holdHeadless, idleMinutes, setIdleMinutes, laneOf, ensureHeadless, isHeadlessConnected, headlessStatus,
  DEFAULT_IDLE_MINUTES, HEADLESS_PROFILE,
} = await import('../lib/headless.js');
const {
  startWebSocketServer, closeWebSocket, sendCommand, waitForProfile, routeProfile, profileActivity, setProfileStarter,
} = await import('../lib/websocket.js');
const { createAdHocSession, destroySession } = await import('../lib/session.js');

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const port = await freePort();
startWebSocketServer(port);
after(() => closeWebSocket());
await new Promise((resolve) => setTimeout(resolve, 100));

const MINUTE = 60_000;
const later = (minutes) => Date.now() + minutes * MINUTE;
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The headless Chrome's extension: registers, answers each command — but "hold" ones, until
 * `release()` —, gone with `stop()`.
 */
async function headlessChrome(profileId = HEADLESS_PROFILE) {
  const held = [];
  const ws = await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://izitest' });
    socket.on('open', () => { socket.send(JSON.stringify({ type: 'register', profileId, headless: true })); resolve(socket); });
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'command') return;
      const answer = () => socket.send(JSON.stringify({ type: 'result', id: msg.id, result: { answeredBy: profileId } }));
      if (msg.command === 'hold') held.push(answer); else answer();
    });
  });
  await waitForProfile(profileId, 2000);
  return {
    release: () => held.splice(0).forEach((answer) => answer()),
    stop: async () => { ws.close(); for (let i = 0; i < 100 && isHeadlessConnected(laneOf(profileId)); i++) await tick(); },
  };
}

/** The idle check at `now`, the Chrome closed when it is told to stop (Chrome exits on SIGTERM). */
async function idleCheck(chrome, now) {
  const checking = stopWhenIdle({ now, minutes: 10 });
  await tick();
  await chrome.stop();
  return checking;
}

test('the idle delay: 10 minutes unless set; a whole number of minutes, 0 for never', () => {
  assert.equal(idleMinutes(), DEFAULT_IDLE_MINUTES);
  assert.equal(DEFAULT_IDLE_MINUTES, 10);
  setIdleMinutes(3);
  assert.equal(idleMinutes(), 3);
  setIdleMinutes(0);
  assert.equal(idleMinutes(), 0);
  for (const wrong of [-1, 2.5, '5', null, 24 * 60 + 1]) assert.throws(() => setIdleMinutes(wrong), /whole number of minutes/);
  assert.equal(idleMinutes(), 0, 'a wrong value changes nothing');
  setIdleMinutes(10);
});

test('the lanes a profile names', () => {
  assert.deepEqual(['headless', 'headless-2', 'headless-6'].map(laneOf), [1, 2, 6]);
  assert.deepEqual(['headless-1', 'headless-7', 'main', undefined].map(laneOf), [null, null, null, null]);
});

test('stopped after the minutes set without work, not before; set to 0, never', async () => {
  const chrome = await headlessChrome();
  assert.equal(await stopWhenIdle({ minutes: 10 }), false, 'just started: as if it had just had work');
  assert.equal(await stopWhenIdle({ now: later(9), minutes: 10 }), false);
  assert.equal(await stopWhenIdle({ now: later(60), minutes: 0 }), false, '0: never');
  assert.equal(await idleCheck(chrome, later(11)), true);
  assert.equal(isHeadlessConnected(1), false);
  assert.equal(await stopWhenIdle({ now: later(30), minutes: 10 }), false, 'nothing left to stop');
});

test('a command under way — a step that waits, a page that loads — is work, however long', async () => {
  const chrome = await headlessChrome();
  const waiting = sendCommand(HEADLESS_PROFILE, 'hold', {}, 60_000);
  await tick();
  assert.equal(profileActivity(HEADLESS_PROFILE).inFlight, 1);
  assert.equal(await stopWhenIdle({ now: later(11), minutes: 10 }), false);
  chrome.release();
  await waiting;
  assert.equal(profileActivity(HEADLESS_PROFILE).inFlight, 0);
  assert.equal(await idleCheck(chrome, later(11)), true);
});

test('a run or a campaign holds it — between two of its tests —, until it is over', async () => {
  const chrome = await headlessChrome();
  const release = holdHeadless();
  assert.equal(await stopWhenIdle({ now: later(11), minutes: 10 }), false);
  release();
  release();
  assert.equal(await idleCheck(chrome, later(11)), true, 'released once, however often it is told');
});

test('a test being recorded in it holds it: the agent may wait for the user\'s answer', async () => {
  const chrome = await headlessChrome();
  const session = createAdHocSession('recording-in-headless');
  session.profile = HEADLESS_PROFILE;
  session.recording = { name: 'Login', steps: [] };
  assert.equal(await stopWhenIdle({ now: later(11), minutes: 10 }), false);
  session.profile = undefined;
  assert.equal(await stopWhenIdle({ now: later(11), minutes: 10 }), false, 'naming none, with no Chrome with windows: its commands go there');
  session.recording = null;
  assert.equal(await idleCheck(chrome, later(11)), true);
  destroySession(session.id);
});

test('the live view\'s upkeep is no work: its tab listing every 3 s does not keep it running', async () => {
  const chrome = await headlessChrome();
  const since = profileActivity(HEADLESS_PROFILE).lastAt;
  await tick(5);
  await sendCommand(HEADLESS_PROFILE, 'get_tabs', {}, 5000, null, { upkeep: true });
  await sendCommand(HEADLESS_PROFILE, 'live_capture', {}, 5000);
  assert.equal(profileActivity(HEADLESS_PROFILE).lastAt, since);
  await sendCommand(HEADLESS_PROFILE, 'snapshot', {});
  assert.ok(profileActivity(HEADLESS_PROFILE).lastAt > since, 'an agent\'s command is');
  await chrome.stop();
});

test('a command naming a headless Chrome stopped starts it; the server\'s upkeep never does', async () => {
  const started = [];
  let chrome = null;
  setProfileStarter((profile) => {
    if (laneOf(profile) === null || isHeadlessConnected(laneOf(profile))) return null;
    started.push(profile);
    return headlessChrome(profile).then((c) => { chrome = c; });
  });
  try {
    assert.equal(await routeProfile(HEADLESS_PROFILE, Date.now(), { upkeep: true }), HEADLESS_PROFILE);
    assert.deepEqual(started, [], 'upkeep: not started');
    assert.deepEqual(await sendCommand(HEADLESS_PROFILE, 'navigate', { url: 'https://app.test' }), { answeredBy: HEADLESS_PROFILE });
    assert.deepEqual(started, [HEADLESS_PROFILE]);
    await sendCommand(HEADLESS_PROFILE, 'snapshot', {});
    assert.deepEqual(started, [HEADLESS_PROFILE], 'once');
    assert.equal(await routeProfile('main'), 'main');
    assert.deepEqual(started, [HEADLESS_PROFILE], 'a profile of no headless Chrome is not started');
  } finally {
    await chrome?.stop();
  }
});

test('a run asked while it stops waits for the stop, then starts it again — not taken for running', async () => {
  const chrome = await headlessChrome();
  const stopping = stopWhenIdle({ now: later(11), minutes: 10 });
  await tick();
  const order = [];
  const run = ensureHeadless().then(() => order.push('started'), (err) => order.push(`not started: ${err.message}`));
  await tick();
  assert.deepEqual(order, [], 'still stopping');
  await chrome.stop();
  assert.equal(await stopping, true);
  await run;
  assert.equal(order.length, 1);
  assert.match(order[0], /^not started: No headless browser installed yet/, 'it went to start it (no Chrome for Testing in this home)');
});

test('its status says the idle delay', async () => {
  setIdleMinutes(5);
  assert.equal((await headlessStatus()).idle_minutes, 5);
  setIdleMinutes(10);
});
