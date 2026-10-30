// Live view — lets the cockpit watch what an agent does in its tab, without touching it.
//
//   GET /live/sessions                    active sessions, their tabs and last action
//   GET /live/tabs/{tabId}/stream?fps=10  MJPEG pushed by Page.startScreencast
//   GET /live/tabs/{tabId}/recording      frames kept since the session started (JSON, or ?format=mjpeg to replay)
//   GET /live/frames/{frameId}.jpg        one kept frame (action frames, recorded stream frames)
//   GET|PUT /live/settings                the switch that turns all of it off
//
// Strictly read-only: the extension side (extension/src/live.ts) only reads the tab through
// the DevTools protocol. No tab is activated, no window changes owner or comes to the
// front, nothing is drawn on the page, and no snapshot runs, so the agent's @eN refs stay
// exactly as they were.
//
// Every action an agent takes (navigate, click, fill, select, keyboard, act) leaves one frame
// on disk, whether anybody watches or not, and the tool result carries its frameId: no step
// is lost. On top of that, while a session has its working window open, its tab is recorded
// continuously — an image each time the screen changes, at most 2 per second — whether
// anybody watches or not (`continuousRecording`). Each session keeps its newest
// SESSION_MAX_STREAM_FRAMES stream frames, and all its action frames. Frames are kept
// RETENTION_MS.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import * as websocket from './websocket.js';
import { listSessions } from './session.js';
import { db, parseJson } from './db.js';

const DATA_DIR = process.env.IZITEST_LIVE_DIR
  || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'data', 'live');
const INDEX_FILE = join(DATA_DIR, 'index.jsonl');

export const MAX_VIEWERS_PER_TAB = 2;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_KEPT_FRAMES = Number(process.env.IZITEST_LIVE_MAX_FRAMES) || 20000;
// When continuous recording is off, a watched tab still keeps one stream frame per interval.
const RECORD_INTERVAL_MS = Number(process.env.IZITEST_LIVE_RECORD_INTERVAL_MS) || 1000;
const SESSION_MAX_STREAM_FRAMES = Number(process.env.IZITEST_LIVE_SESSION_MAX_FRAMES) || 300;
// Which tabs to record is re-checked this often (and right after each action), which also
// restarts a recording lost with an extension restart.
const RECONCILE_MS = 3000;
const ACTION_SETTLE_MS = 300;
const CAPTURE_TIMEOUT_MS = 4000;
const DEFAULT_FPS = 10;
const MAX_FPS = 30;
// The screencast only sends a frame when the screen changes. A stream quiet for this long
// is asked to start again — a no-op when it is alive, a restart when its debugger session
// went away (navigation that swapped the renderer, service worker restart).
const STREAM_REVIVE_MS = 5000;
const BOUNDARY = 'izitestframe';
const FRAME_ID = /^[a-z0-9]{6,12}-[0-9a-f]{12}$/;

export const LIVE_ACTIONS = new Set(['navigate', 'click', 'fill', 'select', 'keyboard']);

// The extensions, through the bridge. Tests swap in a fake browser.
let bridge = {
  sendCommand: websocket.sendCommand,
  getProfiles: websocket.getProfiles,
  broadcast: websocket.broadcastToExtensions,
};

export function setLiveBridge(fake) {
  bridge = { ...bridge, ...fake };
}

// ─── Switch ─────────────────────────────────────────────────────────
//
// IZITEST_LIVE=off is the hard switch: nothing can turn live view back on without a
// restart. Otherwise PUT /live/settings { enabled } flips it at runtime, kept in the settings
// table so it survives a restart.

const isOff = (v) => /^(0|off|false|no)$/i.test(v || '');
const ENV_OFF = isOff(process.env.IZITEST_LIVE);
// IZITEST_LIVE_RECORD=off: same, for the continuous recording only.
const ENV_RECORD_OFF = isOff(process.env.IZITEST_LIVE_RECORD);

function storedSettings() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'live'").get();
    const value = row ? parseJson(row.value) : null;
    return { enabled: value?.enabled !== false, continuousRecording: value?.continuousRecording !== false };
  } catch {
    return { enabled: true, continuousRecording: true }; // no database (unit tests): default on
  }
}

function saveSettings() {
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('live', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(JSON.stringify({ enabled, continuousRecording }));
  } catch (err) {
    log(`[live] Could not save the setting: ${err.message}`);
  }
}

