// Unit tests for the Playwright-Cucumber code generator.
// Run with: node --test test/codegen/playwright-cucumber.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlaywrightCucumber } from '../../lib/codegen/playwright-cucumber.js';
import { DEFAULT_STEP_DEFINITIONS } from '../../lib/gherkin/default-step-definitions.js';

const SEED = DEFAULT_STEP_DEFINITIONS.map((def, i) => ({ id: i + 1, ...def }));

function fileMap(bundle) {
  const map = {};
  for (const f of bundle.files) map[f.path] = f.content;
  return map;
}

test('returns the expected set of files', () => {
  const bundle = generatePlaywrightCucumber(
    { name: 'Click submit', steps: [{ command: 'click', params: { selector: '#go' } }] },
    SEED
  );
  const paths = bundle.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'cucumber.js',
    'features/click-submit.feature',
    'features/steps/default.steps.js',
    'features/support/world.js',
    'package.json',
  ]);
});

test('slugifies the test name for the feature file path', () => {
  const bundle = generatePlaywrightCucumber(
    { name: 'Signup — with email!', steps: [] },
    SEED
  );
  const paths = bundle.files.map((f) => f.path);
  assert.ok(paths.includes('features/signup-with-email.feature'));
});

test('falls back to "test" slug when the name is empty', () => {
  const bundle = generatePlaywrightCucumber({ name: '', steps: [] }, SEED);
  const paths = bundle.files.map((f) => f.path);
  assert.ok(paths.includes('features/test.feature'));
});

test('feature file contains the serialized Gherkin for the test steps', () => {
  const bundle = generatePlaywrightCucumber(
    {
      name: 'Fill email',
      steps: [
        { command: 'navigate', params: { url: 'https://example.com' } },
        { command: 'fill', params: { selector: '#email', value: 'foo@bar.com' } },
      ],
    },
    SEED
  );
  const feature = fileMap(bundle)['features/fill-email.feature'];
  assert.match(feature, /Feature: Fill email/);
  assert.match(feature, /Given I am on "https:\/\/example\.com"/);
  assert.match(feature, /When I fill "#email" with "foo@bar\.com"/);
});

test('default.steps.js imports @cucumber/cucumber and @playwright/test', () => {
  const bundle = generatePlaywrightCucumber({ name: 'x', steps: [] }, SEED);
  const steps = fileMap(bundle)['features/steps/default.steps.js'];
  assert.match(steps, /from '@cucumber\/cucumber'/);
  assert.match(steps, /from '@playwright\/test'/);
});

test('default.steps.js defines a handler for every default step pattern', () => {
  const bundle = generatePlaywrightCucumber({ name: 'x', steps: [] }, SEED);
  const steps = fileMap(bundle)['features/steps/default.steps.js'];
  // Every default pattern must be referenced literally in the steps file so
  // cucumber-expressions can resolve them at runtime.
  for (const def of DEFAULT_STEP_DEFINITIONS) {
    assert.ok(
      steps.includes(`'${def.pattern}'`),
      `steps file missing pattern '${def.pattern}'`
    );
  }
});

test('default.steps.js converts "{int} seconds" into waitForTimeout(seconds * 1000)', () => {
  const bundle = generatePlaywrightCucumber({ name: 'x', steps: [] }, SEED);
  const steps = fileMap(bundle)['features/steps/default.steps.js'];
  assert.match(steps, /waitForTimeout\(seconds \* 1000\)/);
});

test('world.js launches chromium in Before and cleans up in After', () => {
  const bundle = generatePlaywrightCucumber({ name: 'x', steps: [] }, SEED);
  const world = fileMap(bundle)['features/support/world.js'];
  assert.match(world, /import \{ chromium, request \} from 'playwright'/);
  assert.match(world, /Before\(async function/);
  assert.match(world, /After\(async function/);
  assert.match(world, /this\.browser = await chromium\.launch\(\)/);
  assert.match(world, /this\.page = await this\.context\.newPage\(\)/);
});

test('cucumber.js config points at the features and steps folders', () => {
  const bundle = generatePlaywrightCucumber({ name: 'x', steps: [] }, SEED);
  const cfg = fileMap(bundle)['cucumber.js'];
  assert.match(cfg, /paths: \['features\/\*\*\/\*\.feature'\]/);
  assert.match(cfg, /features\/steps\/\*\*\/\*\.js/);
  assert.match(cfg, /features\/support\/\*\*\/\*\.js/);
});

test('package.json is valid JSON with @cucumber/cucumber and playwright deps', () => {
  const bundle = generatePlaywrightCucumber({ name: 'Signup flow', steps: [] }, SEED);
  const pkg = JSON.parse(fileMap(bundle)['package.json']);
  assert.equal(pkg.name, 'signup-flow');
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.devDependencies['@cucumber/cucumber']);
  assert.ok(pkg.devDependencies['@playwright/test']);
  assert.ok(pkg.devDependencies.playwright);
  assert.equal(pkg.scripts.test, 'cucumber-js');
});

test('emits the same world/steps/config regardless of the test content', () => {
  const a = generatePlaywrightCucumber({ name: 'A', steps: [] }, SEED);
  const b = generatePlaywrightCucumber(
    { name: 'B', steps: [{ command: 'click', params: { selector: '#x' } }] },
    SEED
  );
  const amap = fileMap(a);
  const bmap = fileMap(b);
  assert.equal(amap['features/steps/default.steps.js'], bmap['features/steps/default.steps.js']);
  assert.equal(amap['features/support/world.js'], bmap['features/support/world.js']);
  assert.equal(amap['cucumber.js'], bmap['cucumber.js']);
});
