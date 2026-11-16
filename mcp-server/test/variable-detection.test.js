// Unit tests for the variables a recording detects without an LLM, and their names.
// The list contexts are the ones recorded on izitest-test.html and on Bien'ici.
// Run with: node --test test/variable-detection.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHeuristically } from '../lib/classify.js';
import { deriveVarNameFromLocators, itemLabel, listVariable, uniqueVarName, variabilizeInput, isNavigation, typedJustBefore, variabilizeSuggestion, suggestionLocators, keepStepVariable, listNote, sameItemStep } from '../lib/variable-detection.js';
import { selectParams } from '../lib/recording.js';

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
  // Named by a Gherkin phrase, with nothing recorded: by the label it names.
  assert.equal(deriveVarNameFromLocators({ command: 'fill', params: { label: 'Mot de passe', value: 'x' } }), 'mot_de_passe');
});

test('without a label: the submitted name, then the placeholder', () => {
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'placeholder', value: 'janedoe42' }, { type: 'attribute', value: 'input[name="displayName"]' }] }), 'display_name');
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'placeholder', value: 'Ville ou code postal' }] }), 'ville_ou_code_postal');
  assert.equal(deriveVarNameFromLocators({ locators: [{ type: 'aria', value: '42' }, { type: 'css', value: '#x' }] }), null);
  assert.equal(deriveVarNameFromLocators({}), null);
});

test('an accessible name that is only the placeholder ranks as the placeholder (izi_review)', () => {
  const country = { locators: [{ type: 'css', value: '#country-input' }, { type: 'aria', value: 'Start typing...' }, { type: 'attribute', value: 'input[name="country"]' }, { type: 'placeholder', value: 'Start typing...' }] };
  assert.equal(deriveVarNameFromLocators(country), 'country');
  const tag = { locators: [{ type: 'css', value: '#tag-input' }, { type: 'aria', value: 'Add a tag...' }, { type: 'placeholder', value: 'Add a tag...' }] };
  assert.equal(deriveVarNameFromLocators(tag), 'tag_input', 'its id, before the placeholder');
});

test('filled by selector, without locators: the id it names', () => {
  assert.equal(deriveVarNameFromLocators({ params: { selector: '#inline-title' } }), 'inline_title');
  assert.equal(deriveVarNameFromLocators({ params: { selector: '#r1' } }), null, 'a generated id names nothing');
  assert.equal(deriveVarNameFromLocators({ params: { selector: 'div.inline-edit' } }), null);
});

test('what a <select> picked is a variable too, named after the field (izi_wizard_full)', () => {
  const used = new Set();
  const plan = { command: 'select', params: { selector: '#ws-plan', value: 'enterprise', matchBy: 'value' }, locators: [{ type: 'aria', value: 'Plan' }] };
  assert.equal(variabilizeInput(plan, 2, used), true);
  assert.deepEqual([plan.params.value, plan.variable], ['{{plan}}', { name: 'plan', type: 'select', defaultValue: 'enterprise' }]);
  const role = { command: 'select', params: { selector: '#ws-role', value: 'admin' } };
  variabilizeInput(role, 7, used);
  assert.equal(role.variable.name, 'ws_role', 'by its id without locators');
  const fill = { command: 'fill', params: { selector: '#ws-name', value: 'Acme QA' }, locators: [{ type: 'label', value: 'Workspace name' }] };
  variabilizeInput(fill, 1, used);
  assert.deepEqual(fill.variable, { name: 'workspace_name', type: 'text', defaultValue: 'Acme QA' });
  assert.equal(variabilizeInput({ command: 'click', params: { selector: '#go' } }, 3, used), false);
  assert.equal(variabilizeInput({ command: 'select', params: { selector: '#x', value: '' } }, 4, used), false);
});

