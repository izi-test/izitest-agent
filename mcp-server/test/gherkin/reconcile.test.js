// Unit tests for saving an edited feature (the dashboard's Gherkin tab): what was not
// edited stays as it was. Reported live: saving demo_business_bienici dropped the {{option}}
// list variable of its Jardin click and every intent.
// Run with: node --test test/gherkin/reconcile.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsForEditedFeature } from '../../lib/gherkin/reconcile.js';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const JARDIN_LIST = { name: 'option', type: 'list_item', defaultValue: 'Jardin', listContext: { parentSelector: 'fieldset', itemXpath: 'div/label', selectionMode: 'by_text' } };

const RECORDED = {
  name: 'recherche',
  steps: [
    { command: 'navigate', params: { url: 'https://www.bienici.com/recherche', tabId: 7 }, intent: 'Ouvrir la recherche' },
    { command: 'click', params: { selector: 'div.moreFilterBtn' }, intent: 'Ouvrir les critères', locators: [{ type: 'text', value: 'Afficher tous les critères' }] },
    { command: 'click', params: { selector: 'input[name="hasGarden"]', checked: true, viaLabel: true }, intent: 'Cocher Jardin', variable: JARDIN_LIST, locators: [{ type: 'aria', value: 'Jardin' }] },
    { command: 'fill', params: { selector: '#email', value: '{{email}}' }, intent: "Saisir l'e-mail", variable: { name: 'email', type: 'text', defaultValue: 'a@b.c' }, locators: [{ type: 'aria', value: 'Email' }] },
    { command: 'execute_js', params: { code: 'window.scrollTo(0, 0)' }, intent: 'Remonter en haut' },
    { command: 'click', params: { selector: '#seeAllResults', baselinePath: 'data/baselines/baseline-3-6.png' }, intent: 'Voir les annonces' },
  ],
};
const featureOf = (t, definitions = DEFAULTS) => serializeTestToFeatureWith(t, definitions);
const save = (feature, t = RECORDED, definitions = DEFAULTS) => stepsForEditedFeature(feature, definitions, t);

test('saved as it is, the test keeps every step whole — even one no phrase can describe', () => {
  const feature = featureOf(RECORDED);
  assert.match(feature, /"Remonter en haut"/, 'execute_js has no phrase: its intent stands in');
  assert.deepEqual(save(feature), RECORDED.steps);
});

test('an edited value is taken, and the step keeps its locators, intent and variable', () => {
  const steps = save(featureOf(RECORDED).replace('I fill "#email" with "{{email}}"', 'I fill "#email" with "{{email}}@corp"'));
  assert.deepEqual(steps[3].params, { selector: '#email', value: '{{email}}@corp' });
  assert.equal(steps[3].intent, "Saisir l'e-mail");
  assert.deepEqual(steps[3].locators, RECORDED.steps[3].locators);
  assert.equal(steps[3].variable.name, 'email');
  assert.deepEqual(steps.filter((_, i) => i !== 3), RECORDED.steps.filter((_, i) => i !== 3));
});

test('a typed variable no longer in the step is dropped from it', () => {
  const steps = save(featureOf(RECORDED).replace('"{{email}}"', '"bob@corp"'));
  assert.equal(steps[3].params.value, 'bob@corp');
  assert.equal(steps[3].variable, undefined);
});

test('a list variable and a click through the label survive an edit of the same element', () => {
  const steps = save(featureOf(RECORDED).replace('I check "input[name=\\"hasGarden\\"]"', 'I uncheck "input[name=\\"hasGarden\\"]"'));
  assert.deepEqual(steps[2].params, { selector: 'input[name="hasGarden"]', checked: false, viaLabel: true });
  assert.deepEqual(steps[2].variable, JARDIN_LIST);
});

test('another target is another element: nothing of the old step is carried over', () => {
  const steps = save(featureOf(RECORDED).replace('I click on "div.moreFilterBtn"', 'I click on "#filters"'));
  assert.deepEqual(steps[1].params, { selector: '#filters' });
  assert.equal(steps[1].locators, undefined);
  assert.notEqual(steps[1].intent, 'Ouvrir les critères');
});

test('a phrase added or removed leaves the others whole', () => {
  const added = save(featureOf(RECORDED).replace('I click on "div.moreFilterBtn"\n', 'I click on "div.moreFilterBtn"\n    And I wait 2 seconds\n'));
  assert.equal(added.length, 7);
  assert.deepEqual(added[2], { step_order: 3, command: 'wait', params: { ms: '2000' }, intent: 'I wait 2 seconds', step_definition_id: added[2].step_definition_id });
  assert.deepEqual([...added.slice(0, 2), ...added.slice(3)], RECORDED.steps);

  const removed = save(featureOf(RECORDED).replace(/ {4}And "Remonter en haut"\n/, ''));
  assert.deepEqual(removed, RECORDED.steps.filter(s => s.command !== 'execute_js'));
});

test('a business step left as it was keeps its sub-steps, locators included', () => {
  const garden = {
    id: 100, keyword: 'When', pattern: 'je ne garde que les maisons avec jardin', command: 'composite', params_template: {}, is_default: 0,
    steps_template: RECORDED.steps.slice(1, 3).map(({ command, params }) => ({ command, params: { ...params } })),
  };
  const definitions = [...DEFAULTS, garden];
  const feature = featureOf(RECORDED, definitions);
  assert.match(feature, /When je ne garde que les maisons avec jardin\n/);
  assert.deepEqual(save(feature, RECORDED, definitions), RECORDED.steps);
});

test('a phrase nothing matches is reported, alone, with its line', () => {
  assert.throws(() => save(featureOf(RECORDED).replace('I click on "#seeAllResults"', 'I frobnicate "#seeAllResults"')), (err) => {
    assert.equal(err.code, 'GHERKIN_UNRESOLVED');
    assert.deepEqual(err.errors, ['Line 9: no step definition matches "And I frobnicate "#seeAllResults""']);
    return true;
  });
});
