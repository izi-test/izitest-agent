import {
  connect,
  ExtensionTransport,
  Browser,
  Page,
  Dialog
} from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';
import { isHeadless, pageUserAgent } from './headless';
import { showCursorOf } from './cursor';

const connectedBrowsers = new Map<number, Browser>();
const connectedPages = new Map<number, Page>();

// ─── Native JavaScript Dialog State ────────────────────────────────
// When a page calls window.confirm/alert/prompt, Chrome renders a native
// popup that is NOT in the DOM. Puppeteer surfaces it via page.on('dialog').
// If no handler resolves it, the page's JS thread stays frozen forever.
//
// We attach a persistent listener to every page that STORES the dialog
// as "pending" without resolving it. A follow-up handle_dialog command
// reads from this map and calls accept()/dismiss(). A safety timeout
// auto-dismisses orphaned dialogs after 30 s so pages never freeze.

export interface PendingDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue: string;
  dialog: Dialog;
  createdAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingDialogs = new Map<number, PendingDialog>();
const DIALOG_SAFETY_TIMEOUT_MS = 30_000;

function attachDialogListener(tabId: number, page: Page): void {
  page.on('dialog', async (dialog: Dialog) => {
    // Clear any prior orphan (shouldn't happen — native dialogs are modal,
    // only one at a time — but be defensive).
    const prev = pendingDialogs.get(tabId);
    if (prev) {
      clearTimeout(prev.timeoutHandle);
      try { await prev.dialog.dismiss(); } catch {}
    }

    const timeoutHandle = setTimeout(async () => {
      const current = pendingDialogs.get(tabId);
      if (current && current.dialog === dialog) {
        console.warn(`[IziTest] Dialog on tab ${tabId} timed out after ${DIALOG_SAFETY_TIMEOUT_MS}ms — auto-dismissing`);
        pendingDialogs.delete(tabId);
        try { await dialog.dismiss(); } catch {}
      }
    }, DIALOG_SAFETY_TIMEOUT_MS);

    pendingDialogs.set(tabId, {
      type: dialog.type() as PendingDialog['type'],
      message: dialog.message(),
      defaultValue: dialog.defaultValue() || '',
      dialog,
      createdAt: Date.now(),
      timeoutHandle
    });

    console.log(`[IziTest] Dialog detected on tab ${tabId}: ${dialog.type()} "${dialog.message()}"`);
  });
}

export function getPendingDialog(tabId: number): PendingDialog | undefined {
  return pendingDialogs.get(tabId);
}

export function consumePendingDialog(tabId: number): PendingDialog | undefined {
  const pd = pendingDialogs.get(tabId);
  if (pd) {
    clearTimeout(pd.timeoutHandle);
    pendingDialogs.delete(tabId);
  }
  return pd;
}

export function waitForPendingDialog(tabId: number, timeoutMs: number): Promise<PendingDialog | null> {
  return new Promise((resolve) => {
    const existing = pendingDialogs.get(tabId);
    if (existing) return resolve(existing);

    const start = Date.now();
    const poll = () => {
      const pd = pendingDialogs.get(tabId);
      if (pd) return resolve(pd);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  });
}

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
  await emulateForeground(page);
  // Its mouse, shown in the tab as a blue cursor (cursor.ts): seen in the live view.
  showCursorOf(tabId, page);
  // What the page asks of the network, kept from now on: a test step may read the answer to a
  // request a click made (the server's capture, what: "request"). Loaded here, not on import:
  // the network module sets up Chrome's listeners as it loads.
  const { attachNetworkCapture } = await import('./commands/network');
  attachNetworkCapture(tabId, page);
  return page;
}

/**
 * A replay's window is opened without the focus, and a headless one has none to give: the page
 * is told it has it (document.hasFocus(), focus and blur events, :focus styles), as in a window
 * in front. In a Chrome without windows, it is also told the browser's usual name.
 */
async function emulateForeground(page: Page): Promise<void> {
  try {
    await page.emulateFocusedPage(true);
    if (isHeadless()) await page.setUserAgent(pageUserAgent());
  } catch (err) {
    console.warn('[IziTest] Could not emulate the focus:', err instanceof Error ? err.message : String(err));
  }
}

export function detachBrowser(tabId: number): void {
  const browser = connectedBrowsers.get(tabId);
  if (browser) {
    // disconnect() returns a promise: it detaches the debugger, which rejects with
    // "No tab with given id" when the tab is already gone — the usual case here, since
    // this runs from tabs.onRemoved. A plain try/catch only catches a synchronous throw,
    // so that rejection used to escape as an uncaught promise error.
    Promise.resolve()
      .then(() => browser.disconnect())
      .catch(() => { /* the tab is gone; nothing left to detach from */ });
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
