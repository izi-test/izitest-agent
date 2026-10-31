// Unit tests for the targets the Cucumber export writes in generic steps ("When I click
// on …"): the stable one generated code uses, as a Playwright selector string, instead of
// the selector as recorded. Run with: node --test test/codegen/cucumber-targets.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlaywrightCucumber } from '../../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const JARDIN_FOR = 'label[for="\\39 2595267-d4c1-11f1-9672-93f1a5382911"]';

const STEPS = [
  // izitest-test.html: the Sign in button, recorded by position
  { command: 'click', params: { selector: '#login-form > div:nth-of-type(3) > button:nth-of-type(1)' }, locators: [{ type: 'aria', value: 'Sign in' }, { type: 'text', value: 'Sign in' }] },
  // Bien'ici: the Jardin label, recorded with an ID made at each load
  { command: 'click', params: { selector: JARDIN_FOR, checked: true }, locators: [{ type: 'aria', value: 'Jardin' }, { type: 'css', value: JARDIN_FOR }] },
  // A toggle styled away, clicked through its label
  { command: 'click', params: { selector: 'input[name="darkMode"]', checked: false, viaLabel: true } },
  // A field with a React-generated ID
  { command: 'fill', params: { selector: '#\\:r4\\:', value: 'bob@corp' }, locators: [{ type: 'aria', value: 'E-mail' }] },
  // Already sound: left as it is
  { command: 'click', params: { selector: '#seeAllResults' } },
];
const exported = (t, definitions = DEFAULTS) =>
  generatePlaywrightCucumber({ name: 't', project_id: 1, ...t }, definitions).files.find(f => f.path.endsWith('.feature')).content;

test('generic steps get the stable target, as a selector string page.locator() takes', () => {
  const feature = exported({ steps: STEPS });
  assert.match(feature, /When I click on 'role=button\[name="Sign in"s\]'\n/);
  assert.match(feature, /And I check 'label:has-text\("Jardin"\)'\n/);
  assert.match(feature, /And I uncheck 'label:has\(input\[name="darkMode"\]\)'\n/);
  assert.match(feature, /And I fill 'internal:label="E-mail"i' with "bob@corp"\n/);
  assert.match(feature, /And I click on "#seeAllResults"\n/);
  assert.doesNotMatch(feature, /nth-of-type|92595267|:r4:/);
});

test('a role and name found more than once: chained to its scope, or ranked', () => {
  const clear = (place) => exported({ steps: [{ command: 'click', params: { selector: '#login-form > div:nth-of-type(3) > button:nth-of-type(2)' },
    locators: [{ type: 'role', value: 'button', name: 'Clear', ...place }] }] });
  assert.match(clear({ scope: { testid: 'login-form' } }), /I click on '\[data-testid="login-form"\] >> role=button\[name="Clear"s\]'/);
  assert.match(clear({ nth: 1 }), /I click on 'role=button\[name="Clear"s\] >> nth=1'/);
});

test('the feature IziTest edits keeps the recorded selectors, which its replay needs', () => {
  const feature = serializeTestToFeatureWith({ name: 't', steps: STEPS }, DEFAULTS);
  assert.match(feature, /When I click on "#login-form > div:nth-of-type\(3\) > button:nth-of-type\(1\)"/);
  assert.match(feature, /I uncheck 'input\[name="darkMode"\]'/);
});

test('a business step is still found: the target is chosen after, for the phrases left generic', () => {
  const garden = {
    id: 100, keyword: 'When', pattern: 'je ne garde que les maisons avec jardin', command: 'composite', params_template: {}, is_default: 0,
    steps_template: [{ command: 'click', params: { selector: JARDIN_FOR, checked: true }, locators: STEPS[1].locators }],
  };
  const feature = exported({ steps: STEPS }, [...DEFAULTS, garden]);
  assert.match(feature, /And je ne garde que les maisons avec jardin\n/);
  assert.match(feature, /When I click on 'role=button\[name="Sign in"s\]'\n/);
});

test('a choice in a <select> has a phrase, and reads back to the same step', async () => {
  const { parseFeatureToStepsWith } = await import('../../lib/gherkin/parse.js');
  const step = { command: 'select', params: { selector: '#ws-plan', value: 'Pro — 25 members ($29/mo)' } };
  const feature = serializeTestToFeatureWith({ name: 't', steps: [step] }, DEFAULTS);
  assert.match(feature, /When I select "Pro — 25 members \(\$29\/mo\)" in "#ws-plan"/);
  assert.deepEqual(parseFeatureToStepsWith(feature, DEFAULTS)[0].params, { value: 'Pro — 25 members ($29/mo)', selector: '#ws-plan' });
  const stepsJs = generatePlaywrightCucumber({ name: 't', steps: [step] }, DEFAULTS).files.find(f => f.path === 'features/steps/default.steps.js').content;
  assert.match(stepsJs, /When\('I select \{string\} in \{string\}', async function \(option, selector\) \{\n {2}await this\.page\.locator\(selector\)\.selectOption\(option\);/);
});
