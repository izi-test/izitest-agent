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

// Recorded on izitest-test.html: positional selectors that hold only while the layout does.
const SIGN_IN = {
  command: 'click',
  params: { selector: '#login-form > div:nth-of-type(3) > button:nth-of-type(1)' },
  locators: [{ type: 'aria', value: 'Sign in' }, { type: 'text', value: 'Sign in' }, { type: 'css', value: '#login-form > div:nth-of-type(3) > button:nth-of-type(1)' }],
};
const TECHNOLOGY = {
  command: 'click',
  params: { selector: '#profile-form > div:nth-of-type(4) > div > label:nth-of-type(1) > input', checked: true },
  locators: [{ type: 'aria', value: 'Technology' }, { type: 'attribute', value: 'input[name="interests"]' }, { type: 'css', value: '#profile-form > div:nth-of-type(4) > div > label:nth-of-type(1) > input' }],
};

test('a positional button is found by its role and name, not by a text the heading shares', () => {
  assert.match(render(SIGN_IN), /await page\.getByRole\('button', \{ name: 'Sign in', exact: true \}\)\.click\(\);/);
});

test('a box of a group by its label, not by the name attribute all the boxes share', () => {
  const out = render(TECHNOLOGY);
  assert.match(out, /await page\.getByLabel\('Technology'\)\.check\(\);/);
  assert.doesNotMatch(out, /interests/);
});

test('with nothing better recorded, the positional selector stays, without a FIXME', () => {
  const out = render({ command: 'click', params: { selector: '#list > li:nth-of-type(3)' } });
  assert.match(out, /await page\.click\('#list > li:nth-of-type\(3\)'\);/);
  assert.doesNotMatch(out, /FIXME/);
});

test('a box styled away is checked through the label that holds it', () => {
  const out = render({ command: 'click', params: { selector: 'input[name="darkMode"]', checked: false, viaLabel: true } });
  assert.match(out, /await page\.locator\('label', \{ has: page\.locator\('input\[name="darkMode"\]'\) \}\)\.uncheck\(\);/);
});

test('the role and name Chrome gave the element win over what the snapshot computed', () => {
  // <button><span style="display:none">caché</span>Valider</button>: the snapshot reads the
  // hidden text, Chrome's accessible name does not.
  const out = render({
    command: 'click',
    params: { selector: '#form > div:nth-of-type(2) > button' },
    locators: [{ type: 'aria', value: 'cachéValider' }, { type: 'role', value: 'button', name: 'Valider' }],
  });
  assert.match(out, /await page\.getByRole\('button', \{ name: 'Valider', exact: true \}\)\.click\(\);/);
  // A <div role="switch">: no tag says it is one, Chrome does.
  assert.match(render({
    command: 'click',
    params: { selector: '#prefs > div:nth-of-type(3)' },
    locators: [{ type: 'role', value: 'switch', name: 'Notifications' }],
  }), /await page\.getByRole\('switch', \{ name: 'Notifications', exact: true \}\)\.click\(\);/);
});

test('a box styled away behind a separate <label for> is checked through that label', () => {
  const step = (id) => ({ command: 'click', params: { selector: `#${id}`, checked: true, viaLabel: true, labelFor: id }, locators: [{ type: 'aria', value: "J'accepte les CGU" }] });
  assert.match(render(step('cgu')), /await page\.check\('label\[for="cgu"\]'\);/);
  // The id is generated: the label by its text instead.
  assert.match(render(step('3e100fe7-d4c2-11f1-941e-2bb1b8b86cc4')), /await page\.locator\('label', \{ hasText: 'J\\'accepte les CGU' \}\)\.check\(\);/);
});
