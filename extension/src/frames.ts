// Cross-origin iframes, seen from the service worker.
//
// A cross-origin frame's content is invisible to the page's content script, so each such
// frame gets the content script injected and snapshots itself; its position on the page is
// found by hopping from frame to parent (see dom/frame-hop.ts). Clicks and typing are
// still sent at page level: the browser routes them into the frame, as a real user's are.

import { TOP_FRAME } from './helpers';
import { mergeFrameTrees, type FrameAttachment } from './frame-tree';
import type { SnapshotResult } from './types';

export interface FrameInfo {
  frameId: number;
  url: string;
}

/** Every frame of the tab we are allowed to script, the page first. */
export async function listFrames(tabId: number): Promise<FrameInfo[]> {
  const results = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => location.href })
    .catch(() => []);
  return results
    .map((r) => ({ frameId: r.frameId, url: String(r.result ?? '') }))
    .sort((a, b) => (a.frameId === TOP_FRAME ? -1 : b.frameId === TOP_FRAME ? 1 : 0));
}

export function sendToFrame<T>(tabId: number, frameId: number, message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response as T);
    });
  });
}

/** Make sure the content script runs in this frame. False when the frame refuses it. */
export async function ensureContentScriptIn(tabId: number, frameId: number): Promise<boolean> {
  try {
    await sendToFrame(tabId, frameId, { type: 'ping' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Hops: where is a frame, and does a point in it reach the page? ──

export interface HopReport {
  token: string;
  /** The frame that answered: the parent of the frame that asked. */
  parentFrameId: number;
  ref: string | null;
  /** The parent can read the frame: it is same-origin, already merged into its tree. */
  inlined: boolean;
  visible: boolean;
  src: string;
  /** With a point: that point in the parent's viewport, and what it hits there. */
  x?: number;
  y?: number;
  ok?: boolean;
  scrolled?: boolean;
  coveredBy?: string;
}

const HOP_TIMEOUT_MS = 2000;
const pendingHops = new Map<string, (report: HopReport | null) => void>();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'frame_hop_report') return;
  const resolve = pendingHops.get(message.token);
  if (!resolve) return;
  pendingHops.delete(message.token);
  resolve({ ...message, parentFrameId: sender.frameId ?? TOP_FRAME });
});

/** Ask `frameId`'s parent where that frame is — and, with a point, whether a click there reaches it. */
export async function hop(
  tabId: number,
  frameId: number,
  point?: { x: number; y: number },
  uncover = false
): Promise<HopReport | null> {
  const token = crypto.randomUUID();
  const report = new Promise<HopReport | null>((resolve) => {
    pendingHops.set(token, resolve);
    setTimeout(() => {
      if (pendingHops.delete(token)) resolve(null);
    }, HOP_TIMEOUT_MS);
  });
  const sent = await sendToFrame<{ sent: boolean }>(tabId, frameId, { type: 'announce_to_parent', token, ...point, uncover })
    .catch(() => null);
  if (!sent?.sent) {
    pendingHops.delete(token);
    return null;
  }
  return report;
}

// ─── Which frame a ref lives in ──────────────────────────────────────
//
// In chrome.storage.session, not a variable: the service worker can be suspended between
// the snapshot that handed out the refs and the click that uses one.

const refFramesKey = (tabId: number) => `refFrames:${tabId}`;
const nextRefKey = (tabId: number) => `refNext:${tabId}`;
/** The ref of each <iframe> → the frame it holds, so execute_js can be pointed at one. */
const iframeRefsKey = (tabId: number) => `iframeRefs:${tabId}`;

/**
 * Record which frame each new ref lives in, and the next free ref number of the tab.
 * Refs outlive a snapshot, so the map grows with the page, and starts over with a new page.
 */
async function rememberRefFrames(
  tabId: number,
  map: Record<string, number>,
  nextRef: number,
  freshPage: boolean,
  iframes: Record<string, number> = {}
): Promise<void> {
  const stored = freshPage ? {} : await chrome.storage.session.get([refFramesKey(tabId), iframeRefsKey(tabId)]);
  const previous = (stored[refFramesKey(tabId)] as Record<string, number> | undefined) ?? {};
  const previousIframes = (stored[iframeRefsKey(tabId)] as Record<string, number> | undefined) ?? {};
  await chrome.storage.session.set({
    [refFramesKey(tabId)]: { ...previous, ...map },
    [iframeRefsKey(tabId)]: { ...previousIframes, ...iframes },
    [nextRefKey(tabId)]: nextRef,
  });
}

/**
 * The frame an agent means by `frame`: the ref of its <iframe> in a snapshot (@e4), or a
 * piece of its address. Throws with the frames there are when nothing matches.
 */
export async function findFrame(tabId: number, frame: string): Promise<FrameInfo> {
  const frames = await listFrames(tabId);
  const others = frames.filter((f) => f.frameId !== TOP_FRAME);

  if (/^@e\d+$/.test(frame.trim())) {
    const stored = await chrome.storage.session.get(iframeRefsKey(tabId));
    const frameId = (stored[iframeRefsKey(tabId)] as Record<string, number> | undefined)?.[frame.trim()];
    const found = others.find((f) => f.frameId === frameId);
    if (found) return found;
    throw new Error(
      `${frame} is not an iframe of the last snapshot, or its frame has since closed. ` +
      `Pass the iframe's [iframe] ref from a fresh snapshot, or a piece of its URL.`
    );
  }

  const needle = frame.toLowerCase();
  const found = others.find((f) => f.url.toLowerCase().includes(needle));
  if (found) return found;
  const list = others.map((f) => f.url).slice(0, 10).join(', ') || 'none';
  throw new Error(`No iframe whose URL contains "${frame}". Frames in this tab: ${list}.`);
}

async function storedNextRef(tabId: number): Promise<number> {
  const stored = await chrome.storage.session.get(nextRefKey(tabId));
  return (stored[nextRefKey(tabId)] as number | undefined) ?? 1;
}

export async function frameOfRef(tabId: number, ref: string): Promise<number> {
  const stored = await chrome.storage.session.get(refFramesKey(tabId));
  const map = stored[refFramesKey(tabId)] as Record<string, number> | undefined;
  return map?.[ref] ?? TOP_FRAME;
}

/** The cross-origin frames that handed out refs in the tab's last snapshot. */
export async function framesWithRefs(tabId: number): Promise<number[]> {
  const stored = await chrome.storage.session.get(refFramesKey(tabId));
  const map = (stored[refFramesKey(tabId)] as Record<string, number> | undefined) ?? {};
  return [...new Set(Object.values(map))].filter((id) => id !== TOP_FRAME);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([refFramesKey(tabId), nextRefKey(tabId), iframeRefsKey(tabId)]).catch(() => {});
});

