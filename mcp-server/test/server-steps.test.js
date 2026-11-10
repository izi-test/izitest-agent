// Unit tests for the steps a test runs on the server (lib/server-steps.js): an API called to
// prepare data, a value kept from its answer or from the page, used by the steps after. A test
// holding one is played in segments, each given the values kept so far, in the window the one
// before used. The API is a real one, on a free port; the extension is a stand-in. On a database
// of their own, thrown away after.
// Run with: node --test test/server-steps.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'server-steps-')), 'test.db');
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { runServerStep, keptNames } = await import('../lib/server-steps.js');
const { pathValue, pick } = await import('../lib/values.js');
const { saveTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { generateTestCode } = await import('../lib/codegen/index.js');
const { defaultStepDefinitions } = await import('../lib/gherkin/default-step-definitions.js');

// The API: POST /users creates one (its id, and the e-mail it was given); /broken fails.
const received = [];
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] });
    if (req.url === '/broken') { res.writeHead(500); res.end('down for maintenance'); return; }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 42, email: JSON.parse(body || '{}').email, tags: ['new'] } }));
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const API = `http://127.0.0.1:${api.address().port}`;
after(() => api.close());

test('a value at a path of an answer; a part of a text a pattern picks', () => {
  const answer = { data: { id: 42, items: [{ id: 'a' }, { id: 'b' }], user: { name: 'Bob' } } };
  assert.equal(pathValue(answer, 'data.id'), '42');
  assert.equal(pathValue(answer, '$.data.items[1].id'), 'b');
  assert.equal(pathValue(answer, 'data.user'), '{"name":"Bob"}');
  assert.equal(pathValue(answer, 'data.nope'), undefined);
  assert.equal(pick('Order #4521 confirmed', '#(\\d+)'), '4521');
  assert.equal(pick('Order #4521', '\\d+'), '4521');
  assert.throws(() => pick('Order pending', '#(\\d+)'), /is not in "Order pending"/);
});

test('an API called, its answer kept; a value of it, of the page, of the URL', async () => {
  const state = {};
  const { detail } = await runServerStep({ command: 'http', params: { method: 'post', url: `${API}/users`, body: '{"email":"bob@x.dev"}' } }, { state });
  assert.equal(detail, `POST ${API}/users → 201`);
  assert.equal(received.at(-1).type, 'application/json', 'a JSON body says so');
  assert.deepEqual((await runServerStep({ command: 'capture', params: { what: 'response', path: 'data.email', name: 'email' } }, { state })).kept,
    { name: 'email', value: 'bob@x.dev' });

  const page = async (_profile, command, params) => {
    assert.equal(command, 'execute_js');
    return { result: params.code === 'location.href' ? 'https://shop.test/orders/9' : 'Order #4521 confirmed' };
  };
  assert.equal((await runServerStep({ command: 'capture', params: { selector: '#msg', name: 'order', pattern: '#(\\d+)' } }, { sendCommand: page, state })).kept.value, '4521');
  assert.equal((await runServerStep({ command: 'capture', params: { what: 'url', name: 'here' } }, { sendCommand: page, state })).kept.value, 'https://shop.test/orders/9');

  await assert.rejects(runServerStep({ command: 'http', params: { url: `${API}/broken` } }, { state: {} }), /GET .*\/broken answered 500: down for maintenance/);
  await assert.rejects(runServerStep({ command: 'capture', params: { what: 'response', path: 'id', name: 'x' } }, { state: {} }), /No HTTP answer to read/);
  const nothing = async () => ({ result: null });
  await assert.rejects(runServerStep({ command: 'capture', params: { selector: '#gone', name: 'x' } }, { sendCommand: nothing, state: {} }), /no element "#gone"/);
  assert.deepEqual([...keptNames([{ command: 'capture', params: { name: 'a' } }, { command: 'fill', params: {} }])], ['a']);
});

