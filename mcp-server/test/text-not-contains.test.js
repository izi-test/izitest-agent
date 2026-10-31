// Unit tests for the "does not contain" assertion: evaluated, generated and phrased.
// Run with: node --test test/text-not-contains.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion } from '../lib/test-execute.js';
import { generatePlaywrightPlain } from '../lib/codegen/playwright-plain.js';
import { generatePlaywrightCucumber } from '../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../lib/gherkin/default-step-definitions.js';

const NO_DARK_MODE = { type: 'text_not_contains', selector: '#result-profile', expected: 'darkMode' };
const pageText = (text) => async (_profile, command, params) => {
  assert.equal(command, 'execute_js');
  return { result: text, tabId: params.tabId };
};

test('passes when the element is there without the text, fails when the text is in it', async () => {
  const pass = await evaluateAssertion(pageText('{ "publicProfile": "on" }'), NO_DARK_MODE);
  assert.deepEqual([pass.passed, pass.expected], [true, 'does not contain "darkMode"']);
  assert.equal((await evaluateAssertion(pageText('{ "darkMode": "on" }'), NO_DARK_MODE)).passed, false);
});

test('fails when the element is missing: a panel that never showed contains nothing', async () => {
  const missing = await evaluateAssertion(pageText(null), NO_DARK_MODE);
  assert.deepEqual([missing.passed, missing.actual], [false, '(element not found)']);
});

test('generated as not.toContainText, phrased "should not contain", read back the same', () => {
  const steps = [{ command: 'assert', params: {}, assertion: NO_DARK_MODE }];
  assert.match(generatePlaywrightPlain({ name: 't', steps }), /await expect\(page\.locator\('#result-profile'\)\)\.not\.toContainText\('darkMode'\);/);

  const defaults = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const feature = serializeTestToFeatureWith({ name: 't', steps }, defaults);
  assert.match(feature, /Then "#result-profile" should not contain "darkMode"/);
  assert.deepEqual(parseFeatureToStepsWith(feature, defaults)[0].assertion, NO_DARK_MODE);
  const stepsJs = generatePlaywrightCucumber({ name: 't', steps }, defaults).files.find(f => f.path === 'features/steps/default.steps.js').content;
  assert.match(stepsJs, /Then\('\{string\} should not contain \{string\}'[\s\S]*?\.not\.toContainText\(expected\);/);
});
