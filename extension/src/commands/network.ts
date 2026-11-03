// Network request/response capture via CDP (puppeteer Page events).
// Captures headers eagerly; response bodies are fetched lazily on demand
// to avoid slowing down every request on every page.

import { JSONPath } from 'jsonpath-plus';
import type { HTTPResponse, HTTPRequest, Page } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import { resolveTabId } from '../helpers';
import { getPage } from '../puppeteer-client';
import type { NetworkRequestsParams, NetworkResponseParams, NetworkSearchParams } from '../types';

interface CapturedEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  resourceType: string;
  mimeType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  operationName?: string | null;
  timestamp: number;
  fromCache: boolean;
  response: HTTPResponse | null;
  bodyText?: string;
}

const MAX_ENTRIES_PER_TAB = 300;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_MAX_BODY_LENGTH = 5000;
const MAX_REQUEST_BODY_LENGTH = 4000;
const DEFAULT_SEARCH_SCAN_LIMIT = 30;
const DEFAULT_SEARCH_MAX_MATCHES = 10;
const SEARCH_SNIPPET_RADIUS = 100;

const capturesByTab = new Map<number, CapturedEntry[]>();
// Sent with the requests IziTest makes from a page (check_links), lowercase as Chrome reports it.
export const CHECK_HEADER = 'x-izitest-check';
// The pages listened to: a tab gets a new one when its connection is made again (detachBrowser),
// and that one is listened to as well; what the tab's pages saw stays in capturesByTab.
const attachedPages = new WeakSet<Page>();
let idCounter = 0;

function pushEntry(tabId: number, entry: CapturedEntry): void {
  const list = capturesByTab.get(tabId) ?? [];
  list.push(entry);
  if (list.length > MAX_ENTRIES_PER_TAB) list.splice(0, list.length - MAX_ENTRIES_PER_TAB);
  capturesByTab.set(tabId, list);
}

// GraphQL requests usually hit the same URL for every operation — the only way
// to tell them apart is the operation name carried in the POST body.
function extractOperationName(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const ops = Array.isArray(parsed) ? parsed : [parsed];
    const names = ops.map((op) => op?.operationName).filter(Boolean);
    if (names.length) return names.join(', ');
  } catch {
    // not JSON — fall through to a best-effort regex match below
  }
  const match = body.match(/(?:query|mutation|subscription)\s+(\w+)/);
  return match ? match[1] : null;
}

// ─── Capture attachment (idempotent per tab) ────────────────────────

export function attachNetworkCapture(tabId: number, page: Page): void {
  if (attachedPages.has(page)) return;
  attachedPages.add(page);

  page.on('response', (response: HTTPResponse) => {
    const request = response.request();
    const requestBody = request.postData();
    pushEntry(tabId, {
      id: `net-${++idCounter}`,
      method: request.method(),
      url: request.url(),
      status: response.status(),
      statusText: response.statusText(),
      resourceType: request.resourceType(),
      mimeType: (response.headers()['content-type'] || '').split(';')[0],
      requestHeaders: request.headers(),
      responseHeaders: response.headers(),
      requestBody: requestBody?.slice(0, MAX_REQUEST_BODY_LENGTH),
      operationName: extractOperationName(requestBody),
      timestamp: Date.now(),
      fromCache: response.fromCache(),
      response
    });
  });

  page.on('requestfailed', (request: HTTPRequest) => {
    const requestBody = request.postData();
    pushEntry(tabId, {
      id: `net-${++idCounter}`,
      method: request.method(),
      url: request.url(),
      status: 0,
      statusText: request.failure()?.errorText || 'failed',
      resourceType: request.resourceType(),
      mimeType: '',
      requestHeaders: request.headers(),
      responseHeaders: {},
      requestBody: requestBody?.slice(0, MAX_REQUEST_BODY_LENGTH),
      operationName: extractOperationName(requestBody),
      timestamp: Date.now(),
      fromCache: false,
      response: null
    });
  });

  page.once('close', () => {
    capturesByTab.delete(tabId);
  });
}

// ─── Commands ────────────────────────────────────────────────────────

export async function cmdNetworkRequests({ tabId, sessionId, textFilter, method, resourceType, requestBodyFilter, limit }: NetworkRequestsParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  attachNetworkCapture(resolvedTabId, await getPage(resolvedTabId));

  const needle = textFilter?.toLowerCase();
  const bodyNeedle = requestBodyFilter?.toLowerCase();
  const filtered = (capturesByTab.get(resolvedTabId) ?? []).filter((entry) => {
    // IziTest's own requests (check_links): not the page's.
    if (entry.requestHeaders[CHECK_HEADER]) return false;
    if (needle && !entry.url.toLowerCase().includes(needle)) return false;
    if (method && entry.method.toUpperCase() !== method.toUpperCase()) return false;
    if (resourceType && entry.resourceType !== resourceType) return false;
    if (bodyNeedle && !(entry.requestBody ?? '').toLowerCase().includes(bodyNeedle)) return false;
    return true;
  });

  const mostRecentFirst = filtered.slice(-(limit ?? DEFAULT_LIST_LIMIT)).reverse();

  return {
    total: filtered.length,
    returned: mostRecentFirst.length,
    requests: mostRecentFirst.map(({ id, method: m, url, status, statusText, resourceType: rt, mimeType, timestamp, fromCache, operationName }) => ({
      id, method: m, url, status, statusText, resourceType: rt, mimeType, timestamp, fromCache,
      ...(operationName ? { operationName } : {})
    }))
  };
}

