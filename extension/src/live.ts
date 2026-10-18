// Live view: what an agent's tab shows, for someone watching from the cockpit.
//
// Strictly read-only. Everything here goes through the DevTools protocol on the tab's
// existing debugger session: no tab is activated, no window is focused or adopted, nothing
// is drawn on the page and no snapshot runs (so @eN refs are untouched). Page.captureScreenshot
// and Page.startScreencast both render a tab that is in the background, which
// chrome.tabs.captureVisibleTab cannot do without bringing it to the front.

import type { CDPSession } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import { getPage } from './puppeteer-client';
import { delay, TOP_FRAME } from './helpers';

export const LIVE_MAX_WIDTH = 1280;
const LIVE_MAX_HEIGHT = 2048;
const LIVE_JPEG_QUALITY = 60;   // what viewers get
const RECORD_JPEG_QUALITY = 50; // what the continuous recording keeps
const RECORD_INTERVAL_MS = 500; // at most 2 recorded images per second
// A hidden tab that is only recorded is captured when the page reports a change, and at
// least this often — for what changes the screen without an event (canvas, CSS animation).
const RECORD_HIDDEN_SAFETY_MS = 5000;
const SETTLE_QUIET_MS = 100;
const SETTLE_POLL_MS = 40;

export interface LiveCaptureParams {
  tabId: number;
  /** Wait at most this long for the page to stop changing before the capture. */
  settleMs?: number;
}

export interface LiveFrame {
  data: string; // base64 JPEG
  width: number;
  height: number;
  url?: string;
  title?: string;
}

async function client(tabId: number): Promise<CDPSession> {
  const page = await getPage(tabId);
  return (page as unknown as { _client(): CDPSession })._client();
}

// Runs in the content-script world, never in the page's: the page cannot see the observer.
// Timing stays in the service worker — timers of a background tab are throttled to 1s,
// mutation callbacks are not.
function sinceLastMutation(): number {
  const w = window as unknown as { __browserPilotLiveLastMutation?: number; __browserPilotLiveObserver?: MutationObserver };
  if (!w.__browserPilotLiveObserver) {
    w.__browserPilotLiveLastMutation = performance.now();
    w.__browserPilotLiveObserver = new MutationObserver(() => { w.__browserPilotLiveLastMutation = performance.now(); });
    w.__browserPilotLiveObserver.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return 0;
  }
  if (document.readyState === 'loading') return 0;
  return performance.now() - (w.__browserPilotLiveLastMutation ?? 0);
}

/** Wait until the page went SETTLE_QUIET_MS without a DOM change, or `maxMs` passed. */
async function settle(tabId: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    let quietFor = 0;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [TOP_FRAME] },
        func: sinceLastMutation,
      });
      quietFor = Number(res?.result) || 0;
    } catch {
      return; // a page the extension cannot script (chrome://, the web store): capture as is
    }
    if (quietFor >= SETTLE_QUIET_MS) return;
    await delay(Math.min(SETTLE_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** Base64 of a blob, in chunks (spreading a whole image overflows the call stack). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface Image { data: string; width: number; height: number }

/**
 * JPEG at most LIVE_MAX_WIDTH wide, at `quality`. Captures come at device pixels (2x on a
 * Retina screen). `reencode` forces a new encoding even when the size is fine — how a
 * viewer's quality-60 frame becomes a quality-50 recorded one.
 */
async function shrink(base64: string, quality = LIVE_JPEG_QUALITY, reencode = false): Promise<Image> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const { width, height } = bitmap;
  if (width <= LIVE_MAX_WIDTH && !reencode) {
    bitmap.close();
    return { data: base64, width, height };
  }
  const w = Math.min(width, LIVE_MAX_WIDTH);
  const h = Math.round((height * w) / width);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  return { data: await blobToBase64(blob), width: w, height: h };
}

/** Page.captureScreenshot renders a hidden tab too (the screencast does not). */
async function captureNow(cdp: CDPSession, quality = LIVE_JPEG_QUALITY): Promise<Image> {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality,
    optimizeForSpeed: true,
  });
  return shrink(shot.data, quality);
}

