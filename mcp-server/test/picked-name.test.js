// An item picked in a list by its place, then named as it was in later steps — an Auchan recording
// added "the second result" of "lait" to a shopping list, then removed "Lait demi-écrémé UHT" from
// it by its name: a replay that picks another milk removes nothing. What went wrong, each fixed:
// the cards sat in a <nav> and were taken for the site's menu (no variable at all); the text read
// for a card of a box was the first card's; the name, read in the label of the button clicked
// ("Ajouter le produit : … à une liste" in every card), is now kept right after the pick and
// written {{its name}} in the steps that named it — or told to the agent right after the click.
// The extension is a stand-in, the classifier's answers stubbed; on a database of its own.
// Run with: node --test test/picked-name.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'picked-name-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
process.env.OPENROUTER_API_KEY = 'sk-or-test';
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { loadTest } = await import('../lib/test-store.js');
const { pickTemplate, keepPickedNames, reviewSteps } = await import('../lib/recording-review.js');
const { pick } = await import('../lib/values.js');
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

const LABELS = {
  pickedLabel: 'Ajouter le produit : Lait demi-écrémé UHT à une liste', pickedLabelFrom: 'aria-label',
  otherLabels: ['Ajouter le produit : VitaVie Lait 12 vitamines à une liste', 'Ajouter le produit : Matin léger Lait facile à digérer sans lactose à une liste'],
};
const ADD_SECOND = '#cms-slot-topFilterSlot > div > div > div > nav > div:nth-of-type(1) > article:nth-of-type(2) > div:nth-of-type(2) > footer > div:nth-of-type(2) > div:nth-of-type(2) > button';
const REMOVE = 'button[aria-label="Supprimer\\ le\\ produit\\ \\:\\ Lait\\ demi-écrémé\\ UHT\\ de\\ la\\ liste"]';

test('the name of the item picked, read in the label of the element clicked: what the other items\' labels do not read', () => {
  assert.deepEqual(pickTemplate(LABELS), { name: 'Lait demi-écrémé UHT', before: 'Ajouter le produit : ', after: ' à une liste', from: 'aria-label' });
  assert.equal(pickTemplate({ ...LABELS, otherLabels: [] }), null, 'no other item read');
  assert.equal(pickTemplate({ pickedLabel: 'Ajouter au panier', otherLabels: ['Ajouter au panier'] }), null, 'every item the same');
  // A word every label begins with is how they all read: "Lait" of "Lait entier" among "Lait demi-écrémé"
  // only. Written {{its name}} after it ("Supprimer Lait {{product_name}}"), another milk reads the same.
  assert.equal(pickTemplate({ pickedLabel: 'Ajouter Lait entier', otherLabels: ['Ajouter Lait demi-écrémé'] }).name, 'entier');
});

test('what the labels share is cut at a whole word in each of them: "1L" ends a name, it does not end the label', () => {
  // A shop's three results: two end with "1L", one with "6x1L". Cut at "1L à une liste", the
  // pattern kept "Lait demi-écrémé UHT 6x" at a replay that picked the second.
  const label = (name) => `Ajouter le produit : ${name} à une liste`;
  const template = pickTemplate({ pickedLabel: label("Boisson d'amande 1L"), pickedLabelFrom: 'aria-label', otherLabels: [label('Lait entier 1L'), label('Lait demi-écrémé UHT 6x1L')] });
  assert.deepEqual(template, { name: "Boisson d'amande 1L", before: 'Ajouter le produit : ', after: ' à une liste', from: 'aria-label' });
  // The same at their start: "Lot de 2 …" and "Lot de 24 …" share "Lot de 2".
  assert.equal(pickTemplate({ pickedLabel: 'Lot de 2 savons', otherLabels: ['Lot de 24 éponges', 'Lot de 2 brosses'] }).name, '2 savons');
});

