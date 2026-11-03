// The Chrome without windows the server starts (mcp-server/lib/headless.js) is told apart by
// its user agent: its extension registers as the "headless" profile, and the pages it drives
// are given the browser's usual name — some sites refuse "HeadlessChrome".
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'headless.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'headless-'));
  const outfile = join(dir, 'headless.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}

const HEADLESS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';
const WINDOWED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

test('a Chrome without windows is the headless profile; a Chrome with windows is not', async () => {
  const { isHeadless, HEADLESS_PROFILE } = await load();
  assert.equal(HEADLESS_PROFILE, 'headless');
  assert.equal(isHeadless(HEADLESS_UA), true);
  assert.equal(isHeadless(WINDOWED_UA), false);
});

test('the pages of a headless Chrome are told the usual name of the browser', async () => {
  const { pageUserAgent } = await load();
  assert.equal(pageUserAgent(HEADLESS_UA), WINDOWED_UA);
  assert.equal(pageUserAgent(WINDOWED_UA), WINDOWED_UA, 'a Chrome with windows keeps its own');
});
