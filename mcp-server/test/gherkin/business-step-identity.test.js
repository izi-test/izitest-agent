// Unit tests for recognising a business step in another recording, whose selectors hold
// other generated IDs or positions. Run with: node --test test/gherkin/business-step-identity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessStep } from '../../lib/gherkin/business-step.js';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));

/** Bien'ici's garden filter as one recording saw it: the label's for is a uuid made at each load. */
const gardenClick = (uuid, extra = {}) => ({
  command: 'click',
  params: { selector: `label[for="${uuid}"]`, ...extra },
  locators: [{ type: 'aria', value: 'Jardin' }, { type: 'text', value: 'Jardin (44)' }, { type: 'css', value: `label[for="${uuid}"]` }],
});
const recording = (uuid, extra) => ({
  name: `recherche ${uuid}`,
  steps: [
    { command: 'click', params: { selector: 'div.moreFilterBtn' } },
    gardenClick(uuid, extra),
    { command: 'click', params: { selector: '#seeAllResults' } },
  ],
});

/** The business step, built from the first recording. */
function gardenStep(from = recording('92595267-d4c1-11f1-9672-93f1a5382911')) {
  const { steps_template } = buildBusinessStep(from, { from_step: 1, to_step: 3, pattern: 'je ne garde que les maisons avec jardin' });
  return { id: 100, keyword: 'When', pattern: 'je ne garde que les maisons avec jardin', command: 'composite', params_template: {}, steps_template, is_default: 0 };
}
const readsAsBusiness = (t, definition = gardenStep()) =>
  /When je ne garde que les maisons avec jardin\n/.test(serializeTestToFeatureWith(t, [...DEFAULTS, definition]));

test('another recording of the same steps, with another generated ID, reads as the business step', () => {
  assert.equal(readsAsBusiness(recording('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4')), true);
  assert.equal(readsAsBusiness(recording('aeb80c37-d4c1-11f1-955a-67345967af7c', { checked: true })), true,
    'a state recorded later does not keep it from matching a step built without one');
});

test('another element is not taken for it: a stable selector that differs, another name', () => {
  const otherFilter = recording('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4');
  otherFilter.steps[1].locators[0] = { type: 'aria', value: 'Piscine' };
  assert.equal(readsAsBusiness(otherFilter), false);

  const stableButOther = recording('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4');
  stableButOther.steps[2] = { command: 'click', params: { selector: '#seeAllOffers' } };
  assert.equal(readsAsBusiness(stableButOther), false);
});

test('the other parameters still have to match: a box built checked is not one unchecked', () => {
  const checked = gardenStep(recording('92595267-d4c1-11f1-9672-93f1a5382911', { checked: true }));
  assert.equal(readsAsBusiness(recording('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4', { checked: false }), checked), false);
  assert.equal(readsAsBusiness(recording('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4', { checked: true }), checked), true);
});

test('a position that moved is the same element when tag and name agree', () => {
  const save = (nth) => ({
    name: 'profil',
    steps: [{ command: 'click', params: { selector: `#profile-form > div:nth-of-type(${nth}) > button:nth-of-type(1)` }, locators: [{ type: 'aria', value: 'Save profile' }] }],
  });
  const { steps_template } = buildBusinessStep(save(8), { from_step: 1, to_step: 1, pattern: "j'enregistre le profil" });
  const definition = { id: 101, keyword: 'When', pattern: "j'enregistre le profil", command: 'composite', params_template: {}, steps_template, is_default: 0 };
  assert.match(serializeTestToFeatureWith(save(9), [...DEFAULTS, definition]), /When j'enregistre le profil/);
});

test('a box of a group is not every box: the name attribute they share proves nothing', () => {
  const interest = (label, nth) => ({
    command: 'click',
    params: { selector: `#profile-form > div:nth-of-type(4) > div > label:nth-of-type(${nth}) > input`, checked: true },
    locators: [{ type: 'aria', value: label }, { type: 'attribute', value: 'input[name="interests"]' }],
  });
  const { steps_template } = buildBusinessStep({ name: 'a', steps: [interest('Technology', 1)] }, { from_step: 1, to_step: 1, pattern: "j'aime la technologie" });
  const definition = { id: 102, keyword: 'When', pattern: "j'aime la technologie", command: 'composite', params_template: {}, steps_template, is_default: 0 };
  const feature = (step) => serializeTestToFeatureWith({ name: 'b', steps: [step] }, [...DEFAULTS, definition]);
  assert.doesNotMatch(feature(interest('Music', 3)), /j'aime la technologie/);
  assert.match(feature(interest('Technology', 2)), /j'aime la technologie/);
});

test('a business step built before locators were kept still needs the exact selector', () => {
  const definition = gardenStep();
  definition.steps_template = definition.steps_template.map(({ locators, ...tpl }) => tpl);
  assert.equal(readsAsBusiness(recording('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4'), definition), false);
  assert.equal(readsAsBusiness(recording('92595267-d4c1-11f1-9672-93f1a5382911'), definition), true);
});

test('the role and name Chrome gave both clicks identify the element too', () => {
  const click = (nth) => ({
    command: 'click',
    params: { selector: `#app > div:nth-of-type(${nth}) > div` },
    locators: [{ type: 'role', value: 'switch', name: 'Notifications' }],
  });
  const { steps_template } = buildBusinessStep({ name: 'a', steps: [click(2)] }, { from_step: 1, to_step: 1, pattern: "j'active les notifications" });
  const definition = { id: 103, keyword: 'When', pattern: "j'active les notifications", command: 'composite', params_template: {}, steps_template, is_default: 0 };
  assert.match(serializeTestToFeatureWith({ name: 'b', steps: [click(5)] }, [...DEFAULTS, definition]), /When j'active les notifications/);
});
