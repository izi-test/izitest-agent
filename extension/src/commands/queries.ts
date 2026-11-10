// Commands that read page state without modifying it
// These use chrome.scripting.executeScript (not CDP)
// because they only need DOM read access

import { resolveTabId, delay, ensureContentScript, captureTabScreenshot, TOP_FRAME } from '../helpers';
import { findFrame, framesWithRefs, sendToFrame, snapshotAllFrames } from '../frames';
import type {
  SnapshotParams, ExtractParams, PageInfoParams,
  ScreenshotParams, ExecuteJsParams, WaitParams,
  GetCookiesParams, CloseTabParams, CloseWindowParams, SnapshotResult
} from '../types';
import { getPage, isBrowserAttached } from '../puppeteer-client';
import { isOwnedWindow, forgetOwnedWindow, getWindowOwner, listOwnedWindows, listPopupWindows, popupParent, popupsOf } from '../owned-windows';
import { detachBrowser } from '../puppeteer-client';
import { hideCursor } from '../cursor';

const MAX_SNAPSHOT_ELEMENTS = 500;
const WAIT_MAX_TIMEOUT_MS = 10000;
const WAIT_POLL_MS = 300;

// ─── Snapshot ───────────────────────────────────────────────────────

export async function cmdSnapshot({ tabId, sessionId, ...options }: SnapshotParams): Promise<SnapshotResult> {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  await ensureContentScript(resolvedTabId);
  // The page, with the content of its cross-origin iframes merged in (see frames.ts).
  return snapshotAllFrames(resolvedTabId, options as Record<string, unknown>);
}

// ─── Extract ────────────────────────────────────────────────────────

export async function cmdExtract({ selector, attribute, tabId, sessionId, multiple }: ExtractParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);

  // Every frame of the tab, cross-origin iframes included; the page answers first.
  const results = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId, allFrames: true },
    func: (sel: string, attr: string | null, multi: boolean) => {
      // A frame its parent can read is searched by that parent; answering here as well
      // would return its elements twice.
      if (window.frameElement) return [];

      // This document and its same-origin iframes. Inlined: an injected function is
      // serialised, it cannot import a helper.
      const docs: Document[] = [];
      const visit = (doc: Document) => {
        docs.push(doc);
        for (const frame of doc.querySelectorAll('iframe, frame')) {
          try { const inner = (frame as HTMLIFrameElement).contentDocument; if (inner?.body) visit(inner); } catch { /* cross-origin */ }
        }
      };
      visit(document);

      const elements = multi
        ? docs.flatMap((doc) => Array.from(doc.querySelectorAll(sel)))
        : [docs.map((doc) => doc.querySelector(sel)).find(Boolean)].filter(Boolean) as Element[];

      // A field's "value" is what it holds now; the attribute is only what it started with
      // (null for a field filled since).
      const read = (el: Element) => attr === 'value' && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
        ? (el as HTMLInputElement).value
        : attr ? el.getAttribute(attr) : el.outerHTML;
      return elements.map(read);
    },
    args: [selector, attribute || null, multiple ?? false]
  });

  const found = results
    .sort((a, b) => (a.frameId === TOP_FRAME ? -1 : b.frameId === TOP_FRAME ? 1 : 0))
    .flatMap((r) => (r.result as (string | null)[] | undefined) ?? []);
  return multiple ? found : found.slice(0, 1);
}

// ─── Page Info ──────────────────────────────────────────────────────

export async function cmdGetPageInfo({ tabId, sessionId }: PageInfoParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
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

/**
 * The tab as it shows. A tab a test or an agent works in is under the debugger: Chrome draws
 * it for the capture wherever its window is — behind others, without the focus, in a Chrome
 * without windows. Any other tab is captured as the screen shows it.
 */
async function captureTab(tabId: number, format: 'png' | 'jpeg', quality: number): Promise<string> {
  if (isBrowserAttached(tabId)) {
    try {
      const page = await getPage(tabId);
      const cdp = (page as unknown as { _client(): { send(method: string, params: object): Promise<{ data: string }> } })._client();
      const shot = await cdp.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}) });
      return `data:image/${format};base64,${shot.data}`;
    } catch (err) {
      console.warn('[IziTest] Debugger capture failed, capturing the screen instead:', err instanceof Error ? err.message : String(err));
    }
  }
  return captureTabScreenshot(tabId, { format, quality });
}

