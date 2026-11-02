// Unit tests for the phrases that name a form field by its label ("When I fill the field
// "Email" with …"): what a scenario written without seeing the page can say, where it cannot
// know a CSS selector. Read, read back, generated, seeded on every project, and offered to
// the agent that designs tests. On a database of their own, thrown away after.
// Run with: node --test test/field-label.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'field-label-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { DEFAULT_STEP_DEFINITIONS } = await import('../lib/gherkin/default-step-definitions.js');
const { parseFeatureToStepsWith } = await import('../lib/gherkin/parse.js');
const { serializeTestToFeatureWith } = await import('../lib/gherkin/serialize.js');
const { stepsForEditedFeature } = await import('../lib/gherkin/reconcile.js');
const { seedProjectStepDefinitions, seedAllProjectsStepDefinitions, listStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { generatePlaywrightPlain } = await import('../lib/codegen/playwright-plain.js');
const { generatePlaywrightCucumber } = await import('../lib/codegen/playwright-cucumber.js');
const { identityOf } = await import('../lib/triage.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { saveRequirement } = await import('../lib/requirements.js');
const { designBrief } = await import('../lib/requirement-design.js');

const defaults = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const feature = (...phrases) => `Feature: Login\n\n  Scenario: Login\n${phrases.map((p) => `    ${p}\n`).join('')}`;

// The login form of izitest-test.html, as a scenario names it without having seen it.
const LOGIN = feature(
  'Given I am on "http://127.0.0.1:8777/izitest-test.html"',
  'When I fill the field "Email" with "jane@example.com"',
  'And I fill the field "Password" with "secret"',
  'And I check the field "Remember me"',
  'And I uncheck the field "Remember me"',
  'And I select "Support" in the field "Subject"',
);

test('read into a fill, a click and a select by label; read back the same', () => {
  const steps = parseFeatureToStepsWith(LOGIN, defaults);
  assert.deepEqual(steps.slice(1).map((s) => [s.command, s.params]), [
    ['fill', { label: 'Email', value: 'jane@example.com' }],
    ['fill', { label: 'Password', value: 'secret' }],
    ['click', { label: 'Remember me', checked: true }],
    ['click', { label: 'Remember me', checked: false }],
    ['select', { value: 'Support', label: 'Subject' }],
  ]);
  assert.equal(serializeTestToFeatureWith({ name: 'Login', steps }, defaults), LOGIN.replace(/^(\s+)And I fill the field "Email"/m, '$1When I fill the field "Email"'));
});

test('not taken for the phrases that name a selector, nor they for it', () => {
  const steps = parseFeatureToStepsWith(feature('When I fill "#login-email" with "x"', 'And I check "#login-remember"', 'And I select "pro" in "#plan"'), defaults);
  assert.deepEqual(steps.map((s) => s.params), [
    { selector: '#login-email', value: 'x' }, { selector: '#login-remember', checked: true }, { value: 'pro', selector: '#plan' },
  ]);
  assert.match(serializeTestToFeatureWith({ name: 't', steps }, defaults), /When I fill "#login-email" with "x"\n    And I check "#login-remember"\n    And I select "pro" in "#plan"/);
});

test('generated Playwright: by label or placeholder, the first that shows; a box through its label', () => {
  const code = generatePlaywrightPlain({ name: 'Login', steps: parseFeatureToStepsWith(LOGIN, defaults) });
  assert.match(code, /await page\.getByLabel\('Email', \{ exact: true \}\)\.or\(page\.getByPlaceholder\('Email', \{ exact: true \}\)\)\.locator\('visible=true'\)\.first\(\)\.fill\('jane@example\.com'\);/);
  assert.match(code, /await page\.locator\('label:text-is\("Remember me"\)'\)\.or\(page\.getByLabel\('Remember me', \{ exact: true \}\)\)\.locator\('visible=true'\)\.first\(\)\.check\(\);/);
  assert.match(code, /\.first\(\)\.uncheck\(\);/);
  assert.match(code, /getByLabel\('Subject', \{ exact: true \}\).*\.first\(\)\.selectOption\('Support'\);/);
  // A variable of the test stays one in the label.
  const typed = generatePlaywrightPlain({ name: 't', variables: { field: { defaultValue: 'Email' } }, steps: [{ command: 'fill', params: { label: '{{field}}', value: 'x' } }] });
  assert.match(typed, /page\.getByLabel\(`\$\{VARS\.field\}`, \{ exact: true \}\)/);
});

test('Cucumber: the feature keeps the phrases, the steps file defines them, each matched by one definition', () => {
  const steps = parseFeatureToStepsWith(LOGIN, defaults);
  const { files } = generatePlaywrightCucumber({ name: 'Login', project_id: 1, steps }, defaults);
  assert.match(files.find((f) => f.path === 'features/login.feature').content, /When I fill the field "Email" with "jane@example\.com"/);

  const stepsJs = files.find((f) => f.path === 'features/steps/default.steps.js').content;
  assert.match(stepsJs, /When\('I fill the field \{string\} with \{string\}', async function \(label, value\) \{\n  await field\(this\.page, label\)\.fill\(value\);/);
  assert.match(stepsJs, /When\('I select \{string\} in the field \{string\}', async function \(option, label\) \{\n  await field\(this\.page, label\)\.selectOption\(option\);/);
  assert.match(stepsJs, /When\('I check the field \{string\}', async function \(label\) \{\n  await box\(this\.page, label\)\.check\(\);/);
  assert.match(stepsJs, /const box = \(page, label\) => page\.locator\(`label:text-is\(\$\{JSON\.stringify\(label\)\}\)`\)/);

  // Two definitions matching one step make Cucumber fail it as ambiguous.
  const registry = new ParameterTypeRegistry();
  const patterns = [...stepsJs.matchAll(/^(?:Given|When|Then)\('((?:[^'\\]|\\.)*)'/gm)].map((m) => new CucumberExpression(m[1], registry));
  for (const phrase of ['I fill the field "Email" with "x"', 'I select "Support" in the field "Subject"', 'I check the field "Remember me"', 'I uncheck the field "Remember me"', 'I fill "#q" with "x"', 'I check "#c"']) {
    assert.equal(patterns.filter((p) => p.match(phrase)).length, 1, phrase);
  }
});

test('a business step with a field by label: its argument goes in the label', () => {
  const composite = {
    id: 99, keyword: 'Given', pattern: 'I sign in as {string}', command: 'composite', is_default: 0,
    steps_template: [{ command: 'fill', params: { label: 'Email', value: '{0}' } }, { command: 'click', params: { label: '{0}', checked: true } }],
  };
  const { files } = generatePlaywrightCucumber({ name: 't', project_id: 1, steps: [] }, [...defaults, composite]);
  const code = files.find((f) => f.path === 'features/steps/composite.steps.js').content;
  assert.match(code, /await this\.page\.getByLabel\('Email', \{ exact: true \}\)\.or\(this\.page\.getByPlaceholder\('Email', \{ exact: true \}\)\)\.locator\('visible=true'\)\.first\(\)\.fill\(arg0\);/);
  assert.match(code, /await this\.page\.locator\(`label:text-is\("\$\{arg0\}"\)`\)\.or\(this\.page\.getByLabel\(arg0, \{ exact: true \}\)\)/);
});

test('an edited phrase naming another field is another step: the old one\'s intent is not carried over', () => {
  const steps = parseFeatureToStepsWith(LOGIN, defaults);
  const edited = stepsForEditedFeature(LOGIN.replace('fill the field "Password" with "secret"', 'fill the field "Mot de passe" with "secret"'), defaults, { name: 'Login', steps });
  assert.deepEqual(edited[2].params, { label: 'Mot de passe', value: 'secret' });
  assert.equal(edited[2].intent, 'I fill the field "Mot de passe" with "secret"');
});

test('what a phrase types into a field becomes a variable named after its label', () => {
  saveTest({ name: 'login-by-label', steps: parseFeatureToStepsWith(LOGIN, defaults), variables: {} });
  const saved = loadTest('login-by-label');
  assert.deepEqual(Object.keys(saved.variables), ['email', 'password']);
  assert.deepEqual(saved.steps[1].params, { label: 'Email', value: '{{email}}' });
  // A field named by a selector keeps the name it had.
  saveTest({ name: 'login-by-selector', steps: parseFeatureToStepsWith(feature('When I fill "#login-email" with "x"'), defaults), variables: {} });
  assert.deepEqual(Object.keys(loadTest('login-by-selector').variables), ['input_1']);
});

test('a failed step by label is diagnosed by that label: the name of the field to look for', () => {
  assert.equal(identityOf({ command: 'fill', params: { label: 'Email', value: 'x' } }).name, 'Email');
});

test('seeded on a project that existed before the phrases, at start', () => {
  const project = db.prepare("INSERT INTO projects (name, base_url) VALUES ('Old', 'https://old.test') RETURNING id").get().id;
  seedProjectStepDefinitions(project);
  db.prepare("DELETE FROM step_definitions WHERE project_id = ? AND pattern LIKE '%the field%'").run(project);
  assert.equal(listStepDefinitions(project).filter((d) => d.pattern.includes('the field')).length, 0);

  seedAllProjectsStepDefinitions();
  const added = listStepDefinitions(project).filter((d) => d.pattern.includes('the field'));
  assert.deepEqual(added.map((d) => [d.pattern, d.params_template, d.is_default]).sort(), [
    ['I check the field {string}', { label: '{0}', checked: true }, true],
    ['I fill the field {string} with {string}', { label: '{0}', value: '{1}' }, true],
    ['I select {string} in the field {string}', { value: '{0}', label: '{1}' }, true],
    ['I uncheck the field {string}', { label: '{0}', checked: false }, true],
  ]);
});

test('offered to the agent that designs tests, with no CSS selector to fill in', () => {
  const project = db.prepare("INSERT INTO projects (name, base_url) VALUES ('Shop', 'https://shop.test') RETURNING id").get().id;
  seedProjectStepDefinitions(project);
  const { requirement } = saveRequirement({ title: 'Login', projectId: project, source: 'jira', key: 'SHOP-1', criteria: ['A wrong password is refused'] });
  const brief = designBrief(requirement);
  for (const pattern of ['I fill the field {string} with {string}', 'I select {string} in the field {string}', 'I check the field {string}', 'I uncheck the field {string}']) {
    const line = brief.split('\n').find((l) => l === `- When ${pattern}` || l.startsWith(`- When ${pattern} —`));
    assert.equal(line, `- When ${pattern}`, pattern);
  }
  assert.match(brief, /- When I fill \{string\} with \{string\} — the 1st \{string\} is a CSS selector/);
});
