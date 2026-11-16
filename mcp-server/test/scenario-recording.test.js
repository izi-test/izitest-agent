// Unit tests for a test written in Gherkin first, then recorded phrase by phrase
// (lib/scenario-recording.js): the agent writes the scenario with the project's library — its
// business steps, its phrases, its elements by name —; each phrase read against the library
// (a business step, a phrase, one on an element to find, a new one); the recording agent told how
// to do each and saying which it starts (start_phrase); once the test is saved, each new phrase
// a business step of the library made of its steps, its values in quotes its parameters, and the
// element of a phrase written by name named so. The agent and the browser are stand-ins. On a
// database of their own, thrown away after.
// Run with: node --test test/scenario-recording.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = await mkdtemp(join(tmpdir(), 'scenario-recording-'));
process.env.IZITEST_DB_PATH = join(dir, 'test.db');
process.env.IZITEST_SECRET_KEY_FILE = join(dir, 'secret.key');
delete process.env.IZITEST_SECRET_KEY;
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { createProject } = await import('../lib/projects.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { createStepDefinition, listStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { serializeTestToFeature } = await import('../lib/gherkin/serialize.js');
const { withElementNames, listElements, registerElements } = await import('../lib/element-store.js');
const { scenarioOf, scenarioBrief, startPhrase, markPhrases, businessPattern, looksLikeCss, writingBrief, featureIn, writeScenario } = await import('../lib/scenario-recording.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');
const { saveSecret } = await import('../lib/secrets.js');
const { saveDataset } = await import('../lib/datasets.js');

const shop = createProject({ name: 'Shop', base_url: 'https://shop.test/' });
const PAGE = 'shop.test/cart';
// The project knows the search field, and a business step that logs in.
saveTest({ name: 'known', variables: {}, steps: [
  { command: 'fill', params: { selector: '#q', value: 'milk' }, locators: [{ type: 'aria', value: 'Search' }], page: PAGE },
  { command: 'fill', params: { selector: '#user', value: 'bob' }, locators: [{ type: 'aria', value: 'User' }], page: 'shop.test/login' },
  { command: 'click', params: { selector: '#login' }, locators: [{ type: 'role', value: 'button', name: 'Log in' }], page: 'shop.test/login' },
] });
db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(shop.id, 'known');
registerElements(shop.id, loadTest('known').steps);
createStepDefinition(shop.id, { keyword: 'Given', pattern: 'I am logged in as {string}', command: 'composite', params_template: {},
  steps_template: [{ command: 'fill', params: { selector: '#user', value: '{0}' } }, { command: 'click', params: { selector: '#login' } }] });

const SCENARIO = `Feature: Empty the cart
  Scenario: Empty the cart
    Given I am logged in as "bob"
    And I am on "https://shop.test/cart"
    When I fill "Search" with "milk"
    And I click on "Empty the cart"
    And I add "2" bottles of "milk" to the cart (fast)
    Then the cart shows "0" items
    And I click on "#checkout"
`;

test('each phrase read against the library: a business step, a phrase, one on an element to find, a new one', () => {
  const { phrases } = scenarioOf(shop.id, SCENARIO);
  assert.deepEqual(phrases.map((p) => [p.n, p.keyword, p.kind]), [
    [1, 'Given', 'library'], [2, 'Given', 'phrase'], [3, 'When', 'phrase'], [4, 'When', 'find'], [5, 'When', 'new'], [6, 'Then', 'new'], [7, 'When', 'phrase'],
  ]);
  assert.equal(phrases[3].target, 'Empty the cart', 'an element the project does not know, by name');
  assert.equal(phrases[0].pattern, 'I am logged in as {string}');
  assert.match(scenarioOf(shop.id, 'Feature: x').error, /No Scenario|no step/);
  assert.equal(scenarioOf(shop.id, 'Feature: x\n  Scenario: y\n').error, 'The scenario has no step');
  assert.deepEqual(['#id', '.a', 'button', 'main h2', 'div > a', '[data-x]', 'input[name=q]'].map(looksLikeCss), [true, true, true, true, true, true, true]);
  assert.deepEqual(['Empty the cart', 'Panier', 'search'].map(looksLikeCss), [false, false, false]);
});

test('the recording agent is told how to do each phrase, and says which it starts', () => {
  const read = scenarioOf(shop.id, SCENARIO);
  const brief = scenarioBrief(read);
  assert.match(brief, /1\. Given I am logged in as "bob" — a business step of the project: play_business_step\(phrase: "I am logged in as \\"bob\\""\)/);
  assert.match(brief, /4\. And I click on "Empty the cart" — a phrase of the library on the element "Empty the cart", to find on the page — it is then named so/);
  assert.match(brief, /5\. And I add "2" bottles .* — new: find on the page how to do it/);
  assert.match(brief, /6\. Then the cart shows "0" items — new: check it with add_assertion/);
  assert.match(brief, /start_phrase\(number, phrase\)/);

  const recording = { steps: [{ command: 'a' }], scenario: read };
  assert.equal(startPhrase(null, 1).error, 'No recording in progress: start_recording with the scenario first.');
  assert.match(startPhrase({ steps: [] }, 1).error, /no scenario/);
  assert.match(startPhrase(recording, 9).error, /7 phrase\(s\), numbered from 1: no phrase 9/);
  assert.match(startPhrase(recording, 2).text, /^Phrase 2: And I am on "https:\/\/shop\.test\/cart" — a phrase of the library: do what it says\.$/);
  recording.steps.push({ command: 'b' }, { command: 'c' });
  startPhrase(recording, 3);
  recording.steps.push({ command: 'd' });
  markPhrases(recording);
  assert.deepEqual(recording.steps.map((s) => s._phrase), [undefined, 2, 2, 3], 'a step before the first phrase is none\'s');
});

test('a phrase as a business step\'s pattern: a value in quotes the steps use is a parameter, the rest is text', () => {
  const t = {
    variables: { qty: { defaultValue: '2' } },
    steps: [
      { command: 'fill', params: { selector: '#qty', value: '{{qty}}' } },
      { command: 'fill', params: { selector: '#product', value: 'Milk' } },
      { command: 'click', params: { selector: '#add' } },
    ],
  };
  assert.deepEqual(businessPattern('I add "2" bottles of "milk" to the cart (fast)', t, 1, 3), {
    pattern: 'I add {string} bottles of {string} to the cart \\(fast\\)',
    args: [{ variable: 'qty' }, { step: 2, param: 'value' }],
  });
  assert.deepEqual(businessPattern('I see "nothing" here', t, 1, 3), { pattern: 'I see "nothing" here', args: [] }, 'a value no step uses stays text');
});

// ── Recorded through the MCP tools, the browser a stand-in ──

function browser() {
  const sendCommand = async (_profile, command, params) => {
    if (command === 'detect_list_context') return null;
    if (command === 'execute_js') return { result: { value: '', pageUrl: `https://${PAGE}` } };
    if (command === 'close_window') return { closed: true, tabIds: [5] };
    return { success: true, tabId: 5, windowId: 50, pageUrl: `https://${PAGE}`, ...(command === 'navigate' && { url: params.url }) };
  };
  return sendCommand;
}

async function agent(connectionId) {
  const sendCommand = browser();
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

test('recorded phrase by phrase: the new phrases join the library, the element written by name is named so, the test reads as written', async () => {
  const scenario = `Feature: Two bottles
  Scenario: Two bottles
    Given I am on "https://shop.test/cart"
    When I add "2" bottles of "milk" to the cart
    And I click on "Empty the cart"
`;
  const { call, close } = await agent('scenario-agent');
  try {
    const started = await call('start_recording', { name: 'Two bottles', project_id: shop.id, scenario });
    assert.match(started, /2\. When I add "2" bottles of "milk" to the cart — new/);
    assert.match(await call('start_phrase', { number: 1, phrase: 'Given I am on "https://shop.test/cart"' }), /^Phrase 1:/);
    await call('navigate', { url: 'https://shop.test/cart', intent: 'Open the cart' });
    await call('start_phrase', { number: 2 });
    await call('fill', { selector: '#qty', value: '2', intent: 'Type the quantity' });
    await call('fill', { selector: '#product', value: 'milk', intent: 'Type the product' });
    await call('click', { selector: '#add', intent: 'Add to the cart' });
    await call('start_phrase', { number: 3 });
    await call('click', { selector: '#empty', intent: 'Empty the cart' });
    assert.match(await call('start_phrase', { number: 7 }), /no phrase 7/);
    const saved = await call('stop_recording');
    assert.match(saved, /New step of the library: When I add \{string\} bottles of \{string\} to the cart \(steps 2–4\)\./, saved);
    assert.match(saved, /The element of phrase 3 is named "Empty the cart", as the scenario writes it\./);
  } finally {
    await close();
  }

  const definition = listStepDefinitions(shop.id).find((d) => d.pattern === 'I add {string} bottles of {string} to the cart');
  assert.equal(definition.steps_template.length, 3);
  assert.ok(listElements(shop.id).some((e) => e.name === 'Empty the cart'));
  const feature = serializeTestToFeature(withElementNames(loadTest('Two bottles')), shop.id);
  assert.match(feature, /Given I am on "https:\/\/shop\.test\/cart"\n {4}When I add "\{\{[a-z_]+\}\}" bottles of "\{\{[a-z_]+\}\}" to the cart\n {4}And I click on "Empty the cart"\n/, feature);
});

test('the agent writes the scenario with the library: business steps first, the elements by name; a scenario that does not read is told', async () => {
  const brief = writingBrief(shop.id, { name: 'Search', description: 'Search milk, then empty the cart' });
  assert.match(brief, /Search milk, then empty the cart/);
  assert.match(brief, /### Its business steps[^\n]*\n- Given I am logged in as \{string\}/);
  assert.match(brief, /- When I add \{string\} bottles of \{string\} to the cart/, 'a phrase recorded before is in the library now');
  assert.match(brief, /"Search" \(field\)/);
  assert.match(brief, /At https:\/\/shop\.test\//);
  assert.match(brief, /a new phrase, in the words of the domain/);

  assert.equal(featureIn('Here:\n```gherkin\nFeature: a\n  Scenario: b\n    Given I am on "x"\n```\nDone.'), 'Feature: a\n  Scenario: b\n    Given I am on "x"\n');
  const written = await writeScenario(shop.id, { name: 'Search', description: 'Search milk', complete: async () => '```gherkin\nFeature: Search\n  Scenario: Search\n    Given I am logged in as "bob"\n    When I fill "Search" with "milk"\n```' });
  assert.deepEqual(written.phrases.map((p) => p.kind), ['library', 'phrase']);
  await assert.rejects(writeScenario(shop.id, { name: 'x', description: 'y', complete: async () => 'Sorry, I cannot.' }), /did not write a scenario that reads/);
});

test('a phrase on an element the project knows: the agent is told its selector, and the step done another way is that element', async () => {
  const scenario = `Feature: Search again
  Scenario: Search again
    When I fill "search" with "bread"
`;
  const read = scenarioOf(shop.id, scenario);
  assert.deepEqual(read.phrases.map((p) => [p.kind, p.target, p.selector]), [['phrase', 'search', '#q']], 'its name whatever its case');
  assert.match(scenarioBrief(read), /on the element "search" of the project — selector "#q": use it/);
  assert.match(scenarioBrief(read), /An execute_js that only looked is a step too/);

  const { call, close } = await agent('scenario-known');
  try {
    await call('start_recording', { name: 'Search again', project_id: shop.id, scenario });
    await call('start_phrase', { number: 1 });
    // Found otherwise: by another selector, with the name Chrome reads on it.
    await call('fill', { selector: 'input.search-box', value: 'bread', intent: 'Type bread' });
    assert.match(await call('stop_recording'), /The element of phrase 1 is "search", as the scenario writes it\./);
  } finally {
    await close();
  }
  assert.match(serializeTestToFeature(withElementNames(loadTest('Search again')), shop.id), /When I fill "Search" with "\{\{\w+\}\}"\n/);
  assert.equal(listElements(shop.id).filter((e) => e.name.toLowerCase().includes('search')).length, 1, 'one element, not two');
});

test('a login is written with the project\'s secrets and datasets — never an account made up; one none gives is left empty, asked at recording', () => {
  const shopper = createProject({ name: 'Shopper', base_url: 'https://shopper.test/' });
  const bare = writingBrief(shopper.id, { name: 'Login', description: 'Log in' });
  assert.doesNotMatch(bare, /## Its secrets|## Its datasets/, 'none: not told');
  assert.match(bare, /never one you make up; when none fits, leave it\n {3}empty, "", and the agent recording the test asks the user for it/);

  saveSecret(shopper.id, 'SHOPPER_PASSWORD', { value: 'S3cret-shopper', description: 'the password of the test account' });
  saveDataset(shopper.id, { name: 'users', rows: [{ email: 'qa@shopper.test' }] });
  const brief = writingBrief(shopper.id, { name: 'Login', description: 'Log in' });
  assert.match(brief, /## Its secrets[^\n]*\{\{secret\.NAME\}\}[^\n]*\n- SHOPPER_PASSWORD: the password of the test account/);
  assert.match(brief, /## Its datasets[^\n]*\n- users: email — 1 row\(s\); row 1: email "qa@shopper\.test"/);
  assert.doesNotMatch(brief, /S3cret-shopper/, 'a secret\'s value is never told');

  const read = scenarioOf(shopper.id, 'Feature: Login\n  Scenario: Login\n    Given I am on "https://shopper.test/"\n');
  assert.match(scenarioBrief(read), /An empty one, "", is a value the scenario\ndoes not know \(an account, a password\): ask the user for it with ask_user/);
});
