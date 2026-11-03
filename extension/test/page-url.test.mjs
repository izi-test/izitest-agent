// An action on an element of the page says which page it was done on: the server keeps it
// with the step, and knows the element by it (mcp-server/lib/elements.js).
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'page-url.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'page-url-'));
  const outfile = join(dir, 'page-url.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}

test('an action on an element says its page; navigating or reading the page does not', async () => {
  const { actsOnPage } = await load();
  for (const command of ['click', 'fill', 'select', 'upload', 'drag']) assert.equal(actsOnPage(command), true, command);
  for (const command of ['navigate', 'keyboard', 'snapshot', 'screenshot']) assert.equal(actsOnPage(command), false, command);
});

test('the page goes back with the result of the action, and nothing else changes', async () => {
  const { withPageUrl } = await load();
  assert.deepEqual(withPageUrl({ success: true, tag: 'button' }, 'https://shop.test/notes/42'),
    { success: true, tag: 'button', pageUrl: 'https://shop.test/notes/42' });
  assert.deepEqual(withPageUrl({ success: true }, undefined), { success: true }, 'no tab, no page');
  assert.equal(withPageUrl(null, 'https://shop.test/'), null);
  assert.deepEqual(withPageUrl(['a'], 'https://shop.test/'), ['a']);
});