// Read in initLive(): the database is not open yet when this module loads.
let enabled = !ENV_OFF;
let continuousRecording = !ENV_RECORD_OFF;

export function isLiveEnabled() {
  return enabled;
}

export function liveSettings() {
  return {
    enabled,
    lockedOffByEnv: ENV_OFF,
    continuousRecording,
    continuousRecordingLockedOffByEnv: ENV_RECORD_OFF,
    recordingTabs: [...recorders.keys()],
    maxViewersPerTab: MAX_VIEWERS_PER_TAB,
    retentionHours: RETENTION_MS / 3600000,
    sessionMaxStreamFrames: SESSION_MAX_STREAM_FRAMES,
    actions: [...LIVE_ACTIONS, 'act'],
  };
}

export function setLiveEnabled(on) {
  if (ENV_OFF && on) throw Object.assign(new Error('Live view is switched off by IZITEST_LIVE=off; restart the server without it to turn it on.'), { status: 409 });
  enabled = Boolean(on);
  saveSettings();
  if (!enabled) stopEverything();
  else scheduleReconcile();
  log(`[live] Live view ${enabled ? 'on' : 'off'}`);
  return liveSettings();
}

/** The continuous recording alone; live view itself (streams, action frames) stays as is. */
export function setContinuousRecording(on) {
  if (ENV_RECORD_OFF && on) throw Object.assign(new Error('Continuous recording is switched off by IZITEST_LIVE_RECORD=off; restart the server without it to turn it on.'), { status: 409 });
  continuousRecording = Boolean(on);
  saveSettings();
  orphanCheckDue = true;
  scheduleReconcile(0);
  log(`[live] Continuous recording ${continuousRecording ? 'on' : 'off'}`);
  return liveSettings();
}

// ─── Kept frames ────────────────────────────────────────────────────

const kept = []; // { frameId, tabId, at, kind: 'action'|'stream', action?, sessionId?, url? } oldest first
const keptById = new Map();
const streamFramesOf = new Map(); // sessionId → its stream entries, oldest first (the per-session cap)

function indexStreamFrame(entry) {
  if (entry.kind !== 'stream' || !entry.sessionId) return;
  if (!streamFramesOf.has(entry.sessionId)) streamFramesOf.set(entry.sessionId, []);
  streamFramesOf.get(entry.sessionId).push(entry);
}

function reindexStreamFrames() {
  streamFramesOf.clear();
  for (const entry of kept) indexStreamFrame(entry);
}

function framePath(frameId) {
  return join(DATA_DIR, `${frameId}.jpg`);
}

function loadIndex() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) return;
  const cutoff = Date.now() - RETENTION_MS;
  const lines = readFileSync(INDEX_FILE, 'utf8').split('\n').filter(Boolean);
  // Frames dropped by a session's cap leave a { drop } line instead of a rewrite.
  const dropped = new Set();
  for (const line of lines) {
    if (line.startsWith('{"drop"')) try { dropped.add(JSON.parse(line).drop); } catch { /* cut short */ }
  }
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.drop || dropped.has(entry.frameId)) continue;
      if (entry.at >= cutoff && FRAME_ID.test(entry.frameId) && existsSync(framePath(entry.frameId))) {
        kept.push(entry);
        keptById.set(entry.frameId, entry);
      }
    } catch { /* a line cut short by a crash */ }
  }
  kept.sort((a, b) => a.at - b.at);
  reindexStreamFrames();
  rewriteIndex();
}