test('a select is kept by the value of its option, what the form sends', () => {
  const picked = { success: true, selectedValue: 'enterprise', selectedText: 'Enterprise — Unlimited ($99/mo)' };
  assert.deepEqual(selectParams(picked, 'Enterprise — Unlimited ($99/mo)'), { value: 'enterprise', matchBy: 'value' });
  // No value back from the page: as asked.
  assert.deepEqual(selectParams({ success: true }, 'Admin', 'text'), { value: 'Admin', matchBy: 'text' });
  assert.deepEqual(selectParams(undefined, 'Admin'), { value: 'Admin' });
});

test('names stay unique within a test', () => {
  const used = new Set();
  assert.deepEqual(['email', 'email', 'email'].map((n) => uniqueVarName(n, used)), ['email', 'email_2', 'email_3']);
});

test('a click in a menu, a tab bar or a side menu is navigation, not a variable', () => {
  // The dashboard's tabs: "Runs7" carries a count that changes at the next run.
  const TABS = { type: 'list', totalItems: 6, selectedIndex: 4, selectedText: 'Runs7', itemTexts: ['Steps21', 'Gherkin', 'Code', 'Data6', 'Runs7'], itemXpath: 'button', navigation: 'div[role=tablist]' };
  assert.equal(isNavigation(TABS), true, 'the page says so');
  // the portal's side menu, recorded before the page said so: the classifier calls it a menu.
  const SIDE_MENU = { type: 'list', totalItems: 5, selectedText: 'USER MANAGEMENT', itemTexts: ['Home', 'USER MANAGEMENT', 'MANAGE ENDPOINTS'] };
  assert.equal(isNavigation(SIDE_MENU, { isList: true, variableName: 'menu_item', selectionMode: 'by_text' }), true);
  // A choice among items of the app's data stays one.
  assert.equal(isNavigation(JARDIN, { isList: true, variableName: 'category', selectionMode: 'by_text' }), false);
  assert.equal(isNavigation(null), false);
});

test("the links of the page's header are navigation: the cart link is never \"the first of them\"", () => {
  // Auchan: the cart link, among the 4 links of its <header>, was made {{product}} by its place.
  const CART = { type: 'list', totalItems: 4, selectedIndex: 0, selectedText: '3 €19.26', parentSelector: 'main > div > div:nth-of-type(1) > header > div:nth-of-type(2) > div', itemXpath: "a[contains(@class,'navigation-header__link')]", navigation: null };
  assert.equal(isNavigation(CART, { isList: true, variableName: 'product', selectionMode: 'by_index' }), true);
  assert.equal(isNavigation({ ...CART, parentSelector: 'div.top > div' }), true, 'its links named after navigation');
  assert.equal(isNavigation({ ...CART, itemXpath: 'a', parentSelector: '#header > ul' }), true);
  assert.equal(isNavigation({ ...CART, itemXpath: 'a', parentSelector: 'div[role="banner"] > ul' }), true);
  // The results of a search: a card may have a header of its own, the list is not in one.
  const RESULTS = { type: 'list', totalItems: 20, selectedIndex: 1, parentSelector: 'main > div.list__container', itemXpath: "article[contains(@class,'product-thumbnail')]", navigation: null };
  assert.equal(isNavigation(RESULTS, { isList: true, variableName: 'product', selectionMode: 'by_index' }), false);
  assert.equal(isNavigation({ ...RESULTS, parentSelector: 'section.headers-list > div' }), false, 'a word that holds "header" is not one');
  assert.equal(isNavigation({ ...RESULTS, itemXpath: "div[contains(@class,'canvas-item')]" }), false);
  // A search field's suggestions in the header stay a choice.
  assert.equal(isNavigation({ ...CART, choice: true }), false);
  // Cards are content wherever they sit: Auchan draws its products, a brand's sponsored ones too, in a <nav>.
  const IN_NAV = { type: 'box', totalItems: 3, selectedIndex: 1, parentSelector: '#cms-slot-topFilterSlot > div > div > div > nav > div:nth-of-type(1) > article:nth-of-type(1)', itemXpath: "div/footer/div/div/button[contains(@class,'product-thumbnail__add-to-list')]", navigation: 'nav' };
  assert.equal(isNavigation(IN_NAV), false, 'whatever the page says of the <nav> around them');
  assert.equal(isNavigation({ type: 'list', parentSelector: 'nav > div', itemXpath: "./div[contains(@class,'product-card')]", withinXpath: './footer/button', navigation: 'nav' }), false, 'a card found around its button');
  assert.equal(isNavigation(IN_NAV, { isList: true, variableName: 'menu_item' }), true, 'the classifier calling them a menu is still heard');
  assert.equal(isNavigation({ type: 'list', parentSelector: 'nav > div', itemXpath: "div[contains(@class,'product-card')]" }), false);
  assert.equal(isNavigation({ type: 'list', parentSelector: 'nav > ul', itemXpath: 'li/a' }), true, 'the links of a <nav> stay navigation');
});

