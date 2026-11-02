// A form field found by the label a person reads next to it ("When I fill the field "Email"
// with …"): the field Playwright's getByLabel / getByPlaceholder finds in the exported code.
// izitest-test.html has two fields labelled "Email" — the login form's, then the contact
// form's — and its checkboxes sit inside their <label>.
//
// Pure functions over objects shaped like DOM nodes — no browser needed.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'field-label.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'field-label-'));
  const outfile = join(dir, 'field-label.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(outfile);
}
const { fieldByLabel, namesOf, fieldNames } = await load();

/**
 * A page of fields: each with its tag, attributes, labels, box and style. `byId` holds the
 * elements aria-labelledby points at. The document answers querySelectorAll with its fields
 * in page order — the only selector field-label.ts asks for.
 */
function page(build) {
  const byId = {};
  const view = { getComputedStyle: (el) => ({ visibility: el.style.visibility ?? 'visible' }) };
  const doc = { defaultView: view, getElementById: (id) => byId[id] ?? null, querySelectorAll: () => fields };
  const text = (content) => ({ textContent: content });
  const field = (tag, { attrs = {}, labels = [], box = { width: 120, height: 30 }, style = {}, id } = {}) => {
    const el = {
      tagName: tag.toUpperCase(),
      id,
      style,
      labels: labels.map((l) => (typeof l === 'string' ? text(l) : l)),
      ownerDocument: doc,
      getRootNode: () => doc,
      getAttribute: (name) => attrs[name] ?? null,
      getBoundingClientRect: () => box,
    };
    return el;
  };
  const fields = build({ field, text, byId });
  return doc;
}

const arena = page(({ field, text }) => [
  field('input', { labels: ['Email'], attrs: { placeholder: 'you@example.com' }, id: 'login-email' }),
  field('input', { labels: ['Password'], id: 'login-password' }),
  // <label class="check-item"><input type="checkbox"> Remember me</label>
  field('input', { attrs: { type: 'checkbox' }, labels: [text('\n  \n  Remember me\n')], id: 'login-remember' }),
  field('input', { labels: ['Email'], attrs: { placeholder: 'jane@company.com' }, id: 'contact-email' }),
  // <label><span>Phone</span> <em>*</em><input></label>
  field('input', { labels: ['Phone *'], id: 'contact-phone' }),
  field('input', { attrs: { placeholder: 'Start typing...' }, id: 'country-input' }),
]);

test('a field by its <label>: the first of two with that name, as getByLabel(…).first() finds it', () => {
  assert.equal(fieldByLabel('Email', [arena]).id, 'login-email');
  assert.equal(fieldByLabel('Password', [arena]).id, 'login-password');
});

test('the label around a checkbox names it, its spaces aside; a label by its whole text, as getByLabel reads it', () => {
  assert.equal(fieldByLabel('Remember me', [arena]).id, 'login-remember');
  assert.equal(fieldByLabel('Phone *', [arena]).id, 'contact-phone');
  assert.equal(fieldByLabel('Phone', [arena]), null);
});

test('a placeholder names a field that has no label', () => {
  assert.equal(fieldByLabel('Start typing...', [arena]).id, 'country-input');
});

test('exact: a part of the label, or another case, is not it', () => {
  assert.equal(fieldByLabel('Emai', [arena]), null);
  assert.equal(fieldByLabel('email', [arena]), null);
  assert.equal(fieldByLabel('   ', [arena]), null);
});

test('aria-labelledby names a field before aria-label, which names it before its <label>', () => {
  const doc = page(({ field, text, byId }) => {
    byId['card-title'] = text('Card number');
    return [
      field('input', { attrs: { 'aria-labelledby': 'card-title', 'aria-label': 'Number' }, labels: ['Card'], id: 'card' }),
      field('input', { attrs: { 'aria-label': 'Search' }, labels: ['Find'], id: 'search' }),
      // A reference to nothing is ignored, as Playwright ignores it.
      field('input', { attrs: { 'aria-labelledby': 'gone', 'aria-label': 'Zip' }, id: 'zip' }),
    ];
  });
  assert.deepEqual(namesOf(fieldByLabel('Card number', [doc])), ['Card number']);
  assert.equal(fieldByLabel('Number', [doc]), null);
  assert.equal(fieldByLabel('Card', [doc]), null);
  assert.equal(fieldByLabel('Search', [doc]).id, 'search');
  assert.equal(fieldByLabel('Find', [doc]), null);
  assert.equal(fieldByLabel('Zip', [doc]).id, 'zip');
});

test('the field that shows first: a hidden one earlier in the page is passed over', () => {
  const doc = page(({ field }) => [
    field('input', { labels: ['Search'], box: { width: 0, height: 0 }, id: 'mobile-search' }),
    field('input', { labels: ['Search'], style: { visibility: 'hidden' }, id: 'hidden-search' }),
    field('input', { labels: ['Search'], id: 'desktop-search' }),
  ]);
  assert.equal(fieldByLabel('Search', [doc]).id, 'desktop-search');
});

test('none shows: the first there is — a checkbox styled away is clicked through its label', () => {
  const doc = page(({ field }) => [
    field('input', { attrs: { type: 'checkbox' }, labels: ['Dark mode'], box: { width: 0, height: 0 }, id: 'dark-mode' }),
  ]);
  assert.equal(fieldByLabel('Dark mode', [doc]).id, 'dark-mode');
});

test('a same-origin iframe is searched after the page', () => {
  const inner = page(({ field }) => [field('input', { labels: ['Card number'], id: 'in-frame' })]);
  assert.equal(fieldByLabel('Card number', [arena, inner]).id, 'in-frame');
  assert.equal(fieldByLabel('Email', [arena, inner]).id, 'login-email');
});

test('the names of the fields that show, for an error that says what there is', () => {
  assert.deepEqual(fieldNames([arena]), ['Email', 'Password', 'Remember me', 'Phone *', 'Start typing...']);
});
