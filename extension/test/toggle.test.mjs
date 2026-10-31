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
const { toggleOf, isToggleInput, styledAwayToggleLabel, textAround } = await load();

/**
 * A node with just what the toggle helpers read: tag, attributes, ancestors, a label's
 * control, its box and computed style, its text children.
 */
function node(tag, { attrs = {}, parent = null, box = { width: 20, height: 20 }, style = {}, texts = [], labels, ...props } = {}) {
  const view = { getComputedStyle: (el) => ({ opacity: '1', visibility: 'visible', ...el.style }) };
  const n = {
    tagName: tag.toUpperCase(),
    parent,
    parentElement: parent,
    style,
    labels,
    ownerDocument: { defaultView: view },
    getBoundingClientRect: () => box,
    childNodes: texts.map((text) => ({ nodeType: 3, textContent: text })),
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

// izitest-test.html's "Dark mode" toggle: <div class="toggle-wrap"><label class="toggle">
// <input type="checkbox" style="opacity:0;width:0;height:0">…</label> Dark mode</div>
function darkModeToggle() {
  const wrap = node('div', { texts: ['\n  ', ' Dark mode\n'] });
  const label = node('label', { parent: wrap, texts: ['\n   '] });
  const input = node('input', { parent: label, type: 'checkbox', checked: true, box: { width: 0, height: 0 }, style: { opacity: '0' } });
  return { wrap, label, input };
}

test('a toggle input is a checkbox or a radio input, nothing else', () => {
  assert.equal(isToggleInput(node('input', { type: 'checkbox' })), true);
  assert.equal(isToggleInput(node('input', { type: 'radio' })), true);
  assert.equal(isToggleInput(node('input', { type: 'text' })), false);
  assert.equal(isToggleInput(node('div', { attrs: { role: 'checkbox' } })), false);
});

test('a box styled away behind a label that shows is operated through that label', () => {
  const { label, input } = darkModeToggle();
  assert.equal(styledAwayToggleLabel(input), label);
});

test('a box that shows, or with no label that shows, is clicked itself', () => {
  const shown = node('input', { type: 'checkbox', parent: node('label') });
  assert.equal(styledAwayToggleLabel(shown), null);
  const hiddenLabel = node('label', { box: { width: 0, height: 0 } });
  assert.equal(styledAwayToggleLabel(node('input', { type: 'checkbox', parent: hiddenLabel, style: { opacity: '0' } })), null);
  assert.equal(styledAwayToggleLabel(node('input', { type: 'checkbox', style: { opacity: '0' } })), null);
});

test('a separate <label for> counts too', () => {
  const label = node('label');
  const input = node('input', { type: 'radio', labels: [label], box: { width: 0, height: 0 } });
  assert.equal(styledAwayToggleLabel(input), label);
});

test('a control with no name is named by the text next to it', () => {
  assert.equal(textAround(darkModeToggle().input), 'Dark mode');
  assert.equal(textAround(node('input', { parent: node('div', { parent: node('div', { parent: node('div', { parent: node('div', { texts: ['far'] }) }) }) }) })), '');
});
