// Date, time, colour and range inputs are given their value, not typed into: typing left a
// date empty, opened the colour picker, and moved a slider to wherever the click landed.
// Reported on izitest-test.html's profile form (birth date, accent colour, volume).
//
// Pure function over an object shaped like an <input> — no browser needed.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'picked-input.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'picked-'));
  const outfile = join(dir, 'picked.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(outfile);
}
const { pickedInputType, setPickedValue } = await load();

globalThis.Event ??= class Event { constructor(type, init) { this.type = type; Object.assign(this, init); } };

// What Chrome does with a value given to such an input: a date not in yyyy-mm-dd becomes
// empty, a colour is lower-cased (or black when unreadable), a range goes to its nearest step.
function sanitize(input, v) {
  switch (input.type) {
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
    case 'color': return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#000000';
    case 'range': {
      const min = Number(input.min || 0), max = Number(input.max || 100), step = Number(input.step || 1);
      const n = Number.isNaN(Number(v)) ? (min + max) / 2 : Number(v);
      return String(Math.min(max, Math.max(min, min + Math.round((n - min) / step) * step)));
    }
    default: return v;
  }
}

class FakeInput {
  #value;
  constructor(type, { value = '', ...attrs } = {}) {
    this.tagName = 'INPUT';
    this.type = type;
    Object.assign(this, attrs);
    this.#value = value;
    this.events = [];
    this.focused = false;
  }
  get value() { return this.#value; }
  set value(v) { this.#value = sanitize(this, String(v)); }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
}

test('which inputs are picked, not typed', () => {
  for (const type of ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']) {
    assert.equal(pickedInputType(new FakeInput(type)), type);
  }
  for (const type of ['text', 'email', 'number', 'checkbox', 'file']) assert.equal(pickedInputType(new FakeInput(type)), undefined);
  assert.equal(pickedInputType({ tagName: 'TEXTAREA', type: 'textarea' }), undefined);
});

test('a date, a colour, a range: the value is set, then input and change are sent', () => {
  for (const [type, value] of [['date', '1990-05-12'], ['color', '#ff5500'], ['range', '80']]) {
    const input = new FakeInput(type, { value: type === 'range' ? '50' : '' });
    assert.deepEqual(setPickedValue(input, value), { value });
    assert.equal(input.value, value);
    assert.deepEqual(input.events, ['input', 'change']);
    assert.equal(input.focused, true);
  }
});

test('a colour written in capitals is the same colour', () => {
  const input = new FakeInput('color', { value: '#000000' });
  assert.deepEqual(setPickedValue(input, '#FF5500'), { value: '#ff5500' });
});

test('a value the input cannot take is refused, and the input keeps its value', () => {
  const date = new FakeInput('date', { value: '2000-01-01' });
  const refused = setPickedValue(date, '12/05/1990');
  assert.match(refused.error, /date input does not take "12\/05\/1990".*yyyy-mm-dd/);
  assert.equal(date.value, '2000-01-01');
  assert.deepEqual(date.events, [], 'no change announced');

  const range = new FakeInput('range', { value: '50', min: '0', max: '100', step: '10' });
  assert.match(setPickedValue(range, '85').error, /would hold "90".*from 0 to 100, in steps of 10/);
  assert.equal(range.value, '50');
  assert.match(setPickedValue(range, '').error, /range input does not take ""/);
});

test('any other field: null, it is typed into', () => {
  assert.equal(setPickedValue(new FakeInput('text'), 'x'), null);
  assert.equal(setPickedValue({ tagName: 'DIV', type: undefined }, 'x'), null);
});

test('self-contained: it runs in the page from its source alone (handle.evaluate)', () => {
  const alone = new Function(`return (${setPickedValue.toString()})`)();
  const input = new FakeInput('range', { value: '50' });
  assert.deepEqual(alone(input, '80'), { value: '80' });
});
