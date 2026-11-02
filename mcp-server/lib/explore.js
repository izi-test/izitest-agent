// The explorer: walks a site on its own and reports what goes wrong without any assertion
// written for it — the errors a page logs, the requests it fails, the links that lead
// nowhere, the accessibility rules it breaks — on each page it reaches, and after each safe
// click on it. What it finds becomes bugs, each with a test that reproduces it (lib/bugs.js).
//
// Deterministic: no model decides where to go. Pages of the start URL's own site, breadth
// first; clicks only on what looks harmless (no delete, pay, log out…), never a form sent.
// The connected agent explores in depth on its own, with check_page.

import { log } from './logger.js';

export const CHECKS = ['console', 'network', 'links', 'a11y'];
// axe impacts reported by default: what blocks or seriously hinders someone.
export const DEFAULT_IMPACTS = ['critical', 'serious'];
export const SETTLE_MS = 1000;
const CLICK_SETTLE_MS = 700;
const MAX_CLICKS_PER_PAGE = 6;
// What a click must not do to an app it explores.
const DESTRUCTIVE = /delete|remove|destroy|erase|supprim|effac|retir|log ?out|sign ?out|d[ée]conn(ex|ect)|pay|payer|paiement|buy|ach[eè]t|order|command|checkout|subscri|abonn|cancel|annul|reset|r[ée]initialis|send|envoy|submit|valider|confirm|publish|publier|close account/i;
const CLICKABLE_ROLES = new Set(['button', 'tab', 'menuitem', 'switch', 'checkbox', 'radio', 'treeitem']);
// Not pages to visit: files a link downloads.
const FILE_LINK = /\.(pdf|zip|gz|tar|dmg|exe|msi|png|jpe?g|gif|webp|svg|mp4|mp3|csv|xlsx?|docx?)$/i;

/** A page's address as the explorer keys it: no fragment. */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

/** A path to name a page by: "/cart.html?id=2". */
export function pathOf(url) {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return String(url);
  }
}

/** Whether the explorer may click this element (a snapshot ref): a control, named, harmless. */
export function isSafeToClick(ref) {
  const name = String(ref?.name ?? '').trim();
  if (!name || name.length > 60 || DESTRUCTIVE.test(name)) return false;
  return CLICKABLE_ROLES.has(ref.role);
}

/** An error message without what changes from one run to the next: its stack, an "Uncaught X:" prefix. */
export function messageFragment(text) {
  const first = String(text ?? '').split('\n')[0].replace(/^Uncaught (\w+: )?/, '').trim();
  return first.length > 120 ? first.slice(0, 120) : first;
}

/**
 * What a page shows wrong, from what the checks read: `console` (console_messages),
 * `requests` (network_requests), `links` (check_links), `axe` (run_axe). `since` keeps only
 * what happened from then on; `via` is the click that caused it, if any.
 */
export function findingsOf({ page, since = 0, console: logged, requests, links, axe, impacts = DEFAULT_IMPACTS, via = null }) {
  const findings = [];
  const add = (finding) => findings.push({ page, ...(via ? { via } : {}), ...finding });
  for (const message of logged?.messages ?? []) {
    if (message.level !== 'error' || message.timestamp < since) continue;
    add({ kind: 'console_error', message: message.text, source: message.source ?? null });
  }
  for (const request of requests?.requests ?? []) {
    if ((request.timestamp ?? 0) < since || /favicon/i.test(request.url)) continue;
    if (request.status >= 400 || request.status === 0) {
      add({ kind: 'failed_request', request: { method: request.method, url: request.url, status: request.status, resourceType: request.resourceType } });
    }
  }
  for (const link of links?.links ?? []) {
    if (link.status >= 400 || link.status === 0) add({ kind: 'broken_link', link: { href: link.href, attr: link.attr, text: link.text, status: link.status, error: link.error ?? null } });
  }
  for (const violation of axe?.violations ?? []) {
    if (impacts.includes(violation.impact)) add({ kind: 'a11y', rule: violation });
  }
  return dedupe(findings);
}

/** One finding per bug: the same error logged five times on a page is one bug. */
function dedupe(findings) {
  const seen = new Map();
  for (const finding of findings) if (!seen.has(fingerprintOf(finding))) seen.set(fingerprintOf(finding), finding);
  return [...seen.values()];
}

/**
 * What makes two findings the same bug: its kind, the page (its path), the click that caused
 * it, and what went wrong — the message, the request, the link, the rule.
 */
