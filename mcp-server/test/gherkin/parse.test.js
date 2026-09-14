// Unit tests for the Gherkin parser.
// Run with: node --test test/gherkin/parse.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatureToStepsWith } from '../../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

const SEED = DEFAULT_STEP_DEFINITIONS.map((def, i) => ({ id: i + 1, ...def }));

function parse(feature) {
  return parseFeatureToStepsWith(feature, SEED);
}

test('parses a minimal navigate + click scenario', () => {
  const steps = parse(`
Feature: Basic
  Scenario: Basic
    Given I am on "https://example.com"
    When I click on "#submit"
`);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].command, 'navigate');
  assert.deepEqual(steps[0].params, { url: 'https://example.com' });
  assert.equal(steps[1].command, 'click');
  assert.deepEqual(steps[1].params, { selector: '#submit' });
});

test('parses a fill step with two string arguments', () => {
  const steps = parse(`
Feature: Fill
  Scenario: Fill
    When I fill "#email" with "foo@bar.com"
`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, 'fill');
  assert.deepEqual(steps[0].params, { selector: '#email', value: 'foo@bar.com' });
});

test('parses "wait N seconds" and hydrates {0}000 correctly', () => {
  const steps = parse(`
Feature: Wait
  Scenario: Wait
    When I wait 3 seconds
`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, 'wait');
  assert.equal(steps[0].params.ms, '3000');
});

test('parses an assertion into step.assertion, not step.params', () => {
  const steps = parse(`
Feature: Assert
  Scenario: Assert
    Then I should see "Welcome"
`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, 'assert');
  assert.deepEqual(steps[0].params, {});
  assert.deepEqual(steps[0].assertion, { type: 'text_contains', expected: 'Welcome' });
});

test('resolves And/But by inheriting the previous keyword', () => {
  const steps = parse(`
Feature: And
  Scenario: And
    When I click on "#a"
    And I click on "#b"
    And I click on "#c"
`);
  assert.equal(steps.length, 3);
  assert.ok(steps.every(s => s.command === 'click'));
});

test('sets step_definition_id and intent on each resolved step', () => {
  const steps = parse(`
Feature: Link
  Scenario: Link
    When I click on "#submit"
`);
  assert.equal(typeof steps[0].step_definition_id, 'number');
  assert.equal(steps[0].intent, 'I click on "#submit"');
});

test('numbers step_order starting at 1', () => {
  const steps = parse(`
Feature: Order
  Scenario: Order
    Given I am on "/"
    When I click on "#a"
    Then I should see "ok"
`);
  assert.deepEqual(steps.map(s => s.step_order), [1, 2, 3]);
});

test('throws a clear error when a phrase does not match any definition', () => {
  assert.throws(
    () => parse(`
Feature: Bad
  Scenario: Bad
    When I teleport to "Mars"
`),
    (err) => {
      assert.equal(err.code, 'GHERKIN_UNRESOLVED');
      assert.match(err.message, /no step definition matches/);
      assert.match(err.message, /I teleport to "Mars"/);
      return true;
    }
  );
});

test('throws when the document has no Feature', () => {
  assert.throws(() => parse('# just a comment\n'), /No Feature found/);
});

test('throws when the Feature has no Scenario', () => {
  assert.throws(
    () => parse(`
Feature: Empty
`),
    /No Scenario found/
  );
});

test('round-trip: serialize then parse yields equivalent test_steps', async () => {
  const { serializeTestToFeatureWith } = await import('../../lib/gherkin/serialize.js');
  const original = {
    name: 'Round trip',
    steps: [
      { command: 'navigate', params: { url: 'https://example.com' } },
      { command: 'fill', params: { selector: '#email', value: 'a@b.c' } },
      { command: 'click', params: { selector: '#submit' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', expected: 'Welcome' } },
    ],
  };
  const feature = serializeTestToFeatureWith(original, SEED);
  const parsed = parseFeatureToStepsWith(feature, SEED);

  assert.equal(parsed.length, original.steps.length);
  for (let i = 0; i < parsed.length; i++) {
    assert.equal(parsed[i].command, original.steps[i].command);
  }
  assert.deepEqual(parsed[1].params, original.steps[1].params);
  assert.deepEqual(parsed[3].assertion, original.steps[3].assertion);
});