test('the suggestions of a search field stay a choice: in the header\'s <nav>, or called a dropdown menu', () => {
  // A search bar in the header: its suggestions sit in the <nav>, and the page says they are options.
  const IN_HEADER = { type: 'list', totalItems: 5, selectedText: 'Marseille (13)', itemTexts: ['Marseille (13)', 'Marseillan (34)'], choice: true, navigation: null };
  assert.equal(isNavigation(IN_HEADER, { isList: true, variableName: 'menu_item' }), false);
  // Suggestions drawn as plain <div>s, which the classifier calls a dropdown menu: they came right after typing.
  const steps = [{ command: 'fill', params: { selector: '#city', value: 'Mars' } }, { command: 'wait', params: { selector: '.suggestions' } }, { command: 'click', params: { text: 'Marseille' } }];
  assert.equal(typedJustBefore(steps, 2), true, 'a wait for them in between');
  assert.equal(isNavigation({ type: 'list', navigation: null }, { isList: true, variableName: 'menu_item' }, { afterTyping: typedJustBefore(steps, 2) }), false);
  // Nothing typed just before: a click after a click, or after Enter.
  assert.equal(typedJustBefore([{ command: 'click', params: {} }, { command: 'click', params: {} }], 1), false);
  assert.equal(typedJustBefore([{ command: 'keyboard', params: { key: 'Enter' } }, { command: 'click', params: {} }], 1), false, 'Enter sends, it does not type');
});

// The Test Arena's country field: "Fr" typed, "France" picked among its suggestions.
const typedFr = () => ({ command: 'fill', params: { selector: '#country-input', value: '{{country_input}}' }, variable: { name: 'country_input', type: 'text', defaultValue: 'Fr' } });
const pickFrance = () => ({ command: 'click', params: { selector: '#country-list > div:nth-of-type(1)' }, locators: [
  { type: 'aria', value: 'France' }, { type: 'text', value: 'France' },
  { type: 'css', value: '#country-list > div:nth-of-type(1)' }, { type: 'xpath', value: '(//*[@id="country-list"]//div)[1]' },
] });

test('a suggestion picked after typing is a variable of its own, clicked by its text', () => {
  const steps = [typedFr(), { ...pickFrance(), intent: 'Pick France among the suggestions' }];
  const used = new Set(['country_input']);
  assert.equal(variabilizeSuggestion(steps, 1, used), true);
  assert.deepEqual(steps[1].variable, { name: 'country', type: 'text', defaultValue: 'France', suggestionOf: 'country_input', field: 'css #country-input', fieldName: '#country-input' },
    'its field, by which its element is known in every test');
  assert.deepEqual(steps[1].params, { text: '{{country}}' });
  assert.deepEqual(steps[1].locators, [{ type: 'aria', value: '{{country}}' }, { type: 'text', value: '{{country}}' }],
    'not the first suggestion by place: on "Ital" it was Italy, picked silently');
  assert.equal(steps[1].intent, 'Pick {{country}} among the suggestions', 'a run picking Italy reads so');
});

