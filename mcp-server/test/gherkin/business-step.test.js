// Unit tests for business steps built from a recorded test, and what the Cucumber export
// makes of them. Run with: node --test test/gherkin/business-step.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessStep } from '../../lib/gherkin/business-step.js';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';
import { generatePlaywrightCucumber } from '../../lib/codegen/playwright-cucumber.js';

const JARDIN_FOR = 'label[for="\\39 2595267-d4c1-11f1-9672-93f1a5382911"]';

// The Bien'ici search, as recorded.
const RECORDED = {
  name: 'Recherche Bien’ici',
  steps: [
    { command: 'navigate', params: { url: 'https://www.bienici.com/recherche/achat/antony-92160/maisonvilla?prix-max=500000' } },
    { command: 'click', params: { selector: 'div.moreFilterBtn' }, locators: [{ type: 'text', value: 'Afficher tous les critères' }, { type: 'css', value: 'div.moreFilterBtn' }] },
    {
      command: 'click',
      params: { selector: JARDIN_FOR },
      locators: [{ type: 'aria', value: 'Jardin' }, { type: 'text', value: 'Jardin (44)' }, { type: 'css', value: JARDIN_FOR }],
    },
    { command: 'click', params: { selector: '#seeAllResults' } },
    { command: 'assert', params: {}, assertion: { type: 'url_contains', expected: 'jardin=oui' } },
  ],
};

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const composite = (id, keyword, pattern, built) => ({ id, keyword, pattern, command: 'composite', params_template: {}, steps_template: built.steps_template, is_default: 0 });

test('groups the recorded steps, numbered from 1, both ends included, locators kept', () => {
  const { steps_template, error } = buildBusinessStep(RECORDED, { from_step: 2, to_step: 4, pattern: 'je ne garde que les maisons avec jardin' });
  assert.equal(error, undefined);
  assert.deepEqual(steps_template.map(t => t.params.selector), ['div.moreFilterBtn', JARDIN_FOR, '#seeAllResults']);
  assert.equal(steps_template[1].locators[0].value, 'Jardin');
  assert.equal(steps_template[2].locators, undefined);
});

test('an arg takes a whole recorded value, or only part of it', () => {
  const { steps_template } = buildBusinessStep(RECORDED, {
    from_step: 1, to_step: 1,
    pattern: 'je cherche une maison à {string} pour {int} euros maximum',
    args: [{ step: 1, param: 'url', value: 'antony-92160' }, { step: 1, param: 'url', value: '500000' }],
  });
  assert.equal(steps_template[0].params.url, 'https://www.bienici.com/recherche/achat/{0}/maisonvilla?prix-max={1}');
});

test('a parameterised selector drops the locators of the one element recorded', () => {
  const { steps_template } = buildBusinessStep(RECORDED, {
    from_step: 3, to_step: 3, pattern: 'je coche {string}', args: [{ step: 3, param: 'selector' }],
  });
  assert.equal(steps_template[0].params.selector, '{0}');
  assert.equal(steps_template[0].locators, undefined);
});

test('assertions are grouped with their data', () => {
  const { steps_template } = buildBusinessStep(RECORDED, { from_step: 5, to_step: 5, pattern: 'les maisons ont un jardin' });
  assert.deepEqual(steps_template[0], { command: 'assert', params: { type: 'url_contains', expected: 'jardin=oui' } });
});

test('wrong ranges and args are refused with what is wrong', () => {
  const build = (opts) => buildBusinessStep(RECORDED, { pattern: 'x', ...opts }).error;
  assert.match(build({ from_step: 0, to_step: 2 }), /out of range: test "Recherche Bien’ici" has 5 step\(s\)/);
  assert.match(build({ from_step: 4, to_step: 2 }), /out of range/);
  assert.match(build({ from_step: 1, to_step: 6 }), /out of range/);
  assert.match(build({ from_step: 1, to_step: 2, pattern: 'à {string}' }), /1 parameter\(s\).*but 0 arg\(s\)/);
  assert.match(build({ from_step: 1, to_step: 2, pattern: 'à {string}', args: [{ step: 3, param: 'url' }] }), /step 3 is not one of the grouped steps \(1–2\)/);
  assert.match(build({ from_step: 1, to_step: 2, pattern: 'à {string}', args: [{ step: 1, param: 'selector' }] }), /step 1 \(navigate\) has no "selector" \(it has: url\)/);
  assert.match(build({ from_step: 1, to_step: 2, pattern: 'à {string}', args: [{ step: 1, param: 'url', value: 'paris' }] }), /"paris" is not in the "url" of step 1/);
});

