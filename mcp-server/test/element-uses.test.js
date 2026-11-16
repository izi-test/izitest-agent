// Unit tests for an element shared by the tests of a project (lib/elements.js, lib/element-store.js,
// lib/repairs.js): the same field recorded differently — by its selector in one test, by its
// label in another, checked by its placeholder in a third — is one element, under the name the
// user gave it; two buttons that share an id but read differently, or the radios of a group,
// stay apart. Fixed in one step — a repair applied, a step edited —, the element is fixed in the
// others that act on it on the user's word: each keeps what it does, and the element its name.
// On a database of their own, thrown away after.
// Run with: node --test test/element-uses.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'element-uses-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { marksOf, foundLike, findsDifferently } = await import('../lib/elements.js');
const { withElementNames, listElements, renameElement, usesOfStep, relocateElement, elementTargets } = await import('../lib/element-store.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { saveRepairs, getRepair, applyRepair, repairUses, describeRepair } = await import('../lib/repairs.js');
const { relocatedStep } = await import('../lib/triage.js');

const PAGE = 'arena.test/form.html';
const projectNamed = (name) => db.prepare('INSERT INTO projects (name) VALUES (?) RETURNING id').get(name).id;

/** Saves `steps` as test `name` of `project`; the test as the dashboard loads it. */
function saved(name, project, steps) {
  saveTest({ name, variables: {}, steps });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
  return loadTest(name);
}

// The country field of Test Arena, as three recordings saw it.
const typedBySelector = (value = '{{country_input}}') => ({ command: 'fill', params: { selector: '#country-input', value }, page: PAGE });
const typedWithLocators = (value = '{{country}}') => ({
  command: 'fill',
  params: { selector: '#country-input', value },
  locators: [
    { type: 'css', value: '#country-input' },
    { type: 'aria', value: 'Start typing...' },
    { type: 'attribute', value: 'input[name="country"]' },
    { type: 'placeholder', value: 'Start typing...' },
    { type: 'attribute', value: 'input[placeholder="Start\\ typing\\.\\.\\."]' },
    { type: 'xpath', value: '//*[@id="country-input"]' },
  ],
  page: PAGE,
});
const checked = (selector, expected) => ({
  command: 'assert', params: {}, assertion: { type: 'attribute_equals', selector, attribute: 'value', expected }, page: PAGE,
});
const clickOn = (name, selector, extra = {}) => ({
  command: 'click', params: { selector }, locators: [{ type: 'css', value: selector }, { type: 'role', value: 'button', name }], page: PAGE, ...extra,
});

test('what tells an element apart for sure: its id, its test ID; a field\'s name and placeholder', () => {
  assert.deepEqual(marksOf(typedBySelector()), [`${PAGE} ~id=country-input`]);
  assert.deepEqual(marksOf(typedWithLocators()).sort(), [
    `${PAGE} ~id=country-input`, `${PAGE} ~name=country`, `${PAGE} ~placeholder=Start typing...`,
  ], 'from the selector, the CSS and attribute locators, the xpath; escapes undone');
  assert.deepEqual(marksOf(checked('input[placeholder="Start typing..."]', 'France')), [`${PAGE} ~placeholder=Start typing...`],
    'a field read by its placeholder');
  assert.deepEqual(marksOf({ ...clickOn('Save', 'button.save'), locators: [{ type: 'testid', value: '[data-testid="save"]' }, { type: 'role', value: 'button', name: 'Save' }] }),
    [`${PAGE} ~testid=save`]);

  const radio = { command: 'click', params: { selector: 'input[name="color"]' }, locators: [{ type: 'attribute', value: 'input[name="color"]' }, { type: 'role', value: 'radio', name: 'Red' }], page: PAGE };
  assert.deepEqual(marksOf(radio), [], 'a click gives no name: a radio\'s is its whole group\'s');
  const inRow = clickOn('Delete', '#delete');
  inRow.locators[1] = { type: 'role', value: 'button', name: 'Delete', scope: { testid: 'note-3' } };
  assert.deepEqual(marksOf(inRow), [], 'one of several, told apart by its container');
  assert.deepEqual(marksOf(clickOn('Go', '#btn-48213977')), [], 'a generated id');
  assert.deepEqual(marksOf({ ...typedBySelector(), page: undefined }), [], 'no page, no element');
});

test('the same field recorded three ways is one element, under the name the user gave it', () => {
  const project = projectNamed('Arena');
  const first = saved('Country picked among suggestions', project, [typedBySelector(), checked('#country-input', '{{country}}')]);
  assert.equal(withElementNames(first).steps[0].element, 'Country input', 'named in words drawn from its selector, never the selector');
  const [element] = listElements(project);
  assert.deepEqual(renameElement(element.id, 'Country'), { name: 'Country' });

  saved('Country picked among the list', project, [typedWithLocators(), checked('input[placeholder="Start typing..."]', '{{country_choice}}')]);
  const elements = listElements(project);
  assert.equal(elements.length, 1, 'by its id, its name, its placeholder: one element');
  const [country] = elements;
  assert.equal(country.name, 'Country', 'the name the user gave it is kept');
  assert.equal(country.id, element.id);
  assert.deepEqual(country.also, ['css input[placeholder="Start typing..."]', 'field "Start typing..."']);
  assert.deepEqual(country.used_by, [
    { test: 'Country picked among suggestions', steps: [1, 2] },
    { test: 'Country picked among the list', steps: [1, 2] },
  ]);
  assert.deepEqual(withElementNames(loadTest('Country picked among the list')).steps.map((s) => s.element), ['Country', 'Country']);
  assert.ok(elementTargets(project).has('Country'));
});

test('merged, an element not renamed keeps the name a person reads on it', () => {
  const project = projectNamed('Unnamed');
  saved('by selector', project, [typedBySelector()]);
  saved('by label', project, [typedWithLocators()]);
  assert.deepEqual(listElements(project).map((e) => [e.name, e.target]), [['Start typing...', 'field "Start typing..."']]);
});

test('two buttons that share an id but read differently stay two; so do the radios of a group', () => {
  const project = projectNamed('Wizard');
  saved('wizard', project, [clickOn('Next', '#wizard-next'), clickOn('Finish', '#wizard-next'), clickOn('Next', '#wizard-next')]);
  assert.deepEqual(listElements(project).map((e) => e.name), ['Finish', 'Next']);

  const radio = (name) => ({ command: 'click', params: { selector: `#color-${name.toLowerCase()}` }, locators: [{ type: 'attribute', value: 'input[name="color"]' }, { type: 'role', value: 'radio', name }], page: PAGE });
  saved('colors', project, [radio('Red'), radio('Blue')]);
  assert.deepEqual(listElements(project).map((e) => e.name), ['Blue', 'Finish', 'Next', 'Red']);
});

test('a step found like another keeps what it does', () => {
  const source = { ...typedWithLocators(), params: { selector: '#country', value: '{{x}}' }, locators: [{ type: 'css', value: '#country' }] };
  const fill = foundLike(typedBySelector('{{country_input}}'), source);
  assert.deepEqual(fill.params, { selector: '#country', value: '{{country_input}}' });
  assert.deepEqual(fill.locators, [{ type: 'css', value: '#country' }]);
  const check = foundLike(checked('#country-input', 'France'), source);
  assert.deepEqual(check.assertion, { type: 'attribute_equals', selector: '#country', attribute: 'value', expected: 'France' });

  const byAssertion = foundLike(typedWithLocators(), checked('#country', 'France'));
  assert.deepEqual(byAssertion.locators, [{ type: 'css', value: '#country' }], 'an assertion has no locators: the selector alone');
  assert.equal(findsDifferently(typedBySelector(), typedBySelector('other value')), false);
  assert.equal(findsDifferently(typedBySelector(), source), true);
});

/** The two country tests of a project of their own, and a repair of the first one's field: its id changed. */
function countryTests(name) {
  const project = projectNamed(name);
  const a = saved(`${name}: suggestions`, project, [
    { command: 'navigate', params: { url: `https://${PAGE}` } }, typedBySelector(), checked('#country-input', '{{country}}'),
  ]);
  saved(`${name}: list`, project, [typedWithLocators(), checked('input[placeholder="Start typing..."]', '{{country_choice}}')]);
  listElements(project);
  const candidate = { selector: '#country', name: 'Start typing...', role: 'textbox', locators: [{ type: 'css', value: '#country' }, { type: 'placeholder', value: 'Start typing...' }] };
  const [id] = saveRepairs(a.name, null, {
    cause: 'test_drift',
    proposals: [{ kind: 'relocate', step_order: 2, summary: 'Find the field at #country', change: { op: 'replace', step_order: 2, step: relocatedStep(a.steps[1], candidate) } }],
  }, {}, a);
  return { project, repair: getRepair(id) };
}

test('a repair says which other steps act on its element; applied to all, it fixes them, each keeping what it does', () => {
  const { project, repair } = countryTests('All');
  const shared = repairUses(repair);
  assert.equal(shared.element.name, 'Start typing...');
  assert.deepEqual(shared.uses.map((u) => [u.test, u.step_order]), [['All: list', 1], ['All: list', 2], ['All: suggestions', 3]]);
  assert.equal(shared.tests, 2);
  assert.match(describeRepair(repair), /also acted on by 3 other steps in 2 tests \("All: list" steps 1, 2; "All: suggestions" step 3\): with all_uses=true/);

  // Another run of the second test proposed its own repair: superseded by this one.
  const list = loadTest('All: list');
  const [theirs] = saveRepairs('All: list', null, { cause: 'test_drift', proposals: [{ kind: 'relocate', step_order: 1, summary: 'x', change: { op: 'replace', step_order: 1, step: { ...list.steps[0], params: { ...list.steps[0].params, selector: '#elsewhere' } } } }] }, {}, list);

  const applied = applyRepair(repair.id, { allUses: true });
  assert.deepEqual(applied.relocated, [{ test: 'All: list', step_order: 1 }, { test: 'All: list', step_order: 2 }, { test: 'All: suggestions', step_order: 3 }]);
  const [, fill, check] = loadTest('All: suggestions').steps;
  assert.equal(fill.params.selector, '#country');
  assert.equal(check.assertion.selector, '#country');
  assert.equal(check.assertion.expected, '{{country}}');
  const [otherFill, otherCheck] = loadTest('All: list').steps;
  assert.deepEqual(otherFill.params, { selector: '#country', value: '{{country}}' }, 'its own value');
  assert.deepEqual(otherFill.locators, fill.locators);
  assert.deepEqual(otherCheck.assertion, { type: 'attribute_equals', selector: '#country', attribute: 'value', expected: '{{country_choice}}' });
  assert.equal(getRepair(theirs).status, 'superseded');

  const elements = listElements(project);
  assert.equal(elements.length, 1, 'still one element');
  assert.equal(elements[0].name, 'Start typing...', 'under its name');
  assert.equal(repairUses(getRepair(repair.id)), null, 'none left to fix');
});

test('applied to its step alone, the element keeps its name; applied again to all, the others follow', () => {
  const { project, repair } = countryTests('One');
  const applied = applyRepair(repair.id);
  assert.deepEqual(applied.relocated, []);
  assert.equal(loadTest('One: list').steps[0].params.selector, '#country-input', 'the others are as they were');
  assert.deepEqual(listElements(project).map((e) => e.name), ['Start typing...'], 'the repaired step acts on the same element');

  assert.match(describeRepair(getRepair(repair.id)), /3 other steps in 2 tests still find its element "Start typing\.\.\." the old way .*all_uses=true/);
  const again = applyRepair(repair.id, { allUses: true });
  assert.equal(again.relocated.length, 3);
  assert.equal(loadTest('One: list').steps[0].params.selector, '#country');
  assert.throws(() => applyRepair(repair.id), /is applied/);
});

test('a step edited: its uses are listed; its new locators go to them only when asked', () => {
  const { project } = countryTests('Edit');
  const before = loadTest('Edit: list').steps[0];
  const uses = usesOfStep(project, before, { test: 'Edit: list', order: 1 });
  assert.deepEqual([uses.element.name, uses.uses.length, uses.tests], ['Start typing...', 3, 2]);

  const after = { ...before, params: { ...before.params, selector: '[data-testid="country"]' }, locators: [{ type: 'testid', value: '[data-testid="country"]' }] };
  db.prepare("UPDATE test_steps SET params = ?, locators = ? WHERE step_order = 1 AND test_id = (SELECT id FROM tests WHERE name = 'Edit: list')")
    .run(JSON.stringify(after.params), JSON.stringify(after.locators));
  const alone = relocateElement(project, { test: 'Edit: list', order: 1, before, after });
  assert.deepEqual(alone.relocated, []);
  assert.equal(loadTest('Edit: suggestions').steps[1].params.selector, '#country-input');

  const all = relocateElement(project, { test: 'Edit: list', order: 1, before, after, allUses: true });
  assert.deepEqual(all.relocated.map((r) => [r.test, r.step_order]), [['Edit: list', 2], ['Edit: suggestions', 2], ['Edit: suggestions', 3]]);
  assert.equal(loadTest('Edit: suggestions').steps[1].params.selector, '[data-testid="country"]');
  assert.deepEqual(listElements(project).map((e) => [e.name, e.used_by.reduce((n, u) => n + u.steps.length, 0)]), [['Start typing...', 4]]);
});

test('a suggestion found anew in one test is found so in another, under that test\'s own variable', () => {
  const page = '127.0.0.1:8777/izitest-test.html';
  const field = { field: 'css #country-input', fieldName: 'Start typing...' };
  const suggestion = (name) => ({ command: 'click', page, params: { text: `{{${name}}}` }, locators: [{ type: 'text', value: `{{${name}}}` }], variable: { name, type: 'text', defaultValue: 'France', suggestionOf: 'country_input', ...field } });
  // Fixed in "Country picked among suggestions": now found inside the list.
  const fixed = { ...suggestion('country'), params: { selector: '#country-list', text: '{{country}}' }, locators: [{ type: 'css', value: '#country-list' }, { type: 'text', value: '{{country}}' }] };
  const other = foundLike(suggestion('country_choice'), fixed);
  assert.deepEqual(other.locators, [{ type: 'css', value: '#country-list' }, { type: 'text', value: '{{country_choice}}' }], 'its own variable, not {{country}}, which it does not have');
  assert.equal(other.params.text, '{{country_choice}}');
  assert.equal(other.params.selector, '#country-list');
});
