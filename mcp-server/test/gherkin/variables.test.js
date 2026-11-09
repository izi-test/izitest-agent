// Unit tests for variables of a test: declared on a recorded value, mapped to business
// step parameters, round-tripped through the feature IziTest edits, and exported as a
// Cucumber Scenario Outline. Run with: node --test test/gherkin/variables.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTestVariable } from '../../lib/test-variable.js';
import { buildBusinessStep } from '../../lib/gherkin/business-step.js';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';
import { generatePlaywrightCucumber, toScenarioOutline } from '../../lib/codegen/playwright-cucumber.js';
import { generatePlaywrightPlain } from '../../lib/codegen/playwright-plain.js';

const URL = 'https://www.bienici.com/recherche/achat/antony-92160/maisonvilla?prix-max=500000';
const RECORDED = {
  name: 'recherche',
  variables: { option: { type: 'list_item', defaultValue: '5', step: 2 } },
  steps: [
    { command: 'navigate', params: { url: URL, tabId: 7 }, intent: 'Ouvrir la recherche' },
    { command: 'click', params: { selector: '#seeAllResults' } },
    { command: 'assert', params: {}, assertion: { type: 'url_contains', expected: 'jardin=oui' } },
  ],
};
const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const SEARCH = 'je cherche une maison à vendre à {string} pour {int} euros maximum';

/** The recorded test with {{ville}} and {{budget}} declared in its URL. */
function withCityAndBudget() {
  const city = addTestVariable(RECORDED, { step: 1, param: 'url', value: 'antony-92160', name: 'ville' });
  return addTestVariable(city.test, { step: 1, param: 'url', value: '500000', name: 'budget', description: 'Budget maximum' }).test;
}

test('a part of a recorded value becomes a variable, its value the default', () => {
  const t = withCityAndBudget();
  assert.equal(t.steps[0].params.url, 'https://www.bienici.com/recherche/achat/{{ville}}/maisonvilla?prix-max={{budget}}');
  assert.deepEqual(t.variables.ville, { type: 'text', defaultValue: 'antony-92160', step: 1, description: 'Ouvrir la recherche' });
  assert.equal(t.variables.budget.description, 'Budget maximum');
  assert.equal(t.variables.option.defaultValue, '5');
  assert.equal(RECORDED.steps[0].params.url, URL, 'the test passed in is left untouched');
});

test('a whole value, and an assertion\'s, can be a variable too', () => {
  const t = addTestVariable(RECORDED, { step: 3, param: 'expected', name: 'filtre' }).test;
  assert.equal(t.steps[2].assertion.expected, '{{filtre}}');
  assert.equal(t.variables.filtre.defaultValue, 'jardin=oui');
});

test('a variable that cannot be declared says why', () => {
  const add = (opts) => addTestVariable(RECORDED, { step: 1, param: 'url', name: 'ville', ...opts }).error;
  assert.match(add({ step: 4 }), /Step 4 is out of range: test "recherche" has 3 step\(s\)/);
  assert.match(add({ name: '2ville' }), /"2ville" is not a usable variable name/);
  assert.match(add({ name: 'option', value: 'antony-92160' }), /\{\{option\}\} already stands for "5": to use it here, give that value or none/);
  assert.match(add({ param: 'selector' }), /Step 1 \(navigate\) has no "selector" value \(it has: url, tabId\)/);
  assert.match(add({ value: 'paris' }), /"paris" is not in the "url" of step 1/);
  assert.match(addTestVariable(withCityAndBudget(), { step: 1, param: 'url', value: 'achat/{{ville}}', name: 'v' }).error, /already a variable/);
  // A variable alone, named again: renamed, everywhere the test uses it.
  const renamed = addTestVariable(withCityAndBudget(), { step: 1, param: 'url', value: '{{ville}}', name: 'commune' });
  assert.equal(renamed.renamed, 'ville');
  assert.equal(renamed.test.steps[0].params.url, 'https://www.bienici.com/recherche/achat/{{commune}}/maisonvilla?prix-max={{budget}}');
  assert.equal(renamed.test.variables.commune.defaultValue, 'antony-92160');
});

test('a business step maps the test\'s variables to its parameters', () => {
  const t = withCityAndBudget();
  const { steps_template } = buildBusinessStep(t, { from_step: 1, to_step: 1, pattern: SEARCH, args: [{ variable: 'ville' }, { variable: 'budget' }] });
  assert.deepEqual(steps_template[0].params, { url: 'https://www.bienici.com/recherche/achat/{0}/maisonvilla?prix-max={1}' });
});

test('a variable left without a parameter is refused: the code would type "{{ville}}"', () => {
  const t = withCityAndBudget();
  const { error } = buildBusinessStep(t, { from_step: 1, to_step: 1, pattern: 'je cherche à {string}', args: [{ variable: 'ville' }] });
  assert.match(error, /use \{\{budget\}\}: give the phrase a parameter for each and map it with \{ "variable": "budget" \}/);
  assert.match(buildBusinessStep(t, { from_step: 2, to_step: 2, pattern: 'x {string}', args: [{ variable: 'ville' }] }).error, /none of the grouped steps \(2–2\) uses \{\{ville\}\}/);
});