/** The extension, stood in for: each segment it was asked to play, in which tab; a page showing an order number. */
function extension() {
  const segments = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      segments.push({ steps: params.steps, tabId: params.tabId, newWindow: params.newWindow });
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 31 })) };
    }
    if (command === 'execute_js') {
      if (params.code.includes('#order')) return { result: 'Order #4521 confirmed' };
      return { result: { value: 'Results for 4521', pageUrl: 'https://shop.test/search' } };
    }
    return {};
  };
  return { sendCommand, segments };
}

test('a test with server steps is played in segments, each with the values kept so far', async () => {
  saveTest({
    name: 'reorder', variables: { email: { type: 'text', defaultValue: 'u-{{unique}}@x.dev' } },
    steps: [
      { command: 'http', params: { method: 'POST', url: `${API}/users`, body: '{"email":"{{email}}"}' }, intent: 'Create a user' },
      { command: 'capture', params: { what: 'response', path: 'data.id', name: 'user_id' }, intent: 'Keep its id' },
      { command: 'navigate', params: { url: 'https://shop.test/users/{{user_id}}' } },
      { command: 'click', params: { selector: '#buy' } },
      { command: 'capture', params: { selector: '#order', name: 'order', pattern: '#(\\d+)' } },
      { command: 'fill', params: { selector: '#search', value: '{{order}}' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#results', expected: 'for {{order}}' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#results', expected: '{{order + 0}}' } },
    ],
  });
  const { sendCommand, segments } = extension();
  const result = await executeTest('reorder', {}, null, null, true, sendCommand, 'test');

  assert.deepEqual(segments.map((s) => s.steps.map((step) => step.command)), [['navigate', 'click'], ['fill']]);
  assert.equal(segments[0].steps[0].params.url, 'https://shop.test/users/42', 'the id kept from the answer');
  assert.equal(segments[1].steps[0].params.value, '4521', 'the order number kept from the page');
  assert.deepEqual([segments[0].newWindow, segments[1].newWindow, segments[1].tabId], [true, false, 31], 'one window, the same tab');
  assert.match(JSON.parse(received.at(-1).body).email, /^u-\w+@x\.dev$/, 'the e-mail computed for the run');
  assert.equal(result.assertionsPassed, 2, 'the assertions check the values kept');
  assert.deepEqual(result.results.map((r) => [r.step, r.status]), [[1, 'success'], [2, 'success'], [3, 'success'], [4, 'success'], [5, 'success'], [6, 'success']]);
  assert.equal(result.results[1].detail, '{{user_id}} = "42"');
});

test('a server step that fails stops the run there: the steps after are not played', async () => {
  saveTest({
    name: 'down', variables: {},
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test' } },
      { command: 'http', params: { url: `${API}/broken` } },
      { command: 'click', params: { selector: '#go' } },
    ],
  });
  const { sendCommand, segments } = extension();
  await assert.rejects(executeTest('down', {}, null, null, false, sendCommand, 'test'), /answered 500/);
  assert.deepEqual(segments.map((s) => s.steps.map((step) => step.command)), [['navigate']]);
});

test('a browser step that fails after a capture keeps its number in the test, and is diagnosed', async () => {
  saveTest({
    name: 'waits-in-vain', variables: {},
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test' } },
      { command: 'capture', params: { selector: '#order', name: 'order', pattern: '#(\\d+)' } },
      { command: 'click', params: { selector: '#submit' } },
      { command: 'wait', params: { selector: '#submitted' } },
      { command: 'click', params: { selector: '#next' } },
    ],
  });
  const sendCommand = async (_profile, command, params, _timeout, onMessage) => {
    if (command === 'replay_sequence') {
      const waitAt = params.steps.findIndex((s) => s.command === 'wait');
      if (waitAt < 0) return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 31 })) };
      // As the extension does: each step told as it goes, then the error thrown — its results
      // lost on the way back.
      params.steps.forEach((s, i) => onMessage?.({ type: 'step_complete', stepResult: {
        step: i + 1, command: s.command, tabId: 31, status: i < waitAt ? 'success' : i === waitAt ? 'failed' : 'skipped',
        ...(i === waitAt ? { error: 'Waited 10 s for #submitted: not found' } : {}),
      } }));
      throw new Error(`Step ${waitAt + 1}/${params.steps.length} failed: Waited 10 s for #submitted: not found`);
    }
    if (command === 'execute_js') return { result: 'Order #4521 confirmed' };
    if (command === 'network_requests') return { requests: [{ method: 'POST', url: 'https://shop.test/api/submit', status: 400, resourceType: 'fetch' }] };
    return {};
  };
  const failure = await executeTest('waits-in-vain', {}, null, null, false, sendCommand, 'test').then(() => null, (err) => err);
  assert.equal(failure.failedStep, 4, 'the wait, numbered as in the test, not "step 2" of its segment');
  assert.equal(failure.failedStepCommand, 'wait');
  assert.equal(failure.message, 'Waited 10 s for #submitted: not found');
  assert.equal(failure.triage?.cause, 'app_regression');
  assert.match(failure.triage.summary, /^Step 4 waited for #submitted, which never came, .* — and POST \/api\/submit answered 400$/);
  assert.deepEqual(failure.stepResults.map((r) => [r.step, r.status]), [[1, 'success'], [2, 'success'], [3, 'success'], [4, 'failed'], [5, 'skipped']]);
});

