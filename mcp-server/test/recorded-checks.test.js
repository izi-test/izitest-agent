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

test('a suggestion picked after typing, then checked: a variable of its own, and the check follows it', async () => {
  let field = '';
  const sendCommand = async (_profile, command, params) => {
    if (command === 'fill') field = params.value;
    if (command === 'click') field = 'France';
    // The suggestions are gone once one is picked: nothing to read at stop_recording.
    if (command === 'detect_list_context') return null;
    if (command === 'execute_js') return { result: { value: field, pageUrl: 'http://127.0.0.1:8777/izitest-test.html' } };
    return { success: true, tabId: 5, windowId: 50, pageUrl: 'http://127.0.0.1:8777/izitest-test.html', text: 'France',
      ...(command === 'click' ? { locators: [{ type: 'text', value: 'France' }] } : {}) };
  };
  const { call, close } = await agent(sendCommand, 'checks-suggestion');
  await call('start_recording', { name: 'country' });
  await call('navigate', { url: 'http://127.0.0.1:8777/izitest-test.html' });
  await call('fill', { selector: '#country-input', value: 'Fr', intent: 'Type the beginning of the country' });
  await call('click', { selector: '#country-list > div:nth-of-type(1)', text: 'France', intent: 'Pick France among the suggestions' });
  assert.match(await call('add_assertion', { test_name: 'country', assertion_type: 'attribute_equals', selector: '#country-input', attribute: 'value', expected: 'France' }), /recorded as step 4/);
  const stopped = await call('stop_recording');
  await close();
  assert.match(stopped, /\{\{country\}\} — type: text, default: "France"/);
  assert.match(stopped, /The check of step 4 is linked to \{\{country\}\}/);
  const saved = loadTest('country');
  assert.deepEqual(saved.steps[2].params, { text: '{{country}}' });
  assert.equal(saved.steps[3].assertion.expected, '{{country}}');
  assert.deepEqual(Object.keys(saved.variables).sort(), ['country', 'country_input']);
});

test('the checks around a picked suggestion follow it: in a selector\'s attribute, and whatever the case', async () => {
  const { followSuggestion } = await import('../lib/recorded-checks.js');
  const { evaluateAssertion } = await import('../lib/test-execute.js');
  const suggestion = { command: 'click', params: { text: '{{text_choice}}' }, variable: { name: 'text_choice', type: 'text', defaultValue: 'chocolat', suggestionOf: 'text' } };
  const steps = [
    { command: 'fill', params: { value: '{{text}}' }, variable: { name: 'text', type: 'text', defaultValue: 'choco' } },
    { command: 'assert', params: {}, assertion: { type: 'element_visible', selector: 'a[href="/recherche?text=chocolat"]' } },
    suggestion,
    { command: 'assert', params: {}, assertion: { type: 'title_contains', expected: 'Chocolat' } },
    { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: 'article', expected: 'chocolat' } },
    { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: 'h1', expected: 'Chocolaterie' } },
  ];
  const variables = { text: { type: 'text', defaultValue: 'choco' }, text_choice: { type: 'text', defaultValue: 'chocolat' } };
  const { linked } = linkRecordedChecks(steps, variables);
  assert.deepEqual(steps[1].assertion.selector, 'a[href="/recherche?text={{text_choice}}"]');
  assert.deepEqual(steps[3].assertion, { type: 'title_contains', expected: '{{text_choice}}', ignoreCase: true });
  assert.deepEqual(steps[4].assertion, { type: 'text_contains', selector: 'article', expected: '{{text_choice}}', ignoreCase: true }, 'a search term: "Bananes Prix Bas" for "banane"');
  assert.equal(steps[5].assertion.expected, 'Chocolaterie', 'never a piece of a word');
  assert.deepEqual(linked.map((l) => l.step), [2, 4, 5]);
  assert.equal(followSuggestion({ type: 'url_contains', expected: 'x' }, 'v', 'ab'), null, 'a value too short says nothing');

  // Compared whatever the case: "banane" is in "Bananes Prix Bas".
  const page = async () => ({ result: { value: '(181) Bananes Prix Bas', pageUrl: 'https://www.auchan.fr/recherche?text=banane' } });
  assert.equal((await evaluateAssertion(page, { type: 'text_contains', selector: 'article', expected: 'banane', ignoreCase: true })).passed, true);
  assert.equal((await evaluateAssertion(page, { type: 'text_contains', selector: 'article', expected: 'banane' })).passed, false);
});

test('exported to Playwright, a check following a suggestion reads its variable, whatever the case', async () => {
  const { generatePlaywrightPlain } = await import('../lib/codegen/playwright-plain.js');
  const code = generatePlaywrightPlain({ name: 'search', variables: { text_choice: { type: 'text', defaultValue: 'chocolat' } }, steps: [
    { command: 'assert', params: {}, assertion: { type: 'title_contains', expected: '{{text_choice}}', ignoreCase: true } },
    { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: 'article', expected: '{{text_choice}}', ignoreCase: true } },
  ] });
  const title = code.split('\n').find((line) => line.includes('toHaveTitle')).match(/toHaveTitle\((.*)\);/)[1];
  const VARS = { text_choice: 'cho.colat' }; // eslint-disable-line no-unused-vars
  assert.equal(String(eval(title)), '/cho\\.colat/i', 'its value, escaped, not "{{text_choice}}" word for word');
  assert.match(code, /toContainText\(`\$\{VARS\.text_choice\}`, \{ ignoreCase: true \}\)/);
});

