// Unit tests for the variables a recording detects without an LLM, and their names.
// The list contexts are the ones recorded on izitest-test.html and on Bien'ici.
// Run with: node --test test/variable-detection.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHeuristically } from '../lib/classify.js';
import { deriveVarNameFromLocators, itemLabel, listVariable, uniqueVarName } from '../lib/variable-detection.js';

const SIGN_IN = { type: 'box', totalItems: 4, selectedIndex: 0, selectedText: 'Sign in', itemTexts: ['Sign in', 'Clear', 'Send message', 'Clear'], itemXpath: "div/form/div/button[contains(@class,'btn')]" };
const SAVE_PROFILE = { type: 'list', totalItems: 3, selectedIndex: 0, selectedText: 'Save profile', itemTexts: ['Save profile', 'Discard', 'Delete account'], itemXpath: "button[contains(@class,'btn')]" };
const BARE_TOGGLE = { type: 'box', totalItems: 3, selectedIndex: 1, selectedText: '', itemTexts: [], itemXpath: "label[contains(@class,'toggle')]" };
const JARDIN = { type: 'list', totalItems: 6, selectedIndex: 5, selectedText: 'Jardin (44)', itemTexts: ['Balcon (7)', 'Terrasse (18)', 'Balcon ou terrasse (24)', 'Cave (15)', 'Parking (21)'], itemXpath: 'div/label', parentSelector: 'fieldset:nth-of-type(2)' };
const ADD_TO_CART = { type: 'box', totalItems: 12, selectedIndex: 3, selectedText: 'Add to cart', itemTexts: ['Add to cart', 'Add to cart', 'Add to cart', 'Add to cart', 'Add to cart'], itemXpath: 'div/div/button' };
const RESULTS = { type: 'list', totalItems: 10, selectedIndex: 2, selectedText: 'Voir', itemTexts: ['Voir', 'Voir', 'Voir', 'Voir', 'Voir'], itemXpath: 'li/a' };

test('form actions side by side are no list: Sign in, Save profile', () => {
  assert.equal(classifyHeuristically(SIGN_IN).isList, false);
  assert.equal(classifyHeuristically(SAVE_PROFILE).isList, false);
});

test('an item with no text of its own is no list: a bare toggle', () => {
  assert.equal(classifyHeuristically(BARE_TOGGLE).isList, false);
});

test('two items are a pair, not a choice', () => {
  assert.equal(classifyHeuristically({ ...JARDIN, totalItems: 2 }).isList, false);
});

test('labelled items are a list picked by text: Bien\'ici\'s criteria', () => {
  assert.deepEqual(classifyHeuristically(JARDIN), { isList: true, variableName: 'option', selectionMode: 'by_text' });
});

test('the same button or link repeated per item is a list picked by position', () => {
  assert.deepEqual(classifyHeuristically(ADD_TO_CART), { isList: true, variableName: 'item', selectionMode: 'by_index' });
  assert.deepEqual(classifyHeuristically(RESULTS), { isList: true, variableName: 'option', selectionMode: 'by_index' });
});

test('a by_text variable defaults to the item\'s label, without its count', () => {
  assert.equal(itemLabel('  Jardin (44) '), 'Jardin');
  assert.equal(itemLabel('Electronics [1 204]'), 'Electronics');
  assert.equal(itemLabel('Pack (2 personnes)'), 'Pack (2 personnes)');
  const variable = listVariable('critere', JARDIN, { selectionMode: 'by_text' });
  assert.equal(variable.defaultValue, 'Jardin');
  assert.equal(variable.type, 'list_item');
  assert.equal(variable.listContext.selectedText, 'Jardin (44)');
  assert.equal(listVariable('item', ADD_TO_CART, { selectionMode: 'by_index' }).defaultValue, '3');
});

test('a field is named after its label, not its placeholder', () => {
  const email = { locators: [{ type: 'placeholder', value: 'you@example.com' }, { type: 'aria', value: 'Email' }, { type: 'css', value: '#login-email' }] };
  assert.equal(deriveVarNameFromLocators(email), 'email');
  const invite = { locators: [{ type: 'placeholder', value: 'colleague@company.com' }, { type: 'aria', value: 'Invite member 1' }] };
  assert.equal(deriveVarNameFromLocators(invite), 'invite_member_1');
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'aria', value: 'Nom affiché' }] }), 'nom_affiche');
});

test('without a label: the submitted name, then the placeholder', () => {
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'placeholder', value: 'janedoe42' }, { type: 'attribute', value: 'input[name="displayName"]' }] }), 'display_name');
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'placeholder', value: 'Ville ou code postal' }] }), 'ville_ou_code_postal');
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'aria', value: '42' }, { type: 'css', value: '#x' }] }), null);
  assert.equal(deriveVarNameFromLocators({}), null);
});

test('names stay unique within a test', () => {
  const used = new Set();
  assert.deepEqual(['email', 'email', 'email'].map((n) => uniqueVarName(n, used)), ['email', 'email_2', 'email_3']);
});