async function readBody(entry: CapturedEntry): Promise<string> {
  if (entry.bodyText !== undefined) return entry.bodyText;
  if (!entry.response) throw new Error('No response body available for this entry (the request failed before a response was received)');
  entry.bodyText = await entry.response.text();
  return entry.bodyText;
}

export async function cmdNetworkResponse({ tabId, sessionId, id, jsonPath, maxLength }: NetworkResponseParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const entry = (capturesByTab.get(resolvedTabId) ?? []).find((e) => e.id === id);
  if (!entry) throw new Error(`No captured request with id "${id}" on this tab. Call network_requests first to list captured requests.`);

  const body = await readBody(entry);
  const isJson = entry.mimeType.includes('json') || /^\s*[[{]/.test(body);

  if (jsonPath) {
    if (!isJson) throw new Error('jsonPath was provided but the response body does not look like JSON');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Response body could not be parsed as JSON');
    }
    const result = JSONPath({ path: jsonPath, json: parsed as object });
    return {
      id: entry.id, url: entry.url, status: entry.status, mimeType: entry.mimeType,
      jsonPath, matchCount: Array.isArray(result) ? result.length : 0, result
    };
  }

  const limit = maxLength ?? DEFAULT_MAX_BODY_LENGTH;
  const truncated = body.length > limit;
  return {
    id: entry.id, url: entry.url, status: entry.status, mimeType: entry.mimeType, isJson,
    length: body.length, truncated, body: truncated ? body.slice(0, limit) : body
  };
}

// ─── Batch search across a filtered set of requests ─────────────────
// Scans every request matching the filters and returns only the ones whose
// response actually contains the requested data — avoids inspecting each
// candidate one by one (crucial for e.g. GraphQL calls sharing one URL).

export async function cmdNetworkSearch({ tabId, sessionId, textFilter, method, resourceType, requestBodyFilter, jsonPath, bodyContains, limit, maxMatches }: NetworkSearchParams) {
  if (!jsonPath && !bodyContains) throw new Error('Provide jsonPath or bodyContains to search within the captured response bodies');

  const resolvedTabId = await resolveTabId(tabId, sessionId);
  attachNetworkCapture(resolvedTabId, await getPage(resolvedTabId));

  const needle = textFilter?.toLowerCase();
  const bodyNeedle = requestBodyFilter?.toLowerCase();
  const candidates = (capturesByTab.get(resolvedTabId) ?? [])
    .filter((entry) => {
      if (needle && !entry.url.toLowerCase().includes(needle)) return false;
      if (method && entry.method.toUpperCase() !== method.toUpperCase()) return false;
      if (resourceType && entry.resourceType !== resourceType) return false;
      if (bodyNeedle && !(entry.requestBody ?? '').toLowerCase().includes(bodyNeedle)) return false;
      return true;
    })
    .slice(-(limit ?? DEFAULT_SEARCH_SCAN_LIMIT))
    .reverse();

  const maxHits = maxMatches ?? DEFAULT_SEARCH_MAX_MATCHES;
  const matches: Record<string, unknown>[] = [];
  const readErrors: { id: string; url: string; error: string }[] = [];

  for (const entry of candidates) {
    if (matches.length >= maxHits) break;

    let body: string;
    try {
      body = await readBody(entry);
    } catch (err) {
      readErrors.push({ id: entry.id, url: entry.url, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const base = {
      id: entry.id, method: entry.method, url: entry.url,
      ...(entry.operationName ? { operationName: entry.operationName } : {})
    };

    if (jsonPath) {
      const isJson = entry.mimeType.includes('json') || /^\s*[[{]/.test(body);
      if (!isJson) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      const result = JSONPath({ path: jsonPath, json: parsed as object });
      const matchCount = Array.isArray(result) ? result.length : (result === undefined ? 0 : 1);
      if (!matchCount) continue;
      matches.push({ ...base, matchCount, result });
    } else if (bodyContains) {
      const idx = body.toLowerCase().indexOf(bodyContains.toLowerCase());
      if (idx === -1) continue;
      const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
      const end = idx + bodyContains.length + SEARCH_SNIPPET_RADIUS;
      matches.push({ ...base, snippet: body.slice(start, end) });
    }
  }

  return {
    scanned: candidates.length,
    matched: matches.length,
    matches,
    ...(readErrors.length ? { readErrors } : {})
  };
}
