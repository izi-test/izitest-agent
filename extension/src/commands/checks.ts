// What a page does wrong on its own, without an assertion written for it: the errors it
// logs, the links that lead nowhere, the accessibility rules it breaks. Read by the explorer
// (mcp-server/lib/explore.js), by check_page, and by the assertions that reproduce a bug.

import { resolveTabId, TOP_FRAME } from '../helpers';
import type { Page, ConsoleMessage } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { ConsoleMessagesParams, CheckLinksParams, RunAxeParams } from '../types';

// ─── Console ─────────────────────────────────────────────────────────

interface ConsoleEntry {
  level: 'error' | 'warning';
  text: string;
  /** Where the page logged it: script URL and line, when Chrome knows. */
  source?: string;
  /** The page it was logged on. */
  pageUrl: string;
  timestamp: number;
}

const MAX_CONSOLE_ENTRIES = 200;
const consoleByTab = new Map<number, ConsoleEntry[]>();
const consoleAttached = new Set<number>();
// When the tab's page last started loading, and its address: what "this page" logged starts there.
const pageLoadedAt = new Map<number, number>();
const pageUrlOf = new Map<number, string>();
// Chrome's own line for a request answered 4xx/5xx: the network check reports the request.
const RESOURCE_FAILURE = /^Failed to load resource:/;

function pushConsole(tabId: number, entry: ConsoleEntry) {
  const entries = consoleByTab.get(tabId) ?? [];
  entries.push(entry);
  if (entries.length > MAX_CONSOLE_ENTRIES) entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
  consoleByTab.set(tabId, entries);
}

/** Keep the errors and warnings the tab's pages log, and the exceptions they throw. From navigate on. */
export function attachConsoleCapture(tabId: number, page: Page): void {
  if (consoleAttached.has(tabId)) return;
  consoleAttached.add(tabId);
  page.on('console', (message: ConsoleMessage) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warn') return;
    const text = message.text();
    if (RESOURCE_FAILURE.test(text)) return;
    const { url, lineNumber } = message.location() ?? {};
    pushConsole(tabId, {
      level: type === 'error' ? 'error' : 'warning', text: text.slice(0, 1000),
      ...(url ? { source: `${url}${lineNumber != null ? `:${lineNumber + 1}` : ''}` } : {}),
      pageUrl: page.url(), timestamp: Date.now(),
    });
  });
  pageLoadedAt.set(tabId, Date.now());
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    pageLoadedAt.set(tabId, Date.now());
    pageUrlOf.set(tabId, frame.url());
  });
  page.on('pageerror', (error: unknown) => {
    const text = error instanceof Error ? `Uncaught ${error.name}: ${error.message}` : `Uncaught ${String(error)}`;
    pushConsole(tabId, { level: 'error', text: text.slice(0, 1000), pageUrl: page.url(), timestamp: Date.now() });
  });
  page.once('close', () => {
    consoleByTab.delete(tabId);
    consoleAttached.delete(tabId);
    pageLoadedAt.delete(tabId);
    pageUrlOf.delete(tabId);
  });
}

/** What the tab's pages logged since `since` (ms): errors, or warnings too. */
export async function cmdConsoleMessages({ tabId, sessionId, since, level }: ConsoleMessagesParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const wanted = level === 'warning' ? ['error', 'warning'] : ['error'];
  const messages = (consoleByTab.get(resolvedTabId) ?? [])
    .filter((entry) => wanted.includes(entry.level) && (!since || entry.timestamp >= since));
  return { tabId: resolvedTabId, capturing: consoleAttached.has(resolvedTabId), pageLoadedAt: pageLoadedAt.get(resolvedTabId) ?? null, pageUrl: pageUrlOf.get(resolvedTabId) ?? null, messages };
}

// ─── Links ───────────────────────────────────────────────────────────

const LINK_TIMEOUT_MS = 8000;
const MAX_LINKS = 60;

/**
 * Follow the page's links to its own site and say what each answers — asked from the page,
 * with its cookies: a link behind a login is checked as the user sees it. Links elsewhere are
 * listed, not followed: other sites often turn away a request that is not a browser's.
 * With `selector`, only the links it matches.
 */
