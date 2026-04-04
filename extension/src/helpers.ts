// Shared utility functions used across commands

const TAB_LOAD_TIMEOUT_MS = 15000;
export const SCROLL_SETTLE_DELAY_MS = 150;

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

export async function resolveTabId(tabId?: number): Promise<number> {
  return tabId ?? (await getActiveTabId());
}

export function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (changedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, TAB_LOAD_TIMEOUT_MS);
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

/**
 * Capture a screenshot of a specific tab's window, regardless of focus.
 * Temporarily focuses the target window/tab if needed, captures, then restores.
 */
export async function captureTabScreenshot(tabId: number, options: { format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  // Ensure the target tab is the active tab in its window
  // (captureVisibleTab captures the active tab of the specified window)
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await delay(100); // brief settle for tab activation
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: options.format || 'png',
    quality: options.quality || 90
  });
  return dataUrl;
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
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  }
}
