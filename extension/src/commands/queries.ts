// Commands that read page state without modifying it
// These use chrome.scripting.executeScript (not CDP)
// because they only need DOM read access

import { resolveTabId, delay, ensureContentScript, captureTabScreenshot } from '../helpers';
import type {
  SnapshotParams, ExtractParams, PageInfoParams,
  ScreenshotParams, ExecuteJsParams, WaitParams,
  GetCookiesParams, CloseTabParams, SnapshotResult
} from '../types';
import { getPage } from '../puppeteer-client';

const MAX_SNAPSHOT_ELEMENTS = 500;
const WAIT_POLL_INTERVAL_MS = 200;
const WAIT_MAX_TIMEOUT_MS = 10000;

// ─── Snapshot ───────────────────────────────────────────────────────

export async function cmdSnapshot({ tabId, ...options }: SnapshotParams): Promise<SnapshotResult> {
  const resolvedTabId = await resolveTabId(tabId);
  await ensureContentScript(resolvedTabId);

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(resolvedTabId, { type: 'get_snapshot', options }, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response) {
        return reject(new Error('No response from content script'));
      }
      if (!response.success) {
        return reject(new Error(response.error || 'Failed to capture snapshot'));
      }
      resolve(response.result as SnapshotResult);
    });
  });
}

// ─── Extract ────────────────────────────────────────────────────────

export async function cmdExtract({ selector, attribute, tabId, multiple }: ExtractParams) {
  const resolvedTabId = await resolveTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    func: (sel: string, attr: string | null, multi: boolean) => {
      const elements = multi
        ? Array.from(document.querySelectorAll(sel))
        : [document.querySelector(sel)].filter(Boolean) as Element[];

      return elements.map(el => {
        if (attr) {
          return el.getAttribute(attr);
        }
        return el.outerHTML;
      });
    },
    args: [selector, attribute || null, multiple ?? false]
  });

  return results[0]?.result;
}

// ─── Page Info ──────────────────────────────────────────────────────

export async function cmdGetPageInfo({ tabId }: PageInfoParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    func: () => ({
      title: document.title,
      url: window.location.href,
      forms: document.forms.length,
      links: document.links.length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
      images: document.images.length,
      readyState: document.readyState,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight
    })
  });

  return {
    tab: { id: tab.id, url: tab.url, title: tab.title },
    page: results[0]?.result
  };
}

// ─── Screenshot ─────────────────────────────────────────────────────

const CONSOLE_PREVIEW_WIDTH_PX  = 600;
const CONSOLE_PREVIEW_HEIGHT_PX = 340;

function logScreenshotPreview(dataUrl: string): void {
  // Render image inline in DevTools using CSS background-image trick
  console.log(
    '%c                                                                              ',
    [
      `background-image: url('${dataUrl}')`,
      'background-size: contain',
      'background-repeat: no-repeat',
      'background-position: left center',
      `padding: ${CONSOLE_PREVIEW_HEIGHT_PX / 2}px ${CONSOLE_PREVIEW_WIDTH_PX / 2}px`,
      'border: 2px solid #7c3aed',
      'border-radius: 6px',
    ].join('; ')
  );
  // Clickable data URL — open in new tab to view full size
  console.log(
    '%c🖼️ Screenshot — click URL to open full size  %c' + dataUrl,
    'color: #7c3aed; font-weight: bold;',
    'color: #10b981; text-decoration: underline;'
  );
}

export async function cmdScreenshot({ tabId, annotate }: ScreenshotParams) {
  const resolvedTabId = await resolveTabId(tabId);
  
  if (annotate) {
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(resolvedTabId, { type: 'draw_annotations' }, resolve);
    });
    // Wait for render
    await delay(300);
  }

  const dataUrl = await captureTabScreenshot(resolvedTabId, { format: 'png', quality: 90 });

  if (annotate) {
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(resolvedTabId, { type: 'clear_annotations' }, resolve);
    });
  }

  logScreenshotPreview(dataUrl);

  return { dataUrl, tabId: resolvedTabId };
}

// ─── Tabs ───────────────────────────────────────────────────────────

export async function cmdGetTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    status: tab.status
  }));
}

export async function cmdCloseTab({ tabId }: CloseTabParams) {
  await chrome.tabs.remove(tabId);
  return { success: true };
}

// ─── Wait ───────────────────────────────────────────────────────────

export async function cmdWait({ ms, selector, tabId }: WaitParams) {
  if (ms) {
    await delay(ms);
    return { waited: ms };
  }

  if (selector) {
    const resolvedTabId = await resolveTabId(tabId);
    const startTime = Date.now();

    while (Date.now() - startTime < WAIT_MAX_TIMEOUT_MS) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: resolvedTabId },
        func: (sel: string) => !!document.querySelector(sel),
        args: [selector]
      });
      if (results[0]?.result) return { found: true, selector };
      await delay(WAIT_POLL_INTERVAL_MS);
    }
    return { found: false, selector, timeout: true };
  }

  return { error: 'Specify either ms or selector' };
}

// ─── Execute JavaScript ─────────────────────────────────────────────

export async function cmdExecuteJs({ code, tabId }: ExecuteJsParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);
  const result = await page.evaluate(code);
  return result;
}

// ─── Cookies ────────────────────────────────────────────────────────

export async function cmdGetCookies({ url, domain }: GetCookiesParams) {
  const query: chrome.cookies.GetAllDetails = {};
  if (url) query.url = url;
  if (domain) query.domain = domain;

  const cookies = await chrome.cookies.getAll(query);
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value.slice(0, 50) + '...',
    domain: cookie.domain,
    expires: cookie.expirationDate
  }));
}