test('a URL check follows a suggestion picked: its query value, or its first word, read on the URL decoded', async () => {
  const { followSuggestion } = await import('../lib/recorded-checks.js');
  const { evaluateAssertion } = await import('../lib/test-execute.js');
  // Walmart: "laptop computers" picked, the agent checked the URL holds /search?q=laptop.
  const check = followSuggestion({ type: 'url_contains', expected: '/search?q=laptop' }, 'search_choice', 'laptop computers');
  assert.deepEqual(check, { type: 'url_contains', expected: '/search?q={{search_choice}}', ignoreCase: true });
  assert.equal(followSuggestion({ type: 'url_contains', expected: '/search?q=lap' }, 'search_choice', 'laptop computers'), null, 'a piece of a word says nothing');
  const at = (url) => async () => ({ result: { value: url } });
  assert.equal((await evaluateAssertion(at('https://www.walmart.com/search?q=laptop+computers&typeahead=lapt'), { ...check, expected: '/search?q=laptop computers' })).passed, true);
  assert.equal((await evaluateAssertion(at('https://www.walmart.com/search?q=bananas'), { ...check, expected: '/search?q=Bananas' })).passed, true, 'the value given with a capital');
  assert.equal((await evaluateAssertion(at('https://www.walmart.com/'), { ...check, expected: '/search?q=Bananas' })).passed, false);
});

test('a suggestion\'s plural, and a query value alone, follow it: the page another value leads to holds it too', async () => {
  const { followSuggestion } = await import('../lib/recorded-checks.js');
  const { evaluateAssertion } = await import('../lib/test-execute.js');
  // Auchan: "chocolat" picked leads to its aisle, "Chocolats pas cher - Auchan.fr", at
  // /…/ca-n0507?redirect_keywords=chocolat; "banane" to its search, "Votre recherche banane".
  const steps = [
    { command: 'fill', params: { value: '{{text}}' }, variable: { name: 'text', type: 'text', defaultValue: 'choco' } },
    { command: 'click', params: { text: '{{text_choice}}' }, variable: { name: 'text_choice', type: 'text', defaultValue: 'chocolat', suggestionOf: 'text' } },
    { command: 'assert', params: {}, assertion: { type: 'url_contains', expected: 'redirect_keywords=chocolat' } },
    { command: 'assert', params: {}, assertion: { type: 'title_contains', expected: 'Chocolats' } },
    { command: 'assert', params: {}, assertion: { type: 'title_equals', expected: 'Chocolats' } },
    { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: 'h1', expected: 'Chocolaterie' } },
  ];
  const { linked } = linkRecordedChecks(steps, { text: { type: 'text', defaultValue: 'choco' }, text_choice: { type: 'text', defaultValue: 'chocolat' } });
  assert.deepEqual(steps[2].assertion, { type: 'url_contains', expected: '{{text_choice}}', ignoreCase: true }, 'the query name is how the site took this value');
  assert.deepEqual(steps[3].assertion, { type: 'title_contains', expected: '{{text_choice}}', ignoreCase: true });
  assert.equal(steps[4].assertion.expected, 'Chocolats', 'what a text is, not what it holds: kept');
  assert.equal(steps[5].assertion.expected, 'Chocolaterie', 'never another word made of it');
  assert.deepEqual(linked.map((l) => l.step), [3, 4]);
  // Linked before it was followed (redirect_keywords={{text_choice}}): the same.
  assert.deepEqual(followSuggestion({ type: 'url_contains', expected: '?redirect_keywords={{text_choice}}', ignoreCase: true }, 'text_choice', 'chocolat'),
    { type: 'url_contains', expected: '{{text_choice}}', ignoreCase: true });
  assert.equal(followSuggestion({ type: 'url_contains', expected: '/search?q={{v}}', ignoreCase: true }, 'v', 'laptop'), null, 'a path with it is kept whole');
  assert.deepEqual(followSuggestion({ type: 'text_contains', selector: '.results', expected: '12 bananes' }, 'v', 'banane'),
    { type: 'text_contains', selector: '.results', expected: '12 {{v}}', ignoreCase: true });

  const page = (url, title) => async () => ({ result: { value: title ?? url, pageUrl: url } });
  const banane = 'https://www.auchan.fr/recherche?text=banane&keywords=ban&suggestType=mots-cles&suggestLabel=banane';
  assert.equal((await evaluateAssertion(page(banane), { ...steps[2].assertion, expected: 'banane' })).passed, true);
  assert.equal((await evaluateAssertion(page(banane, 'Votre recherche banane sur Auchan.fr'), { ...steps[3].assertion, expected: 'banane' })).passed, true);
  assert.equal((await evaluateAssertion(page(banane, 'Chocolats pas cher - Auchan.fr'), { ...steps[3].assertion, expected: 'chocolat' })).passed, true);
});
