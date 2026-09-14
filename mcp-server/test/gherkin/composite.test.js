// Unit tests for composite (multi-step) step definitions.
// Run with: node --test test/gherkin/composite.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../../lib/gherkin/parse.js';
import { generatePlaywrightCucumber } from '../../lib/codegen/playwright-cucumber.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

// Single-step seed definitions (same as other tests)
const SEED = DEFAULT_STEP_DEFINITIONS.map((def, i) => ({ id: i + 1, ...def }));

// A composite "login" definition — one Gherkin phrase, four test_steps.
const LOGIN_COMPOSITE = {
  id: 100,
  keyword: 'When',
  pattern: 'I login with {string} and {string}',
  command: 'composite',
  params_template: {},
  steps_template: [
    { command: 'navigate', params: { url: '/login' } },
    { command: 'fill',     params: { selector: '#username', value: '{0}' } },
    { command: 'fill',     params: { selector: '#password', value: '{1}' } },
    { command: 'click',    params: { selector: '#submit' } },
  ],
};

const DEFS_WITH_LOGIN = [...SEED, LOGIN_COMPOSITE];

// ─── Serialize tests ───────────────────────────────────────────────

test('serialize: collapses a matching sequence into a composite step', () => {
  const t = {
    name: 'Login test',
    steps: [
      { command: 'navigate', params: { url: '/login' } },
      { command: 'fill',     params: { selector: '#username', value: 'admin' } },
      { command: 'fill',     params: { selector: '#password', value: 'secret' } },
      { command: 'click',    params: { selector: '#submit' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, DEFS_WITH_LOGIN);
  assert.match(feature, /When I login with "admin" and "secret"/);
  // The four steps should be collapsed into one line, not four
  const stepLines = feature.split('\n').filter(l => l.match(/^\s+(Given|When|Then|And)\s/));
  assert.equal(stepLines.length, 1);
});

test('serialize: uses explicit step_definition_id for composite match', () => {
  const t = {
    name: 'Login explicit',
    steps: [
      { command: 'navigate', params: { url: '/login' }, step_definition_id: 100 },
      { command: 'fill',     params: { selector: '#username', value: 'u' } },
      { command: 'fill',     params: { selector: '#password', value: 'p' } },
      { command: 'click',    params: { selector: '#submit' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, DEFS_WITH_LOGIN);
  assert.match(feature, /When I login with "u" and "p"/);
});

test('serialize: falls back to single steps when sequence does not match composite', () => {
  const t = {
    name: 'No composite match',
    steps: [
      { command: 'navigate', params: { url: '/login' } },
      { command: 'fill',     params: { selector: '#username', value: 'admin' } },
      // Missing the fill for password and click — not enough steps for composite
    ],
  };
  const feature = serializeTestToFeatureWith(t, DEFS_WITH_LOGIN);
  assert.match(feature, /Given I am on "\/login"/);
  assert.match(feature, /When I fill "#username" with "admin"/);
  assert.doesNotMatch(feature, /I login with/);
});

test('serialize: composite + trailing single steps', () => {
  const t = {
    name: 'Login then check',
    steps: [
      { command: 'navigate', params: { url: '/login' } },
      { command: 'fill',     params: { selector: '#username', value: 'admin' } },
      { command: 'fill',     params: { selector: '#password', value: 'pass' } },
      { command: 'click',    params: { selector: '#submit' } },
      { command: 'assert',   params: {}, assertion: { type: 'text_contains', expected: 'Welcome' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, DEFS_WITH_LOGIN);
  assert.match(feature, /When I login with "admin" and "pass"/);
  assert.match(feature, /Then I should see "Welcome"/);
  const stepLines = feature.split('\n').filter(l => l.match(/^\s+(Given|When|Then|And)\s/));
  assert.equal(stepLines.length, 2);
});

// ─── Parse tests ───────────────────────────────────────────────────

test('parse: expands a composite step into multiple test_steps', () => {
  const feature = `
Feature: Login
  Scenario: Login
    When I login with "admin" and "secret"
`;
  const steps = parseFeatureToStepsWith(feature, DEFS_WITH_LOGIN);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].command, 'navigate');
  assert.deepEqual(steps[0].params, { url: '/login' });
  assert.equal(steps[1].command, 'fill');
  assert.deepEqual(steps[1].params, { selector: '#username', value: 'admin' });
  assert.equal(steps[2].command, 'fill');
  assert.deepEqual(steps[2].params, { selector: '#password', value: 'secret' });
  assert.equal(steps[3].command, 'click');
  assert.deepEqual(steps[3].params, { selector: '#submit' });
});

test('parse: composite steps get sequential step_order', () => {
  const feature = `
Feature: Login
  Scenario: Login
    When I login with "a" and "b"
`;
  const steps = parseFeatureToStepsWith(feature, DEFS_WITH_LOGIN);
  assert.deepEqual(steps.map(s => s.step_order), [1, 2, 3, 4]);
});

test('parse: only first sub-step carries intent and step_definition_id', () => {
  const feature = `
Feature: Login
  Scenario: Login
    When I login with "u" and "p"
`;
  const steps = parseFeatureToStepsWith(feature, DEFS_WITH_LOGIN);
  assert.equal(steps[0].intent, 'I login with "u" and "p"');
  assert.equal(steps[0].step_definition_id, 100);
  assert.equal(steps[1].intent, null);
  assert.equal(steps[1].step_definition_id, null);
});

test('parse: composite followed by regular steps keeps correct ordering', () => {
  const feature = `
Feature: Login then check
  Scenario: Login then check
    When I login with "a" and "b"
    Then I should see "Welcome"
`;
  const steps = parseFeatureToStepsWith(feature, DEFS_WITH_LOGIN);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map(s => s.step_order), [1, 2, 3, 4, 5]);
  assert.equal(steps[4].command, 'assert');
  assert.deepEqual(steps[4].assertion, { type: 'text_contains', expected: 'Welcome' });
});

// ─── Round-trip tests ──────────────────────────────────────────────

test('round-trip: serialize composite then parse yields same test_steps', () => {
  const original = {
    name: 'Login roundtrip',
    steps: [
      { command: 'navigate', params: { url: '/login' } },
      { command: 'fill',     params: { selector: '#username', value: 'admin' } },
      { command: 'fill',     params: { selector: '#password', value: 'secret' } },
      { command: 'click',    params: { selector: '#submit' } },
    ],
  };
  const feature = serializeTestToFeatureWith(original, DEFS_WITH_LOGIN);
  const parsed = parseFeatureToStepsWith(feature, DEFS_WITH_LOGIN);

  assert.equal(parsed.length, original.steps.length);
  for (let i = 0; i < parsed.length; i++) {
    assert.equal(parsed[i].command, original.steps[i].command);
    if (original.steps[i].command !== 'assert') {
      assert.deepEqual(parsed[i].params, original.steps[i].params);
    }
  }
});

test('round-trip: composite + single steps survive serialization and parsing', () => {
  const original = {
    name: 'Full roundtrip',
    steps: [
      { command: 'navigate', params: { url: '/login' } },
      { command: 'fill',     params: { selector: '#username', value: 'u' } },
      { command: 'fill',     params: { selector: '#password', value: 'p' } },
      { command: 'click',    params: { selector: '#submit' } },
      { command: 'assert',   params: {}, assertion: { type: 'text_contains', expected: 'Dashboard' } },
    ],
  };
  const feature = serializeTestToFeatureWith(original, DEFS_WITH_LOGIN);
  const parsed = parseFeatureToStepsWith(feature, DEFS_WITH_LOGIN);

  assert.equal(parsed.length, 5);
  assert.equal(parsed[4].command, 'assert');
  assert.deepEqual(parsed[4].assertion, { type: 'text_contains', expected: 'Dashboard' });
});

// ─── Codegen tests ─────────────────────────────────────────────────

test('codegen: emits composite.steps.js when composite definitions exist', () => {
  const bundle = generatePlaywrightCucumber(
    { name: 'Login', steps: [] },
    DEFS_WITH_LOGIN
  );
  const paths = bundle.files.map(f => f.path);
  assert.ok(paths.includes('features/steps/composite.steps.js'));
});

test('codegen: composite.steps.js contains the pattern and Playwright actions', () => {
  const bundle = generatePlaywrightCucumber(
    { name: 'Login', steps: [] },
    DEFS_WITH_LOGIN
  );
  const composite = bundle.files.find(f => f.path === 'features/steps/composite.steps.js');
  assert.ok(composite);
  assert.match(composite.content, /I login with \{string\} and \{string\}/);
  assert.match(composite.content, /this\.page\.goto/);
  assert.match(composite.content, /this\.page\.fill/);
  assert.match(composite.content, /this\.page\.click/);
});

test('codegen: no composite.steps.js when there are no composite definitions', () => {
  const bundle = generatePlaywrightCucumber(
    { name: 'Simple', steps: [] },
    SEED  // only single-step definitions
  );
  const paths = bundle.files.map(f => f.path);
  assert.ok(!paths.includes('features/steps/composite.steps.js'));
});

// ─── Composite with assertion sub-step ─────────────────────────────

const CHECKOUT_COMPOSITE = {
  id: 101,
  keyword: 'Then',
  pattern: 'the checkout should show {string} for {string}',
  command: 'composite',
  params_template: {},
  steps_template: [
    { command: 'assert', params: { type: 'element_visible', selector: '.checkout' } },
    { command: 'assert', params: { type: 'text_contains', selector: '.total', expected: '{0}' } },
    { command: 'assert', params: { type: 'text_contains', selector: '.item-name', expected: '{1}' } },
  ],
};

const DEFS_WITH_CHECKOUT = [...SEED, CHECKOUT_COMPOSITE];

test('parse: composite with assert sub-steps populates assertion field', () => {
  const feature = `
Feature: Checkout
  Scenario: Checkout
    Then the checkout should show "$42" for "Widget"
`;
  const steps = parseFeatureToStepsWith(feature, DEFS_WITH_CHECKOUT);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].command, 'assert');
  assert.deepEqual(steps[0].assertion, { type: 'element_visible', selector: '.checkout' });
  assert.deepEqual(steps[0].params, {});
  assert.equal(steps[1].command, 'assert');
  assert.deepEqual(steps[1].assertion, { type: 'text_contains', selector: '.total', expected: '$42' });
  assert.equal(steps[2].command, 'assert');
  assert.deepEqual(steps[2].assertion, { type: 'text_contains', selector: '.item-name', expected: 'Widget' });
});

test('serialize: collapses assert sequence into composite assertion step', () => {
  const t = {
    name: 'Checkout test',
    steps: [
      { command: 'assert', params: {}, assertion: { type: 'element_visible', selector: '.checkout' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '.total', expected: '$42' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '.item-name', expected: 'Widget' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, DEFS_WITH_CHECKOUT);
  assert.match(feature, /Then the checkout should show "\$42" for "Widget"/);
  const stepLines = feature.split('\n').filter(l => l.match(/^\s+(Given|When|Then|And)\s/));
  assert.equal(stepLines.length, 1);
});