export function fingerprintOf(finding) {
  const where = `${pathOf(finding.page)}${finding.via ? ` > ${finding.via.selector}` : ''}`;
  switch (finding.kind) {
    case 'console_error': return `console|${where}|${messageFragment(finding.message)}`;
    case 'failed_request': return `request|${where}|${finding.request.method} ${pathOf(finding.request.url)} ${finding.request.status}`;
    case 'broken_link': return `link|${pathOf(finding.link.href)}|${finding.link.status}`;
    case 'a11y': return `a11y|${where}|${finding.rule.id}`;
    default: return `${finding.kind}|${where}`;
  }
}

export function severityOf(finding) {
  switch (finding.kind) {
    case 'console_error': return /^Uncaught/.test(finding.message) ? 'high' : 'medium';
    case 'failed_request': return finding.request.status >= 500 || finding.request.status === 0 ? 'high' : 'medium';
    case 'broken_link': return 'medium';
    case 'a11y': return finding.rule.impact === 'critical' ? 'high' : finding.rule.impact === 'serious' ? 'medium' : 'low';
    default: return 'low';
  }
}

export function titleOf(finding) {
  const on = ` on ${pathOf(finding.page)}${finding.via ? ` after clicking "${finding.via.name}"` : ''}`;
  switch (finding.kind) {
    case 'console_error': return `Console error${on}: ${messageFragment(finding.message)}`;
    case 'failed_request': return `${finding.request.method} ${pathOf(finding.request.url)} → ${finding.request.status || 'no response'}${on}`;
    case 'broken_link': return `Broken link "${finding.link.text || finding.link.attr}" → ${pathOf(finding.link.href)} (${finding.link.status || finding.link.error || 'no response'})${on}`;
    case 'a11y': return `Accessibility: ${finding.rule.help} (${finding.rule.id}, ${finding.rule.count} element${finding.rule.count > 1 ? 's' : ''})${on}`;
    default: return `${finding.kind}${on}`;
  }
}

/** A CSS attribute selector's value, quoted. */
const cssString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The check a test makes to reproduce the finding: it fails while the bug is there, passes
 * once it is fixed.
 */
export function assertionOf(finding) {
  switch (finding.kind) {
    case 'console_error': return { type: 'no_console_errors', expected: messageFragment(finding.message) };
    case 'failed_request': return { type: 'no_failed_requests', expected: pathOf(finding.request.url) };
    case 'broken_link': return { type: 'link_ok', selector: `a[href=${cssString(finding.link.attr)}]` };
    case 'a11y': return { type: 'no_a11y_violations', expected: finding.rule.id };
    default: return null;
  }
}

/** The steps of a test that reproduces the finding: the page, the click, a moment, the check. */
export function reproStepsOf(finding) {
  const steps = [{ command: 'navigate', params: { url: finding.page }, intent: `Open ${pathOf(finding.page)}` }];
  if (finding.via) {
    steps.push({ command: 'click', params: { selector: finding.via.selector }, locators: finding.via.locators ?? [], intent: `Click "${finding.via.name}"` });
  }
  steps.push({ command: 'wait', params: { ms: SETTLE_MS }, intent: 'Let the page settle' });
  steps.push({ command: 'assert', params: {}, assertion: assertionOf(finding), intent: titleOf(finding) });
  return steps;
}

// ─── In the browser ────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the checks on the page of `tabId` now: console and network from `since` on — by
 * default from when this page started loading, not what earlier pages of the tab did — links
 * and accessibility as the page stands. Console and network are read first: the link check
 * makes requests of its own.
 */
export async function checkPage({ tabId, sendCommand, since = 0, checks = CHECKS, impacts = DEFAULT_IMPACTS, via = null, page }) {
  const ask = (command, params) => sendCommand(undefined, command, { tabId, ...params }).catch((err) => {
    log(`check ${command} failed on tab ${tabId}: ${err.message}`);
    return null;
  });
  const logged = await ask('console_messages', {});
  const from = since || logged?.pageLoadedAt || 0;
  const requests = checks.includes('network') ? await ask('network_requests', { limit: 300 }) : null;
  const [links, axe] = await Promise.all([
    checks.includes('links') ? ask('check_links', {}) : null,
    checks.includes('a11y') ? ask('run_axe', {}) : null,
  ]);
  const url = page ?? links?.page ?? axe?.page ?? logged?.pageUrl ?? null;
  const findings = findingsOf({ page: url, since: from, console: checks.includes('console') ? logged : null, requests, links, axe, impacts, via });
  return { findings, links: links?.links ?? [] };
}

