// Files given to a file input from inside the page: which input a ref stands for (the
// input, its drop zone, its label, the "Upload" button next to it), and the files it then
// holds. izitest-test.html's avatar is a drop zone hiding its <input type="file">.
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

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'file-input.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'file-input-'));
  const outfile = join(dir, 'file-input.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(outfile);
}
const { fileInputOf, putFiles } = await load();

// What putFiles uses of the page: a DataTransfer that collects File objects, events.
globalThis.DataTransfer ??= class {
  constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
};
globalThis.Event ??= class Event { constructor(type, init) { this.type = type; Object.assign(this, init); } };

/** A node with a tag, children and a parent: enough for querySelectorAll('input[type="file"]'). */
function node(tag, { type, children = [], ...props } = {}) {
  const n = { tagName: tag.toUpperCase(), type, parentElement: null, children, ...props };
  for (const child of children) child.parentElement = n;
  n.querySelectorAll = () => {
    const found = [];
    const visit = (el) => { for (const c of el.children) { if (c.tagName === 'INPUT' && c.type === 'file') found.push(c); visit(c); } };
    visit(n);
    return found;
  };
  return n;
}

test('the input itself, the one its label is for, the one inside a drop zone', () => {
  const input = node('input', { type: 'file' });
  assert.equal(fileInputOf(input), input);
  assert.equal(fileInputOf(node('label', { control: input })), input);
  const zone = node('div', { children: [node('span'), input] });
  assert.equal(fileInputOf(zone), input);
});

test('an "Upload" button next to its hidden input: the only one around it', () => {
  const input = node('input', { type: 'file' });
  const button = node('button');
  node('div', { children: [button, input] });
  assert.equal(fileInputOf(button), input);
});

test('none, or two at the level where one is found: null', () => {
  assert.equal(fileInputOf(node('div', { children: [node('span')] })), null);
  const button = node('button');
  node('div', { children: [button, node('input', { type: 'file' }), node('input', { type: 'file' })] });
  assert.equal(fileInputOf(button), null);
  assert.equal(fileInputOf(node('input', { type: 'text' })), null);
});

test('the files are put in the input, then input and change are sent', () => {
  const events = [];
  const input = node('input', { type: 'file', dispatchEvent: (e) => events.push(e.type) });
  const png = { name: 'avatar.png', type: 'image/png', base64: Buffer.from('PNG!').toString('base64') };
  assert.deepEqual(putFiles(input, [png]), { names: ['avatar.png'] });
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0].type, 'image/png');
  assert.deepEqual(events, ['input', 'change']);
});

test('several files need an input that takes several', async () => {
  const file = (name) => ({ name, type: 'text/plain', base64: '' });
  const single = node('input', { type: 'file', dispatchEvent: () => {} });
  assert.match(putFiles(single, [file('a.txt'), file('b.txt')]).error, /takes one file, not 2/);
  const multiple = node('input', { type: 'file', multiple: true, dispatchEvent: () => {} });
  assert.deepEqual(putFiles(multiple, [file('a.txt'), file('b.txt')]), { names: ['a.txt', 'b.txt'] });
  assert.equal(await multiple.files[1].text(), '');
});

test('self-contained: both run in the page from their source alone', () => {
  for (const fn of [fileInputOf, putFiles]) {
    const alone = new Function(`return (${fn.toString()})`)();
    assert.equal(typeof alone, 'function');
  }
  const input = node('input', { type: 'file' });
  assert.equal(new Function(`return (${fileInputOf.toString()})`)()(node('div', { children: [input] })), input);
});
