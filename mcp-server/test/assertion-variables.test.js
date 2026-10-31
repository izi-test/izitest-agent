// Unit tests for assertions that follow the test's variables: checking what a fill step
// typed, they check whatever a replay types instead. The case is izi_login on
// izitest-test.html, whose e-mail assertion failed on a second Examples row.
// Run with: node --test test/assertion-variables.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkAssertionToVariables, addTestVariable } from '../lib/test-variable.js';
import { generatePlaywrightPlain } from '../lib/codegen/playwright-plain.js';
import { toScenarioOutline } from '../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../lib/gherkin/serialize.js';
import { DEFAULT_STEP_DEFINITIONS } from '../lib/gherkin/default-step-definitions.js';

const VARIABLES = {
  email: { type: 'text', defaultValue: 'jane.doe@example.com', step: 2 },
  password: { type: 'text', defaultValue: 'S3cret!pass', step: 3 },
  prenom: { type: 'text', defaultValue: 'jane', step: 4 },
  option: { type: 'list_item', defaultValue: 'Technology', step: 5 },
  court: { type: 'text', defaultValue: 'on', step: 6 },
};
const EMAIL_CHECK = { type: 'text_contains', selector: '#result-login', expected: '"email": "jane.doe@example.com"' };

test('an assertion on a typed value is saved with its variable', () => {
  const { assertion, linked } = linkAssertionToVariables(EMAIL_CHECK, VARIABLES);
  assert.equal(assertion.expected, '"email": "{{email}}"');
  assert.deepEqual(linked, ['email']);
  assert.equal(EMAIL_CHECK.expected, '"email": "jane.doe@example.com"', 'the assertion passed in is left untouched');
});

test('the longest value wins, and a shorter one is not looked for inside its placeholder', () => {
  const { assertion, linked } = linkAssertionToVariables({ type: 'text_contains', expected: 'jane.doe@example.com / jane' }, VARIABLES);
  assert.equal(assertion.expected, '{{email}} / {{prenom}}');
  assert.deepEqual(linked, ['email', 'prenom']);
});

test('on the window of a replay run with other values, those values are linked', () => {
  // izi_profile_fields replayed with date_of_birth=1985-11-30: the result shows that date.
  const variables = { date_of_birth: { type: 'text', defaultValue: '1990-05-12', step: 5 }, volume: { type: 'text', defaultValue: '80', step: 7 } };
  const check = { type: 'text_contains', selector: '#result-profile', expected: '"dob": "1985-11-30"' };
  const { assertion, linked } = linkAssertionToVariables(check, variables, { date_of_birth: '1985-11-30', volume: '25' });
  assert.equal(assertion.expected, '"dob": "{{date_of_birth}}"');
  assert.deepEqual(linked, ['date_of_birth']);
  assert.deepEqual(linkAssertionToVariables(check, variables).linked, [], 'the defaults are not on that page');
});

test('a value is linked whole, never as a piece of a word (izi_review)', () => {
  // "Fra" typed, "France" picked in the suggestions: the result shows France.
  const variables = { country: { type: 'text', defaultValue: 'Fra' }, tag: { type: 'text', defaultValue: 'playwright' } };
  const country = { type: 'text_contains', selector: '#result-dynamic', expected: '"country": "France"' };
  assert.deepEqual(linkAssertionToVariables(country, variables).linked, []);
  const tags = { type: 'text_contains', selector: '#result-dynamic', expected: '"tags": "playwright,cucumber"' };
  assert.equal(linkAssertionToVariables(tags, variables).assertion.expected, '"tags": "{{tag}},cucumber"');
  const special = { type: 'text_contains', selector: '#r', expected: 'total: 1.5$ (x+y)' };
  assert.equal(linkAssertionToVariables(special, { price: { type: 'text', defaultValue: '1.5$ (x+y)' } }).assertion.expected, 'total: {{price}}');
});

test('list variables, short values and assertions without text are left alone', () => {
  assert.deepEqual(linkAssertionToVariables({ type: 'text_contains', expected: 'Technology is on' }, VARIABLES).linked, []);
  const exists = { type: 'element_exists', selector: '#ok' };
  assert.equal(linkAssertionToVariables(exists, VARIABLES).assertion, exists);
  assert.deepEqual(linkAssertionToVariables(EMAIL_CHECK, undefined).linked, []);
});

test('an assertion saved before can reuse the variable of the value it checks', () => {
  const login = { name: 'izi_login', variables: VARIABLES, steps: [{ command: 'assert', params: {}, assertion: { ...EMAIL_CHECK } }] };
  const { test: linked, reused } = addTestVariable(login, { step: 1, param: 'expected', name: 'email' });
  assert.equal(reused, true);
  assert.equal(linked.steps[0].assertion.expected, '"email": "{{email}}"');
  assert.deepEqual(linked.variables, VARIABLES, 'the variable keeps its default');
});

test('linked, the check follows the data in plain code and in a Scenario Outline', () => {
  const { assertion } = linkAssertionToVariables(EMAIL_CHECK, VARIABLES);
  const steps = [
    { command: 'fill', params: { selector: '#login-email', value: '{{email}}' } },
    { command: 'assert', params: {}, assertion },
  ];
  assert.match(generatePlaywrightPlain({ name: 't', variables: VARIABLES, steps }),
    /await expect\(page\.locator\('#result-login'\)\)\.toContainText\(`"email": "\$\{VARS\.email\}"`\);/);

  const defaults = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const feature = toScenarioOutline(serializeTestToFeatureWith({ name: 't', steps }, defaults), VARIABLES);
  assert.match(feature, /When I fill "#login-email" with "<email>"\n {4}Then "#result-login" should contain '"email": "<email>"'/);
  assert.match(feature, /\| email \|\n {6}\| jane\.doe@example\.com \|/);
});