function rewriteIndex() {
  writeFileSync(INDEX_FILE, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
}

function keep(buffer, meta) {
  const at = meta.at ?? Date.now();
  const frameId = `${at.toString(36)}-${randomBytes(6).toString('hex')}`;
  const entry = { frameId, ...meta, at };
  try {
    writeFileSync(framePath(frameId), buffer);
    appendFileSync(INDEX_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    log(`[live] Could not keep frame: ${err.message}`);
    return null;
  }
  kept.push(entry);
  keptById.set(frameId, entry);
  indexStreamFrame(entry);
  if (entry.kind === 'stream' && entry.sessionId) capSession(entry.sessionId);
  if (kept.length > MAX_KEPT_FRAMES) prune();
  return entry;
}

/**
 * A session keeps its newest SESSION_MAX_STREAM_FRAMES stream frames; its action frames are
 * never dropped here. The index gets a { drop } line per frame rather than a rewrite: at
 * 2 frames a second, rewriting 20 000 lines each time would cost more than the frames.
 */
function capSession(sessionId) {
  const list = streamFramesOf.get(sessionId);
  if (!list || list.length <= SESSION_MAX_STREAM_FRAMES) return;
  const excess = list.splice(0, list.length - SESSION_MAX_STREAM_FRAMES);
  const gone = new Set(excess.map((e) => e.frameId));
  kept.splice(0, kept.length, ...kept.filter((e) => !gone.has(e.frameId)));
  for (const entry of excess) {
    keptById.delete(entry.frameId);
    try { unlinkSync(framePath(entry.frameId)); } catch { /* already gone */ }
  }
  try {
    appendFileSync(INDEX_FILE, excess.map((e) => JSON.stringify({ drop: e.frameId })).join('\n') + '\n');
  } catch { /* the next rewrite drops them anyway: their files are gone */ }
}

/** Drop frames older than the retention, and the oldest beyond MAX_KEPT_FRAMES. */
export function prune(now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  let drop = 0;
  while (drop < kept.length && (kept[drop].at < cutoff || kept.length - drop > MAX_KEPT_FRAMES)) drop++;
  if (!drop) return 0;
  for (const entry of kept.splice(0, drop)) {
    keptById.delete(entry.frameId);
    try { unlinkSync(framePath(entry.frameId)); } catch { /* already gone */ }
  }
  reindexStreamFrames();
  rewriteIndex();
  return drop;
}

// ─── Who owns a tab ─────────────────────────────────────────────────

/** Tabs of every connected browser profile, each tagged with its profile. */
async function allTabs() {
  const profileIds = [...bridge.getProfiles().keys()];
  const lists = await Promise.all(profileIds.map(async (profile) => {
    try {
      const tabs = await bridge.sendCommand(profile, 'get_tabs', {}, 5000);
      return (tabs || []).map((t) => ({ ...t, profile }));
    } catch {
      return [];
    }
  }));
  return lists.flat();
}

/** The session working in this window (or that opened this popup). */
function sessionForTab(tab) {
  const sessions = listSessions();
  return sessions.find((s) => s.lastTabId === tab.id)
    || sessions.find((s) => s.windowId !== undefined && (s.windowId === tab.windowId || s.windowId === tab.openedFrom))
    || null;
}

/** An agent's tab: in a window IziTest Agent opened, or a popup opened from one. The
 *  user's own tabs are never shown — the same rule that keeps agents out of them. */
function isAgentTab(tab) {
  return tab.owner !== 'user' || tab.openedFrom !== undefined || Boolean(sessionForTab(tab));
}

async function findTab(tabId) {
  return (await allTabs()).find((t) => t.id === tabId) || null;
}

// ─── Frame per action ───────────────────────────────────────────────

/**
 * Keep the image of `tabId` once the page has settled (ACTION_SETTLE_MS at most) and return
 * its frameId — or null when live view is off or the capture failed. Never throws: an
 * action must not fail because its picture could not be taken.
 */
export async function captureActionFrame({ profile, tabId, action, session, dispatch = bridge.sendCommand }) {
  if (!enabled || tabId === undefined || tabId === null) return null;
  try {
    // `dispatch` is the one the action itself went through (the tools pass theirs).
    const frame = await dispatch(profile, 'live_capture', { tabId, settleMs: ACTION_SETTLE_MS }, CAPTURE_TIMEOUT_MS);
    if (!frame?.data) return null;
    const entry = keep(Buffer.from(frame.data, 'base64'), {
      tabId, kind: 'action', action, sessionId: session?.id, url: frame.url, width: frame.width, height: frame.height,
    });
    if (entry && session) session.lastFrameId = entry.frameId;
    // The window may be new (first navigate) or the front tab may have changed (a click
    // opened one): record it from now, not at the next periodic check.
    if (continuousRecording && !recorders.has(tabId)) scheduleReconcile();
    // A viewer of a page that stopped changing would otherwise never see this state: the
    // screencast only sends frames on change.
    if (entry) streams.get(tabId)?.offer(Buffer.from(frame.data, 'base64'), false);
    return entry?.frameId ?? null;
  } catch (err) {
    log(`[live] No frame after ${action} on tab ${tabId}: ${err.message}`);
    return null;
  }
}

// ─── Streams ────────────────────────────────────────────────────────

const streams = new Map(); // tabId → Stream

class Viewer {
  constructor(res, fps) {
    this.res = res;
    this.interval = 1000 / fps;
    this.lastSentAt = 0;
    this.pending = null;
    this.timer = null;
    res.on('drain', () => this.flush());
  }

  /** Newest frame wins: a viewer that is behind skips to the current image, but the last
   *  image of a burst is always delivered (it is what the screen shows now). */
  push(buffer) {
    this.pending = buffer;
    this.flush();
  }

  flush() {
    if (!this.pending || this.timer || this.res.writableEnded) return;
    if (this.res.writableNeedDrain) return; // 'drain' calls back
    const wait = this.interval - (Date.now() - this.lastSentAt);
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
      return;
    }
    const buffer = this.pending;
    this.pending = null;
    this.lastSentAt = Date.now();
    this.res.write(Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`),
      buffer,
      Buffer.from('\r\n'),
    ]));
  }

  close() {
    clearTimeout(this.timer);
    if (!this.res.writableEnded) this.res.end();
  }
}

class Stream {
  constructor(tab) {
    this.tabId = tab.id;
    this.windowId = tab.windowId;
    this.openedFrom = tab.openedFrom;
    this.profile = tab.profile;
    this.viewers = new Set();
    this.lastFrame = null;
    this.lastFrameAt = 0;
    this.lastKeptAt = 0;
    this.fps = DEFAULT_FPS;
    this.revive = setInterval(() => this.keepAlive(), STREAM_REVIVE_MS);
    this.revive.unref?.();
  }

  async start() {
    await bridge.sendCommand(this.profile, 'live_start', { tabId: this.tabId, fps: this.fps }, 8000);
  }

  async keepAlive() {
    if (Date.now() - this.lastFrameAt < STREAM_REVIVE_MS) return;
    try {
      await this.start();
    } catch (err) {
      log(`[live] Stream of tab ${this.tabId} ended: ${err.message}`);
      this.end();
    }
  }

  /** A frame for the viewers; `fromCast` frames are also kept for the recording. */
  offer(buffer, fromCast = true) {
    this.lastFrame = buffer;
    if (fromCast) {
      this.lastFrameAt = Date.now();
      // A tab recorded continuously already keeps its frames (see Recorders).
      if (!recorders.has(this.tabId) && Date.now() - this.lastKeptAt >= RECORD_INTERVAL_MS) {
        this.lastKeptAt = Date.now();
        const session = sessionForTab({ id: this.tabId, windowId: this.windowId, openedFrom: this.openedFrom });
        keep(buffer, { tabId: this.tabId, kind: 'stream', sessionId: session?.id });
      }
    }
    for (const viewer of this.viewers) viewer.push(buffer);
  }

  remove(viewer) {
    viewer.close();
    this.viewers.delete(viewer);
    if (this.viewers.size === 0) this.end();
  }

  end() {
    clearInterval(this.revive);
    for (const viewer of this.viewers) viewer.close();
    this.viewers.clear();
    if (streams.get(this.tabId) === this) streams.delete(this.tabId);
    bridge.sendCommand(this.profile, 'live_stop', { tabId: this.tabId }, 5000).catch(() => {});
    log(`[live] Stream of tab ${this.tabId} stopped (no viewer left)`);
  }
}

function stopEverything() {
  for (const stream of [...streams.values()]) stream.end();
  recorders.clear();
  bridge.broadcast({ type: 'command', id: `live-off-${Date.now()}`, command: 'live_stop_all', params: {} });
}

/** A screencast frame pushed by an extension ({ tabId, data: base64 JPEG }). */
export function deliverFrame(msg) {
  const stream = streams.get(msg.tabId);
  if (!stream || !enabled || typeof msg.data !== 'string') return;
  stream.offer(Buffer.from(msg.data, 'base64'));
}

websocket.onExtensionMessage('live_frame', deliverFrame);

// ─── Continuous recording ───────────────────────────────────────────

const recorders = new Map(); // tabId → { profile, sessionId }

/**
 * The tabs to record: for each session with its working window open, the tab it works in
 * and the tab in front in that window (a click may have opened a new one), plus the front
 * tab of popups opened from it.
 */
function wantedRecordings(tabs) {
  const wanted = new Map();
  for (const session of listSessions()) {
    if (session.windowId === undefined && session.lastTabId === undefined) continue;
    for (const tab of tabs) {
      const inWindow = session.windowId !== undefined && (tab.windowId === session.windowId || tab.openedFrom === session.windowId);
      if (tab.id === session.lastTabId || (inWindow && tab.active)) {
        if (!wanted.has(tab.id)) wanted.set(tab.id, { profile: tab.profile, sessionId: session.id });
      }
    }
  }
  return wanted;
}

let reconciling = null;
let reconcileTimer = null;
// Recordings the server does not know about exist only after it restarted while the
// extension kept recording, or after a switch: checked then, not every few seconds.
let orphanCheckDue = true;

/** Start the recordings that should run, stop the others. Safe to call any time. */
export function reconcileRecorders() {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const on = enabled && continuousRecording;
    const hasWindows = listSessions().some((s) => s.windowId !== undefined || s.lastTabId !== undefined);
    const wanted = on && hasWindows ? wantedRecordings(await allTabs()) : new Map();

    for (const [tabId, rec] of [...recorders]) {
      if (wanted.has(tabId)) continue;
      recorders.delete(tabId);
      bridge.sendCommand(rec.profile, 'live_record_stop', { tabId }, 5000).catch(() => {});
      log(`[live] Recording of tab ${tabId} stopped`);
    }
    for (const [tabId, rec] of wanted) {
      const isNew = !recorders.has(tabId);
      recorders.set(tabId, rec);
      // Idempotent on the extension side: re-asking every time restarts a recording lost
      // with an extension restart or a swapped debugger session.
      try {
        await bridge.sendCommand(rec.profile, 'live_record_start', { tabId }, 8000);
        if (isNew) log(`[live] Recording tab ${tabId} (session ${rec.sessionId})`);
      } catch (err) {
        recorders.delete(tabId);
        if (isNew) log(`[live] Could not record tab ${tabId}: ${err.message}`);
      }
    }

    // A recording the server does not want — it was restarted while the extension kept
    // recording — is stopped too.
    if (orphanCheckDue && bridge.getProfiles().size) {
      orphanCheckDue = false;
      for (const profile of bridge.getProfiles().keys()) {
        try {
          const { tabIds = [] } = await bridge.sendCommand(profile, 'live_record_list', {}, 5000) ?? {};
          for (const tabId of tabIds) {
            if (!recorders.has(tabId)) bridge.sendCommand(profile, 'live_record_stop', { tabId }, 5000).catch(() => {});
          }
        } catch { /* an extension without this command records nothing */ }
      }
    }
  })().finally(() => { reconciling = null; });
  return reconciling;
}

/** Soon (debounced): a navigate has just opened a window, it should be recorded from now. */
export function scheduleReconcile(ms = 100) {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileRecorders().catch((err) => log(`[live] Recording check failed: ${err.message}`));
  }, ms);
  reconcileTimer.unref?.();
}

/** A recorded frame pushed by an extension ({ tabId, data: base64 JPEG quality 50, at }). */
export function deliverRecordFrame(msg) {
  const rec = recorders.get(msg.tabId);
  if (!rec || !enabled || !continuousRecording || typeof msg.data !== 'string') return;
  keep(Buffer.from(msg.data, 'base64'), {
    tabId: msg.tabId, kind: 'stream', sessionId: rec.sessionId, at: Number(msg.at) || Date.now(),
  });
}

websocket.onExtensionMessage('live_record', deliverRecordFrame);

// ─── HTTP ───────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function handleSessions(res) {
  const tabs = await allTabs();
  const sessions = listSessions().map((s) => {
    const own = tabs.filter((t) =>
      (s.windowId !== undefined && (t.windowId === s.windowId || t.openedFrom === s.windowId))
      || t.id === s.lastTabId);
    return {
      id: s.id,
      name: s.label,
      client: s.client ?? null,
      windowId: s.windowId ?? null,
      tabs: own.map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        ...(t.openedFrom !== undefined ? { popup: true } : {}),
        viewers: streams.get(t.id)?.viewers.size ?? 0,
        recording: recorders.has(t.id),
      })),
      lastAction: s.lastAction ?? null,
      recording: own.filter((t) => recorders.has(t.id)).map((t) => t.id),
      createdAt: new Date(s.createdAt).toISOString(),
    };
  });
  json(res, 200, { enabled, sessions });
}

async function handleStream(req, res, tabId, url) {
  const fps = Math.max(1, Math.min(MAX_FPS, Number(url.searchParams.get('fps')) || DEFAULT_FPS));
  let stream = streams.get(tabId);
  if (stream && stream.viewers.size >= MAX_VIEWERS_PER_TAB) {
    return json(res, 429, { error: `Tab ${tabId} already has ${MAX_VIEWERS_PER_TAB} viewers (the maximum).` });
  }

  if (!stream) {
    // Two viewers arriving together must share one stream: the second waits for the
    // first one's start instead of opening a stream of its own (and a third slot).
    let opening = starting.get(tabId);
    if (!opening) {
      opening = openStream(tabId, fps);
      starting.set(tabId, opening);
      opening.finally(() => starting.delete(tabId)).catch(() => {});
    }
    const opened = await opening;
    if (opened.error) return json(res, opened.status, { error: opened.error });
    stream = opened.stream;
  } else if (fps > stream.fps) {
    stream.fps = fps;
    stream.start().catch(() => {});
  }
  if (stream.viewers.size >= MAX_VIEWERS_PER_TAB) {
    return json(res, 429, { error: `Tab ${tabId} already has ${MAX_VIEWERS_PER_TAB} viewers (the maximum).` });
  }

  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay(true);
  req.socket?.setTimeout(0);

  const viewer = new Viewer(res, fps);
  stream.viewers.add(viewer);
  log(`[live] Viewer joined tab ${tabId} (${stream.viewers.size}/${MAX_VIEWERS_PER_TAB}, ${fps} fps)`);
  // A page that does not change sends nothing: show what it shows now.
  if (stream.lastFrame) viewer.push(stream.lastFrame);
  else seedFrame(stream);

  const leave = () => {
    if (!stream.viewers.has(viewer)) return;
    stream.remove(viewer);
    log(`[live] Viewer left tab ${tabId}`);
  };
  // Not req's 'close': for a GET it fires as soon as the request has been read.
  res.on('close', leave);
}

const starting = new Map(); // tabId → Promise<{ stream } | { status, error }>

async function openStream(tabId, fps) {
  const tab = await findTab(tabId);
  if (!tab) return { status: 404, error: `No tab ${tabId} in the connected browsers.` };
  if (!isAgentTab(tab)) return { status: 403, error: `Tab ${tabId} is one of the user's own tabs, not an agent's: it is not shown.` };
  const stream = new Stream(tab);
  stream.fps = fps;
  streams.set(tabId, stream);
  try {
    await stream.start();
  } catch (err) {
    stream.end();
    return { status: 502, error: `Could not stream tab ${tabId}: ${err.message}` };
  }
  return { stream };
}

async function seedFrame(stream) {
  try {
    const frame = await bridge.sendCommand(stream.profile, 'live_capture', { tabId: stream.tabId, settleMs: 0 }, CAPTURE_TIMEOUT_MS);
    if (frame?.data && !stream.lastFrame) stream.offer(Buffer.from(frame.data, 'base64'), false);
  } catch { /* the screencast's first frame will do */ }
}

/**
 * Frames of `tabId` since its session started. The session is the one working in the tab
 * now, or else the last one that left a frame there — its recording outlives it (24h).
 */
export function recordingOf(tabId, tab = { id: tabId }) {
  const ofTab = kept.filter((e) => e.tabId === tabId);
  const live = sessionForTab(tab);
  const sessionId = live?.id ?? [...ofTab].reverse().find((e) => e.sessionId)?.sessionId;
  const since = live?.createdAt ?? 0;
  const frames = ofTab.filter((e) => e.at >= since && (!sessionId || !e.sessionId || e.sessionId === sessionId));
  return { session: live, sessionId: sessionId ?? null, frames };
}

async function handleRecording(res, tabId, url) {
  const tab = streams.get(tabId) ? { id: tabId, windowId: streams.get(tabId).windowId, openedFrom: streams.get(tabId).openedFrom }
    : (await findTab(tabId)) ?? { id: tabId };
  const { session, sessionId, frames } = recordingOf(tabId, tab);
  if (url.searchParams.get('format') !== 'mjpeg') {
    return json(res, 200, {
      tabId,
      session: session
        ? { id: session.id, name: session.label, startedAt: new Date(session.createdAt).toISOString(), active: true }
        : (sessionId ? { id: sessionId, active: false } : null),
      count: frames.length,
      frames: frames.map((e) => ({
        frameId: e.frameId,
        at: new Date(e.at).toISOString(),
        kind: e.kind,
        ...(e.action ? { action: e.action } : {}),
        ...(e.url ? { url: e.url } : {}),
        src: `/live/frames/${e.frameId}.jpg`,
      })),
    });
  }

  // Replay at the pace it was recorded (?speed=4 to go faster), long idle gaps cut to 2s.
  const speed = Math.max(0.25, Math.min(32, Number(url.searchParams.get('speed')) || 1));
  res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-store' });
  let closed = false;
  res.on('close', () => { closed = true; });
  for (let i = 0; i < frames.length && !closed; i++) {
    let buffer;
    try { buffer = await readFile(framePath(frames[i].frameId)); } catch { continue; }
    res.write(Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`),
      buffer,
      Buffer.from('\r\n'),
    ]));
    const gap = i + 1 < frames.length ? Math.min(2000, frames[i + 1].at - frames[i].at) / speed : 0;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  }
  res.end();
}

