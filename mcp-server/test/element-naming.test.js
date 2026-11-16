// Unit tests for a Gherkin that reads like the application, not like its selectors: an element
// nothing on the page names is named in words drawn from its selector, then by the agent from
// what the tests do with it (lib/element-naming.js) — each name its own in the project,
// whatever its case, one already taken elsewhere told apart —, never over a name the user gave;
// and a wait of a time only is no phrase of the Gherkin, kept with the phrase before it when the
// feature is saved (lib/gherkin/serialize.js, reconcile.js). The agent is a stand-in. On a
// database of their own, thrown away after.
// Run with: node --test test/element-naming.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'element-naming-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { readableSelector, words, baseName } = await import('../lib/elements.js');
const { withElementNames, listElements, renameElement, elementsToName, registerElements } = await import('../lib/element-store.js');
const { nameElements, nameElementsLater, setElementNamer, namingBrief, parseNames } = await import('../lib/element-naming.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { serializeTestToFeatureWith, scenarioPhrases } = await import('../lib/gherkin/serialize.js');
const { stepsForEditedFeature } = await import('../lib/gherkin/reconcile.js');
const { generatePlaywrightCucumber } = await import('../lib/codegen/playwright-cucumber.js');
const { DEFAULT_STEP_DEFINITIONS } = await import('../lib/gherkin/default-step-definitions.js');

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const projectNamed = (name, language = 'en') => db.prepare('INSERT INTO projects (name, language) VALUES (?, ?) RETURNING id').get(name, language).id;
const SHOP = 'shop.test/cart';
const ADMIN = 'shop.test/admin';

function saved(name, project, steps) {
  saveTest({ name, variables: {}, steps });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
  return loadTest(name);
}
const clickCss = (selector, page, extra = {}) => ({ command: 'click', params: { selector }, locators: [{ type: 'css', value: selector }], page, ...extra });
const check = (selector, expected, page, intent) => ({ command: 'assert', params: {}, assertion: { type: 'text_contains', selector, expected }, page, ...(intent && { intent }) });
const time = (ms) => ({ command: 'wait', params: { ms } });

/** The agent, stood in for: answers `names` (id → name) for what it is asked; keeps what it read. */
function agentNaming(namesFor) {
  const asked = [];
  const complete = async ({ system, prompt }) => {
    asked.push({ system, prompt });
    const ids = [...prompt.matchAll(/^- id (\d+),/gm)].map((m) => Number(m[1]));
    return JSON.stringify({ names: ids.map((id) => ({ id, name: namesFor(id, prompt) })).filter((n) => n.name) });
  };
  return { complete, asked };
}

test('a name in words, drawn from the part of the selector that picks the element — never the selector', () => {
  assert.equal(readableSelector('#shop-cart-total'), 'Shop cart total');
  assert.equal(readableSelector('[data-testid=flash-message]'), 'Flash message');
  assert.equal(readableSelector('button[aria-label="Empty the cart"]'), 'Empty the cart', 'an aria-label as written');
  assert.equal(readableSelector('#shop-results > article.product-card:nth-of-type(2) .product-card__price'), 'Product card price');
  assert.equal(readableSelector('tr[data-testid=note-row][data-description="{{description}}"] [data-testid=note-submit]'), 'Note submit');
  assert.equal(readableSelector('input[name="j_username"]'), 'Username', 'a letter alone says nothing');
  assert.equal(readableSelector('main h2'), 'Heading');
  assert.equal(readableSelector('div > span'), null);
  assert.equal(words('flashMessage'), 'Flash message');

  assert.equal(baseName(clickCss('#cookie-banner-accept', SHOP, { locators: [{ type: 'css', value: '#cookie-banner-accept' }, { type: 'text', value: 'Accept all cookies' }] })), 'Accept all cookies', 'the text of what is clicked');
  assert.equal(baseName(clickCss('#total', SHOP, { locators: [{ type: 'text', value: '19,47 €' }] })), 'Total', 'a price is no name');
  assert.equal(baseName(clickCss('div > span', SHOP)), 'div > span', 'the selector when nothing else says anything');
});

test('the elements to name: found by a selector alone, or with a page added — not those the user named', () => {
  const project = projectNamed('Shop');
  saved('cart total', project, [
    { command: 'click', params: { selector: '#save' }, locators: [{ type: 'role', value: 'button', name: 'Save' }], page: SHOP },
    { command: 'click', params: { selector: '#save-admin' }, locators: [{ type: 'role', value: 'button', name: 'Save' }], page: ADMIN },
    check('#shop-cart-total', '6,42', SHOP, 'Check the cart total is 3 × the price'),
    clickCss('#empty', SHOP, { intent: 'Empty the cart' }),
  ]);
  const names = listElements(project).map((e) => e.name).sort();
  assert.deepEqual(names, ['Empty', 'Save', 'Save (admin)', 'Shop cart total']);
  const { elements, taken } = elementsToName(project);
  assert.deepEqual(elements.map((e) => e.name).sort(), ['Empty', 'Save (admin)', 'Shop cart total'], 'a page added to tell two apart: to name too');
  const total = elements.find((e) => e.name === 'Shop cart total');
  assert.deepEqual(total.uses, [{ test: 'cart total', command: 'assert', intent: 'Check the cart total is 3 × the price', assertion: { type: 'text_contains', selector: '#shop-cart-total', expected: '6,42' } }]);
  assert.deepEqual(taken, [{ name: 'Save', page: SHOP }]);

  renameElement(listElements(project).find((e) => e.name === 'Empty').id, 'Vider le panier');
  assert.equal(elementsToName(project).elements.some((e) => e.name === 'Vider le panier'), false, 'a name the user gave stays');
});

test('the agent names them from what the tests do, in the project\'s language, each name its own whatever its case', async () => {
  const project = projectNamed('Boutique', 'fr');
  saved('panier', project, [
    { command: 'click', params: { selector: '#go' }, locators: [{ type: 'role', value: 'button', name: 'Rechercher' }], page: ADMIN, intent: 'Search a user' },
    clickCss('.search-btn', SHOP, { intent: 'Search a product' }),
    check('#shop-cart-total', '6,42', SHOP, 'Check the cart total'),
    check('#flash', 'Saved', SHOP, 'Check the message'),
    check('#weird', 'x', SHOP),
  ]);
  const byTarget = Object.fromEntries(elementsToName(project).elements.map((e) => [e.target, e.id]));
  const { complete, asked } = agentNaming((id) => ({
    [byTarget['css .search-btn']]: 'rechercher', // another element's name, another case: told apart
    [byTarget['css #shop-cart-total']]: 'Total du panier',
    [byTarget['css #flash']]: '#flash', // a selector is no name
  })[id]);

  const { changed, left } = await nameElements(project, { complete });
  const prompt = asked[0].prompt;
  assert.match(prompt, /its tests written in French/);
  assert.match(prompt, /- "Rechercher" \(shop\.test\/admin\)/, 'the names taken, with their page');
  assert.match(prompt, /checked: text_contains "6,42" — "Check the cart total"/);
  assert.match(prompt, /never the same name with a number/);
  assert.deepEqual(changed.map((c) => c.to).sort(), ['Total du panier', 'rechercher (cart)']);
  assert.equal(left, 2, '#flash and #weird: no name given, left as they were');
  const names = listElements(project).map((e) => e.name);
  assert.ok(names.includes('Flash') && names.includes('Weird'));

  // Named by the agent: not asked again, and kept when a later step reads a label on it.
  assert.deepEqual(elementsToName(project).elements.map((e) => e.target).sort(), ['css #flash', 'css #weird']);
  registerElements(project, [{ command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#shop-cart-total', expected: '1' }, page: SHOP, locators: [{ type: 'aria', value: 'Cart total' }] }]);
  assert.ok(listElements(project).some((e) => e.name === 'Total du panier'));
});

test('a name another element has, whatever its case, is refused to the user too', () => {
  const project = projectNamed('Rename');
  saved('two saves', project, [clickCss('#a', SHOP), clickCss('#b', ADMIN)]);
  const [a, b] = listElements(project).sort((x, y) => x.id - y.id);
  assert.deepEqual(renameElement(a.id, 'Save'), { name: 'Save' });
  const refused = renameElement(b.id, 'SAVE');
  assert.equal(refused.status, 409);
  assert.match(refused.error, /Another element of this project is named "Save" \(shop\.test\/cart\): give this one a name that tells them apart/);
});

test('the agent\'s answer: only names, for the elements asked', () => {
  const elements = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const answer = '```json\n{ "names": [{ "id": 1, "name": " « Total du panier » " }, { "id": 2, "name": "search-form" }, { "id": 3, "name": "E-mail" }, { "id": 4, "name": "[data-x]" }, { "id": 9, "name": "Other" }] }\n```';
  assert.deepEqual(parseNames(answer, elements), [{ id: 1, name: 'Total du panier' }, { id: 3, name: 'E-mail' }]);
  assert.throws(() => parseNames('Sorry', elements), /did not answer with names/);
  assert.match(namingBrief({ project: 'P', language: 'en', elements: [], taken: [] }), /\(none\)/);
});

test('once a test is saved, its elements are named in the background — only with an agent, only its own', async () => {
  const project = projectNamed('Later');
  saved('later', project, [check('#later-total', '1', SHOP, 'Check the total')]);
  saved('other', project, [check('#other-total', '1', SHOP, 'Check another total')]);
  registerElements(project, [...loadTest('later').steps, ...loadTest('other').steps]);
  setElementNamer(null);
  nameElementsLater('later');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(listElements(project).every((e) => !e.name.startsWith('Total')), 'no agent: nothing');

  const { complete, asked } = agentNaming(() => 'Total');
  setElementNamer(complete);
  nameElementsLater('later');
  for (let i = 0; i < 50 && !listElements(project).some((e) => e.name === 'Total'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(listElements(project).map((e) => e.name).sort(), ['Other total', 'Total']);
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0].prompt, /other-total/, 'only the elements the saved test acts on');
  setElementNamer(null);
});

test('a wait of a time only is no phrase: it goes with the phrase before it, and a saved feature keeps it', () => {
  const project = projectNamed('Waits');
  const t = withElementNames(saved('waits', project, [
    time(1000),
    { command: 'navigate', params: { url: 'https://shop.test/cart' } },
    clickCss('#empty', SHOP),
    time(4000),
    check('#count', '0', SHOP),
  ]));
  const phrases = scenarioPhrases(t, DEFAULTS);
  assert.deepEqual(phrases.map((p) => p.steps.map((s) => s.command)), [['wait', 'navigate'], ['click', 'wait'], ['assert']]);
  const feature = serializeTestToFeatureWith(t, DEFAULTS);
  assert.doesNotMatch(feature, /I wait|seconds/i);
  assert.match(feature, /When I click on "Empty"\n/);

  // Saved as it is: every step back, the waits too.
  assert.deepEqual(stepsForEditedFeature(feature, DEFAULTS, t).map((s) => s.command), ['wait', 'navigate', 'click', 'wait', 'assert']);
  // A phrase reworded keeps the waits that went with it, where they were.
  const reworded = stepsForEditedFeature(feature.replace('When I click on "Empty"', 'When I click on "#clear"'), DEFAULTS, t);
  assert.deepEqual(reworded.map((s) => [s.command, s.params?.ms ?? s.params?.selector ?? null]),
    [['wait', 1000], ['navigate', null], ['click', '#clear'], ['wait', 4000], ['assert', null]]);
  // A phrase taken out takes its waits with it.
  assert.deepEqual(stepsForEditedFeature(feature.replace(/ {4}When I click on "Empty"\n/, ''), DEFAULTS, t).map((s) => s.command), ['wait', 'navigate', 'assert']);

  // The Cucumber export plays its phrases: the waits are in it.
  const exported = generatePlaywrightCucumber(t, DEFAULTS).files.find((f) => f.path.endsWith('.feature')).content;
  assert.match(exported, /I wait 4 seconds|wait 4000/);
  // A test of waits only: they are its phrases.
  assert.equal(scenarioPhrases({ steps: [time(1000)] }, DEFAULTS).length, 1);
});

test('a wait for an element is a phrase that names it, read back as the element', () => {
  const project = projectNamed('Wait for');
  const t = withElementNames(saved('wait for', project, [
    { command: 'navigate', params: { url: 'https://shop.test/cart' } },
    { command: 'wait', params: { selector: '#shop-results .btn--more' }, page: SHOP },
  ]));
  const feature = serializeTestToFeatureWith(t, DEFAULTS);
  assert.match(feature, /When I wait for "Btn more"\n/, 'its last class in words, not the selector');
  const [, wait] = stepsForEditedFeature(feature.replace('Given I am on', 'Given I am on'), DEFAULTS, t);
  assert.equal(wait.params.selector, '#shop-results .btn--more');
});