/**
 * Explore from `startUrl`: its site's pages, breadth first, up to `maxPages` and within
 * `budgetMs`. `onProgress` hears of each page. The findings, and the pages visited.
 */
export async function explore({ startUrl, sendCommand, maxPages = 8, interact = true, checks = CHECKS, impacts = DEFAULT_IMPACTS, budgetMs = 120000, onProgress = () => {} }) {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Not a URL: ${startUrl}`);
  const origin = new URL(start).origin;
  const deadline = Date.now() + budgetMs;
  const queue = [start];
  const queued = new Set([start]);
  const pages = [];
  const findings = new Map();
  const keep = (list) => { for (const finding of list) if (!findings.has(fingerprintOf(finding))) findings.set(fingerprintOf(finding), finding); };

  let tabId = null;
  const open = async (url) => {
    const result = await sendCommand(undefined, 'navigate', tabId ? { url, tabId } : { url, newWindow: true });
    tabId = result?.tabId ?? tabId;
    await sleep(SETTLE_MS);
    return result;
  };

  while (queue.length && pages.length < maxPages && Date.now() < deadline) {
    const url = queue.shift();
    const since = Date.now();
    const page = { url, findings: 0, clicks: 0 };
    try {
      const loaded = await open(url);
      // A redirect elsewhere (a login page of another site): not this site's page.
      if (loaded?.url && new URL(loaded.url).origin !== origin) { page.skipped = `left the site for ${loaded.url}`; pages.push(page); continue; }
      const { findings: found, links } = await checkPage({ tabId, sendCommand, since, checks: [...checks, 'links'].filter((c, i, all) => all.indexOf(c) === i), impacts, page: url });
      keep(checks.includes('links') ? found : found.filter((f) => f.kind !== 'broken_link'));
      page.findings += found.length;
      for (const link of links) {
        const next = normalizeUrl(link.finalUrl || link.href);
        if (!next || queued.has(next) || new URL(next).origin !== origin || FILE_LINK.test(new URL(next).pathname)) continue;
        if (link.status >= 400 || link.status === 0 || (link.type && link.type !== 'text/html')) continue;
        queued.add(next);
        queue.push(next);
      }
      if (interact && Date.now() < deadline) {
        const clicked = await clickAround({ url, tabId, sendCommand, open, checks, impacts, deadline, keep });
        page.clicks = clicked.clicks;
        page.findings += clicked.findings;
      }
    } catch (err) {
      page.error = err.message;
      log(`Explorer: ${url} failed: ${err.message}`);
    }
    pages.push(page);
    onProgress({ page, pages, queued: queue.length, found: findings.size });
  }
  return { tabId, pages, findings: [...findings.values()], unvisited: queue.length, outOfTime: Date.now() >= deadline };
}

/**
 * Click each harmless control of the page in turn, from the page as loaded, and check what
 * each click made the page log or fail. The page is loaded again after a click that changed
 * it, so the next one starts from the same place.
 */
async function clickAround({ url, tabId, sendCommand, open, checks, impacts, deadline, keep }) {
  const snap = await sendCommand(undefined, 'snapshot', { tabId, purposeFilter: 'click', interactiveOnly: true, compact: true, format: 'text' }).catch(() => null);
  const controls = Object.values(snap?.refs ?? {}).filter((ref) => ref?.selector && isSafeToClick(ref)).slice(0, MAX_CLICKS_PER_PAGE);
  let clicks = 0;
  let found = 0;
  for (const control of controls) {
    if (Date.now() >= deadline) break;
    const since = Date.now();
    const result = await sendCommand(undefined, 'click', { tabId, selector: control.selector }).catch(() => null);
    if (!result) continue;
    clicks++;
    if (result.newTabId) await sendCommand(undefined, 'close_tab', { tabId: result.newTabId }).catch(() => {});
    await sleep(CLICK_SETTLE_MS);
    const via = { selector: control.selector, locators: control.locators ?? [], name: control.name, role: control.role };
    const { findings } = await checkPage({ tabId, sendCommand, since, checks: checks.filter((c) => c === 'console' || c === 'network'), impacts, via, page: url });
    keep(findings);
    found += findings.length;
    const changed = (result.changes ?? []).some((line) => !line.startsWith('no visible change'));
    if (changed) await open(url);
  }
  return { clicks, findings: found };
}
