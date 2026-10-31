// Unit tests for the codegen entry point shared by the dashboard route and get_test_as_code.
// Run with: node --test test/codegen/generate-test-code.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestCode, formatCodeFiles } from '../../lib/codegen/index.js';

const RECORDED = {
  name: 'Recherche Bien’ici Antony',
  project_id: 7,
  steps: [
    { command: 'navigate', params: { url: 'https://www.bienici.com' } },
    { command: 'click', params: { selector: '#search' } },
  ],
};

const noDefinitions = () => assert.fail('step definitions must not be read for playwright-plain');

test('playwright-plain: one spec file named after the test', () => {
  const result = generateTestCode(RECORDED, 'playwright-plain', noDefinitions);
  assert.equal(result.error, undefined);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'tests/recherche-bien-ici-antony.spec.js');
  assert.match(result.files[0].content, /from '@playwright\/test'/);
  assert.match(result.files[0].content, /page\.goto\('https:\/\/www\.bienici\.com'\)/);
});

test('playwright-cucumber: reads the definitions of the test\'s own project', () => {
  let askedFor;
  const result = generateTestCode(RECORDED, 'playwright-cucumber', (projectId) => {
    askedFor = projectId;
    return [];
  });
  assert.equal(askedFor, 7);
  assert.ok(result.files.some(f => f.path === 'features/recherche-bien-ici-antony.feature'));
  assert.ok(result.files.some(f => f.path === 'package.json'));
});

test('playwright-cucumber without a project is refused with a 400', () => {
  const result = generateTestCode({ ...RECORDED, project_id: null }, 'playwright-cucumber', () => []);
  assert.equal(result.status, 400);
  assert.match(result.error, /not assigned to a project/);
});

test('an unknown framework is refused with a 400 that lists the known ones', () => {
  const result = generateTestCode(RECORDED, 'cypress', noDefinitions);
  assert.equal(result.status, 400);
  assert.match(result.error, /playwright-plain, playwright-cucumber/);
});

test('formatCodeFiles: a heading per path and a fenced block in the file\'s language', () => {
  const text = formatCodeFiles([
    { path: 'tests/a.spec.js', content: "test('a');\n" },
    { path: 'features/a.feature', content: 'Feature: A' },
  ]);
  assert.equal(text, "### tests/a.spec.js\n```js\ntest('a');\n```\n\n### features/a.feature\n```gherkin\nFeature: A\n```");
});

test('formatCodeFiles: the fence outgrows any backticks in the code', () => {
  const content = 'const md = `\n```\nnested\n```\n`;\n';
  const text = formatCodeFiles([{ path: 'x.js', content }]);
  assert.ok(text.startsWith('### x.js\n````js\n'));
  assert.ok(text.endsWith('\n````'));
  assert.ok(text.includes(content));
});