/** One image of the tab as it is now, once it has settled (or `settleMs` passed). */
export async function cmdLiveCapture({ tabId, settleMs = 300 }: LiveCaptureParams): Promise<LiveFrame> {
  const tab = await chrome.tabs.get(tabId);
  await settle(tabId, Math.max(0, Math.min(settleMs, 2000)));
  const image = await captureNow(await client(tabId));
  const now = await chrome.tabs.get(tabId).catch(() => tab);
  return { ...image, url: now.url, title: now.title };
}

// ─── Casts: one screencast per tab, for viewers and for the recording ─────────

type FrameSink = (tabId: number, frame: Image & { at: number }) => void;

let viewerSink: FrameSink = () => {};
let recordSink: FrameSink = () => {};

/** Where frames go: the background script forwards them to the bridge — viewer frames
 *  as `live_frame`, recorded ones as `live_record`. */
export function setLiveSink(viewers: FrameSink, recording: FrameSink = () => {}): void {
  viewerSink = viewers;
  recordSink = recording;
}

interface Cast {
  cdp: CDPSession;
  /** 0 = nobody watching. */
  viewerFps: number;
  recording: boolean;
  /** Settings the running screencast was started with. */
  quality: number;
  lastAckAt: number;
  lastViewerSent?: string;
  // Recording: newest candidate waits until RECORD_INTERVAL_MS after the last one kept, so
  // the last image of a burst is always recorded.
  lastRecordSource?: string;
  lastRecordedAt: number;
  pendingRecord?: { image: Image; quality: number };
  recordTimer?: ReturnType<typeof setTimeout>;
  // Hidden tab handling
  hidden: boolean;
  checkedAt: number;
  changes: number;
  changesAtCapture: number;
  lastPollCaptureAt: number;
  poller?: ReturnType<typeof setTimeout>;
  onFrame: (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => void;
}

const casts = new Map<number, Cast>();
const VISIBILITY_CHECK_MS = 1000;

const rateOf = (cast: Cast) => Math.max(cast.viewerFps, cast.recording ? 1000 / RECORD_INTERVAL_MS : 0);
const qualityOf = (cast: Cast) => (cast.viewerFps ? LIVE_JPEG_QUALITY : RECORD_JPEG_QUALITY);

// Content-script world again: visibility, and a counter of what can change the screen.
function pageState(): { visibility: string; changes: number } {
  const w = window as unknown as { __browserPilotLiveChanges?: number };
  if (w.__browserPilotLiveChanges === undefined) {
    w.__browserPilotLiveChanges = 1;
    const bump = () => { w.__browserPilotLiveChanges = (w.__browserPilotLiveChanges ?? 0) + 1; };
    new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const type of ['scroll', 'input', 'resize', 'load']) {
      window.addEventListener(type, bump, { capture: true, passive: true });
    }
  }
  return { visibility: document.visibilityState, changes: w.__browserPilotLiveChanges };
}

/** Hidden = background tab, minimized or covered window: Chrome stops painting it. */
async function readPageState(tabId: number): Promise<{ hidden: boolean; changes: number }> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [TOP_FRAME] }, func: pageState });
    const state = res?.result as { visibility: string; changes: number } | undefined;
    return { hidden: state?.visibility !== 'visible', changes: state?.changes ?? -1 };
  } catch {
    // Cannot ask (chrome:// page): treat as hidden and always changed; duplicates are dropped.
    return { hidden: true, changes: -1 };
  }
}

function toViewers(tabId: number, cast: Cast, image: Image): void {
  if (!cast.viewerFps || image.data === cast.lastViewerSent) return; // same screen: nothing changed
  cast.lastViewerSent = image.data;
  viewerSink(tabId, { ...image, at: Date.now() });
}

function toRecording(tabId: number, cast: Cast, image: Image, quality: number): void {
  if (!cast.recording || image.data === cast.lastRecordSource) return;
  cast.pendingRecord = { image, quality };
  flushRecord(tabId, cast);
}