// ─── Snapshot across frames ──────────────────────────────────────────

type FrameSnapshot = SnapshotResult & { nextRef?: number };

async function snapshotFrame(tabId: number, frameId: number, options: Record<string, unknown>): Promise<FrameSnapshot> {
  const response = await sendToFrame<{ success: boolean; result?: FrameSnapshot; error?: string }>(
    tabId, frameId, { type: 'get_snapshot', options });
  if (!response?.success || !response.result) throw new Error(response?.error || 'Failed to capture snapshot');
  return response.result;
}

/**
 * The page's snapshot with the content of its cross-origin iframes merged in.
 *
 * Same-origin iframes are already part of the page's own snapshot. Each cross-origin frame
 * snapshots itself — after its parent, so it knows which ref its <iframe> got — numbering
 * its refs after everything handed out so far. Hidden frames (tracking pixels) are skipped.
 */
export async function snapshotAllFrames(tabId: number, options: Record<string, unknown>): Promise<SnapshotResult> {
  // Elements already named keep their ref; new ones are numbered above every ref the tab
  // has handed out, so a number never comes back meaning something else. A new page starts
  // over at @e1, and its frames forget the refs of the page before.
  const top = await snapshotFrame(tabId, TOP_FRAME, { ...options, refStart: await storedNextRef(tabId), restartIfFresh: true });
  const freshPage = top.freshRefs === true;

  const others = options.scope ? [] : (await listFrames(tabId)).filter((f) => f.frameId !== TOP_FRAME);
  if (others.length === 0) {
    await rememberRefFrames(tabId, {}, top.nextRef ?? 1, freshPage);
    return top;
  }

  const injected = await Promise.all(others.map((f) => ensureContentScriptIn(tabId, f.frameId)));
  const placed = await Promise.all(
    others.map(async (f, i) => ({ frame: f, report: injected[i] ? await hop(tabId, f.frameId) : null }))
  );

  // Every iframe the page names by a ref, same-origin ones included: execute_js can target it.
  const iframes: Record<string, number> = {};
  for (const p of placed) if (p.report?.ref) iframes[p.report.ref] = p.frame.frameId;

  let pending = placed.filter((p) => p.report && !p.report.inlined && p.report.visible);
  const snapshots = new Map<number, FrameSnapshot>([[TOP_FRAME, top]]);
  const attachments: FrameAttachment[] = [];
  const refFrames: Record<string, number> = {};
  let nextRef = top.nextRef ?? 1;

  while (pending.length) {
    // A frame goes after its parent, whose snapshot names its <iframe>. A parent that is
    // never snapshotted (a same-origin frame merged into its own parent) does not block it.
    let ready = pending.filter((p) => snapshots.has(p.report!.parentFrameId));
    if (ready.length === 0) ready = pending;

    for (const p of ready) {
      // The first round of hops ran before any frame was snapshotted, so a frame inside
      // another iframe was told its <iframe> had no ref yet. Ask again now that the parent
      // has handed out its refs; the page's own refs existed from the start.
      let place = p.report!;
      if (place.parentFrameId !== TOP_FRAME && snapshots.has(place.parentFrameId)) {
        place = (await hop(tabId, p.frame.frameId)) ?? place;
      }

      const snap = await snapshotFrame(tabId, p.frame.frameId, { ...options, refStart: nextRef, resetRefs: freshPage })
        .catch(() => null);
      if (!snap) continue;
      nextRef = Math.max(nextRef, snap.nextRef ?? nextRef);
      for (const m of snap.tree.matchAll(/^\s*(@e\d+)/gm)) refFrames[m[1]] = p.frame.frameId;
      snapshots.set(p.frame.frameId, snap);
      if (place.ref && snapshots.has(place.parentFrameId)) iframes[place.ref] = p.frame.frameId;
      attachments.push({
        parentFrameId: place.parentFrameId,
        ref: snapshots.has(place.parentFrameId) ? place.ref : null,
        childFrameId: p.frame.frameId,
        src: place.src || p.frame.url,
      });
    }
    pending = pending.filter((p) => !ready.includes(p));
  }

  await rememberRefFrames(tabId, refFrames, nextRef, freshPage, iframes);

  const trees = new Map([...snapshots].map(([id, s]) => [id, s.tree.split('\n')]));
  const refs = Object.assign({}, ...[...snapshots.values()].map((s) => s.refs ?? {}));
  return { ...top, tree: mergeFrameTrees(trees, attachments, TOP_FRAME).join('\n'), refs };
}

