// Unit tests for drag steps: the code generated from them, their Gherkin phrases, read back
// the same. izitest-test.html's priority list, sorted by dropping an item on the top or the
// bottom of another.
// Run with: node --test test/drag.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlaywrightPlain } from '../lib/codegen/playwright-plain.js';
import { generatePlaywrightCucumber } from '../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));

const item = (value, n) => [
  { type: 'text', value: `⠿${value}#${n}` },
  { type: 'css', value: `div[data-value="${value.toLowerCase()}"]` },
  { type: 'xpath', value: `//*[@id="sortable-list"]/div[${n}]` },
];
// Recorded: Cost Efficiency dropped on the top of Performance.
const TO_THE_TOP = {
  command: 'drag',
  params: { selector: 'div[data-value="cost"]', target: 'div[data-value="performance"]', position: 'top', targetLocators: item('Performance', 1) },
  locators: item('Cost', 5),
};

test('plain Playwright: dragTo the target, on its centre', () => {
  const step = { command: 'drag', params: { selector: '#card-ship', target: '#done' } };
  assert.match(generatePlaywrightPlain({ name: 't', steps: [step] }), /await page\.locator\('#card-ship'\)\.dragTo\(page\.locator\('#done'\)\);/);
});

test('plain Playwright: near an edge of the target, a quarter of the way in', () => {
  const out = generatePlaywrightPlain({ name: 't', steps: [TO_THE_TOP] });
  assert.match(out, /const target = page\.locator\('div\[data-value="performance"\]'\);/);
  assert.match(out, /const \{ width, height \} = await target\.boundingBox\(\);/);
  assert.match(out, /await page\.locator\('div\[data-value="cost"\]'\)\.dragTo\(target, \{ targetPosition: \{ x: width \/ 2, y: height \/ 4 \} \}\); \/\/ its top/);
  const bottom = generatePlaywrightPlain({ name: 't', steps: [{ ...TO_THE_TOP, params: { ...TO_THE_TOP.params, position: 'bottom' } }] });
  assert.match(bottom, /y: height \* 3 \/ 4/);
  // Two of them in one test: each in its own block, no `target` declared twice.
  const twice = generatePlaywrightPlain({ name: 't', steps: [TO_THE_TOP, TO_THE_TOP] });
  assert.equal(twice.match(/^ {2}\{$/gm).length, 2);
});

test('both ends get a stable locator: a position recorded, the data value used', () => {
  const positional = {
    command: 'drag',
    params: { selector: '#sortable-list > div:nth-of-type(5)', target: '#sortable-list > div:nth-of-type(1)', targetLocators: item('Performance', 1) },
    locators: item('Cost', 5),
  };
  assert.match(generatePlaywrightPlain({ name: 't', steps: [positional] }),
    /await page\.locator\('div\[data-value="cost"\]'\)\.dragTo\(page\.locator\('div\[data-value="performance"\]'\)\);/);
});

test('Gherkin: "I drag … to …" and "I drag … to the top of …", read back the same', () => {
  const center = { command: 'drag', params: { selector: '#card-ship', target: '#done' } };
  const feature = serializeTestToFeatureWith({ name: 't', steps: [center, TO_THE_TOP] }, DEFAULTS);
  assert.match(feature, /When I drag "#card-ship" to "#done"/);
  assert.match(feature, /And I drag 'div\[data-value="cost"\]' to the top of 'div\[data-value="performance"\]'/);
  const [first, second] = parseFeatureToStepsWith(feature, DEFAULTS);
  assert.deepEqual(first.params, center.params);
  assert.deepEqual(second.params, { selector: 'div[data-value="cost"]', position: 'top', target: 'div[data-value="performance"]' });
});

test('Cucumber: the feature names both ends by their stable locator, and the steps drag', () => {
  const positional = { ...TO_THE_TOP, params: { ...TO_THE_TOP.params, selector: '#sortable-list > div:nth-of-type(5)', target: '#sortable-list > div:nth-of-type(1)' } };
  const { files } = generatePlaywrightCucumber({ name: 'priorities', project_id: 1, steps: [positional] }, DEFAULTS);
  const feature = files.find(f => f.path === 'features/priorities.feature').content;
  assert.match(feature, /When I drag 'div\[data-value="cost"\]' to the top of 'div\[data-value="performance"\]'/);
  const stepsJs = files.find(f => f.path === 'features/steps/default.steps.js').content;
  assert.match(stepsJs, /When\('I drag \{string\} to \{string\}', async function \(source, target\) \{\n {2}await this\.page\.locator\(source\)\.dragTo\(this\.page\.locator\(target\)\);/);
  assert.match(stepsJs, /When\('I drag \{string\} to the \{word\} of \{string\}', async function \(source, edge, target\)/);
  assert.match(stepsJs, /top: \[1 \/ 2, 1 \/ 4\]/);
});

test('a business step drags too', () => {
  const business = {
    id: 99, keyword: 'When', pattern: 'je mets le coût en premier', command: 'composite', is_default: 0,
    steps_template: [TO_THE_TOP],
  };
  const composite = generatePlaywrightCucumber({ name: 't', project_id: 1, steps: [] }, [...DEFAULTS, business]).files
    .find(f => f.path === 'features/steps/composite.steps.js').content;
  assert.match(composite, /const target = this\.page\.locator\('div\[data-value="performance"\]'\);/);
  assert.match(composite, /await this\.page\.locator\('div\[data-value="cost"\]'\)\.dragTo\(target, \{ targetPosition: \{ x: width \/ 2, y: height \/ 4 \} \}\);/);
});
