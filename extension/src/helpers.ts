// Shared utility functions used across commands

const TAB_LOAD_TIMEOUT_MS = 15000;
export const SCROLL_SETTLE_DELAY_MS = 150;

export async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
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
