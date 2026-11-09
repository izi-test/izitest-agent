// What a snapshot shows of a field's value (src/dom/field-value.ts): a password field that it is
// filled, never what with — the snapshot goes to an agent.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'field-value.ts');
const outfile = join(await mkdtemp(join(tmpdir(), 'field-value-')), 'field-value.mjs');
await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { shownInputValue, HIDDEN_VALUE } = await import(outfile);

test('a password field shows it is filled, never its value', () => {
  assert.equal(shownInputValue('password', 'S3cr3t!'), HIDDEN_VALUE);
  assert.equal(shownInputValue('PASSWORD', 'x'), HIDDEN_VALUE);
  assert.equal(shownInputValue('password', ''), null, 'empty: nothing shown');
});

test('another field shows its value; a checkbox, a button, a hidden or file input none', () => {
  assert.equal(shownInputValue('email', 'qa@shop.test'), 'qa@shop.test');
  assert.equal(shownInputValue(undefined, 'typed'), 'typed', 'text by default');
  assert.equal(shownInputValue('range', '60'), '60');
  for (const type of ['checkbox', 'radio', 'submit', 'reset', 'button', 'hidden', 'file']) assert.equal(shownInputValue(type, 'on'), null, type);
});
