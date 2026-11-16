// Unit tests for a business step that stops partway while a test is recorded (lib/business-play.js):
// the login of a shop whose verification code is asked only on a new device. What it did in the
// browser is recorded — a login done but missing from the test, the test then failing logged out,
// is what an Auchan recording gave —; the agent is told how to go on; played again with its failed
// step optional, it goes on from there without doing the login again, the step is optional in the
// library for every test, and the test reads as the business step. The browser is a stand-in. On a
// database of their own, thrown away after.
// Run with: node --test test/business-partial.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = await mkdtemp(join(tmpdir(), 'business-partial-'));
process.env.IZITEST_DB_PATH = join(dir, 'test.db');
process.env.IZITEST_SECRET_KEY_FILE = join(dir, 'secret.key');
delete process.env.IZITEST_SECRET_KEY;
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { createProject } = await import('../lib/projects.js');
const { loadTest } = await import('../lib/test-store.js');
const { createStepDefinition, getStepDefinition } = await import('../lib/gherkin/step-definition-store.js');
const { serializeTestToFeature } = await import('../lib/gherkin/serialize.js');
const { withElementNames } = await import('../lib/element-store.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');
const { saveSecret } = await import('../lib/secrets.js');

const shop = createProject({ name: 'Shop', base_url: 'https://shop.test/' });
for (const [name, value] of [['EMAIL', 'ann@shop.test'], ['PASSWORD', 'pw-of-ann'], ['CODE', '123456']]) saveSecret(shop.id, name, { value });
const login = createStepDefinition(shop.id, {
  keyword: 'When', pattern: 'I log in as {string} with the password {string} and the code {string}', command: 'composite', params_template: {},
  steps_template: [
    { command: 'fill', params: { selector: '#email', value: '{0}' } },
    { command: 'fill', params: { selector: '#password', value: '{1}' } },
    { command: 'click', params: { selector: '#login' } },
    { command: 'wait', params: { ms: 2000 } },
    { command: 'fill', params: { selector: '#code', value: '{2}' } },
  ],
});
const PHRASE = 'I log in as "{{secret.EMAIL}}" with the password "{{secret.PASSWORD}}" and the code "{{secret.CODE}}"';

/** The shop: no code asked this time; the login form, or no form when told so. */
function browser({ form = true } = {}) {
  const played = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      const { selector } = params.steps[0].params;
      played.push(selector);
      const missing = selector === '#code' || (!form && selector === '#email');
      return { results: [missing ? { status: 'failed', error: `All 1 locators failed: css="${selector}" (not found within 1 s)` } : { status: 'success', tabId: 5 }] };
    }
    return { success: true, tabId: 5, windowId: 50, pageUrl: 'https://shop.test/' };
  };
  return { sendCommand, played };
}

async function agent(sendCommand, connectionId) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, { sendCommand, getProfiles: () => new Map() });
  registerTestTools(server, { sendCommand });
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    call: async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return { text: res.content[0].text, isError: !!res.isError };
    },
    close: async () => { await client.close(); dropConnection(connectionId); },
  };
}