// ─── Measuring a click target inside a frame ─────────────────────────

export interface FramePoint {
  x: number;
  y: number;
  tag: string;
  text: string;
  scrolled?: boolean;
  coveredBy?: string;
}

/**
 * Where on the page to click an element of `frameId`, and whether the click would reach it.
 *
 * `measureLocal` measures it inside its own frame (with that frame's own covered check);
 * then each parent in turn places the point on its own viewport and checks the click would
 * land on the <iframe> — a banner over the iframe stops it just like one over a button.
 */
export async function measureInFrame(
  tabId: number,
  frameId: number,
  uncover: boolean,
  measureLocal: (uncover: boolean) => Promise<FramePoint>
): Promise<FramePoint> {
  const local = await measureLocal(uncover);
  if (local.coveredBy || local.scrolled) return local;

  let point = { x: local.x, y: local.y };
  for (let current = frameId; current !== TOP_FRAME; ) {
    const report = await hop(tabId, current, point, uncover);
    if (!report) {
      return { ...local, coveredBy: 'its frame, which could not be located on the page (it may have just closed or reloaded)' };
    }
    if (report.scrolled) return { ...local, scrolled: true };
    if (!report.ok) return { ...local, x: report.x ?? point.x, y: report.y ?? point.y, coveredBy: report.coveredBy };
    point = { x: report.x!, y: report.y! };
    current = report.parentFrameId;
  }
  return { ...local, ...point, scrolled: false };
}

/** The first non-page frame where `ask` succeeds — for selectors that are not on the page itself. */
export async function findInFrames<T extends { success: boolean }>(
  tabId: number,
  ask: (frameId: number) => Promise<T>
): Promise<{ frameId: number; answer: T } | null> {
  for (const frame of await listFrames(tabId)) {
    if (frame.frameId === TOP_FRAME) continue;
    if (!(await ensureContentScriptIn(tabId, frame.frameId))) continue;
    const answer = await ask(frame.frameId).catch(() => null);
    if (answer?.success) return { frameId: frame.frameId, answer };
  }
  return null;
}