function flushRecord(tabId: number, cast: Cast): void {
  if (!cast.pendingRecord || cast.recordTimer) return;
  const wait = RECORD_INTERVAL_MS - (Date.now() - cast.lastRecordedAt);
  if (wait > 0) {
    cast.recordTimer = setTimeout(() => { cast.recordTimer = undefined; flushRecord(tabId, cast); }, wait);
    return;
  }
  const { image, quality } = cast.pendingRecord;
  cast.pendingRecord = undefined;
  cast.lastRecordSource = image.data;
  cast.lastRecordedAt = Date.now();
  const at = Date.now();
  // Frames shared with viewers are at their quality: encode the recorded copy at its own.
  const ready = quality === RECORD_JPEG_QUALITY ? Promise.resolve(image) : shrink(image.data, RECORD_JPEG_QUALITY, true);
  ready
    .then((recorded) => { if (casts.get(tabId) === cast && cast.recording) recordSink(tabId, { ...recorded, at }); })
    .catch(() => {});
}

function deliver(tabId: number, cast: Cast, image: Image, quality: number): void {
  toViewers(tabId, cast, image);
  toRecording(tabId, cast, image, quality);
}

/**
 * The screencast goes silent while the tab is hidden; the tab is captured instead, and
 * only images that differ from the last one go out — still "an image when the screen
 * changes", found by looking rather than told. For viewers it looks at their fps. When the
 * tab is only recorded, it captures only after the page reported a change (or every
 * RECORD_HIDDEN_SAFETY_MS), so an idle agent window costs one script call per tick.
 */
function schedulePoll(tabId: number, cast: Cast): void {
  cast.poller = setTimeout(async () => {
    if (casts.get(tabId) !== cast) return;
    try {
      // Viewers' polls capture regardless of changes: their state is read once a second.
      // A recording-only hidden tab reads it every tick: it decides whether to capture.
      if (Date.now() - cast.checkedAt >= VISIBILITY_CHECK_MS || (cast.hidden && !cast.viewerFps)) {
        const state = await readPageState(tabId);
        cast.hidden = state.hidden;
        cast.checkedAt = Date.now();
        cast.changes = state.changes;
      }
      if (cast.hidden && !cast.cdp.detached) {
        const changed = cast.changes === -1 || cast.changes !== cast.changesAtCapture;
        const due = Date.now() - cast.lastPollCaptureAt >= RECORD_HIDDEN_SAFETY_MS;
        if (cast.viewerFps || changed || due) {
          const quality = qualityOf(cast);
          cast.changesAtCapture = cast.changes;
          cast.lastPollCaptureAt = Date.now();
          deliver(tabId, cast, await captureNow(cast.cdp, quality), quality);
        }
      }
    } catch { /* tab navigating or closing: try again next tick */ }
    if (casts.get(tabId) === cast) schedulePoll(tabId, cast);
  }, rateOf(cast) ? 1000 / rateOf(cast) : RECORD_INTERVAL_MS);
}

async function startScreencast(cast: Cast): Promise<void> {
  cast.quality = qualityOf(cast);
  await cast.cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: cast.quality,
    maxWidth: LIVE_MAX_WIDTH,
    maxHeight: LIVE_MAX_HEIGHT,
    everyNthFrame: 1,
  });
}

/** The cast of `tabId` on its current debugger session — started, or reused. */
async function ensureCast(tabId: number): Promise<{ cast: Cast; restarted: boolean }> {
  const cdp = await client(tabId);
  const current = casts.get(tabId);
  if (current && current.cdp === cdp && !cdp.detached) return { cast: current, restarted: false };
  if (current) stopCast(tabId, current);

  const cast: Cast = {
    cdp,
    // Carried over from a cast lost with its debugger session.
    viewerFps: current?.viewerFps ?? 0,
    recording: current?.recording ?? false,
    quality: 0,
    lastAckAt: 0,
    lastRecordedAt: 0,
    hidden: false,
    checkedAt: 0,
    changes: 0,
    changesAtCapture: 0,
    lastPollCaptureAt: 0,
    onFrame: (event) => {
      const now = Date.now();
      // While hidden, the poller's captures are the stream: the screencast frames each
      // capture provokes would alternate with them and defeat the duplicate check.
      if (!cast.hidden) {
        deliver(tabId, cast, { data: event.data, width: event.metadata.deviceWidth, height: event.metadata.deviceHeight }, cast.quality);
      }
      // Pacing: Chrome sends nothing new until a frame is acknowledged. Acknowledge no
      // sooner than 1/rate after the previous one, so a busy page never exceeds the rate.
      const wait = Math.max(0, 1000 / rateOf(cast) - (now - cast.lastAckAt));
      cast.lastAckAt = now + wait;
      setTimeout(() => {
        if (casts.get(tabId) !== cast) return;
        cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      }, wait);
    },
  };
  casts.set(tabId, cast);
  cdp.on('Page.screencastFrame', cast.onFrame as never);
  return { cast, restarted: Boolean(current) };
}