test('stopped at a code the page did not ask for: what it did is recorded, then, made optional, it goes on without logging in again', async () => {
  const { sendCommand, played } = browser();
  const { call, close } = await agent(sendCommand, 'partial-login');
  try {
    await call('start_recording', { name: 'Logged in', project_id: shop.id });
    await call('navigate', { url: 'https://shop.test/', intent: 'Open the shop' });

    const stopped = await call('play_business_step', { phrase: PHRASE });
    assert.equal(stopped.isError, true);
    assert.match(stopped.text, /stopped at its step 4 of 4 \(fill on #code\): All 1 locators failed/);
    assert.match(stopped.text, /Its steps 1–3 were done in the browser and are recorded\. If the page does not need its step 4 this time — a code asked only on a new device/);
    assert.match(stopped.text, /call play_business_step again with optional_step: 4/);
    assert.deepEqual(played, ['#email', '#password', '#login', '#code']);

    played.length = 0;
    const went = await call('play_business_step', { phrase: PHRASE, optional_step: 4 });
    assert.equal(went.isError, false, went.text);
    assert.match(went.text, /Played "I log in as .*" \(4 steps\): recorded as this business step\. Not done, optional: step 4 \(not shown by the page\)\. Its step 4 is optional now, in the business step/);
    assert.deepEqual(played, [], 'the login is not done again, nor the code tried again');
    await call('stop_recording');
  } finally {
    await close();
  }

  // In the library: the code optional (the wait of a time only not counted), for every test.
  assert.deepEqual(getStepDefinition(login.id).steps_template.map((tpl) => !!tpl.optional), [false, false, false, false, true]);
  // The test: the whole business step once, linked to it, its code optional; it reads as the phrase.
  const saved = loadTest('Logged in');
  assert.deepEqual(saved.steps.map((s) => [s.command, s.params?.selector ?? s.params?.url ?? null, !!s.optional]), [
    ['navigate', 'https://shop.test/', false], ['fill', '#email', false], ['fill', '#password', false], ['click', '#login', false], ['fill', '#code', true],
  ]);
  assert.equal(saved.steps[1].step_definition_id, login.id);
  assert.match(serializeTestToFeature(withElementNames(saved), shop.id), /When I log in as "\{\{\w+\}\}" with the password "\{\{\w+\}\}" and the code "\{\{\w+\}\}"\n/);

  // Played again, in another test: the code is optional now — not asked, it goes on.
  const again = browser();
  const second = await agent(again.sendCommand, 'partial-login-2');
  try {
    await second.call('start_recording', { name: 'Logged in again', project_id: shop.id });
    const ok = await second.call('play_business_step', { phrase: PHRASE });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /Not done, optional: step 4 \(All 1 locators failed/);
    await second.call('stop_recording');
  } finally {
    await second.close();
  }
});

test('stopped at its first step — the form not open —: nothing done, nothing recorded, told to get there first', async () => {
  const { sendCommand } = browser({ form: false });
  const { call, close } = await agent(sendCommand, 'partial-first');
  try {
    await call('start_recording', { name: 'No form', project_id: shop.id });
    const stopped = await call('play_business_step', { phrase: PHRASE });
    assert.match(stopped.text, /stopped at its step 1 of 4 .* None of its steps was done: if the page is not where it starts \(a form to open first\), get there, then play it again\./);
    assert.match(await call('stop_recording').then((r) => r.text), /no steps were recorded/);
  } finally {
    await close();
  }
});

test('a business step that only checks, and what it checks does not hold: nothing recorded; while recording, it waits seconds, not the project\'s 30 s', async () => {
  createStepDefinition(shop.id, {
    keyword: 'Then', pattern: 'I am logged in', command: 'composite', params_template: {},
    steps_template: [
      { command: 'assert', params: { type: 'url_contains', expected: 'shop.test' } },
      { command: 'assert', params: { type: 'text_contains', selector: 'header', expected: 'My account' } },
    ],
  });
  const timeouts = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'execute_js') {
      timeouts.push(params);
      const header = String(params.code ?? '').includes('header');
      return { result: { value: header ? 'Log in' : 'https://shop.test/', pageUrl: 'https://shop.test/' } };
    }
    return { success: true, tabId: 5, windowId: 50, pageUrl: 'https://shop.test/' };
  };
  const { call, close } = await agent(sendCommand, 'partial-check');
  db.prepare('UPDATE projects SET element_timeout_ms = 30000 WHERE id = ?').run(shop.id);
  try {
    await call('start_recording', { name: 'Checked', project_id: shop.id });
    await call('navigate', { url: 'https://shop.test/', intent: 'Open the shop' });
    const started = Date.now();
    const stopped = await call('play_business_step', { phrase: 'I am logged in' });
    assert.ok(Date.now() - started < 12_000, 'seconds, not the 30 s of the project');
    assert.match(stopped.text, /stopped at its step 2 of 2 .* Its steps before were checks only, which change nothing on the page: nothing was recorded\./);
    const saved = await call('stop_recording');
    assert.match(saved.text, /saved with 1 steps/, 'the navigate alone');
  } finally {
    db.prepare('UPDATE projects SET element_timeout_ms = NULL WHERE id = ?').run(shop.id);
    await close();
  }
});