test('named as it was in later steps: its name kept right after the pick, {{its name}} written in them, played with another item', () => {
  const steps = [
    { command: 'click', params: { selector: ADD_SECOND }, variable: { name: 'product', type: 'box_item', defaultValue: '1', listContext: { type: 'box', selectionMode: 'by_index', ...LABELS } } },
    { command: 'click', params: { selector: 'form.formAddToList button.btn' } },
    { command: 'assert', assertion: { type: 'text_contains', selector: 'main', expected: 'Lait demi-écrémé UHT' } },
    { command: 'click', params: { selector: REMOVE }, locators: [{ type: 'aria', value: 'Supprimer le produit : Lait demi-écrémé UHT de la liste' }] },
  ];
  assert.equal(reviewSteps(steps).length, 2, 'read over, both named it');
  const done = keepPickedNames(steps, new Set(['product']));
  assert.deepEqual(done, [{ pick: 1, name: 'Lait demi-écrémé UHT', variable: 'product_name', named: [4, 5] }]);
  assert.deepEqual(steps[1], {
    command: 'capture',
    params: { name: 'product_name', selector: ADD_SECOND, what: 'attribute', attribute: 'aria-label', pattern: 'Ajouter\\s+le\\s+produit\\s+:\\s*(.+?)\\s*à\\s+une\\s+liste' },
    intent: 'Keep the name of the product picked as {{product_name}}',
  });
  assert.equal(steps[3].assertion.expected, '{{product_name}}');
  assert.equal(steps[4].params.selector, 'button[aria-label="Supprimer\\ le\\ produit\\ \\:\\ {{product_name}}\\ de\\ la\\ liste"]');
  assert.equal(steps[4].locators[0].value, 'Supprimer le produit : {{product_name}} de la liste');
  assert.deepEqual(reviewSteps(steps), [], 'nothing left to tell');
  // At a replay, the second card is another milk: its name is the one kept.
  assert.equal(pick('Ajouter le produit : Lait entier bio 1L à une liste', steps[1].params.pattern), 'Lait entier bio 1L');
  assert.deepEqual(keepPickedNames(steps), [], 'done once');

  // The pick found by the item's own name: no other item is found by it — told, not changed.
  const byName = [
    { ...steps[0], params: { selector: 'button[aria-label="Ajouter le produit : Lait demi-écrémé UHT à une liste"]' } },
    { command: 'click', params: { selector: REMOVE } },
  ];
  assert.deepEqual(keepPickedNames(byName), []);
  assert.match(reviewSteps(byName)[0].says, /names "Lait demi-écrémé UHT", the item step 1 picked by its place/);
});

test('recorded: the cards of a <nav> picked by place, told the name right after the click, saved with it kept', async () => {
  let page = 'results';
  const sendCommand = async (_profile, command, params) => {
    if (command === 'navigate') page = 'results';
    if (command === 'detect_list_context') {
      if (params.selector !== ADD_SECOND) return null;
      return { type: 'box', parentSelector: '#cms-slot-topFilterSlot > div > div > div > nav > div:nth-of-type(1) > article:nth-of-type(1)',
        itemXpath: "div/footer/div/div/button[contains(@class,'product-thumbnail__add-to-list')]", totalItems: 3, selectedIndex: 1, selectedText: '', itemTexts: ['', '', ''],
        // What the page says of them: they sit in a <nav>. Cards all the same, not a menu.
        navigation: 'nav', choice: false };
    }
    if (command === 'execute_js') {
      // The card picked, read at its place among the boxes — not the first one.
      if (/"selectedIndex":1/.test(params.code ?? '')) {
        // As the browser answers an execute_js: what the script returned, itself.
        return { pickedText: 'LACTEL Lait demi-écrémé UHT 6x1L 7,51€', otherTexts: ['LACTEL VitaVie Lait 12 vitamines 6x1L 7,03€'], ...LABELS };
      }
      return { result: { value: page === 'list' ? 'Mes listes' : 'https://www.auchan.fr/recherche?text=lait', pageUrl: 'https://www.auchan.fr/recherche?text=lait' } };
    }
    if (command === 'click' && /mes-listes/.test(params.selector ?? '')) page = 'list';
    return { success: true, tabId: 5, windowId: 50, pageUrl: page === 'list' ? 'https://www.auchan.fr/client/mes-listes-de-courses' : 'https://www.auchan.fr/recherche?text=lait' };
  };
  const connectionId = 'picked-name';
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, { sendCommand, getProfiles: () => new Map() });
  registerTestTools(server, { sendCommand });
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
  try {
    await call('start_recording', { name: 'Milk in the list' });
    await call('navigate', { url: 'https://www.auchan.fr/recherche?text=lait' });
    const clicked = await call('click', { selector: ADD_SECOND, intent: 'Ajouter le deuxième résultat à une liste' });
    assert.match(clicked, /List: taken as item 2 of 3 of a list/, 'not the site\'s menu: its cards sit in a <nav>');
    assert.match(clicked, /Its name here: "Lait demi-écrémé UHT" — another item at the next run\./);
    assert.match(clicked, /capture_value\(name: "item_name", ref: the one you clicked, what: "attribute", attribute: "aria-label", pattern: "Ajouter le produit :\\\\s\*\(\.\+\?\)\\\\s\*à une liste"\)/);
    await call('click', { selector: 'a[href="/client/mes-listes-de-courses"]', intent: 'Ouvrir Mes listes' });
    await call('click', { selector: REMOVE, intent: 'Retirer le produit de la liste' });
    const saved = await call('stop_recording');
    assert.match(saved, /saved with 5 steps/);
    assert.match(saved, /The item picked by its place at step 2 was named as it was \("Lait demi-écrémé UHT"\) in step 5: its name is kept right after the pick as \{\{product_name\}\} \(step 3\)/);
    const test = loadTest('Milk in the list');
    assert.deepEqual(test.steps.map((s) => s.command), ['navigate', 'click', 'capture', 'click', 'click']);
    assert.equal(test.steps[1].variable.listContext.pickedText, 'LACTEL Lait demi-écrémé UHT 6x1L 7,51€');
    assert.match(test.steps[4].params.selector, /\{\{product_name\}\}/);
  } finally {
    await client.close();
    dropConnection(connectionId);
  }
});