test('the exported code keeps the values as it runs: Playwright through VARS, Cucumber through the World', () => {
  const t = {
    name: 'reorder', project_id: 1, variables: { email: { defaultValue: 'bob@x.dev' } },
    steps: [
      { command: 'http', params: { method: 'POST', url: 'https://api.test/users', body: '{"email":"{{email}}"}' } },
      { command: 'capture', params: { what: 'response', path: 'data.id', name: 'user_id' } },
      { command: 'navigate', params: { url: 'https://shop.test/users/{{user_id}}' } },
      { command: 'capture', params: { selector: '#order', name: 'order', pattern: '#(\\d+)' } },
    ],
  };
  const [spec] = generateTestCode(t, 'playwright-plain').files;
  assert.match(spec.content, /async \(\{ page, request \}\) => \{\n {2}let RESPONSE = null;/);
  assert.match(spec.content, /request\.fetch\('https:\/\/api\.test\/users', \{ method: 'POST', data: `\{"email":"\$\{VARS\.email\}"\}`/);
  assert.match(spec.content, /VARS\['user_id'\] = pathValue\(RESPONSE, 'data\.id'\);/);
  assert.match(spec.content, /page\.goto\(`https:\/\/shop\.test\/users\/\$\{VARS\.user_id\}`\)/);
  assert.match(spec.content, /VARS\['order'\] = pick\(\(\(await page\.locator\('#order'\)\.first\(\)\.textContent\(\)\) \?\? ''\)\.trim\(\), '#\(\\\\d\+\)'\);/);

  const definitions = defaultStepDefinitions('en').map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const files = generateTestCode(t, 'playwright-cucumber', () => definitions).files;
  const feature = files.find((f) => f.path.endsWith('.feature')).content;
  assert.match(feature, /Given I call POST "https:\/\/api\.test\/users" with '\{"email":"<email>"\}'\n {4}When I store "data\.id" of the response as "user_id"\n {4}Given I am on "https:\/\/shop\.test\/users\/\{\{user_id\}\}"\n {4}When I store the text of "#order" matching "#\(\\d\+\)" as "order"/);
  assert.match(feature, /Examples:\n {6}\| email \|\n/, 'a column for the variable only, none for the values kept');
  assert.match(files.find((f) => f.path.endsWith('world.js')).content, /lookup: \(name\) => this\.vars\[name\]/);
});

/** The page's network, stood in for: the requests it made (most recent last) and their answers. */
function network(requests) {
  const asked = [];
  const sendCommand = async (_profile, command, params) => {
    asked.push(command);
    if (command === 'network_requests') {
      const now = Date.now();
      const made = requests.filter((r) => (r.at ?? 0) <= now && r.url.includes(params.textFilter) && (!params.method || r.method === params.method));
      return { total: made.length, requests: made.slice().reverse().map(({ id, method, url, status, timestamp }) => ({ id, method, url, status, timestamp })) };
    }
    if (command === 'network_response') return { id: params.id, body: requests.find((r) => r.id === params.id).body };
    return {};
  };
  return { sendCommand, asked };
}

test('a value of the answer to a request the page made: the one since the step before, waited for, else the last before', async () => {
  const start = Date.now();
  const older = { id: 'net-1', method: 'POST', url: 'https://shop.test/api/orders', status: 201, timestamp: start - 5000, body: '{"id": 11}' };
  const listing = { id: 'net-2', method: 'GET', url: 'https://shop.test/api/orders?page=1', status: 200, timestamp: start - 4000, body: '[]' };
  const fresh = { id: 'net-3', method: 'POST', url: 'https://shop.test/api/orders', status: 201, timestamp: start + 600, at: start + 600, body: '{"id": 4521, "lines": [{"sku": "A-1"}]}' };
  const capture = (params, requests, since) => runServerStep({ command: 'capture', params: { what: 'request', name: 'order', ...params } }, { sendCommand: network(requests).sendCommand, tabId: 3, state: { since, waitMs: 1500 } });

  assert.equal((await capture({ url: '/api/orders', method: 'POST', path: 'id' }, [older, listing, fresh], start)).kept.value, '4521', 'waited for: it came after the click');
  assert.equal((await capture({ url: '/api/orders', path: 'lines[0].sku' }, [older, listing, { ...fresh, at: 0 }], start)).kept.value, 'A-1');
  assert.equal((await capture({ url: '/api/orders', method: 'POST', path: 'id' }, [older, listing], 0)).kept.value, '11', 'none since: the last before');
  await assert.rejects(capture({ url: '/api/payments', path: 'id' }, [older], 0), /The page made no request to "\/api\/payments"/);
  await assert.rejects(capture({ url: '/api/orders', method: 'POST', path: 'total' }, [{ ...fresh, at: 0 }], 0), /has nothing at "total"/);
  assert.equal((await capture({ url: '/api/orders', method: 'POST', pattern: '"id": (\\d+)' }, [{ ...fresh, at: 0 }], 0)).kept.value, '4521', 'no path: the body, a pattern picking in it');
});

test('the exported code keeps the answers the page gets, and reads the one asked', () => {
  const t = {
    name: 'buy', project_id: 1, variables: {},
    steps: [
      { command: 'click', params: { selector: '#buy' } },
      { command: 'capture', params: { what: 'request', url: '/api/orders', method: 'POST', path: 'id', name: 'order' } },
      { command: 'navigate', params: { url: 'https://shop.test/orders/{{order}}' } },
    ],
  };
  const [spec] = generateTestCode(t, 'playwright-plain').files;
  assert.match(spec.content, /const ANSWERS = \[\];\n {2}page\.on\('response', \(response\) => ANSWERS\.push\(response\)\);/);
  assert.match(spec.content, /VARS\['order'\] = await answerTo\(ANSWERS, '\/api\/orders', 'id', 'POST'\);/);

  const definitions = defaultStepDefinitions('en').map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const files = generateTestCode(t, 'playwright-cucumber', () => definitions).files;
  assert.match(files.find((f) => f.path.endsWith('.feature')).content, /And I store "id" of the request to "\/api\/orders" as "order"/);
  assert.match(files.find((f) => f.path.endsWith('world.js')).content, /this\.page\.on\('response', \(response\) => this\.responses\.push\(response\)\);/);
});
