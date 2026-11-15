// A click on an item of a list while a test is recorded — "add the second result to the cart" —:
// the list is read when it is clicked, on its page. Read at stop_recording, on the last page (the
// cart), the results were gone, and the second result was kept by its product's name; the header's
// cart link, still there, was made "the first of the header's links". An agent connected over MCP,
// the extension a stand-in, the classifier's answers stubbed; on a database of its own.
// Run with: node --test test/recorded-lists.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'recorded-lists-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
process.env.OPENROUTER_API_KEY = 'sk-or-test';
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { loadTest } = await import('../lib/test-store.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');

// The classifier says a list of products, picked by place (lib/classify.js, through Jev).
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({
    answers: {
      is_list: { type: 'noul', noul: 0.9 },
      selection_mode: { type: 'choice', choice: 'by_index', confidence: 0.9, probabilities: {} },
      variable_name: { type: 'choice', choice: 'product', confidence: 0.9, probabilities: {} },
    },
    usage: { input_tokens: 100, output_tokens: 0 },
  }),
});
after(() => { globalThis.fetch = realFetch; });

const ADD_SECOND = 'button[aria-label="Ajouter AUCHAN Lait demi-écrémé 6x1L au panier"]';
const CART_LINK = 'a[aria-label="Aller à la page panier"]';

/** A shop: its search results, then its cart; the header and its cart link on both. */
function shop() {
  let page = 'home';
  const asked = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'navigate') page = 'results';
    if (command === 'detect_list_context') {
      asked.push({ selector: params.selector, page });
      if (params.selector === ADD_SECOND && page === 'results') {
        return { type: 'list', parentSelector: 'main > div.list__container', itemXpath: "article[contains(@class,'product-thumbnail')]//button",
          totalItems: 20, selectedIndex: 1, selectedText: 'Ajouter au panier', itemTexts: ['Ajouter au panier', 'Ajouter au panier'], navigation: null, choice: false };
      }
      if (params.selector === CART_LINK) {
        return { type: 'list', parentSelector: 'main > div > div:nth-of-type(1) > header > div:nth-of-type(2) > div', itemXpath: "a[contains(@class,'navigation-header__link')]",
          totalItems: 4, selectedIndex: 0, selectedText: '3 €19.26', itemTexts: ['Mes produits', '3 €19.26'], navigation: null, choice: false };
      }
      return null;
    }
    if (command === 'click' && params.selector === CART_LINK) page = 'cart';
    if (command === 'execute_js') return { result: { value: '19,26 €', pageUrl: 'https://shop.test/checkout/cart' } };
    return { success: true, tabId: 5, windowId: 50, pageUrl: `https://shop.test/${page}` };
  };
  return { sendCommand, asked };
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

const actionOf = (text) => /\((act_\d+)\)/.exec(text)?.[1];

test('the second result clicked is a list item, read on its page; the header\'s cart link is not; a look at the page is removed', async () => {
  const { sendCommand, asked } = shop();
  const { call, close } = await agent(sendCommand, 'conn-lists');
  try {
    await call('start_recording', { name: 'Second result to the cart' });
    await call('navigate', { url: 'https://shop.test/recherche?text=lait', intent: 'Rechercher du lait' });
    await call('click', { selector: ADD_SECOND, intent: 'Ajouter le deuxième résultat au panier' });
    await call('click', { selector: CART_LINK, intent: 'Ouvrir le panier' });
    const look = actionOf(await call('execute_js', { code: "document.querySelector('.total').textContent" }));
    assert.match(await call('record_step', { action_id: look, remove: true }), /removed: the test now has 3 steps/);
    assert.match(await call('record_step', { action_id: 'act_999', remove: true }), /nothing removed/);
    await call('stop_recording');
  } finally {
    await close();
  }

  // Read before each click, on the page it was on — not again at stop_recording, on the cart.
  assert.deepEqual(asked, [{ selector: ADD_SECOND, page: 'results' }, { selector: CART_LINK, page: 'results' }]);
  const saved = loadTest('Second result to the cart');
  assert.deepEqual(saved.steps.map((s) => s.command), ['navigate', 'click', 'click']);
  assert.equal(saved.steps[1].variable?.type, 'list_item');
  assert.equal(saved.steps[1].variable?.defaultValue, '1', 'the second, by its place');
  assert.equal(saved.steps[2].variable ?? null, null, 'the cart link of the header: where the test goes');
  assert.equal('_listContext' in saved.steps[1], false, 'not saved');
});

