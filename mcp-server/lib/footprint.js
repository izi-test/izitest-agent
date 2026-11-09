// What a test touches in its app: the pages it goes to and the API it calls — its footprint.
// Kept with each run that passed from its first step (test_executions.footprint): the pages its
// steps ran on and the requests its pages made to the app (fetch and XHR, on the app's hosts),
// with its server steps' HTTP calls. What a change touches is weighed against it to choose the
// tests a commit needs (lib/regression.js).
//
// A path is kept as a page is (lib/elements.js pageOf): a part holding a digit or a long token
// is starred, so /api/notes/42 and /api/notes/43 are one route: GET /api/notes/*.

import { db, parseJson } from './db.js';
import { pageOf } from './elements.js';
import { loadTest } from './test-store.js';

/** The path of a URL as a footprint keeps it: /notes/*, without host, query or fragment; null for no web page. */
export function pathOf(url) {
  const page = pageOf(url);
  return page ? page.slice(page.indexOf('/')) : null;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

// What a page asks the app for its data; the rest (scripts, styles, images, fonts) is how it is
// drawn, and a dev server serves the app's source files as scripts.
const DATA_REQUESTS = new Set(['xhr', 'fetch', 'eventsource']);
// A dev server's own requests (hot reload).
const DEV_SERVER = /\/(@vite|@react-refresh|@fs|__vite|node_modules|sockjs-node|__webpack_hmr)\b|hot-update/;

/**
 * The footprint of a run: the pages it was on (`pageUrls`), and the requests its pages made
 * since it started (`requests`, as the extension lists them) to the hosts of those pages —
 * the app's front and its API, whatever their port —, and `serverCalls` ("POST https://…").
 * Sorted, without repeats: { pages: ['/notes'], api: ['GET /api/notes'] }.
 */
export function footprintOfRun({ pageUrls = [], requests = [], since = 0, serverCalls = [], hosts = [] }) {
  const appHosts = new Set([...hosts, ...pageUrls.map(hostOf)].filter(Boolean));
  const pages = new Set(pageUrls.map(pathOf).filter(Boolean));
  const api = new Set();
  for (const request of requests) {
    if ((request.timestamp ?? 0) < since || !appHosts.has(hostOf(request.url)) || DEV_SERVER.test(request.url)) continue;
    if (request.resourceType === 'document') {
      const path = pathOf(request.url);
      if (path) pages.add(path);
    } else if (DATA_REQUESTS.has(request.resourceType)) {
      const path = pathOf(request.url);
      if (path) api.add(`${String(request.method ?? 'GET').toUpperCase()} ${path}`);
    }
  }
  for (const call of serverCalls) {
    const [method, url] = call.split(' ');
    const path = pathOf(url);
    if (path) api.add(`${method.toUpperCase()} ${path}`);
  }
  return { pages: [...pages].sort(), api: [...api].sort() };
}

// A value a step gets when it runs ({{base_url}}, {{note_id}}): in a path, one part of it.
const withValuesStarred = (url) => String(url ?? '').replace(/\{\{[^}]*\}\}/g, '0');

/** What a test's steps say it touches, run or not: the pages it opens and was on, its server steps' calls. */
export function footprintOfSteps(steps = [], { baseUrl = null } = {}) {
  const pageUrls = [];
  const serverCalls = [];
  const absolute = (url) => {
    let value = String(url ?? '');
    // {{base_url}}/notes: the project's base URL, most likely.
    if (baseUrl) value = value.replace(/^\{\{[^}]*\}\}(?=\/)/, baseUrl.replace(/\/$/, ''));
    value = withValuesStarred(value);
    if (/^https?:/i.test(value)) return value;
    return baseUrl && value.startsWith('/') ? new URL(value, baseUrl).href : null;
  };
  for (const step of steps) {
    if (step.command === 'navigate') {
      const url = absolute(step.params?.url);
      if (url) pageUrls.push(url);
    }
    // Kept as the extension saw it: host and path (lib/elements.js pageOf).
    if (step.page) pageUrls.push(`http://${step.page}`);
    if (step.command === 'http') {
      const url = absolute(step.params?.url);
      if (url) serverCalls.push(`${String(step.params?.method ?? 'GET').toUpperCase()} ${url}`);
    }
  }
  return footprintOfRun({ pageUrls, serverCalls });
}

/**
 * Read what a run that just passed touched, from the extension: the requests of its tabs since
 * `since`. Null when they cannot be read — the run is then kept without a footprint.
 */
export async function readFootprint(sendCommand, { tabIds, since, pageUrls, steps, baseUrl }) {
  const requests = [];
  for (const tabId of new Set(tabIds.filter((id) => id != null))) {
    try {
      const listed = await sendCommand(undefined, 'network_requests', { tabId, limit: 300 });
      requests.push(...(listed?.requests ?? []));
    } catch {
      // Its tab is gone (the test closed it): what it called there is not known.
    }
  }
  const ofSteps = footprintOfSteps(steps, { baseUrl });
  const ofRun = footprintOfRun({ pageUrls, requests, since, hosts: baseUrl ? [hostOf(baseUrl)] : [] });
  return {
    pages: [...new Set([...ofRun.pages, ...ofSteps.pages])].sort(),
    api: [...new Set([...ofRun.api, ...ofSteps.api])].sort(),
  };
}

/** Keep a run's footprint. */
export function saveFootprint(executionId, footprint) {
  db.prepare('UPDATE test_executions SET footprint = ? WHERE id = ?').run(JSON.stringify(footprint), executionId);
}

/**
 * What a test touches: the footprint of its last run that kept one, with the pages and calls
 * its steps hold now; `run` says which run, null when no run kept one — then only its steps
 * say, and what its pages call is not known.
 */
export function footprintOfTest(name) {
  const test = loadTest(name);
  if (!test) return null;
  const baseUrl = test.project_id ? db.prepare('SELECT base_url FROM projects WHERE id = ?').get(test.project_id)?.base_url ?? null : null;
  const ofSteps = footprintOfSteps(test.steps, { baseUrl });
  const last = db.prepare(
    `SELECT id, finished_at, footprint FROM test_executions
     WHERE test_name = ? AND footprint IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get(name);
  const ofRun = parseJson(last?.footprint) ?? { pages: [], api: [] };
  return {
    pages: [...new Set([...ofRun.pages, ...ofSteps.pages])].sort(),
    api: [...new Set([...ofRun.api, ...ofSteps.api])].sort(),
    run: last ? { execution_id: last.id, finished_at: last.finished_at } : null,
  };
}
