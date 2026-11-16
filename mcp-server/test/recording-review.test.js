// Unit tests for what made an Auchan recording pass once, then fail at the next run: the search
// typed checked in the URL as it was encoded (p%C3%A2tes) — now linked to its variable —; a
// library step made from a pick by place clicking the very item recorded ("Bananes Prix Bas") —
// now picking at that place —; and the name of the product picked written in later checks — now
// found when the recording is read over before it is saved (lib/recording-review.js), told to the
// agent, a second stop_recording saving. The browser is a stand-in. On a database of their own.
// Run with: node --test test/recording-review.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'recording-review-')), 'test.db');
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { linkAssertionToVariables } = await import('../lib/test-variable.js');
const { buildBusinessStep } = await import('../lib/gherkin/business-step.js');
const { stepsForPhrase, compileDefinitions } = await import('../lib/gherkin/parse.js');
const { scenarioPhrases } = await import('../lib/gherkin/serialize.js');
const { playBusinessSteps } = await import('../lib/business-play.js');
const { reviewSteps, reviewText, pickedWords } = await import('../lib/recording-review.js');
const { loadTest } = await import('../lib/test-store.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection } = await import('../lib/session.js');

const LIST = { type: 'list', parentSelector: 'main ul.results', itemXpath: './li', selectionMode: 'by_index', withinXpath: './/button[2]' };
const pickFirst = (label) => ({
  command: 'click',
  params: { selector: 'button[aria-label^="Ajouter le produit"][aria-label$="à une liste"]' },
  locators: [{ type: 'aria', value: label }],
  variable: { name: 'item', type: 'box_item', defaultValue: '0', listContext: { ...LIST, itemTexts: [label, 'Ajouter le produit : Spaghetti n°5 à une liste'] } },
  intent: 'Ajouter le premier résultat à une liste',
});

test('a value typed, checked in the URL as the page encodes it: linked to its variable', () => {
  const variables = { text: { type: 'text', defaultValue: 'pâtes' }, two: { type: 'text', defaultValue: 'pâtes fraîches' } };
  assert.deepEqual(linkAssertionToVariables({ type: 'url_contains', expected: 'p%C3%A2tes' }, { text: variables.text }).assertion, { type: 'url_contains', expected: '{{text}}' });
  assert.deepEqual(linkAssertionToVariables({ type: 'url_contains', expected: '?text=p%C3%A2tes+fra%C3%AEches' }, variables).assertion.expected, '?text={{two}}');
  assert.deepEqual(linkAssertionToVariables({ type: 'text_contains', selector: 'h1', expected: 'p%C3%A2tes' }, variables).linked, [], 'a text is not a URL');
});

test('a library step made from a pick by place picks at that place: built, read back, played', async () => {
  const recorded = { name: 'source', steps: [pickFirst('Ajouter le produit : Bananes Prix Bas à une liste'), { command: 'click', params: { text: 'nos courses' } }] };
  const { steps_template } = buildBusinessStep(recorded, { from_step: 1, to_step: 2, pattern: "j'ajoute le premier résultat à la liste", args: [] });
  assert.deepEqual(steps_template[0].variable, { name: 'item', type: 'box_item', defaultValue: '0', listContext: { type: 'list', parentSelector: 'main ul.results', itemXpath: './li', selectionMode: 'by_index', withinXpath: './/button[2]' } });

  const definition = { id: 7, keyword: 'When', pattern: "j'ajoute le premier résultat à la liste", steps_template };
  // Read back: a test that picked another product, at the same place, reads as the phrase.
  const other = { steps: [pickFirst('Ajouter le produit : Penne rigate à une liste'), { command: 'click', params: { text: 'nos courses' } }] };
  other.steps[0].params.selector = 'button[aria-label="Ajouter le produit : Penne rigate à une liste"]';
  assert.equal(scenarioPhrases(other, [definition])[0].business, 7);
  const second = structuredClone(other);
  second.steps[0].variable.defaultValue = '1';
  assert.equal(scenarioPhrases(second, [definition])[0].business, undefined, 'another place: another step');

  // Expanded from the phrase: the pick is a variable of the test, at its place.
  const expanded = stepsForPhrase("j'ajoute le premier résultat à la liste", 'When', compileDefinitions([definition])).steps;
  assert.equal(expanded[0].variable.listContext.parentSelector, 'main ul.results');

  // Played: the item at that place now, not the one recorded.
  const sent = [];
  await playBusinessSteps({ phrase: 'x', steps: expanded }, {
    sendCommand: async (_p, _c, params) => { sent.push(params.steps[0]); return { results: [{ status: 'success', tabId: 1 }] }; },
    live: (p) => p, tabId: 1, elementTimeoutMs: 1000,
  });
  assert.deepEqual(sent[0].variableResolve, { parentSelector: 'main ul.results', itemXpath: './li', selectionMode: 'by_index', value: '0', withinXpath: './/button[2]' });
  assert.equal(sent[1].variableResolve, undefined);
});

test('read over: the name of the item picked by its place, and a value typed, written as they were in later steps', () => {
  const pick = pickFirst('Ajouter le produit : Penne rigate Barilla 500g à une liste');
  assert.deepEqual(pickedWords(pick), ['penne', 'rigate', 'barilla', '500g'], 'not the words every item of the list reads');
  const steps = [
    { command: 'fill', params: { selector: '#q', value: '{{text}}' }, variable: { name: 'text', type: 'text', defaultValue: 'pâtes' } },
    { command: 'click', params: { selector: 'a[title="pâtes"]' }, _actionId: 'act_2' },
    pick,
    { command: 'click', params: { text: 'Mes listes' } },
    { command: 'assert', assertion: { type: 'element_exists', selector: 'button[aria-label="Supprimer le produit : Penne rigate de la liste"]' }, _actionId: 'act_9' },
    { command: 'click', params: { selector: 'a[aria-label="Aller à la page panier"]' } },
  ];
  const findings = reviewSteps(steps);
  assert.deepEqual(findings.map((f) => [f.step, f.actionId]), [[2, 'act_2'], [5, 'act_9']]);
  assert.match(findings[0].says, /holds "pâtes", the value typed at step 1 \(\{\{text\}\}\)/);
  assert.match(findings[1].says, /names "penne rigate", the item step 3 picked by its place/);
  const text = reviewText(findings, steps);
  assert.match(text, /^Not saved yet: read over, the recording has 2 steps that would pass once, then fail at the next run:/);
  assert.match(text, /- Step 5 \(act_9\), element_exists button\[aria-label="Supprimer le produit : Penne rigate de la liste"\]:/);
  assert.match(text, /Then call stop_recording again: it saves\./);
  assert.deepEqual(reviewSteps([pick, { command: 'click', params: { selector: 'a[aria-label="Aller à la page panier"]' } }]), [], 'a word of the site alone is not the name');
});

test('stop_recording reads it over: told first, not saved; called again, saved', async () => {
  const sendCommand = async (_profile, command) => {
    if (command === 'detect_list_context') return null;
    if (command === 'execute_js') return { result: { value: '', pageUrl: 'https://shop.test/' } };
    return { success: true, tabId: 5, windowId: 50, pageUrl: 'https://shop.test/' };
  };
  const connectionId = 'review-agent';
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
    await call('start_recording', { name: 'Typed then clicked' });
    await call('navigate', { url: 'https://shop.test/' });
    await call('fill', { selector: '#q', value: 'chocolat', intent: 'Type the search' });
    await call('click', { selector: 'a[title="chocolat"]', intent: 'Open the aisle' });
    const first = await call('stop_recording');
    assert.match(first, /^Not saved yet: read over, the recording has a step that would pass once, then fail at the next run:\n- Step 3 \(act_\d+\), click a\[title="chocolat"\] \("Open the aisle"\): holds "chocolat", the value typed at step 2/);
    assert.equal(loadTest('Typed then clicked'), null);
    assert.match(await call('stop_recording'), /Test "Typed then clicked" saved with 3 steps/);
  } finally {
    await client.close();
    dropConnection(connectionId);
  }
});

