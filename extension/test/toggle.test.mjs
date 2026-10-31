// Which checkbox, radio or switch a click acts on, and its state: what recording keeps so
// that replay sets the state instead of toggling. Reported live: Bien'ici's "Jardin" filter
// is a <label for> over a hidden <input type="checkbox">, clicked through its label.
//
// Pure function over plain objects shaped like DOM nodes — no browser needed.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'toggle.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'toggle-'));
  const outfile = join(dir, 'toggle.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(outfile);
}
const { toggleOf } = await load();

/** A node with just what toggleOf reads: tag, attributes, ancestors, a label's control. */
function node(tag, { attrs = {}, parent = null, ...props } = {}) {
  const n = {
    tagName: tag.toUpperCase(),
    parent,
    getAttribute: (name) => attrs[name] ?? null,
    // Enough of closest() for the selectors toggleOf uses.
    closest(selector) {
      for (let cur = n; cur; cur = cur.parent) {
        if (selector === 'label' && cur.tagName === 'LABEL') return cur;
        if (selector.includes('[role=') && ['checkbox', 'radio', 'switch'].includes(cur.getAttribute('role'))) return cur;
      }
      return null;
    },
    ...props,
  };
  return n;
}

test('a checkbox, a radio: their own state', () => {
  assert.deepEqual(toggleOf(node('input', { type: 'checkbox', checked: false })), { kind: 'checkbox', checked: false });
  assert.deepEqual(toggleOf(node('input', { type: 'radio', checked: true })), { kind: 'radio', checked: true });
});

test('a label, or a text inside it: the hidden control it labels (Bien\'ici)', () => {
  const input = node('input', { type: 'checkbox', checked: true });
  const label = node('label', { control: input });
  assert.deepEqual(toggleOf(label), { kind: 'checkbox', checked: true });
  assert.deepEqual(toggleOf(node('span', { parent: label })), { kind: 'checkbox', checked: true });
});

test('a custom switch or checkbox: aria-checked, also from a node inside it', () => {
  const sw = node('button', { attrs: { role: 'switch', 'aria-checked': 'true' } });
  assert.deepEqual(toggleOf(sw), { kind: 'switch', checked: true });
  const box = node('div', { attrs: { role: 'checkbox', 'aria-checked': 'false' } });
  assert.deepEqual(toggleOf(node('svg', { parent: box })), { kind: 'checkbox', checked: false });
});

test('anything else is no toggle: a button, a text field and its label', () => {
  assert.equal(toggleOf(node('button')), undefined);
  const field = node('input', { type: 'text', checked: false });
  assert.equal(toggleOf(field), undefined);
  assert.equal(toggleOf(node('label', { control: field })), undefined);
  assert.equal(toggleOf(node('label', { control: null })), undefined);
});
