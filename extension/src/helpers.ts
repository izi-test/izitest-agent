// Shared utility functions used across commands

import { getSessionWindow, getWindowOwner } from './owned-windows';

/**
 * A refusal the agent is meant to read and act on — not a malfunction.
 * Flagged so the command loop can report it without logging it as an extension error.
 */
export class ExpectedRefusal extends Error {
  readonly expected = true;
  constructor(message: string) {
    super(message);
    this.name = 'ExpectedRefusal';
  }
}

export function isExpectedRefusal(error: unknown): boolean {
  return error instanceof Error && (error as { expected?: boolean }).expected === true;
}

const TAB_LOAD_TIMEOUT_MS = 15000;

/**
 * The page's own frame. Every message meant for the page names it: once the content script
 * also runs inside iframes, a message without a frameId goes to every frame of the tab and
 * the first one to answer wins.
 */
export const TOP_FRAME = 0;
export const SCROLL_SETTLE_DELAY_MS = 150;
const SCREENSHOT_MIN_INTERVAL_MS = 1200;
const SCREENSHOT_RETRY_DELAYS_MS = [800, 1500, 2200];
// Captures are serialised through one queue, so a capture that never settles would block
// every later one for the life of the service worker — and with it every command that
// takes a debug screenshot. captureVisibleTab can hang on a window that cannot be brought
// to the front, so no capture is allowed to run unbounded.
const SCREENSHOT_TIMEOUT_MS = 10000;

let lastScreenshotCaptureAt = 0;
let screenshotCaptureQueue: Promise<void> = Promise.resolve();

export async function getActiveTabId(): Promise<number> {
  // Strategy 1: active tab in the last focused window (ideal case)
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused?.id && focused.url && !focused.url.startsWith('chrome://')) return focused.id;

  // Strategy 2: active tab in any window (handles DevTools/popup stealing focus)
  const [anyActive] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (anyActive?.id && anyActive.url && !anyActive.url.startsWith('chrome://')) return anyActive.id;

  // Strategy 3: any active tab across all windows
  const allActive = await chrome.tabs.query({ active: true });
  const realTab = allActive.find(t => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
  if (realTab?.id) return realTab.id;

  throw new Error('No active tab found');
}

/**
 * Which tab a command acts on.
 *
 * An explicit tabId always wins. Otherwise the command stays inside its own session's
 * window — and if that session has no window yet, it fails instead of guessing.
 *
 * There is deliberately no fallback to the globally active tab for a session: "active"
 * means whichever window was focused last, which is either another agent's work or the
 * page the user is reading right now. Reading that page was never the intent, and it leaks
 * whatever the user happens to have open.
 *
 * The fallback survives only for callers with no session at all — the popup's debug panel,
 * which acts on the current tab on purpose.
 */
export async function resolveTabId(tabId?: number, sessionId?: string): Promise<number> {
  if (tabId) return tabId;

  if (sessionId) {
    const windowId = await getSessionWindow(sessionId);
    if (windowId !== undefined) {
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (active?.id) return active.id;
    }
    throw new ExpectedRefusal(
      `This session has no window of its own yet, so there is no tab to act on. ` +
      `Call navigate() first — it opens one — or pass an explicit tabId to work in a tab ` +
      `that already exists (get_tabs lists them, with the owner of each). ` +
      `IziTest Agent will not fall back to the foreground tab: that is the user's own page.`
    );
  }

  return getActiveTabId();
}

/**
 * Refuse an explicit tabId that points into another agent's working window.
 *
 * Seen live: session B passed session A's tabId, read A's page and navigated in it. The
 * window changed owner, A could no longer close its own window, and B's close_window
 * closed A's. Taking over another agent's tab now has to be asked for, with force.
 */
export async function assertTabIsNotAnotherSessions(
  tabId: number,
  sessionId: string | undefined,
  { liveSessions, force }: { liveSessions?: string[]; force?: boolean }
): Promise<void> {
  if (!sessionId || force) return;

  let windowId: number;
  try {
    windowId = (await chrome.tabs.get(tabId)).windowId;
  } catch {
    return; // the tab is gone; let the command fail on its own terms
  }

  const owner = await getWindowOwner(windowId);
  if (!owner || owner === sessionId) return;
  // An owner that is no longer alive left an orphan — nobody is working there.
  if (liveSessions !== undefined && !liveSessions.includes(owner)) return;

  throw new ExpectedRefusal(
    `Tab ${tabId} is in the working window of session ${owner}, which is another agent ` +
    `still working. Acting there would move the window to you and leave that agent without ` +
    `one. Use your own tab (navigate() opens it), or pass force: true if you really mean to ` +
    `take over this tab.`
  );
}

/**
 * Until the tab's page has loaded: called once navigation is under way (after page.goto), it
 * waits for the tab's 'complete'.
 *
 * A page that has already loaded by then has already sent its 'complete', and no other comes:
 * it is answered at once. That is a page served from the cache — DOMContentLoaded and load in the
 * same instant, 'complete' told before page.goto returns. Seen in the headless Chrome: each
 * navigate to a logout that redirects to the app's home waited out the 15 s, from the second visit.
 */
export function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (changedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') done();
    };
    // Listening first, then looking: a 'complete' between the two is not missed either.
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(done, TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.get(tabId).then(
      (tab) => { if (tab.status === 'complete') done(); },
      // The tab is gone: nothing will load in it. The caller fails on its own terms.
      done,
    );
  });
}

/**
 * Get the windowId for a given tab. Used to ensure captureVisibleTab
 * targets the correct window regardless of which window has focus.
 */
export async function getWindowIdForTab(tabId: number): Promise<number> {
  const tab = await chrome.tabs.get(tabId);
  return tab.windowId;
}

function isCaptureQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
}

async function waitForScreenshotSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, SCREENSHOT_MIN_INTERVAL_MS - (now - lastScreenshotCaptureAt));
  if (waitMs > 0) {
    await delay(waitMs);
  }
}

/**
 * Capture a screenshot of a specific tab's window, regardless of focus.
 * Temporarily focuses the target window/tab if needed, captures, then restores.
 */
export async function captureTabScreenshot(tabId: number, options: { format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<string> {
  const runCapture = async (): Promise<string> => {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    // Ensure the target tab is the active tab in its window
    // (captureVisibleTab captures the active tab of the specified window)
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await delay(50);
    }

    await waitForScreenshotSlot();

    for (let attempt = 0; attempt <= SCREENSHOT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: options.format || 'png',
          quality: options.quality || 90
        });
        lastScreenshotCaptureAt = Date.now();
        return dataUrl;
      } catch (error) {
        if (!isCaptureQuotaError(error) || attempt === SCREENSHOT_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await delay(SCREENSHOT_RETRY_DELAYS_MS[attempt]);
      }
    }

    throw new Error('Screenshot capture failed unexpectedly');
  };

  const bounded = (): Promise<string> => Promise.race([
    runCapture(),
    delay(SCREENSHOT_TIMEOUT_MS).then(() => {
      throw new Error(`Screenshot of tab ${tabId} timed out after ${SCREENSHOT_TIMEOUT_MS}ms`);
    }),
  ]);

  const captureTask = screenshotCaptureQueue.then(bounded, bounded);
  screenshotCaptureQueue = captureTask.then(() => undefined, () => undefined);
  return captureTask;
}

export function updateBadge(text: string, color: string): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure the content script is loaded in the given tab.
 * Tries a ping first; if it fails, injects the script programmatically.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: TOP_FRAME });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [TOP_FRAME] },
      files: ['content.js']
    });
  }
}
