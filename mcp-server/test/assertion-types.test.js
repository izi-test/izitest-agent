// Every assertion type, the same in the replay, in plain Playwright and in Cucumber. text_equals,
// attribute_equals and element_count came out as "// TODO: unsupported assertion", and had
// no Gherkin phrase. Found on izitest-test.html's review form (izi_review).
// Run with: node --test test/assertion-types.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion } from '../lib/test-execute.js';
import { generatePlaywrightPlain } from '../lib/codegen/playwright-plain.js';
import { generatePlaywrightCucumber } from '../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));

// assertion, the plain Playwright line, the Gherkin phrase.
const CASES = [
  [{ type: 'text_equals', selector: '#inline-title', expected: 'Mon avis' },
    "await expect(page.locator('#inline-title')).toHaveText('Mon avis');", 'Then "#inline-title" should have text "Mon avis"'],
  [{ type: 'attribute_equals', selector: '#country-input', attribute: 'value', expected: 'France' },
    "await expect(page.locator('#country-input')).toHaveValue('France');", 'Then the "value" of "#country-input" should be "France"'],
  [{ type: 'attribute_equals', selector: 'a.help', attribute: 'href', expected: '/help' },
    "await expect(page.locator('a.help')).toHaveAttribute('href', '/help');", 'Then the "href" of "a.help" should be "/help"'],
  [{ type: 'element_count', selector: '#tags-container .tag', expected: '2' },
    "await expect(page.locator('#tags-container .tag')).toHaveCount(2);", 'Then "#tags-container .tag" should match 2 elements'],
  [{ type: 'element_exists', selector: '.tag' },
    "await expect(page.locator('.tag').first()).toBeAttached();", 'Then ".tag" should exist'],
  [{ type: 'element_hidden', selector: '#country-list' },
    "await expect(page.locator('#country-list')).toBeHidden();", 'Then "#country-list" should be hidden'],
  [{ type: 'title_contains', expected: 'Test Arena' },
    "await expect(page).toHaveTitle(new RegExp('Test Arena'));", 'Then the title should contain "Test Arena"'],
];

for (const [assertion, line, phrase] of CASES) {
  test(`${assertion.type}${assertion.attribute ? ` (${assertion.attribute})` : ''}: generated, phrased, read back the same`, () => {
    const steps = [{ command: 'assert', params: {}, assertion }];
    assert.ok(generatePlaywrightPlain({ name: 't', steps }).includes(line), line);

    const feature = serializeTestToFeatureWith({ name: 't', steps }, DEFAULTS);
    assert.ok(feature.includes(phrase), `${phrase}\n${feature}`);
    assert.deepEqual(parseFeatureToStepsWith(feature, DEFAULTS)[0].assertion, assertion);
  });
}

test('every phrase has its step in the exported default.steps.js', () => {
  const stepsJs = generatePlaywrightCucumber({ name: 't', steps: [] }, DEFAULTS).files.find(f => f.path === 'features/steps/default.steps.js').content;
  for (const def of DEFAULT_STEP_DEFINITIONS) assert.ok(stepsJs.includes(`('${def.pattern}'`), def.pattern);
});

test('a composite step generates them too', () => {
  const business = {
    id: 99, keyword: 'Then', pattern: 'the review is sent', command: 'composite', is_default: 0,
    steps_template: CASES.map(([assertion]) => ({ command: 'assert', params: assertion })),
  };
  const files = generatePlaywrightCucumber({ name: 't', steps: [] }, [...DEFAULTS, business]).files;
  const composite = files.find(f => f.path === 'features/steps/composite.steps.js')?.content ?? '';
  assert.doesNotMatch(composite, /Unsupported assertion/);
  assert.match(composite, /toHaveValue\('France'\)/);
  assert.match(composite, /toHaveCount\(Number\('2'\)\)/);
});

test("a field's value is what it holds now, not its value attribute", async () => {
  let code = '';
  const page = async (_profile, _command, params) => { code = params.code; return { result: 'France' }; };
  const result = await evaluateAssertion(page, { type: 'attribute_equals', selector: '#country-input', attribute: 'value', expected: 'France' });
  assert.equal(result.passed, true);
  assert.match(code, /el\.value/);
});
