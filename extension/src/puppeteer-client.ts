import {
  connect,
  ExtensionTransport,
  Browser,
  Page
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';

const connectedBrowsers = new Map<number, Browser>();
const connectedPages = new Map<number, Page>();

export async function ensureBrowserAttached(tabId: number): Promise<Browser> {
  if (connectedBrowsers.has(tabId)) {
    return connectedBrowsers.get(tabId)!;
  }

  const browser = await connect({
    transport: await ExtensionTransport.connectTab(tabId),
    defaultViewport: null // Do not alter the actual browser window viewport
  });

  connectedBrowsers.set(tabId, browser);

  browser.on('disconnected', () => {
    connectedBrowsers.delete(tabId);
    connectedPages.delete(tabId);
  });

  return browser;
}

export async function getPage(tabId: number): Promise<Page> {
  if (connectedPages.has(tabId)) {
    return connectedPages.get(tabId)!;
  }

  const browser = await ensureBrowserAttached(tabId);
  const pages = await browser.pages();
  
  const page = pages[0];
  if (!page) {
    throw new Error('No page found for tab ' + tabId);
  }
  
  connectedPages.set(tabId, page);
  return page;
}

export function detachBrowser(tabId: number): void {
  const browser = connectedBrowsers.get(tabId);
  if (browser) {
    // browser.disconnect() might throw if the tab is already destroyed, we can wrap it
    try { browser.disconnect(); } catch (e) {}
    connectedBrowsers.delete(tabId);
    connectedPages.delete(tabId);
  }
}

export function isBrowserAttached(tabId: number): boolean {
  return connectedBrowsers.has(tabId);
}

// ─── Lifecycle Cleanup ──────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  detachBrowser(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    detachBrowser(source.tabId);
  }
});