test('with a wait for the suggestions in between; named after a field with no suffix; words matched by their start', () => {
  const city = { command: 'fill', params: { selector: '#city', value: '{{city}}' }, variable: { name: 'city', type: 'text', defaultValue: 'saint eti' } };
  const steps = [city, { command: 'wait', params: { selector: '.suggestions li' } }, { command: 'click', params: { text: 'Saint-Étienne (42)' } }];
  assert.equal(variabilizeSuggestion(steps, 2, new Set(['city'])), true);
  assert.equal(steps[2].variable.name, 'city_choice');
  assert.equal(steps[2].variable.defaultValue, 'Saint-Étienne (42)');
});

test('a button clicked after typing is no suggestion; nor a click after a click', () => {
  const name = { command: 'fill', params: { selector: '#name', value: '{{name}}' }, variable: { name: 'name', type: 'text', defaultValue: 'Bob' } };
  const save = { command: 'click', params: { selector: '#save' }, locators: [{ type: 'text', value: 'Save' }] };
  assert.equal(variabilizeSuggestion([name, save], 1, new Set()), false);
  assert.equal(save.variable, undefined);
  assert.equal(variabilizeSuggestion([pickFrance(), pickFrance()], 1, new Set()), false);
});

test('a check between typing and picking does not hide the suggestion; its text is its label, not its accessible name', () => {
  // Auchan: "choco" typed, the agent checks the suggestion shows, then picks it.
  const typed = { command: 'fill', params: { selector: 'input[name="text"]', value: '{{text}}' }, variable: { name: 'text', type: 'text', defaultValue: 'choco' } };
  const shows = { command: 'assert', params: {}, assertion: { type: 'element_visible', selector: 'a[href="/recherche?text=chocolat"]' } };
  const pick = { command: 'click', params: { selector: 'a[aria-label="Suggestion de mot clé 1/2: chocolat"]' }, locators: [
    { type: 'aria', value: 'Suggestion de mot clé  1/2: chocolat' }, { type: 'text', value: 'chocolat' }, { type: 'css', value: 'a[aria-label="…"]' },
  ] };
  const steps = [typed, shows, pick];
  assert.equal(typedJustBefore(steps, 2), true);
  assert.equal(variabilizeSuggestion(steps, 2, new Set(['text'])), true);
  assert.equal(pick.variable.name, 'text_choice');
  assert.equal(pick.variable.defaultValue, 'chocolat', 'not "Suggestion de mot clé 1/2: chocolat"');
  assert.deepEqual(pick.locators, [{ type: 'text', value: '{{text_choice}}' }]);
});

// Auchan's suggestion link, as a click on it records it.
const auchanPick = [
  { type: 'aria', value: 'Suggestion de mot clé  1/2: chocolat' },
  { type: 'attribute', value: 'a[aria-label="Suggestion\\ de\\ mot\\ clé\\ \\ 1\\/2\\:\\ chocolat"]' },
  { type: 'text', value: 'chocolat' },
  { type: 'xpath', value: '//header//a[3]' },
];

test('a suggestion is found by an attribute ending with its text, then by its text — never by its place', () => {
  assert.deepEqual(suggestionLocators(auchanPick, 'chocolat', '{{text_choice}}'), [
    { type: 'css', value: 'a[aria-label$=": {{text_choice}}" i]' },
  ], 'the position "1/2" changes with the value: only the end is kept, whatever its case; the text alone is not');
  // Walmart: "Bananas" given, "bananas" suggested under a heading "Bananas Selections".
  assert.deepEqual(suggestionLocators([{ type: 'css', value: 'a[aria-label="laptop computers"]' }, { type: 'aria', value: 'laptop computers' }, { type: 'text', value: 'laptop computers' }], 'laptop computers', '{{search_choice}}'), [
    { type: 'css', value: 'a[aria-label$="{{search_choice}}" i]' },
    { type: 'aria', value: '{{search_choice}}' },
  ], 'its text alone found the heading, and the click went there');
  assert.deepEqual(suggestionLocators([{ type: 'css', value: 'a[href="/recherche?text=chocolaterie"]' }], 'chocolat', '{{v}}'), [{ type: 'text', value: '{{v}}' }], 'never a piece of a word');
});

