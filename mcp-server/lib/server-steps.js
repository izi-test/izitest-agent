// The steps a test runs on the server, between the ones the browser plays: keeping a value
// (`capture`: a text, a field's value, an attribute, the URL or the title of the page, a value
// of the last HTTP answer, or of the answer to a request the page made — the id a click on
// "Buy" got back) as a variable the next steps use, and calling an HTTP API
// (`http`: to prepare data — create a user, keep its id —, with values of the test in its URL,
// headers and body). A test holding one is played in segments (test-execute.js), and each
// segment gets the values kept so far.

import { pathValue, pick } from './values.js';

export const SERVER_COMMANDS = new Set(['capture', 'http']);
export const isServerStep = (step) => SERVER_COMMANDS.has(step?.command);

// What `capture` reads on the page: the code run there, the element found by `selector`.
const READERS = {
  text: (el) => `${el} ? ${el}.textContent.trim() : null`,
  value: (el) => `${el} ? ('value' in ${el} ? ${el}.value : ${el}.textContent.trim()) : null`,
  attribute: (el, attribute) => `${el} ? ${el}.getAttribute(${JSON.stringify(attribute ?? '')}) : null`,
};
const HTTP_TIMEOUT_MS = 30_000;
// An answer the page is still waiting for: looked for again every so often, up to this long.
const REQUEST_WAIT_MS = 10_000;
const REQUEST_POLL_MS = 300;

const answerOf = (raw) => (raw && typeof raw === 'object' && 'result' in raw && !('requests' in raw) && !('body' in raw) ? raw.result : raw);

/**
 * The body of the answer to a request the page made, its URL holding `url` (and of `method`):
 * one made since `since` (the step before started), waited for when it has not come yet;
 * else the last one before. Throws when the page made none.
 */
async function pageAnswer(params, { sendCommand, tabId, since, waitMs = REQUEST_WAIT_MS }) {
  const where = tabId ? { tabId } : {};
  const deadline = Date.now() + waitMs;
  let chosen = null;
  for (;;) {
    const listed = answerOf(await sendCommand(undefined, 'network_requests', { textFilter: params.url, ...(params.method ? { method: params.method } : {}), limit: 20, ...where }));
    const answered = (listed?.requests ?? []).filter((r) => r.status > 0);
    chosen = answered.find((r) => !since || r.timestamp >= since) ?? null;
    if (chosen || Date.now() >= deadline) { chosen ??= answered[0] ?? null; break; }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_POLL_MS));
  }
  if (!chosen) throw new Error(`The page made no request to "${params.url}"${params.method ? ` (${params.method})` : ''}`);
  const read = answerOf(await sendCommand(undefined, 'network_response', { id: chosen.id, maxLength: 1_000_000, ...where }));
  return { request: chosen, body: String(read?.body ?? '') };
}

/** The names of the variables a test's steps keep: known before they are, so an expression using one waits for it. */
export function keptNames(steps) {
  return new Set((steps ?? []).filter((s) => s.command === 'capture' && s.params?.name).map((s) => s.params.name));
}

/** Reads what a `capture` step keeps; throws with what was not found. */
async function capture(params, { sendCommand, tabId, state }) {
  const what = params.what ?? 'text';
  if (!params.name) throw new Error('A capture needs the name of the variable it keeps');
  if (what === 'request') {
    if (!params.url) throw new Error('Capturing the answer to a request of the page needs a part of its URL (url)');
    const { request, body } = await pageAnswer(params, { sendCommand, tabId, since: state.since, waitMs: state.waitMs });
    if (!params.path) return pick(body, params.pattern);
    let json;
    try { json = JSON.parse(body); } catch { throw new Error(`The answer to ${request.method} ${request.url} is no JSON: no "${params.path}" in it`); }
    const found = pathValue(json, params.path);
    if (found === undefined) throw new Error(`The answer to ${request.method} ${request.url} has nothing at "${params.path}"`);
    return pick(found, params.pattern);
  }
  if (what === 'response') {
    if (!state.lastResponse) throw new Error('No HTTP answer to read: call an API first');
    const found = pathValue(state.lastResponse.json, params.path);
    if (found === undefined) throw new Error(`The last answer has nothing at "${params.path}"`);
    return pick(found, params.pattern);
  }
  let code;
  if (what === 'url') code = 'location.href';
  else if (what === 'title') code = 'document.title';
  else {
    const reader = READERS[what];
    if (!reader) throw new Error(`No way to capture "${what}": text, value, attribute, url, title, response or request`);
    if (!params.selector) throw new Error(`Capturing the ${what} of an element needs its selector`);
    code = `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); return ${reader('el', params.attribute)}; })()`;
  }
  const result = await sendCommand(undefined, 'execute_js', { code, ...(tabId ? { tabId } : {}) });
  const value = result?.result !== undefined ? result.result : result;
  if (value == null) throw new Error(`Nothing to capture: no element "${params.selector}" on the page`);
  return pick(String(value), params.pattern);
}

/** Calls an API: the answer kept (status, JSON) for the captures after it; throws on a status it did not expect. */
async function http(params, { state, fetchImpl = fetch }) {
  const method = String(params.method ?? 'GET').toUpperCase();
  if (!params.url) throw new Error('An HTTP call needs its URL');
  const headers = { ...(params.headers ?? {}) };
  let body = params.body;
  if (body != null && typeof body !== 'string') body = JSON.stringify(body);
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain';
  }
  const response = await fetchImpl(params.url, {
    method, headers, ...(body != null && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: kept as text */ }
  state.lastResponse = { status: response.status, json, text };
  const expected = params.expect_status != null ? Number(params.expect_status) : null;
  if (expected != null ? response.status !== expected : !response.ok) {
    throw new Error(`${method} ${params.url} answered ${response.status}${expected != null ? `, not ${expected}` : ''}: ${text.slice(0, 200)}`);
  }
  return `${method} ${params.url} → ${response.status}`;
}

/**
 * Runs a server step: `{ detail, kept }` — what it did, and the variable it kept ({ name, value })
 * for a capture. Throws with the reason it failed. `state` lives as long as the run.
 */
export async function runServerStep(step, context) {
  if (step.command === 'capture') {
    const value = await capture(step.params ?? {}, context);
    return { detail: `{{${step.params.name}}} = "${value}"`, kept: { name: step.params.name, value } };
  }
  if (step.command === 'http') return { detail: await http(step.params ?? {}, context) };
  throw new Error(`Not a server step: ${step.command}`);
}