test('the baseline screenshot of a VRT step is left out of a business step', () => {
  const vrt = { name: 'vrt', steps: [{ command: 'click', params: { selector: '#go', baselinePath: 'data/baselines/baseline-3-1.png' } }] };
  assert.deepEqual(buildBusinessStep(vrt, { from_step: 1, to_step: 1, pattern: 'je valide' }).steps_template[0].params, { selector: '#go' });
});

test('the feature IziTest edits keeps {{variables}} and reads back, {int} included', () => {
  const t = withCityAndBudget();
  const search = buildBusinessStep(t, { from_step: 1, to_step: 1, pattern: SEARCH, args: [{ variable: 'ville' }, { variable: 'budget' }] });
  const definitions = [...DEFAULTS, { id: 100, keyword: 'Given', pattern: SEARCH, command: 'composite', params_template: {}, steps_template: search.steps_template }];

  const feature = serializeTestToFeatureWith(t, definitions);
  assert.match(feature, /Given je cherche une maison à vendre à "\{\{ville\}\}" pour \{\{budget\}\} euros maximum/);
  const steps = parseFeatureToStepsWith(feature, definitions);
  assert.equal(steps[0].params.url, t.steps[0].params.url);
  assert.equal(parseFeatureToStepsWith(feature.replace('{{budget}}', '650000'), definitions)[0].params.url,
    'https://www.bienici.com/recherche/achat/{{ville}}/maisonvilla?prix-max=650000');
});

test('the Cucumber export is a Scenario Outline with one row of default values', () => {
  const t = withCityAndBudget();
  const search = buildBusinessStep(t, { from_step: 1, to_step: 1, pattern: SEARCH, args: [{ variable: 'ville' }, { variable: 'budget' }] });
  const definitions = [...DEFAULTS, { id: 100, keyword: 'Given', pattern: SEARCH, command: 'composite', params_template: {}, steps_template: search.steps_template }];
  const feature = generatePlaywrightCucumber({ ...t, project_id: 1 }, definitions).files.find(f => f.path.endsWith('.feature')).content;

  assert.match(feature, /\n {2}Scenario Outline: recherche\n {4}Given je cherche une maison à vendre à "<ville>" pour <budget> euros maximum\n/);
  assert.match(feature, /\n\n {4}Examples:\n {6}\| ville \| budget \|\n {6}\| antony-92160 \| 500000 \|\n$/);
  assert.doesNotMatch(feature, /\{\{/);
});

test('a typed value is an Outline column too, and a test without variables is left a Scenario', () => {
  const fill = { name: 'login', variables: { email: { defaultValue: 'a|b@corp.com' } }, steps: [{ command: 'fill', params: { selector: '#email', value: '{{email}}' } }] };
  const feature = toScenarioOutline(serializeTestToFeatureWith(fill, DEFAULTS), fill.variables);
  assert.match(feature, /When I fill "#email" with "<email>"/);
  assert.match(feature, /\| email \|\n {6}\| a\\\|b@corp\.com \|/);
  const plain = serializeTestToFeatureWith({ name: 'p', steps: [RECORDED.steps[1]] }, DEFAULTS);
  assert.equal(toScenarioOutline(plain, {}), plain);
});

test('a value holding the quote around its <column> is escaped in Examples (izi_priorities)', () => {
  // '"reason": "<reason>"' is in single quotes: "d'abord" closed it, the step was undefined.
  const t = {
    name: 'priorities',
    variables: { reason: { defaultValue: "La performance d'abord" }, quote: { defaultValue: 'dit "oui"' } },
    steps: [
      { command: 'fill', params: { selector: '#why', value: '{{reason}}' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#result', expected: '"reason": "{{reason}}"' } },
      { command: 'fill', params: { selector: '#quote', value: '{{quote}}' } },
    ],
  };
  const feature = toScenarioOutline(serializeTestToFeatureWith(t, DEFAULTS), t.variables);
  assert.match(feature, /Then "#result" should contain '"reason": "<reason>"'/);
  // Gherkin reads \\ in a cell as \, and {string} reads \' as '.
  assert.match(feature, /\| La performance d\\\\'abord \| dit \\\\"oui\\\\" \|/);
});

test('plain Playwright code reads the variables from VARS', () => {
  const out = generatePlaywrightPlain(withCityAndBudget());
  assert.match(out, /ville: 'antony-92160',\n {2}budget: '500000',/);
  assert.match(out, /await page\.goto\(`https:\/\/www\.bienici\.com\/recherche\/achat\/\$\{VARS\.ville\}\/maisonvilla\?prix-max=\$\{VARS\.budget\}`\);/);
});