test('the feature reads in business phrases, the project\'s own winning over the defaults', () => {
  const search = buildBusinessStep(RECORDED, {
    from_step: 1, to_step: 1, pattern: 'je cherche une maison à {string} pour {int} euros maximum',
    args: [{ step: 1, param: 'url', value: 'antony-92160' }, { step: 1, param: 'url', value: '500000' }],
  });
  const garden = buildBusinessStep(RECORDED, { from_step: 2, to_step: 4, pattern: 'je ne garde que les maisons avec jardin' });
  const definitions = [...DEFAULTS, composite(100, 'Given', 'je cherche une maison à {string} pour {int} euros maximum', search), composite(101, 'When', 'je ne garde que les maisons avec jardin', garden)];

  const feature = serializeTestToFeatureWith(RECORDED, definitions);
  assert.match(feature, /\n {4}Given je cherche une maison à "antony-92160" pour 500000 euros maximum\n {4}When je ne garde que les maisons avec jardin\n {4}Then the URL should contain "jardin=oui"\n/);
});

test('the tab a step ran in is left out: the phrase matches another recording of the same steps', () => {
  const recordedInTab = (tabId) => ({
    name: `tab ${tabId}`,
    steps: [{ command: 'navigate', params: { url: RECORDED.steps[0].params.url, tabId } }],
  });
  const search = buildBusinessStep(recordedInTab(231077689), {
    from_step: 1, to_step: 1, pattern: 'je cherche une maison à {string}', args: [{ step: 1, param: 'url', value: 'antony-92160' }],
  });
  assert.deepEqual(Object.keys(search.steps_template[0].params), ['url']);

  const feature = serializeTestToFeatureWith(recordedInTab(231077654), [...DEFAULTS, composite(100, 'Given', 'je cherche une maison à {string}', search)]);
  assert.match(feature, /Given je cherche une maison à "antony-92160"/);
});

test('a single-step definition with fixed text beats a built-in default of the same shape', () => {
  const ownSearch = { id: 200, keyword: 'Given', pattern: 'je cherche une maison à {string}', command: 'navigate', params_template: { url: 'https://www.bienici.com/recherche/achat/{0}/maisonvilla?prix-max=500000' }, steps_template: null, is_default: 0 };
  const feature = serializeTestToFeatureWith({ name: 't', steps: [RECORDED.steps[0]] }, [...DEFAULTS, ownSearch]);
  assert.match(feature, /Given je cherche une maison à "antony-92160"/);
});

test('composite.steps.js: stable locators, args in place, literals that parse', () => {
  const garden = buildBusinessStep(RECORDED, { from_step: 2, to_step: 4, pattern: 'je ne garde que les maisons avec jardin' });
  const search = buildBusinessStep(RECORDED, {
    from_step: 1, to_step: 1, pattern: 'je cherche une maison à {string}', args: [{ step: 1, param: 'url', value: 'antony-92160' }],
  });
  const { files } = generatePlaywrightCucumber(RECORDED, [...DEFAULTS, composite(100, 'Given', 'je cherche une maison à {string}', search), composite(101, 'When', 'je ne garde que les maisons avec jardin', garden)]);
  const steps = files.find(f => f.path === 'features/steps/composite.steps.js').content;

  assert.match(steps, /Given\('je cherche une maison à \{string\}', async function \(arg0\) \{\n {2}await this\.page\.goto\(`https:\/\/www\.bienici\.com\/recherche\/achat\/\$\{arg0\}\/maisonvilla\?prix-max=500000`\);/);
  assert.match(steps, /await this\.page\.click\('div\.moreFilterBtn'\);\n {2}await this\.page\.locator\('label', \{ hasText: 'Jardin' \}\)\.click\(\);\n {2}await this\.page\.click\('#seeAllResults'\);/);
});

test('composite.steps.js: a CSS escape is a valid JS literal, not an octal escape', () => {
  const definitions = [composite(1, 'When', 'je coche le jardin', { steps_template: [{ command: 'click', params: { selector: JARDIN_FOR } }] })];
  const steps = generatePlaywrightCucumber(RECORDED, definitions).files.find(f => f.path === 'features/steps/composite.steps.js').content;
  const literal = /await this\.page\.click\((.*)\);/.exec(steps)[1];
  assert.equal(new Function(`'use strict'; return ${literal};`)(), JARDIN_FOR);
  assert.match(steps, /\/\/ FIXME: this selector holds an ID the page generates/);
});

test('expanding a business phrase back into steps keeps their locators', () => {
  const garden = buildBusinessStep(RECORDED, { from_step: 2, to_step: 4, pattern: 'je ne garde que les maisons avec jardin' });
  const definitions = [...DEFAULTS, composite(101, 'When', 'je ne garde que les maisons avec jardin', garden)];
  const steps = parseFeatureToStepsWith('Feature: f\n  Scenario: s\n    When je ne garde que les maisons avec jardin\n', definitions);
  assert.equal(steps.length, 3);
  assert.equal(steps[1].locators[0].value, 'Jardin');
});