test('a button that reads nothing (an icon): the name picked is what its card alone reads, read when it is clicked', async () => {
  const { detectListContext } = await import('../lib/classify.js');
  const BOX = { type: 'box', parentSelector: '#wrapper > article:nth-of-type(1)', itemXpath: "div/footer/button[contains(@class,'add-to-list')]", totalItems: 65, selectedIndex: 0, selectedText: '' };
  const asked = [];
  const sendCommand = async (_profile, command, params) => {
    asked.push(command);
    if (command === 'detect_list_context') return { ...BOX };
    if (command === 'execute_js') {
      assert.match(params.code, /#wrapper > article:nth-of-type\(1\)/);
      return { result: { pickedText: 'Penne rigate n°66 Barilla 500g 1,29 € Ajouter au panier', otherTexts: ['Spaghetti n°5 Barilla 500g 0,99 € Ajouter au panier'] } };
    }
    return {};
  };
  const context = await detectListContext(sendCommand, { selector: 'button.add-to-list' });
  assert.deepEqual(asked, ['detect_list_context', 'execute_js']);
  assert.equal(context.pickedText, 'Penne rigate n°66 Barilla 500g 1,29 € Ajouter au panier');

  const { listVariable } = await import('../lib/variable-detection.js');
  const pick = { command: 'click', params: { selector: 'button[aria-label^="Ajouter le produit"][aria-label$="à une liste"]' }, variable: listVariable('item', context, { selectionMode: 'by_index' }) };
  assert.deepEqual(pickedWords(pick), ['penne', 'rigate', 'n°66'], 'not what its neighbours read too: Barilla, 500g, Ajouter, panier');
  const findings = reviewSteps([pick, { command: 'assert', assertion: { type: 'element_exists', selector: 'button[aria-label="Supprimer le produit : Penne rigate de la liste"]' } }]);
  assert.match(findings[0]?.says ?? '', /names "penne rigate", the item step 1 picked by its place/);
});
