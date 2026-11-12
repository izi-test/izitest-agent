// Before a test, the browser without windows forgets what the app left (cookies, storage): the
// test starts logged out. Never the user's Chrome. chrome.browsingData is a stand-in.
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'site-data.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'site-data-'));
  const outfile = join(dir, 'site-data.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}

const { cmdClearSiteData, originsOf } = await load();

function chromeStandIn() {
  const calls = [];
  globalThis.chrome = { browsingData: { remove: async (options, types) => { calls.push({ options, types }); } } };
  return calls;
}

test('origins only, each once; what is not a web URL is left out', () => {
  assert.deepEqual(
    originsOf(['https://portal.corp.com/ECM/login/auth', 'https://portal.corp.com/ECM/home', 'http://127.0.0.1:5173/', 'about:blank', 'data:text/html,x', 'not a url']),
    ['https://portal.corp.com', 'http://127.0.0.1:5173'],
  );
});

test('in the browser without windows, the app\'s cookies and storage go', async () => {
  const calls = chromeStandIn();
  const result = await cmdClearSiteData({ origins: ['https://portal.corp.com/ECM/login/auth'] }, true);
  assert.deepEqual(result, { cleared: true, origins: ['https://portal.corp.com'] });
  assert.deepEqual(calls[0].options, { origins: ['https://portal.corp.com'] });
  for (const kind of ['cookies', 'localStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers']) assert.equal(calls[0].types[kind], true, kind);
});

test('in the user\'s Chrome, nothing is cleared: their own sessions stay', async () => {
  const calls = chromeStandIn();
  const result = await cmdClearSiteData({ origins: ['https://portal.corp.com/'] }, false);
  assert.equal(result.cleared, false);
  assert.equal(calls.length, 0);
});

test('no origin: nothing is cleared (never everything)', async () => {
  const calls = chromeStandIn();
  assert.equal((await cmdClearSiteData({ origins: [] }, true)).cleared, false);
  assert.equal(calls.length, 0);
});
