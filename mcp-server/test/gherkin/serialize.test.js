// Unit tests for the Gherkin serializer.
// Run with: node --test test/gherkin/serialize.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeTestToFeatureWith } from '../../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

// Emulate the shape returned by the DB layer (id + keeping params_template as object).
const SEED = DEFAULT_STEP_DEFINITIONS.map((def, i) => ({ id: i + 1, ...def }));

test('serializes a simple click test', () => {
  const t = {
    name: 'Click submit',
    description: '',
    steps: [
      { command: 'navigate', params: { url: 'https://example.com' } },
      { command: 'click', params: { selector: '#submit' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /Feature: Click submit/);
  assert.match(feature, /Scenario: Click submit/);
  assert.match(feature, /Given I am on "https:\/\/example\.com"/);
  assert.match(feature, /When I click on "#submit"/);
});

test('collapses consecutive same-keyword steps to "And"', () => {
  const t = {
    name: 'Login',
    steps: [
      { command: 'click', params: { selector: '#email' } },
      { command: 'click', params: { selector: '#password' } },
      { command: 'click', params: { selector: '#submit' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  const whens = feature.split('\n').filter(l => l.trim().startsWith('When') || l.trim().startsWith('And'));
  assert.equal(whens[0].trim().startsWith('When'), true);
  assert.equal(whens[1].trim().startsWith('And'), true);
  assert.equal(whens[2].trim().startsWith('And'), true);
});

test('serializes a fill step with two arguments', () => {
  const t = {
    name: 'Fill email',
    steps: [
      { command: 'fill', params: { selector: '#email', value: 'foo@bar.com' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /When I fill "#email" with "foo@bar\.com"/);
});

test('serializes an assertion using step.assertion bag', () => {
  const t = {
    name: 'Check welcome',
    steps: [
      {
        command: 'assert',
        params: {},
        assertion: { type: 'text_contains', expected: 'Welcome' },
      },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /Then I should see "Welcome"/);
});

test('prefers the most specific assertion template when multiple could match', () => {
  const t = {
    name: 'Check .msg contains Hello',
    steps: [
      {
        command: 'assert',
        params: {},
        assertion: { type: 'text_contains', selector: '.msg', expected: 'Hello' },
      },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  // The 3-key template "{string} should contain {string}" must win over the
  // 2-key "I should see {string}" because it carries the selector.
  assert.match(feature, /Then "\.msg" should contain "Hello"/);
});

test('serializes "wait X seconds" by reverse-matching "{0}000" template', () => {
  const t = {
    name: 'Wait 5s',
    steps: [
      { command: 'wait', params: { ms: '5000' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /When I wait 5 seconds/);
});

test('falls back to intent when no definition matches', () => {
  const t = {
    name: 'Exotic step',
    steps: [
      { command: 'execute_js', params: { code: 'console.log(1)' }, intent: 'log something' },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  // Fallback keyword is "When" and phrase is the intent in quotes
  assert.match(feature, /When "log something"/);
});

test('uses explicit step_definition_id when provided', () => {
  const t = {
    name: 'Explicit link',
    steps: [
      {
        command: 'navigate',
        params: { url: 'https://a.com' },
        step_definition_id: SEED.find(d => d.pattern === 'I navigate to {string}').id,
      },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /When I navigate to "https:\/\/a\.com"/);
  assert.doesNotMatch(feature, /Given I am on/);
});

test('quotes a string holding double quotes in single quotes, and escapes it when it holds both', () => {
  const t = {
    name: 'Quotes',
    steps: [
      { command: 'click', params: { selector: 'button[title="ok"]' } },
      { command: 'click', params: { selector: `button[title="it's"]` } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /When I click on 'button\[title="ok"\]'/);
  assert.match(feature, /And I click on "button\[title=\\"it's\\"\]"/);
  assert.deepEqual(parseFeatureToStepsWith(feature, SEED).map(s => s.params.selector), t.steps.map(s => s.params.selector));
});

test('includes the description lines indented under Feature', () => {
  const t = {
    name: 'With desc',
    description: 'line 1\nline 2',
    steps: [{ command: 'navigate', params: { url: '/' } }],
  };
  const feature = serializeTestToFeatureWith(t, SEED);
  assert.match(feature, /Feature: With desc\n {2}line 1\n {2}line 2/);
});