export async function cmdCheckLinks({ tabId, sessionId, selector, limit }: CheckLinksParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId, frameIds: [TOP_FRAME] },
    func: checkLinksInPage,
    args: [selector ?? null, Math.min(limit ?? MAX_LINKS, 200), LINK_TIMEOUT_MS],
  });
  return { tabId: resolvedTabId, ...(result?.result as object) };
}

/** Runs in the page: serialised by chrome.scripting, everything it uses is inside it. */
async function checkLinksInPage(selector: string | null, limit: number, timeoutMs: number) {
  const seen = new Map<string, { href: string; attr: string; text: string }>();
  let external = 0;
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>(selector ?? 'a[href]'))) {
    const attr = anchor.getAttribute('href') ?? '';
    if (!attr || attr.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(attr) || anchor.hasAttribute('download')) continue;
    let url: URL;
    try { url = new URL(attr, location.href); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.origin !== location.origin) { external++; continue; }
    url.hash = '';
    if (!seen.has(url.href)) seen.set(url.href, { href: url.href, attr, text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  const links = Array.from(seen.values()).slice(0, limit);

  const ask = async (href: string, method: 'HEAD' | 'GET') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Marked: the network check leaves IziTest's own requests out.
      const response = await fetch(href, { method, credentials: 'same-origin', redirect: 'follow', signal: controller.signal, headers: { 'X-IziTest-Check': 'links' } });
      return { status: response.status, type: (response.headers.get('content-type') ?? '').split(';')[0], finalUrl: response.url };
    } catch (error) {
      return { status: 0, type: '', finalUrl: href, error: controller.signal.aborted ? 'timeout' : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  const results: Array<Record<string, unknown>> = [];
  let next = 0;
  // Six at a time, as a browser opens connections to one host.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < links.length) {
      const link = links[next++];
      let answer = await ask(link.href, 'HEAD');
      // Some servers refuse HEAD, or answer it differently: asked again with GET.
      if (answer.status === 0 || answer.status >= 400) answer = await ask(link.href, 'GET');
      results.push({ ...link, ...answer });
    }
  }));
  return { page: location.href, checked: results.length, external, links: results };
}

// ─── Accessibility ───────────────────────────────────────────────────

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

/**
 * The accessibility rules the page breaks, by axe-core (injected on demand, in the
 * extension's own world of the page: the page's scripts do not see it). `rules` limits the
 * run to those rule ids, `selector` to that part of the page.
 */
export async function cmdRunAxe({ tabId, sessionId, rules, selector }: RunAxeParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const target = { tabId: resolvedTabId, frameIds: [TOP_FRAME] };
  await chrome.scripting.executeScript({ target, files: ['axe.min.js'] });
  const [result] = await chrome.scripting.executeScript({ target, func: runAxeInPage, args: [rules ?? null, selector ?? null, AXE_TAGS] });
  const answer = result?.result as { error?: string } | undefined;
  if (!answer || answer.error) throw new Error(`axe-core could not run on this page: ${answer?.error ?? 'no answer'}`);
  return { tabId: resolvedTabId, ...answer };
}

/** Runs in the page, after axe.min.js: serialised by chrome.scripting. */
async function runAxeInPage(rules: string[] | null, selector: string | null, tags: string[]) {
  const axe = (window as unknown as { axe?: { run: (context: unknown, options: unknown) => Promise<any> } }).axe;
  if (!axe) return { error: 'axe-core is not loaded' };
  const context = selector ? document.querySelector(selector) : document;
  if (!context) return { error: `Nothing on the page matches ${selector}` };
  try {
    const result = await axe.run(context, {
      runOnly: rules?.length ? { type: 'rule', values: rules } : { type: 'tag', values: tags },
      resultTypes: ['violations'],
    });
    return {
      page: location.href,
      violations: result.violations.map((violation: any) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        count: violation.nodes.length,
        nodes: violation.nodes.slice(0, 5).map((node: any) => ({
          target: node.target.join(' '),
          html: String(node.html).slice(0, 200),
          summary: String(node.failureSummary ?? '').slice(0, 300),
        })),
      })),
    };
  } catch (error) {
    return { error: String(error) };
  }
}
