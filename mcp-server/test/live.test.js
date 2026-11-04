// Live view (lib/live.js): action frames, the MJPEG stream and its limits, the recording,
// the off switch — against a fake browser, over real HTTP.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bp-live-'));
process.env.IZITEST_LIVE_DIR = dir;
process.env.IZITEST_LIVE_SESSION_MAX_FRAMES = '5';
const live = await import('../lib/live.js');
const { resolveSession, destroySession, setConnectionClient, setConnectionRun, dropConnection, createAdHocSession, sessionsOfRun } = await import('../lib/session.js');

// Smallest valid JPEG markers are enough: the server never decodes frames.
const jpeg = (n) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);
const b64 = (n) => jpeg(n).toString('base64');

const AGENT_TAB = 5, USER_TAB = 9;
const received = [];
const recordingInExtension = new Set();
let tabs = [
  { id: AGENT_TAB, windowId: 50, url: 'https://shop.test/', title: 'Shop', active: true, owner: 's:watched' },
  { id: USER_TAB, windowId: 90, url: 'https://mail.test/', title: 'Mail', active: true, owner: 'user' },
];
live.setLiveBridge({
  getProfiles: () => new Map([['p1', {}]]),
  broadcast: (msg) => { received.push({ command: msg.command }); return 1; },
  sendCommand: async (_profile, command, params) => {
    received.push({ command, ...params });
    if (command === 'get_tabs') return tabs;
    if (command === 'live_record_list') return { tabIds: [...recordingInExtension] };
    if (command === 'live_record_start') recordingInExtension.add(params.tabId);
    if (command === 'live_record_stop') recordingInExtension.delete(params.tabId);
    if (command === 'live_capture') return { data: b64(1), width: 1280, height: 720, url: 'https://shop.test/' };
    return { ok: true };
  },
});