test('a step redone by hand keeps its variable: the suggestion it picks, what it types', () => {
  const pick = { command: 'click', variable: { name: 'text_choice', type: 'text', defaultValue: 'chocolat', suggestionOf: 'text' } };
  assert.deepEqual(keepStepVariable(pick, { command: 'click', params: { selector: 'a[aria-label="…"]' }, locators: auchanPick, intent: 'Choisir chocolat' }), {
    command: 'click', params: { text: '{{text_choice}}' }, intent: 'Choisir chocolat',
    locators: [{ type: 'css', value: 'a[aria-label$=": {{text_choice}}" i]' }],
  });
  const typed = { command: 'fill', variable: { name: 'text', type: 'text', defaultValue: 'choco' } };
  assert.equal(keepStepVariable(typed, { command: 'fill', params: { selector: '#q', value: 'choco' } }).params.value, '{{text}}');
  assert.equal(keepStepVariable(typed, { command: 'fill', params: { selector: '#q', value: 'autre' } }).params.value, 'autre', 'another value typed on purpose stays');
  assert.equal(keepStepVariable({ command: 'click' }, { command: 'click', params: { selector: '#x' } }).params.selector, '#x');
});

test('the agent is told of a click found in a list — not of a menu, a suggestion or a value kept fixed', () => {
  const CARD = { type: 'list', parentSelector: '#results', itemXpath: './article', withinXpath: './footer/button[2]', totalItems: 8, selectedIndex: 1, itemTexts: ['Whole milk 1L 1,15 €', 'Semi-skimmed milk 6x1L 6,42 €'] };
  const steps = [
    { command: 'navigate', params: {} },
    { command: 'click', params: {}, _listContext: CARD },
    { command: 'click', params: {}, _listContext: { ...CARD, withinXpath: './footer/button[3]' } },
  ];
  assert.match(listNote(steps, 1, 'act_2'), /^List: taken as item 2 of 8 of a list \("Whole milk 1L 1,15 €", "Semi-skimmed milk 6x1L 6,42 €", …\) — this element of that item\./);
  assert.match(listNote(steps, 2, 'act_3'), /the same item as step 2: it shares its variable/);
  assert.equal(sameItemStep(steps, 2, steps[2]._listContext), 2);
  assert.match(listNote(steps, 1, 'act_2', { correct: (pick) => `pick_list_item({ pick: "${pick}" })` }), /pick_list_item\(\{ pick: "none" \}\)/);
  // Not told: a menu, a suggestion picked right after typing, a value kept fixed, a click in no list.
  const MENU = { type: 'list', parentSelector: 'nav > ul', itemXpath: 'li/a', totalItems: 6, selectedIndex: 1, itemTexts: ['Home', 'Garden'], navigation: 'nav' };
  assert.equal(listNote([{ command: 'click', _listContext: MENU }], 0, 'a'), null);
  // Cards the page draws in a <nav> are told: not a menu.
  assert.match(listNote([{ command: 'click', _listContext: { ...CARD, navigation: 'nav' } }], 0, 'a'), /^List: taken as item 2 of 8/);
  assert.equal(listNote([{ command: 'fill', params: { value: 'Fr' } }, { command: 'click', _listContext: CARD }], 1, 'a'), null);
  assert.equal(listNote([{ command: 'click', _listContext: CARD, _skipVariable: true }], 0, 'a'), null);
  assert.equal(listNote([{ command: 'click', _listContext: null }], 0, 'a'), null);
});