export async function cmdScreenshot({ tabId, sessionId, annotate, format, quality }: ScreenshotParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  
  // Each cross-origin frame outlines its own refs (the page cannot reach into it); the page
  // then draws its own, with the banner counting every ref of the tab.
  const frames = annotate ? await framesWithRefs(resolvedTabId) : [];
  if (annotate) {
    let frameRefs = 0;
    for (const frameId of frames) {
      const drawn = await sendToFrame<{ refs?: number }>(resolvedTabId, frameId, { type: 'draw_annotations', banner: false })
        .catch(() => null);
      frameRefs += drawn?.refs ?? 0;
    }
    await sendToFrame(resolvedTabId, TOP_FRAME, { type: 'draw_annotations', banner: true, frameRefs })
      .catch(() => null);
    // Wait for render
    await delay(100);
  }

  // Without the cursor of the driven mouse: a screenshot compared with a baseline would differ by it.
  await hideCursor(resolvedTabId, true);
  const dataUrl = await captureTab(resolvedTabId, format ?? 'png', quality ?? 90)
    .finally(() => hideCursor(resolvedTabId, false));

  if (annotate) {
    for (const frameId of [TOP_FRAME, ...frames]) {
      await sendToFrame(resolvedTabId, frameId, { type: 'clear_annotations' }).catch(() => null);
    }
  }

  logScreenshotPreview(dataUrl);

  return { dataUrl, tabId: resolvedTabId };
}

// ─── Tabs ───────────────────────────────────────────────────────────

export async function cmdGetTabs() {
  const tabs = await chrome.tabs.query({});
  // Who each tab belongs to, so an agent can tell its own working window from another
  // session's and from the user's own tabs before passing an explicit tabId anywhere.
  const owners = new Map(await listOwnedWindows());
  const popups = await listPopupWindows();
  return tabs.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    status: tab.status,
    owner: owners.has(tab.windowId)
      ? (owners.get(tab.windowId) || 'izitest-agent (no session)')
      : 'user',
    // A popup the page opened (window.open): the working window it was opened from.
    ...(popups.has(tab.windowId) ? { openedFrom: popups.get(tab.windowId) } : {}),
  }));
}

export async function cmdCloseTab({ tabId }: CloseTabParams) {
  // Detach first, while the tab still exists: Puppeteer's ExtensionTransport.close() calls
  // chrome.debugger.detach without handling its rejection, so detaching after the tab is
  // gone surfaces as "Uncaught (in promise) No tab with given id".
  detachBrowser(tabId);
  await chrome.tabs.remove(tabId);
  return { success: true };
}

// Closes the whole window holding `tabId` — only if IziTest Agent opened that window.
// Returns a status rather than throwing, so the MCP tool can explain a refusal.
export async function cmdCloseWindow({ tabId, sessionId, liveSessions }: CloseWindowParams) {
  let windowId: number;
  try {
    windowId = (await chrome.tabs.get(tabId)).windowId;
  } catch {
    return { closed: false, reason: 'gone' }; // already closed (by the user, or earlier)
  }

  const tabs = await chrome.tabs.query({ windowId });
  if (!(await isOwnedWindow(windowId))) {
    return { closed: false, reason: 'not_owned', windowId, tabCount: tabs.length };
  }

  // A session closes its own window, never the window of another agent that is still
  // working. An owner that is no longer alive leaves an orphan, which anyone may close —
  // it is still a window IziTest Agent opened, never one of the user's.
  const owner = await getWindowOwner(windowId);
  const ownerIsWorking = !!owner && owner !== sessionId
    && (liveSessions === undefined || liveSessions.includes(owner));
  if (sessionId && ownerIsWorking) {
    return { closed: false, reason: 'other_session', windowId, tabCount: tabs.length, owner };
  }

  // Closing the working window closes the popups its pages opened too: they are the same
  // task's, and nobody would close them afterwards. A popup closed on its own goes alone.
  const isPopup = (await popupParent(windowId)) !== undefined;
  const windowIds = [windowId, ...(isPopup ? [] : await popupsOf(windowId))];

  const tabIds: number[] = [];
  let popupsClosed = 0;
  for (const id of windowIds) {
    const windowTabs = id === windowId ? tabs : await chrome.tabs.query({ windowId: id }).catch(() => []);
    // Same reason as cmdCloseTab: detach every tab of the window before destroying it,
    // rather than letting tabs.onRemoved detach from tabs that no longer exist.
    for (const tab of windowTabs) if (tab.id !== undefined) detachBrowser(tab.id);
    if (id === windowId) await chrome.windows.remove(id);
    const removed = id === windowId || await chrome.windows.remove(id).then(() => true, () => false);
    await forgetOwnedWindow(id);
    if (!removed) continue; // a popup already closed by its page
    if (id !== windowId) popupsClosed++;
    for (const tab of windowTabs) if (tab.id !== undefined) tabIds.push(tab.id);
  }
  return { closed: true, windowId, tabIds, isPopup, popupsClosed };
}