let server, base;
before(async () => {
  live.initLive({ reconcileEveryMs: 0 });
  server = createServer((req, res) => live.liveRouter(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Open a stream; resolves with its status, and lets the caller read frames then hang up. */
function watch(tabId, query = '') {
  return new Promise((resolve) => {
    const req = http.get(`${base}/live/tabs/${tabId}/stream${query}`, (res) => {
      const viewer = { status: res.statusCode, frames: 0, body: '', close: () => req.destroy() };
      res.on('data', (chunk) => {
        viewer.body += chunk.toString('latin1');
        viewer.frames = (viewer.body.match(/Content-Type: image\/jpeg/g) || []).length;
      });
      resolve(viewer);
    });
    req.on('error', () => {});
  });
}
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('an action frame is kept, served, and named in the session', async () => {
  setConnectionClient('live-test', { name: 'claude-code', version: '2.1.0' });
  const session = resolveSession('live-test', 'watched');
  session.adoptTab(AGENT_TAB, 50);
  session.lastAction = { tool: 'click', at: '2026-10-15T10:00:00.000Z', status: 'ok' };
  const frameId = await live.captureActionFrame({ tabId: AGENT_TAB, action: 'click', session });
  assert.match(frameId, /^[a-z0-9]+-[0-9a-f]{12}$/);
  assert.equal(session.lastFrameId, frameId);
  assert.deepEqual(received.at(-1), { command: 'live_capture', tabId: AGENT_TAB, settleMs: 300 });

  const res = await fetch(`${base}/live/frames/${frameId}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg(1));
});

test('a frame id that is not one is refused, path tricks included', async () => {
  assert.equal((await fetch(`${base}/live/frames/..%2F..%2Fizitest.db.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/live/frames/zzzzzz-000000000000.jpg`)).status, 404);
});

test('a failed capture never fails the action', async () => {
  const frameId = await live.captureActionFrame({
    tabId: AGENT_TAB, action: 'click', dispatch: async () => { throw new Error('tab gone'); },
  });
  assert.equal(frameId, null);
});

test('stream: frames reach the viewer, a third viewer is refused, the last one leaving stops it', async () => {
  received.length = 0;
  const [a, b] = await Promise.all([watch(AGENT_TAB), watch(AGENT_TAB)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // Both arrived together: one stream, started once.
  assert.equal(received.filter((c) => c.command === 'live_start').length, 1);

  const third = await watch(AGENT_TAB);
  assert.equal(third.status, 429);

  live.deliverFrame({ tabId: AGENT_TAB, data: b64(2) });
  await until(() => a.frames >= 1 && b.frames >= 1);

  a.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!received.some((c) => c.command === 'live_stop'), 'one viewer still watches');
  b.close();
  await until(() => received.some((c) => c.command === 'live_stop' && c.tabId === AGENT_TAB));
});

test('stream: a viewer is paced to its fps, and still gets the last image of a burst', async () => {
  const v = await watch(AGENT_TAB, '?fps=2');
  await until(() => v.frames >= 1); // the image the page shows now
  const before = v.frames;
  for (let n = 10; n < 20; n++) live.deliverFrame({ tabId: AGENT_TAB, data: b64(n) });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(v.frames - before <= 1, `burst paced (got ${v.frames - before} in 200ms at 2 fps)`);
  await until(() => v.body.includes(jpeg(19).toString('latin1')), 1500);
  v.close();
});

test("the user's own tabs and unknown tabs are not streamed", async () => {
  const user = await watch(USER_TAB);
  assert.equal(user.status, 403);
  const unknown = await watch(12345);
  assert.equal(unknown.status, 404);
});

test('sessions list their tabs, client and last action', async () => {
  const res = await fetch(`${base}/live/sessions`);
  const body = await res.json();
  const s = body.sessions.find((x) => x.name === 'watched');
  assert.equal(s.windowId, 50);
  assert.deepEqual(s.client, { name: 'claude-code', version: '2.1.0' });
  assert.equal(s.lastAction.tool, 'click');
  assert.deepEqual(s.tabs.map((t) => t.tabId), [AGENT_TAB]);
  assert.ok(!JSON.stringify(body).includes('mail.test'), "the user's tabs are not listed");
});

test('continuous recording: the session tab is recorded without any viewer', async () => {
  await live.reconcileRecorders();
  assert.ok(recordingInExtension.has(AGENT_TAB));
  assert.ok(!recordingInExtension.has(USER_TAB), "the user's tabs are never recorded");
  live.deliverRecordFrame({ tabId: AGENT_TAB, data: b64(30), at: Date.now() });
  const body = await (await fetch(`${base}/live/tabs/${AGENT_TAB}/recording`)).json();
  const last = body.frames.at(-1);
  assert.equal(last.kind, 'stream');
  assert.deepEqual(Buffer.from(await (await fetch(`${base}${last.src}`)).arrayBuffer()), jpeg(30));
  const sessions = await (await fetch(`${base}/live/sessions`)).json();
  assert.deepEqual(sessions.sessions.find((x) => x.name === 'watched').recording, [AGENT_TAB]);
});

test('continuous recording: the front tab of the window is recorded too (a click opened it)', async () => {
  tabs = [{ ...tabs[0], active: false }, { id: 6, windowId: 50, url: 'https://shop.test/cart', active: true, owner: 's:watched' }, tabs[1]];
  await live.reconcileRecorders();
  assert.ok(recordingInExtension.has(AGENT_TAB), 'the working tab stays recorded');
  assert.ok(recordingInExtension.has(6));
  tabs = [{ ...tabs[0], active: true }, tabs[2]];
  await live.reconcileRecorders();
  assert.ok(!recordingInExtension.has(6), 'a closed tab is no longer recorded');
});

test('continuous recording: a session keeps its newest stream frames and every action frame', async () => {
  const actions = [];
  for (let i = 0; i < 3; i++) actions.push(await live.captureActionFrame({ tabId: AGENT_TAB, action: 'click', session: resolveSession('live-test', 'watched') }));
  for (let n = 40; n < 48; n++) live.deliverRecordFrame({ tabId: AGENT_TAB, data: b64(n), at: Date.now() });

  const body = await (await fetch(`${base}/live/tabs/${AGENT_TAB}/recording`)).json();
  const stream = body.frames.filter((f) => f.kind === 'stream');
  assert.equal(stream.length, 5, 'capped at IZITEST_LIVE_SESSION_MAX_FRAMES');
  const newest = await Promise.all(stream.map(async (f) => Buffer.from(await (await fetch(`${base}${f.src}`)).arrayBuffer())[2]));
  assert.deepEqual(newest, [43, 44, 45, 46, 47]);
  for (const id of actions) assert.ok(body.frames.some((f) => f.frameId === id), 'action frames are never dropped');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.jpg')).length, body.count, 'dropped frames are deleted from disk');
});

test('after a restart, frames dropped by the cap stay dropped', async () => {
  const now = live.recordingOf(AGENT_TAB).frames.map((f) => f.frameId);
  // A second instance of the module reads the same folder, as a restarted server would.
  const restarted = await import('../lib/live.js?restart');
  restarted.initLive({ reconcileEveryMs: 0 });
  assert.deepEqual(restarted.recordingOf(AGENT_TAB).frames.map((f) => f.frameId), now);
});

test('continuous recording can be switched off on its own', async () => {
  const off = await (await fetch(`${base}/live/settings`, { method: 'PUT', body: JSON.stringify({ continuousRecording: false }) })).json();
  assert.equal(off.continuousRecording, false);
  assert.equal(off.enabled, true);
  await live.reconcileRecorders();
  assert.equal(recordingInExtension.size, 0);
  const before = (await (await fetch(`${base}/live/tabs/${AGENT_TAB}/recording`)).json()).count;
  live.deliverRecordFrame({ tabId: AGENT_TAB, data: b64(50), at: Date.now() });
  assert.equal((await (await fetch(`${base}/live/tabs/${AGENT_TAB}/recording`)).json()).count, before);
  // Action frames and live view are untouched.
  assert.ok(await live.captureActionFrame({ tabId: AGENT_TAB, action: 'fill' }));

  const on = await (await fetch(`${base}/live/settings`, { method: 'PUT', body: JSON.stringify({ continuousRecording: true }) })).json();
  assert.equal(on.continuousRecording, true);
  await live.reconcileRecorders();
  assert.ok(recordingInExtension.has(AGENT_TAB));
  assert.equal((await fetch(`${base}/live/settings`, { method: 'PUT', body: JSON.stringify({ continuousRecording: 'no' }) })).status, 400);
});

test('recording: frames of the tab since its session started, then replayable', async () => {
  const res = await fetch(`${base}/live/tabs/${AGENT_TAB}/recording`);
  const body = await res.json();
  assert.equal(body.session.name, 'watched');
  assert.ok(body.count >= 2);
  assert.ok(body.frames.some((f) => f.kind === 'action' && f.action === 'click'));
  assert.ok(body.frames.some((f) => f.kind === 'stream'));
  assert.ok(body.frames.some((f) => f.kind === 'action'));
  assert.ok(body.frames.every((f) => f.src === `/live/frames/${f.frameId}.jpg`));

  const replay = await fetch(`${base}/live/tabs/${AGENT_TAB}/recording?format=mjpeg&speed=32`);
  assert.match(replay.headers.get('content-type'), /multipart\/x-mixed-replace/);
  const text = Buffer.from(await replay.arrayBuffer()).toString('latin1');
  assert.equal((text.match(/Content-Type: image\/jpeg/g) || []).length, body.count);
});

test('live view is GET-only', async () => {
  assert.equal((await fetch(`${base}/live/sessions`, { method: 'POST' })).status, 405);
});

test('switched off: no frames taken, routes answer 503, streams stop everywhere', async () => {
  received.length = 0;
  const v = await watch(AGENT_TAB);
  assert.equal(v.status, 200);
  const off = await fetch(`${base}/live/settings`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  assert.equal((await off.json()).enabled, false);
  assert.ok(received.some((c) => c.command === 'live_stop_all'));
  assert.ok(received.some((c) => c.command === 'live_stop' && c.tabId === AGENT_TAB));

  assert.equal((await fetch(`${base}/live/sessions`)).status, 503);
  assert.equal(await live.captureActionFrame({ tabId: AGENT_TAB, action: 'click' }), null);

  const on = await fetch(`${base}/live/settings`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  assert.equal((await on.json()).enabled, true);
  assert.equal((await fetch(`${base}/live/sessions`)).status, 200);
});

test('frames older than the retention are deleted from disk', async () => {
  const frameId = await live.captureActionFrame({ tabId: AGENT_TAB, action: 'fill' });
  assert.ok(existsSync(join(dir, `${frameId}.jpg`)));
  const dropped = live.prune(Date.now() + 25 * 60 * 60 * 1000);
  assert.ok(dropped >= 1);
  assert.ok(!existsSync(join(dir, `${frameId}.jpg`)));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.jpg')), []);
});

test('a session that ends stops being recorded', async () => {
  await live.reconcileRecorders();
  assert.ok(recordingInExtension.has(AGENT_TAB));
  destroySession('s:watched');
  await live.reconcileRecorders();
  assert.equal(recordingInExtension.size, 0);
});

test('a run of the dashboard is followed: the tab its agent opens, then the one it moves to', async () => {
  const RUN = 'run-0123456789ab';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setConnectionRun('conn-run', RUN);
  const own = resolveSession('conn-run');
  const helper = resolveSession('conn-run', 'helper');
  const stranger = resolveSession('conn-other');
  assert.deepEqual([own.runId, helper.runId, stranger.runId], [RUN, RUN, null], "a connection's sessions are its run's, named ones too");

  const told = [];
  const stop = live.followRun(RUN, (tabId) => told.push(tabId), { everyMs: 10 });
  await wait(30);
  assert.deepEqual(told, [], 'no tab before the agent opens one');
  own.adoptTab(105, 150);
  await wait(30);
  assert.deepEqual(told, [105], 'told once, not at every check');
  stranger.adoptTab(109, 190);
  helper.adoptTab(107, 170);
  helper.lastUsedAt = Date.now() + 1000;
  await wait(30);
  assert.deepEqual(told, [105, 107], 'the session used last is the one shown; another run is not');
  stop();
  own.lastUsedAt = Date.now() + 2000;
  await wait(30);
  assert.deepEqual(told, [105, 107], 'stopped: nothing more told');

  const adHoc = createAdHocSession('dashboard-agent', { runId: 'run-ba9876543210' });
  assert.deepEqual(sessionsOfRun('run-ba9876543210').map((s) => s.id), [adHoc.id], "the dashboard's own agent is followed the same way");
  dropConnection('conn-run');
  assert.equal(resolveSession('conn-run').runId, null, 'a connection gone takes its run along');
  for (const s of [helper, stranger, adHoc]) destroySession(s.id);
  dropConnection('conn-run');
  dropConnection('conn-other');
});
