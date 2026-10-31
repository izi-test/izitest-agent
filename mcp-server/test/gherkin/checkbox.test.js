// Unit tests for checkboxes recorded with their state: generated code sets the state
// (check/uncheck/setChecked) and the Gherkin says so, both ways.
// Run with: node --test test/gherkin/checkbox.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlaywrightPlain } from '../../lib/codegen/playwright-plain.js';
import { generatePlaywrightCucumber } from '../../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';
import { buildBusinessStep } from '../../lib/gherkin/business-step.js';
import { addTestVariable } from '../../lib/test-variable.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const JARDIN_FOR = 'label[for="\\39 2595267-d4c1-11f1-9672-93f1a5382911"]';
const box = (checked, selector = '#cgu') => ({ command: 'click', params: { selector, ...(checked === undefined ? {} : { checked }) } });
const render = (...steps) => generatePlaywrightPlain({ name: 't', steps });

test('a box recorded checked is checked, one recorded unchecked is unchecked: never toggled', () => {
  assert.match(render(box(true)), /await page\.check\('#cgu'\);/);
  assert.match(render(box(false)), /await page\.uncheck\('#cgu'\);/);
  assert.match(render(box(undefined)), /await page\.click\('#cgu'\);/);
});

test('Bien\'ici\'s label: the stable locator, checked', () => {
  const out = render({ ...box(true, JARDIN_FOR), locators: [{ type: 'aria', value: 'Jardin' }, { type: 'css', value: JARDIN_FOR }] });
  assert.match(out, /await page\.locator\('label', \{ hasText: 'Jardin' \}\)\.check\(\);/);
});

test('a state held in a variable is set from it', () => {
  const t = addTestVariable({ name: 't', steps: [box(true)] }, { step: 1, param: 'checked', name: 'cgu' }).test;
  assert.equal(t.steps[0].params.checked, '{{cgu}}');
  assert.equal(t.variables.cgu.defaultValue, 'true');
  assert.match(generatePlaywrightPlain(t), /await page\.locator\('#cgu'\)\.setChecked\(`\$\{VARS\.cgu\}` === 'true'\);/);
});

test('the Gherkin says check, uncheck or the state\'s variable, and reads back to the same steps', () => {
  const steps = [box(true), box(false, '#news'), { ...box('{{cgu}}', '#cgu2') }, box(undefined, '#go')];
  const feature = serializeTestToFeatureWith({ name: 'f', steps }, DEFAULTS);
  assert.match(feature, /When I check "#cgu"\n {4}And I uncheck "#news"\n {4}And I set "#cgu2" checked to "\{\{cgu\}\}"\n {4}And I click on "#go"\n/);
  assert.deepEqual(parseFeatureToStepsWith(feature, DEFAULTS).map(s => s.params), steps.map(s => s.params));
});

test('the Cucumber export implements the phrases with check()', () => {
  const steps = generatePlaywrightCucumber({ name: 'f', steps: [box(true)] }, DEFAULTS).files.find(f => f.path === 'features/steps/default.steps.js').content;
  assert.match(steps, /When\('I check \{string\}', async function \(selector\) \{\n {2}await this\.page\.locator\(selector\)\.check\(\);/);
  assert.match(steps, /When\('I uncheck \{string\}'[\s\S]*?\.uncheck\(\);/);
  assert.match(steps, /When\('I set \{string\} checked to \{string\}'[\s\S]*?\.setChecked\(checked === 'true'\);/);
});

test('a business step checks its box, or sets it from a parameter', () => {
  const recorded = { name: 'r', variables: {}, steps: [{ ...box(true, JARDIN_FOR), locators: [{ type: 'aria', value: 'Jardin' }, { type: 'css', value: JARDIN_FOR }] }] };
  const garden = buildBusinessStep(recorded, { from_step: 1, to_step: 1, pattern: 'je veux un jardin' });
  const withState = buildBusinessStep(addTestVariable(recorded, { step: 1, param: 'checked', name: 'jardin' }).test,
    { from_step: 1, to_step: 1, pattern: 'jardin {string}', args: [{ variable: 'jardin' }] });
  const definitions = [
    { id: 1, keyword: 'When', pattern: 'je veux un jardin', command: 'composite', params_template: {}, steps_template: garden.steps_template },
    { id: 2, keyword: 'When', pattern: 'jardin {string}', command: 'composite', params_template: {}, steps_template: withState.steps_template },
  ];
  const code = generatePlaywrightCucumber(recorded, definitions).files.find(f => f.path === 'features/steps/composite.steps.js').content;
  assert.match(code, /When\('je veux un jardin', async function \(\) \{\n {2}await this\.page\.locator\('label', \{ hasText: 'Jardin' \}\)\.check\(\);/);
  assert.match(code, /When\('jardin \{string\}', async function \(arg0\) \{\n {2}await this\.page\.locator\('label', \{ hasText: 'Jardin' \}\)\.setChecked\(arg0 === 'true'\);/);
});