test('the "+" of the card an earlier click added shares its variable: one {{product}} moves "Add" and "+" alike', async () => {
  // The extension finds no look-alike for either button, and answers with their card (utils/list-item.ts).
  const CARD = { type: 'list', parentSelector: '#shop-results', itemXpath: "./article[contains(concat(' ', normalize-space(@class), ' '), ' product-card ')]",
    totalItems: 8, selectedIndex: 1, selectedText: 'Semi-skimmed milk 6x1L 6,42 €', itemTexts: ['Whole milk 1L 1,15 €', 'Semi-skimmed milk 6x1L 6,42 €'], navigation: null, choice: false };
  const ADD = "./div/footer/div/button[2]";
  const MORE = "./div/footer/div/button[3]";
  const contexts = { '#add': { ...CARD, withinXpath: ADD }, '#more': { ...CARD, withinXpath: MORE } };
  const sendCommand = async (_profile, command, params) => {
    if (command === 'detect_list_context') return contexts[params.selector] ?? null;
    return { success: true, tabId: 6, windowId: 60, pageUrl: 'https://shop.test/search?q=milk' };
  };
  const { call, close } = await agent(sendCommand, 'conn-card');
  try {
    await call('start_recording', { name: 'Second card, three of it' });
    await call('navigate', { url: 'https://shop.test/search?q=milk' });
    await call('click', { selector: '#add', intent: 'Add the second result to the cart' });
    await call('click', { selector: '#more', intent: 'Raise the quantity to 2' });
    await call('click', { selector: '#more', intent: 'Raise the quantity to 3' });
    await call('stop_recording');
  } finally {
    await close();
  }
  const saved = loadTest('Second card, three of it');
  const [, add, two, three] = saved.steps;
  assert.equal(add.variable.name, 'product');
  assert.deepEqual([two.variable.name, three.variable.name], ['product', 'product'], 'one variable for the card');
  assert.deepEqual([add, two, three].map((s) => s.variable.listContext.withinXpath), [ADD, MORE, MORE], 'each its own element in it');
  assert.deepEqual(Object.keys(saved.variables), ['product']);
  assert.equal(saved.variables.product.step, 2, 'told by the first step that picks it');
  assert.equal(saved.variables.product.defaultValue, '1');
});

test('a click found in a list says so to the agent, whose pick goes before the classifier\'s', async () => {
  const SECTIONS = { type: 'list', parentSelector: 'div.container', itemXpath: "./div[contains(concat(' ', normalize-space(@class), ' '), ' section ')]",
    withinXpath: './div/form/button', totalItems: 7, selectedIndex: 6, selectedText: '7 — Product search & cart', itemTexts: ['1 — Simple login', '2 — Contact form', '3 — User profile', '4 — Dynamic'], navigation: null, choice: false };
  const CATEGORY = { type: 'list', parentSelector: 'ul.categories', itemXpath: 'li', totalItems: 5, selectedIndex: 2, selectedText: 'Garden', itemTexts: ['Kitchen', 'Bathroom', 'Garden'], navigation: null, choice: false };
  const contexts = { '#search': SECTIONS, '#garden': CATEGORY, '#alone': null };
  const sendCommand = async (_profile, command, params) => {
    if (command === 'detect_list_context') return params.selector in contexts ? contexts[params.selector] : null;
    return { success: true, tabId: 7, windowId: 70, pageUrl: 'https://shop.test/' };
  };
  const { call, close } = await agent(sendCommand, 'conn-pick');
  try {
    await call('start_recording', { name: 'Picks of the agent' });
    await call('navigate', { url: 'https://shop.test/' });
    const search = await call('click', { selector: '#search', intent: 'Launch the search' });
    assert.match(search, /List: taken as item 7 of 7 of a list \("1 — Simple login", "2 — Contact form", "3 — User profile", …\) — this element of that item\./);
    assert.match(search, /record_step\(action_id: "act_\d+", pick: "none"\)/);
    assert.match(await call('record_step', { action_id: actionOf(search), pick: 'none' }), /not an item of a list: a click on this element/);

    const garden = await call('click', { selector: '#garden', intent: 'Open the garden category' });
    assert.match(await call('record_step', { action_id: actionOf(garden), pick: 'by_text' }), /the item with its label in the list/);

    const alone = await call('click', { selector: '#alone', intent: 'Close the banner' });
    assert.doesNotMatch(alone, /List:/, 'in no list: nothing told');
    assert.match(await call('record_step', { action_id: actionOf(alone), pick: 'by_place' }), /no list was found around it/);
    await call('stop_recording');
  } finally {
    await close();
  }
  const saved = loadTest('Picks of the agent');
  const [, search, garden, alone] = saved.steps;
  assert.equal(search.variable ?? null, null, 'the agent said: not a list — though the classifier says one');
  assert.equal(garden.variable?.listContext.selectionMode, 'by_text', 'by its label, as the agent said — the classifier said by place');
  assert.equal(garden.variable?.defaultValue, 'Garden');
  assert.equal(alone.variable ?? null, null);
});
