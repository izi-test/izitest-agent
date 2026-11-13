// Checks made while a test is recorded: each the next step, right after the action whose result it
// checks. Added once the test was saved, they were all checked on its last page and put at its end —
// on PORTAL, a tab clicked 0.4 s after another stopped the first from loading, and the check of its
// content, at the end, failed. An agent connected over MCP, the extension a stand-in; on a database
// of its own.
// Run with: node --test test/recorded-checks.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'recorded-checks-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');
const { linkRecordedChecks } = await import('../lib/recorded-checks.js');

/** A user's page, a tab of it opened by a click: what is on it decides what a check reads. */
function portal() {
  const shown = new Set(['#user']);
  const texts = { '#welcome': 'Welcome' };
  const sendCommand = async (_profile, command, params) => {
    if (command === 'click' && params.selector === '#tab-attributes') shown.add('#attributes');
    if (command === 'click' && params.selector === '#tab-accounts') shown.add('#accounts');
    if (command === 'fill') texts['#welcome'] = `Welcome ${params.value}`;
    if (command === 'execute_js') {
      const selector = /querySelector\("([^"]+)"\)/.exec(params.code)?.[1];
      const value = !selector ? 'https://portal.test/ECM/users/show/12'
        : /textContent/.test(params.code) ? (texts[selector] ?? null) : shown.has(selector);
      return { result: { value, pageUrl: 'https://portal.test/ECM/users/show/12' } };
    }
    return { success: true, tabId: 5, windowId: 50, pageUrl: 'https://portal.test/ECM/users/show/12' };
  };
  return sendCommand;
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
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text,
    close: async () => { await client.close(); dropConnection(connectionId); },
  };
}

test('a check made while recording is the next step, right after the action whose result it checks', async () => {
  const { call, close } = await agent(portal(), 'checks-in-place');
  assert.match(await call('start_recording', { name: 'user details' }), /add_assertion\(test_name: "user details", …\) records the check as the next step/);
  await call('navigate', { url: 'https://portal.test/ECM/users/show/12', intent: 'Open a user' });
  await call('click', { selector: '#tab-attributes', intent: 'Open the Other Attributes tab' });
  const first = await call('add_assertion', { test_name: 'user details', assertion_type: 'element_exists', selector: '#attributes', description: 'The attributes are loaded' });
  assert.match(first, /PASSED and recorded as step 3 of "user details", right after step 2 \(Open the Other Attributes tab\)/);
  assert.match(first, /holds the test there until it holds/);
  await call('click', { selector: '#tab-accounts', intent: 'Open the Accounts tab' });
  assert.match(await call('add_assertion', { test_name: 'user details', assertion_type: 'element_exists', selector: '#accounts', step_order: 1 }),
    /recorded as step 5[\s\S]*step_order is not used while recording/);
  await call('stop_recording');
  await close();

  const steps = loadTest('user details').steps;
  assert.deepEqual(steps.map((s) => s.command), ['navigate', 'click', 'assert', 'click', 'assert'], 'each check after its own action, none at the end');
  assert.deepEqual(steps.filter((s) => s.command === 'assert').map((s) => s.assertion.selector), ['#attributes', '#accounts']);
  assert.equal(steps[2].intent, 'The attributes are loaded');
  assert.equal(steps[2].page, 'portal.test/ECM/users/show/*', 'the page it was checked on');
});

test('a check that fails while recording is not recorded; a wrong test name says which one is recorded', async () => {
  const { call, close } = await agent(portal(), 'checks-refused');
  await call('start_recording', { name: 'refused' });
  await call('navigate', { url: 'https://portal.test/ECM/users/show/12' });
  assert.match(await call('add_assertion', { test_name: 'refused', assertion_type: 'element_exists', selector: '#accounts' }), /Assertion FAILED — not added/);
  assert.match(await call('add_assertion', { test_name: 'other', assertion_type: 'element_exists', selector: '#user' }),
    /Test "other" not found\. The test being recorded is "refused": pass that name/);
  await call('stop_recording');
  await close();
  assert.deepEqual(loadTest('refused').steps.map((s) => s.command), ['navigate']);
});

test('a check of what was typed is linked to its variable when the recording is saved', async () => {
  const { call, close } = await agent(portal(), 'checks-linked');
  await call('start_recording', { name: 'greeted' });
  await call('navigate', { url: 'https://portal.test/ECM/users/show/12' });
  await call('fill', { selector: '#first-name', value: 'Bernadette', intent: 'Type the first name' });
  assert.match(await call('add_assertion', { test_name: 'greeted', assertion_type: 'text_contains', selector: '#welcome', expected: 'Welcome Bernadette' }), /recorded as step 3/);
  const stopped = await call('stop_recording');
  await close();
  const saved = loadTest('greeted');
  const variable = saved.steps[1].params.value.match(/^\{\{(\w+)\}\}$/)?.[1];
  assert.ok(variable, `the fill is a variable: ${saved.steps[1].params.value}`);
  assert.equal(saved.steps[2].assertion.expected, `Welcome {{${variable}}}`, 'a replay with another name checks that name');
  assert.match(stopped, new RegExp(`The check of step 3 is linked to \\{\\{${variable}\\}\\}`));
});

test('on a saved test, add_assertion still puts the check at the end, or at step_order', async () => {
  saveTest({ name: 'saved', steps: [{ command: 'navigate', params: { url: 'https://portal.test/ECM/users/show/12' } }, { command: 'click', params: { selector: '#tab-attributes' } }] });
  const { call, close } = await agent(portal(), 'checks-saved');
  await call('navigate', { url: 'https://portal.test/ECM/users/show/12' });
  assert.match(await call('add_assertion', { test_name: 'saved', assertion_type: 'element_exists', selector: '#user' }), /PASSED and added to test "saved" at step 3/);
  assert.match(await call('add_assertion', { test_name: 'saved', assertion_type: 'url_contains', expected: '/users/show/', step_order: 2 }), /added to test "saved" at step 2/);
  await close();
  assert.deepEqual(loadTest('saved').steps.map((s) => s.command), ['navigate', 'assert', 'click', 'assert']);
});

test('playing a dataset, a check of what its row shows is linked to its column', () => {
  const steps = [{ command: 'fill', params: { value: '{{email}}' } }, { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: 'h1', expected: 'Hello Ann' } }];
  const { variables, linked } = linkRecordedChecks(steps, {}, { email: 'ann@x.dev', name: 'Ann' });
  assert.equal(steps[1].assertion.expected, 'Hello {{name}}');
  assert.deepEqual(linked, [{ step: 2, names: ['name'] }]);
  assert.deepEqual(variables, { name: { type: 'text', defaultValue: 'Ann' } }, 'the column it names is declared');
});