// ─── Wait ───────────────────────────────────────────────────────────

export async function cmdWait({ ms, selector, tabId, sessionId }: WaitParams) {
  if (ms) {
    await delay(ms);
    return { waited: ms };
  }

  if (selector) {
    const resolvedTabId = await resolveTabId(tabId, sessionId);

    // Looked for in every frame of the tab, cross-origin iframes included, and asked again
    // from here rather than watched from inside the page: a MutationObserver only sees its
    // own document, and page timers are throttled to ~1s in a hidden window, service worker
    // ones are not.
    const isThere = async (): Promise<boolean> => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: resolvedTabId, allFrames: true },
        func: (sel: string) => {
          if (window.frameElement) return false; // searched by its parent
          const find = (doc: Document): boolean => {
            if (doc.querySelector(sel)) return true;
            for (const frame of doc.querySelectorAll('iframe, frame')) {
              try { const inner = (frame as HTMLIFrameElement).contentDocument; if (inner?.body && find(inner)) return true; } catch { /* cross-origin */ }
            }
            return false;
          };
          return find(document);
        },
        args: [selector]
      }).catch(() => []);
      return results.some((r) => r.result === true);
    };

    const deadline = Date.now() + WAIT_MAX_TIMEOUT_MS;
    do {
      if (await isThere()) return { found: true, selector };
      await delay(WAIT_POLL_MS);
    } while (Date.now() < deadline);
    return { found: false, selector, timeout: true, waitedMs: WAIT_MAX_TIMEOUT_MS };
  }

  return { error: 'Specify either ms or selector' };
}

// ─── Execute JavaScript ─────────────────────────────────────────────

export async function cmdExecuteJs({ code, tabId, sessionId, frame }: ExecuteJsParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const page = await getPage(resolvedTabId);
  if (!frame) return page.evaluate(code);

  // Through the debugger when Puppeteer sees the frame: like on the page, the code then runs
  // whatever the frame's Content-Security-Policy says about eval.
  const target = await findFrame(resolvedTabId, frame);
  const matches = page.frames().filter((f) => f !== page.mainFrame() && f.url() === target.url);
  if (matches.length === 1) return matches[0].evaluate(code);

  // Otherwise straight into that frame. eval runs in the page's own world, so a frame whose
  // CSP forbids eval refuses it: say so rather than return nothing.
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId, frameIds: [target.frameId] },
    world: 'MAIN',
    args: [code],
    func: async (source: string) => {
      try {
        return { ok: true, value: await (0, eval)(source) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  });
  const outcome = injection?.result as { ok: boolean; value?: unknown; error?: string } | undefined;
  if (!outcome) throw new Error(`The iframe ${target.url} did not answer.`);
  if (!outcome.ok) {
    const csp = /unsafe-eval|Content Security Policy/i.test(outcome.error ?? '')
      ? ' This iframe\'s Content-Security-Policy forbids running code from a string; snapshot, extract and wait still read it.'
      : '';
    throw new Error(`In iframe ${target.url}: ${outcome.error}.${csp}`);
  }
  return outcome.value;
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
