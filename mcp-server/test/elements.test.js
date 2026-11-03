// Unit tests for the elements of a project (lib/elements.js, lib/element-store.js): a step
// keeps the page it was done on, and what it acts on is known by an exact key — page, role,
// name, container —, never by resemblance. Two "Save" buttons of two pages are two elements,
// even with the same selector; the same "Save" recorded by two tests is one. The dashboard's
// Gherkin names an element instead of giving its selector, and reads the name back; a business
// step built on one page is not taken for the same clicks on another. A run gives their page
// to the steps recorded before steps kept it. An assertion checks an element too. The agent
// writing Gherkin is told the names. On a database of their own, thrown away after.
// Run with: node --test test/elements.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'elements-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { pageOf, elementKey } = await import('../lib/elements.js');
const { withElementNames, elementTargets, listElements, renameElement, deleteElement, elementLines } = await import('../lib/element-store.js');
const { evaluateAssertion } = await import('../lib/test-execute.js');
const { designBrief } = await import('../lib/requirement-design.js');
const { seedProjectStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { saveTest, loadTest, fillStepPages } = await import('../lib/test-store.js');
const { recordAction } = await import('../lib/recording.js');
const { Session } = await import('../lib/session.js');
const { serializeTestToFeatureWith } = await import('../lib/gherkin/serialize.js');
const { stepsForEditedFeature } = await import('../lib/gherkin/reconcile.js');
const { parseFeatureToStepsWith } = await import('../lib/gherkin/parse.js');
const { buildBusinessStep } = await import('../lib/gherkin/business-step.js');
const { DEFAULT_STEP_DEFINITIONS } = await import('../lib/gherkin/default-step-definitions.js');

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const projectNamed = (name) => db.prepare('INSERT INTO projects (name) VALUES (?) RETURNING id').get(name).id;

/** A click on a button Chrome names `name`, at `selector`, on `page`. */
const clickOn = (name, selector, page, extra = {}) => ({
  command: 'click',
  params: { selector },
  locators: [{ type: 'aria', value: name }, { type: 'css', value: selector }, { type: 'role', value: 'button', name }],
  ...(page && { page }),
  ...extra,
});
const fillIn = (label, selector, value, page) => ({
  command: 'fill',
  params: { selector, value },
  locators: [{ type: 'css', value: selector }, { type: 'aria', value: label }],
  page,
});

/** Saves `steps` as test `name` of `project`; the test as the dashboard loads it. */
function saved(name, project, steps) {
  saveTest({ name, variables: {}, steps });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
  return loadTest(name);
}

test('a page is its host and path: no query, no fragment, its ids starred, a hash route kept', () => {
  assert.equal(pageOf('https://Notes.test/notes/42/edit?tab=2#top'), 'notes.test/notes/*/edit');
  assert.equal(pageOf('http://localhost:5180/'), 'localhost:5180/');
  assert.equal(pageOf('https://shop.test/p/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'shop.test/p/*');
  assert.equal(pageOf('https://www.bienici.com/recherche/achat/antony-92160/maison'), 'www.bienici.com/recherche/achat/*/maison',
    'a slug with an id is starred: the search of another city is the same page');
  assert.equal(pageOf('https://app.test/#/notes/7'), 'app.test/notes/*');
  assert.equal(pageOf('about:blank'), null);
  assert.equal(pageOf(undefined), null);
});

test('an element is known by its page, then its role and name, with its container when the page has several', () => {
  const page = 'notes.test/notes/*';
  assert.equal(elementKey(clickOn('Save', 'button.save', page)), 'notes.test/notes/* button "Save"');
  const inCard = clickOn('Delete', 'button.delete', page);
  inCard.locators[2] = { type: 'role', value: 'button', name: 'Delete', scope: { testid: 'note-3' } };
  assert.equal(elementKey(inCard), 'notes.test/notes/* button "Delete" in testid "note-3"');
  assert.equal(elementKey(fillIn('E-mail', '#email', 'bob@corp', 'shop.test/login')), 'shop.test/login field "E-mail"');
  assert.equal(elementKey({ command: 'click', params: { selector: '#search' }, page }), 'notes.test/notes/* css #search');

  assert.equal(elementKey(clickOn('Save', 'button.save')), null, 'no page, no element');
  assert.equal(elementKey({ command: 'click', params: { selector: 'ul > li:nth-of-type(3)' }, page }), null, 'a position alone tells nothing');
  assert.equal(elementKey({ command: 'navigate', params: { url: 'https://notes.test' }, page }), null);
  assert.equal(elementKey({ ...clickOn('Paris', 'li.city'), page, variable: { name: 'city', listContext: {} } }), null,
    'an item a variable picks is not one element');
});

test('the "Save" of two pages are two elements, even with the same selector; the same "Save" in two tests is one', () => {
  const project = projectNamed('Notes');
  const notes = saved('edit a note', project, [clickOn('Save', '#form button', 'notes.test/notes/*')]);
  const profile = saved('edit the profile', project, [clickOn('Save', '#form button', 'notes.test/profile')]);
  const again = saved('edit a note again', project, [clickOn('Save', 'form > button:nth-of-type(1)', 'notes.test/notes/*')]);

  assert.equal(withElementNames(notes).steps[0].element, 'Save');
  assert.equal(withElementNames(profile).steps[0].element, 'Save (profile)', 'its name says its page');
  assert.equal(withElementNames(again).steps[0].element, 'Save', 'another recording of the same button');

  const elements = listElements(project);
  assert.deepEqual(elements.map((e) => [e.name, e.page, e.target]), [
    ['Save', 'notes.test/notes/*', 'button "Save"'],
    ['Save (profile)', 'notes.test/profile', 'button "Save"'],
  ]);
  assert.deepEqual(elements[0].used_by, [{ test: 'edit a note', steps: [1] }, { test: 'edit a note again', steps: [1] }]);
});

test('the Gherkin names the element, and reads its name back as the element', () => {
  const project = projectNamed('Shop');
  const recorded = saved('sign in', project, [
    { command: 'navigate', params: { url: 'https://shop.test/login' } },
    fillIn('E-mail', '#login-email', 'bob@corp', 'shop.test/login'),
    clickOn('Sign in', '#login-form > div:nth-of-type(3) > button:nth-of-type(1)', 'shop.test/login'),
  ]);
  const shown = withElementNames(recorded);
  const feature = serializeTestToFeatureWith(shown, DEFAULTS);
  assert.match(feature, /When I fill "E-mail" with "\{\{input_2\}\}"\n/, 'the value typed is a variable of the test');
  assert.match(feature, /And I click on "Sign in"\n/);
  assert.doesNotMatch(feature, /nth-of-type/, 'no selector shows');

  // Saved as it was: the very same steps.
  const targets = elementTargets(project);
  assert.deepEqual(stepsForEditedFeature(feature, DEFAULTS, shown, { targets }).map((s) => s.params.selector),
    [undefined, '#login-email', '#login-form > div:nth-of-type(3) > button:nth-of-type(1)']);

  // Another value: the field stays the element, its locators and page kept.
  const edited = stepsForEditedFeature(feature.replace('"{{input_2}}"', '"alice@corp"'), DEFAULTS, shown, { targets });
  assert.equal(edited[1].params.selector, '#login-email');
  assert.equal(edited[1].params.value, 'alice@corp');
  assert.equal(edited[1].page, 'shop.test/login');
  assert.ok(edited[1].locators?.some((l) => l.value === 'E-mail'));

  // Written by hand, in another scenario: the name is the element.
  const [, click] = parseFeatureToStepsWith(
    'Feature: x\n  Scenario: x\n    Given I am on "https://shop.test/login"\n    When I click on "Sign in"\n', DEFAULTS, { targets });
  assert.equal(click.params.selector, '#login-form > div:nth-of-type(3) > button:nth-of-type(1)');
  assert.equal(click.page, 'shop.test/login');
  assert.ok(click.locators.some((l) => l.type === 'role' && l.name === 'Sign in'));

  // A name no element has stays a selector.
  const [, raw] = parseFeatureToStepsWith('Feature: x\n  Scenario: x\n    Given I am on "https://shop.test"\n    When I click on "#buy"\n', DEFAULTS, { targets });
  assert.equal(raw.params.selector, '#buy');
  assert.equal(raw.page, undefined);
});

test('a business step built on one page is not taken for the same clicks on another page', () => {
  const recordedOn = (page) => ({
    name: `save on ${page}`,
    steps: [clickOn('Edit', '#form .edit', page), clickOn('Save', '#form button', page)],
  });
  const { steps_template } = buildBusinessStep(recordedOn('notes.test/notes/*'), { from_step: 1, to_step: 2, pattern: 'I save the note' });
  assert.equal(steps_template[1].page, 'notes.test/notes/*', 'its sub-steps keep their page');
  const saveNote = { id: 900, keyword: 'When', pattern: 'I save the note', command: 'composite', params_template: {}, steps_template, is_default: 0 };
  const reads = (t) => serializeTestToFeatureWith(t, [...DEFAULTS, saveNote]);

  assert.match(reads(recordedOn('notes.test/notes/*')), /When I save the note\n/);
  assert.doesNotMatch(reads(recordedOn('notes.test/profile')), /I save the note/, 'same selectors, another page');

  const otherSelectors = recordedOn('notes.test/notes/*');
  otherSelectors.steps[1] = clickOn('Save', 'form > div:nth-of-type(2) > button', 'notes.test/notes/*');
  assert.match(reads(otherSelectors), /When I save the note\n/, 'the same element whatever its selector');

  const before = recordedOn(undefined);
  assert.match(reads(before), /When I save the note\n/, 'steps with no page yet are matched as before');
});

test('a recorded step keeps the page its action said, once', () => {
  const session = new Session({ id: 'rec' });
  session.recording = { name: 'r', steps: [] };
  session.notePage({ success: true, pageUrl: 'https://notes.test/notes/12' });
  recordAction(session, 'click', { selector: '#save' }, null, null, 'Save');
  recordAction(session, 'keyboard', { key: 'Enter' }, null, null, 'Press Enter');
  assert.equal(session.recording.steps[0].page, 'notes.test/notes/*');
  assert.equal(session.recording.steps[1].page, undefined, 'the next action reports its own');
});

test('a run gives their page to the passing steps recorded without one', () => {
  const project = projectNamed('Old');
  saved('old test', project, [
    { command: 'navigate', params: { url: 'https://old.test' } },
    clickOn('Save', '#save'),
    clickOn('Cancel', '#cancel'),
    clickOn('Close', '#close', 'old.test/kept'),
  ]);
  const testId = db.prepare("SELECT id FROM tests WHERE name = 'old test'").get().id;
  const filled = fillStepPages(testId, [
    { step: 1, command: 'navigate', status: 'success', pageUrl: 'about:blank' },
    { step: 2, command: 'click', status: 'success', pageUrl: 'https://old.test/notes/5' },
    { step: 3, command: 'click', status: 'failed', pageUrl: 'https://old.test/notes/5' },
    { step: 4, command: 'click', status: 'success', pageUrl: 'https://old.test/elsewhere' },
  ]);
  assert.equal(filled, 1);
  assert.deepEqual(loadTest('old test').steps.map((s) => s.page), [undefined, 'old.test/notes/*', undefined, 'old.test/kept']);
});

test('an element is renamed under a name no other has, and deleted once no step acts on it', () => {
  const project = projectNamed('Rename');
  saved('one', project, [clickOn('OK', '#ok', 'r.test/a'), clickOn('OK', '#ok', 'r.test/b')]);
  const [a, b] = listElements(project);
  assert.deepEqual(renameElement(a.id, '  Confirm   order '), { name: 'Confirm order' });
  assert.equal(renameElement(b.id, 'Confirm order').status, 409);
  assert.equal(renameElement(b.id, ' ').status, 400);
  assert.equal(withElementNames(loadTest('one')).steps[0].element, 'Confirm order');

  assert.equal(deleteElement(a.id).status, 409, 'a step still acts on it');
  saved('one', project, [clickOn('OK', '#ok', 'r.test/b')]);
  assert.deepEqual(deleteElement(a.id), { deleted: true });
  assert.deepEqual(listElements(project).map((e) => e.name), ['OK (b)']);
});

/** An assertion that `selector` contains `expected`, checked on `page`. */
const containsCheck = (selector, expected, page) => ({
  command: 'assert', params: {}, assertion: { type: 'text_contains', selector, expected }, ...(page && { page }),
});

test('an assertion checks an element of its page: named in the Gherkin, read back as it', () => {
  const project = projectNamed('Checks');
  const t = saved('profile saved', project, [
    clickOn('Save profile', '#save', 'shop.test/profile'),
    containsCheck('#result-profile', 'Saved', 'shop.test/profile'),
    { command: 'assert', params: {}, assertion: { type: 'text_contains', expected: 'Saved' }, page: 'shop.test/profile' },
    { command: 'assert', params: {}, assertion: { type: 'no_console_errors', expected: 'TypeError' }, page: 'shop.test/profile' },
  ]);
  assert.equal(elementKey(t.steps[1]), 'shop.test/profile css #result-profile');
  assert.equal(elementKey(t.steps[2]), null, 'the whole page is no element');
  assert.equal(elementKey(t.steps[3]), null, 'nor what the page logs');
  assert.equal(elementKey(containsCheck('#result-profile', 'x', 'shop.test/notes')) === elementKey(t.steps[1]), false, 'another page, another element');

  const shown = withElementNames(t);
  assert.equal(shown.steps[1].element, '#result-profile');
  renameElement(listElements(project).find((e) => e.name === '#result-profile').id, 'Profile result');
  const feature = serializeTestToFeatureWith(withElementNames(t), DEFAULTS);
  assert.match(feature, /Then "Profile result" should contain "Saved"\n/);

  const targets = elementTargets(project);
  const [, check] = parseFeatureToStepsWith(
    'Feature: x\n  Scenario: x\n    Given I am on "https://shop.test/profile"\n    Then "Profile result" should contain "Done"\n', DEFAULTS, { targets });
  assert.deepEqual(check.assertion, { type: 'text_contains', selector: '#result-profile', expected: 'Done' });
  assert.equal(check.page, 'shop.test/profile');
});

test('an assertion says the page it was checked on; a run gives it to one that has none', async () => {
  const page = async (_profile, command, params) => {
    assert.equal(command, 'execute_js');
    assert.match(params.code, /pageUrl: location\.href/);
    return { result: { value: 'Saved!', pageUrl: 'https://shop.test/profile?tab=1' } };
  };
  const checked = await evaluateAssertion(page, { type: 'text_contains', selector: '#result', expected: 'Saved' });
  assert.deepEqual([checked.passed, pageOf(checked.pageUrl)], [true, 'shop.test/profile']);

  const project = projectNamed('Old checks');
  saved('old checks', project, [containsCheck('#result', 'Saved'), containsCheck('#other', 'Nope')]);
  const testId = db.prepare("SELECT id FROM tests WHERE name = 'old checks'").get().id;
  fillStepPages(testId, [
    { step: 1, command: 'assert', status: 'success', pageUrl: 'https://shop.test/profile' },
    { step: 2, command: 'assert', status: 'failed', pageUrl: 'https://shop.test/profile' },
  ]);
  assert.deepEqual(loadTest('old checks').steps.map((s) => s.page), ['shop.test/profile', undefined]);
});

test('the agent writing Gherkin is told the elements of the app, page by page, by name', () => {
  const project = projectNamed('Told');
  seedProjectStepDefinitions(project);
  saved('sign in again', project, [
    fillIn('E-mail', '#login-email', 'bob@corp', 'told.test/login'),
    clickOn('Sign in', '#login-form button', 'told.test/login'),
    containsCheck('#welcome', 'Hello', 'told.test/home'),
  ]);
  assert.deepEqual(elementLines(project), [
    '- told.test/home: "#welcome" (css #welcome)',
    '- told.test/login: "E-mail" (field), "Sign in" (button)',
  ]);
  const brief = designBrief({ key: 'REQ-1', title: 'Sign in', description: '', criteria: [], cases: [], project_id: project });
  assert.match(brief, /## The elements of the app/);
  assert.match(brief, /- told\.test\/login: "E-mail" \(field\), "Sign in" \(button\)/);
  assert.match(brief, /When I click on \{string\} — the 1st \{string\} is a CSS selector \(or the name of an element of the app\)/);

  const empty = projectNamed('Empty');
  seedProjectStepDefinitions(empty);
  const none = designBrief({ key: 'REQ-2', title: 'x', description: '', criteria: [], cases: [], project_id: empty });
  assert.match(none, /When I click on \{string\} — the 1st \{string\} is a CSS selector\n/);
  assert.doesNotMatch(none, /## The elements of the app|or the name of an element/, 'no element, no list');
});
