// Unit tests for the locator chosen by generated code when a recorded selector holds a
// generated ID. Run with: node --test test/codegen/locators.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFragileSelector } from '../../lib/codegen/locators.js';
import { generatePlaywrightPlain } from '../../lib/codegen/playwright-plain.js';

const render = (...steps) => generatePlaywrightPlain({ name: 't', steps });

// Recorded on Bien'ici: the <label for> of the "Jardin" filter holds a uuid made at each load,
// and its text carries a listing count.
const JARDIN = {
  command: 'click',
  params: { selector: 'label[for="\\39 2595267-d4c1-11f1-9672-93f1a5382911"]' },
  locators: [
    { type: 'aria', value: 'Jardin' },
    { type: 'text', value: 'Jardin (44)' },
    { type: 'css', value: 'label[for="\\39 2595267-d4c1-11f1-9672-93f1a5382911"]' },
    { type: 'xpath', value: '//label[@for="92595267-d4c1-11f1-9672-93f1a5382911"]' },
  ],
};

test('generated IDs are spotted, CSS escapes included', () => {
  for (const selector of [
    JARDIN.params.selector,
    '#\\:r1\\:',
    '#radix-12',
    'div[aria-labelledby="headlessui-label-3"] > span',
    'button.Button_root__a1b2c3',
    '.css-1x2y3z',
    'input[id="field-123456"]',
  ]) {
    assert.equal(isFragileSelector(selector), true, selector);
  }
});

test('stable selectors are left alone', () => {
  for (const selector of [
    '#seeAllResults',
    'div.moreFilterBtn',
    'input[name="hasGarden"]',
    'button[title=\'ok\']',
    '[data-testid="submit"]',
    '#searchResultsContainer > div:nth-of-type(1) > form',
    'a[href="/annonce/123456"]',
    '',
  ]) {
    assert.equal(isFragileSelector(selector), false, selector);
  }
});

test('a <label> whose for is generated is clicked as a label, by its own text', () => {
  const out = render(JARDIN);
  assert.match(out, /await page\.locator\('label', \{ hasText: 'Jardin' \}\)\.click\(\);/);
  assert.doesNotMatch(out, /92595267|Jardin \(44\)/);
});

test('a stable recorded selector keeps the code generated so far', () => {
  const out = render({
    command: 'click',
    params: { selector: '#seeAllResults' },
    locators: [{ type: 'text', value: 'Voir les 44 annonces' }, { type: 'css', value: '#seeAllResults' }],
  });
  assert.match(out, /await page\.click\('#seeAllResults'\);/);
});

test('a data-testid comes first, then another stable CSS locator', () => {
  const fragile = '#field-123456';
  assert.match(render({
    command: 'click',
    params: { selector: fragile },
    locators: [{ type: 'css', value: 'button.save' }, { type: 'testid', value: '[data-testid="save"]' }],
  }), /await page\.click\('\[data-testid="save"\]'\);/);
  assert.match(render({
    command: 'click',
    params: { selector: fragile },
    locators: [{ type: 'css', value: fragile }, { type: 'attribute', value: 'button[name="save"]' }],
  }), /await page\.click\('button\[name="save"\]'\);/);
});

test('a checkbox clicked directly is found by its label', () => {
  const out = render({
    command: 'click',
    params: { selector: 'input[id="f-3e100fe7-d4c2-11f1"]' },
    locators: [{ type: 'aria', value: 'Jardin (44)' }, { type: 'attribute', value: 'input[id="f-3e100fe7-d4c2-11f1"]' }],
  });
  assert.match(out, /await page\.getByLabel\('Jardin \(44\)'\)\.click\(\);/);
});

test('a field with a generated ID is filled by its label, the value kept', () => {
  const out = render({
    command: 'fill',
    params: { selector: '#\\:r4\\:', value: '{{email}}' },
    locators: [{ type: 'aria', value: 'E-mail' }, { type: 'css', value: '#\\:r4\\:' }],
  });
  assert.match(out, /await page\.getByLabel\('E-mail'\)\.fill\(`\$\{VARS\.email\}`\);/);
});

test('a placeholder, then an exact text, when no label applies', () => {
  assert.match(render({
    command: 'click',
    params: { selector: '#search-998877' },
    locators: [{ type: 'placeholder', value: 'Ville ou code postal' }],
  }), /await page\.getByPlaceholder\('Ville ou code postal', \{ exact: true \}\)\.click\(\);/);
  assert.match(render({
    command: 'click',
    params: { selector: 'div.css-1q2w3e' },
    locators: [{ type: 'aria', value: 'Afficher tous les critères' }, { type: 'text', value: 'Afficher tous les critères' }],
  }), /await page\.getByText\('Afficher tous les critères', \{ exact: true \}\)\.click\(\);/);
});

test('nothing stable recorded: the selector stays, flagged with a FIXME', () => {
  const out = render({ command: 'click', params: { selector: '#node-12345678' } });
  assert.match(out, /\n {2}\/\/ FIXME: this selector holds an ID the page generates at each load[^\n]*\n {2}await page\.click\('#node-12345678'\);/);
});

test('locator-based scroll, hover, press and wait use the locator API', () => {
  const step = (command, params = {}) => ({ ...JARDIN, command, params: { ...JARDIN.params, ...params } });
  const out = render(step('hover'), step('press', { key: 'Enter' }), step('scroll'), step('wait'));
  const label = "page\\.locator\\('label', \\{ hasText: 'Jardin' \\}\\)";
  assert.match(out, new RegExp(`await ${label}\\.hover\\(\\);`));
  assert.match(out, new RegExp(`await ${label}\\.press\\('Enter'\\);`));
  assert.match(out, new RegExp(`await ${label}\\.scrollIntoViewIfNeeded\\(\\);`));
  assert.match(out, new RegExp(`await ${label}\\.waitFor\\(\\);`));
});
