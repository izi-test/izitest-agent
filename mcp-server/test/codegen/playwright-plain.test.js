// Unit tests for the plain Playwright code generator.
// Run with: node --test test/codegen/playwright-plain.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlaywrightPlain } from '../../lib/codegen/playwright-plain.js';

test('emits the Playwright import header', () => {
  const out = generatePlaywrightPlain({ name: 'Empty', steps: [] });
  assert.match(out, /^import \{ test, expect \} from '@playwright\/test';/m);
  assert.match(out, /test\('Empty', async \(\{ page \}\) => \{/);
  assert.match(out, /\}\);\n$/);
});

test('renders navigate and click steps', () => {
  const out = generatePlaywrightPlain({
    name: 'Click submit',
    steps: [
      { command: 'navigate', params: { url: 'https://example.com' } },
      { command: 'click', params: { selector: '#submit' } },
    ],
  });
  assert.match(out, /await page\.goto\('https:\/\/example\.com'\);/);
  assert.match(out, /await page\.click\('#submit'\);/);
});

test('renders fill with two arguments', () => {
  const out = generatePlaywrightPlain({
    name: 'Fill',
    steps: [
      { command: 'fill', params: { selector: '#email', value: 'foo@bar.com' } },
    ],
  });
  assert.match(out, /await page\.fill\('#email', 'foo@bar\.com'\);/);
});

test('renders wait with numeric ms', () => {
  const out = generatePlaywrightPlain({
    name: 'Wait',
    steps: [{ command: 'wait', params: { ms: '3000' } }],
  });
  assert.match(out, /await page\.waitForTimeout\(3000\);/);
});

test('renders wait for selector', () => {
  const out = generatePlaywrightPlain({
    name: 'Wait sel',
    steps: [{ command: 'wait', params: { selector: '.loaded' } }],
  });
  assert.match(out, /await page\.waitForSelector\('\.loaded'\);/);
});

test('renders keyboard press', () => {
  const out = generatePlaywrightPlain({
    name: 'Key',
    steps: [{ command: 'keyboard', params: { key: 'Enter' } }],
  });
  assert.match(out, /await page\.keyboard\.press\('Enter'\);/);
});

test('renders text_contains assertion without selector as body check', () => {
  const out = generatePlaywrightPlain({
    name: 'See',
    steps: [
      { command: 'assert', params: {}, assertion: { type: 'text_contains', expected: 'Welcome' } },
    ],
  });
  assert.match(out, /await expect\(page\.locator\('body'\)\)\.toContainText\('Welcome'\);/);
});

test('renders text_contains assertion with selector', () => {
  const out = generatePlaywrightPlain({
    name: 'See',
    steps: [
      {
        command: 'assert',
        params: {},
        assertion: { type: 'text_contains', selector: '.msg', expected: 'Hello' },
      },
    ],
  });
  assert.match(out, /await expect\(page\.locator\('\.msg'\)\)\.toContainText\('Hello'\);/);
});

test('renders element_visible and element_not_exists assertions', () => {
  const out = generatePlaywrightPlain({
    name: 'Visible',
    steps: [
      { command: 'assert', assertion: { type: 'element_visible', selector: '#ok' } },
      { command: 'assert', assertion: { type: 'element_not_exists', selector: '.err' } },
    ],
  });
  assert.match(out, /await expect\(page\.locator\('#ok'\)\)\.toBeVisible\(\);/);
  assert.match(out, /await expect\(page\.locator\('\.err'\)\)\.toHaveCount\(0\);/);
});

test('renders url and title assertions', () => {
  const out = generatePlaywrightPlain({
    name: 'Url',
    steps: [
      { command: 'assert', assertion: { type: 'url_equals', expected: 'https://a.com/' } },
      { command: 'assert', assertion: { type: 'url_contains', expected: '/dashboard' } },
      { command: 'assert', assertion: { type: 'title_equals', expected: 'Home' } },
    ],
  });
  assert.match(out, /await expect\(page\)\.toHaveURL\('https:\/\/a\.com\/'\);/);
  assert.match(out, /await expect\(page\)\.toHaveURL\(new RegExp\('\/dashboard'\)\);/);
  assert.match(out, /await expect\(page\)\.toHaveTitle\('Home'\);/);
});

test('injects viewport with test.use() when defined', () => {
  const out = generatePlaywrightPlain({
    name: 'VP',
    viewport: { width: 1920, height: 1080 },
    steps: [],
  });
  assert.match(out, /test\.use\(\{ viewport: \{ width: 1920, height: 1080 \} \}\);/);
});

test('emits a VARS constant and template literal for {{var}} placeholders', () => {
  const out = generatePlaywrightPlain({
    name: 'Vars',
    variables: {
      username: { defaultValue: 'alice', type: 'string' },
    },
    steps: [
      { command: 'fill', params: { selector: '#email', value: '{{username}}@corp.com' } },
    ],
  });
  assert.match(out, /const VARS = \{/);
  assert.match(out, /username: 'alice',/);
  assert.match(out, /await page\.fill\('#email', `\$\{VARS\.username\}@corp\.com`\);/);
});

test('quotes variable keys that are not valid JS identifiers', () => {
  const out = generatePlaywrightPlain({
    name: 'Odd vars',
    variables: {
      'user-name': { defaultValue: 'bob' },
    },
    steps: [],
  });
  assert.match(out, /'user-name': 'bob',/);
});

test('emits description lines as leading comments inside the test body', () => {
  const out = generatePlaywrightPlain({
    name: 'With desc',
    description: 'line 1\nline 2',
    steps: [],
  });
  assert.match(out, /async \(\{ page \}\) => \{\n {2}\/\/ line 1\n {2}\/\/ line 2/);
});

test('escapes single quotes in string literals', () => {
  const out = generatePlaywrightPlain({
    name: 'Quotes',
    steps: [
      { command: 'click', params: { selector: "button[title='ok']" } },
    ],
  });
  assert.match(out, /await page\.click\('button\[title=\\'ok\\'\]'\);/);
});

test('escapes $ in user text so it is not misread as interpolation', () => {
  const out = generatePlaywrightPlain({
    name: 'Dollar',
    variables: { x: { defaultValue: '1' } },
    steps: [
      { command: 'fill', params: { selector: '#a', value: '${not-a-var} {{x}}' } },
    ],
  });
  assert.match(out, /`\\\$\{not-a-var\} \$\{VARS\.x\}`/);
});

test('falls back to a TODO comment for unknown commands', () => {
  const out = generatePlaywrightPlain({
    name: 'Weird',
    steps: [{ command: 'teleport', params: { where: 'Mars' } }],
  });
  assert.match(out, /\/\/ TODO: unsupported command 'teleport'/);
});

test('indents every rendered body line by two spaces', () => {
  const out = generatePlaywrightPlain({
    name: 'Indent',
    steps: [{ command: 'navigate', params: { url: '/' } }],
  });
  const bodyLine = out.split('\n').find((l) => l.includes('page.goto'));
  assert.ok(bodyLine && bodyLine.startsWith('  '), `expected 2-space indent, got: ${bodyLine}`);
});