/** Apply the cast's needs: restart the screencast when its quality must change, stop it
 *  when nobody needs it any more. */
async function reconfigure(tabId: number, cast: Cast): Promise<void> {
  if (!cast.viewerFps && !cast.recording) {
    stopCast(tabId, cast);
    return;
  }
  if (cast.quality !== qualityOf(cast)) {
    if (cast.quality) await cast.cdp.send('Page.stopScreencast').catch(() => {});
    await startScreencast(cast);
  }
  if (!cast.poller) schedulePoll(tabId, cast);
}

function stopCast(tabId: number, cast: Cast): void {
  if (casts.get(tabId) === cast) casts.delete(tabId);
  clearTimeout(cast.poller);
  clearTimeout(cast.recordTimer);
  cast.cdp.off('Page.screencastFrame', cast.onFrame as never);
  if (!cast.cdp.detached && cast.quality) cast.cdp.send('Page.stopScreencast').catch(() => {});
}

export interface LiveStartParams {
  tabId: number;
  fps?: number;
}

/**
 * Stream the tab to viewers: an image each time the screen changes, at most `fps`.
 *
 * Idempotent: the bridge calls it again whenever the stream has gone quiet, which also
 * restarts a cast lost with a debugger session (navigation that swapped the renderer,
 * service worker restart).
 */
export async function cmdLiveStart({ tabId, fps = 10 }: LiveStartParams): Promise<{ streaming: true; fps: number; restarted: boolean }> {
  const rate = Math.max(1, Math.min(30, Math.round(fps)));
  const { cast, restarted } = await ensureCast(tabId);
  cast.viewerFps = rate;
  await reconfigure(tabId, cast);
  return { streaming: true, fps: rate, restarted };
}

export async function cmdLiveStop({ tabId }: { tabId: number }): Promise<{ streaming: false; recording: boolean }> {
  const cast = casts.get(tabId);
  if (cast) {
    cast.viewerFps = 0;
    cast.lastViewerSent = undefined;
    await reconfigure(tabId, cast);
  }
  return { streaming: false, recording: Boolean(cast?.recording && casts.has(tabId)) };
}

/**
 * Record the tab continuously, viewers or not: at most 2 images per second, quality 50.
 * Idempotent, like live_start — the bridge re-asks for every recorded tab regularly.
 */
export async function cmdLiveRecordStart({ tabId }: { tabId: number }): Promise<{ recording: true; restarted: boolean }> {
  const { cast, restarted } = await ensureCast(tabId);
  cast.recording = true;
  await reconfigure(tabId, cast);
  return { recording: true, restarted };
}

export async function cmdLiveRecordStop({ tabId }: { tabId: number }): Promise<{ recording: false }> {
  const cast = casts.get(tabId);
  if (cast) {
    cast.recording = false;
    cast.pendingRecord = undefined;
    clearTimeout(cast.recordTimer);
    cast.recordTimer = undefined;
    await reconfigure(tabId, cast);
  }
  return { recording: false };
}

/** Stop every stream and recording — the bridge asks for it when live view is switched off. */
export async function cmdLiveStopAll(): Promise<{ stopped: number }> {
  const n = casts.size;
  for (const [tabId, cast] of [...casts]) stopCast(tabId, cast);
  return { stopped: n };
}

/** Tabs being recorded — so the bridge can tell which recordings it no longer wants. */
export async function cmdLiveRecordList(): Promise<{ tabIds: number[] }> {
  return { tabIds: [...casts].filter(([, c]) => c.recording).map(([id]) => id) };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const cast = casts.get(tabId);
  if (cast) stopCast(tabId, cast);
});