async function handleFrame(res, frameId) {
  const entry = FRAME_ID.test(frameId) ? keptById.get(frameId) : null;
  if (!entry) return json(res, 404, { error: `No frame ${frameId} (frames are kept ${RETENTION_MS / 3600000}h).` });
  try {
    const buffer = await readFile(framePath(frameId));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=86400, immutable' });
    res.end(buffer);
  } catch {
    json(res, 404, { error: `Frame ${frameId} is gone.` });
  }
}

/** Routes under /live/. The caller has already checked the token. */
export async function liveRouter(req, res, url) {
  const path = url.pathname;
  try {
    if (path === '/live/settings') {
      if (req.method === 'GET') return json(res, 200, liveSettings());
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        const flags = ['enabled', 'continuousRecording'].filter((k) => k in body);
        if (!flags.length || flags.some((k) => typeof body[k] !== 'boolean')) {
          return json(res, 400, { error: 'Expected { "enabled": true | false } and/or { "continuousRecording": true | false }' });
        }
        if ('enabled' in body) setLiveEnabled(body.enabled);
        if ('continuousRecording' in body) setContinuousRecording(body.continuousRecording);
        return json(res, 200, liveSettings());
      }
      return json(res, 405, { error: 'GET or PUT' });
    }

    if (req.method !== 'GET') return json(res, 405, { error: 'Live view is read-only: GET only.' });
    if (!enabled) return json(res, 503, { error: 'Live view is switched off (PUT /live/settings { "enabled": true } to turn it on).', ...liveSettings() });

    if (path === '/live/sessions') return await handleSessions(res);

    let m = path.match(/^\/live\/tabs\/(\d+)\/stream$/);
    if (m) return await handleStream(req, res, Number(m[1]), url);

    m = path.match(/^\/live\/tabs\/(\d+)\/recording$/);
    if (m) return await handleRecording(res, Number(m[1]), url);

    m = path.match(/^\/live\/frames\/([^/]+)\.jpg$/);
    if (m) return await handleFrame(res, m[1]);

    return json(res, 404, { error: 'Unknown live route' });
  } catch (err) {
    log(`[live] ${path} failed: ${err.message}`);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
    else res.end();
  }
}

// ─── Init ───────────────────────────────────────────────────────────

/** `reconcileEveryMs: 0` leaves the periodic recording check to the caller (tests). */
export function initLive({ reconcileEveryMs = RECONCILE_MS } = {}) {
  const stored = storedSettings();
  enabled = ENV_OFF ? false : stored.enabled;
  continuousRecording = ENV_RECORD_OFF ? false : stored.continuousRecording;
  loadIndex();
  prune();
  setInterval(() => prune(), 10 * 60 * 1000).unref();
  if (reconcileEveryMs) {
    setInterval(() => reconcileRecorders().catch((err) => log(`[live] Recording check failed: ${err.message}`)), reconcileEveryMs).unref();
  }
  log(`[live] Live view ${enabled ? 'on' : 'off'}${ENV_OFF ? ' (IZITEST_LIVE=off)' : ''}, ` +
      `continuous recording ${enabled && continuousRecording ? 'on' : 'off'} — ${kept.length} frame(s) kept`);
}
