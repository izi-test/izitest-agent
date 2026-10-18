// Screenshot captures share one queue. A capture that never settles used to block every
// later one for the life of the service worker — and with it every command that takes a
// debug screenshot, which is why close_window "timed out after 30000ms" while get_tabs
// (excluded from debug screenshots) still answered in 15ms.
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'helpers.ts');

/** A Chrome whose captureVisibleTab behaviour the test controls per call. */
function fakeChrome(captureBehaviour) {
  let calls = 0;
  return {
    calls: () => calls,
    api: {
      tabs: {
        get: async (id) => ({ id, windowId: 10, active: true }),
        update: async () => {},
        onCreated: { addListener: () => {} },
        query: async () => [],
        captureVisibleTab: async () => { calls++; return captureBehaviour(calls); },
      },
      windows: { get: async (id) => ({ id }), onRemoved: { addListener: () => {} } },
      storage: { session: { get: async () => ({}), set: async () => {} } },
    },
  };
}

async function loadHelpers(captureBehaviour) {
  const chrome = fakeChrome(captureBehaviour);
  globalThis.chrome = chrome.api;
  const dir = await mkdtemp(join(tmpdir(), 'helpers-shot-'));
  const outfile = join(dir, 'helpers.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return { mod: await import(outfile), chrome };
}

const never = () => new Promise(() => {});

test('a capture that never settles does not block the next one', async (t) => {
  // 10s bound + 1.2s pacing: give the queue room to drain.
  t.diagnostic('waits for the capture timeout, ~11s');
  const { mod } = await loadHelpers((n) => (n === 1 ? never() : 'data:image/jpeg;base64,AAA'));

  const stuck = mod.captureTabScreenshot(1).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  const next = mod.captureTabScreenshot(2);

  assert.match(await stuck, /^rejected: Screenshot of tab 1 timed out/);
  assert.equal(await next, 'data:image/jpeg;base64,AAA', 'the queue must keep moving');
});

test('a failing capture does not block the next one either', async () => {
  const { mod } = await loadHelpers((n) => {
    if (n === 1) throw new Error('capture blew up');
    return 'data:image/jpeg;base64,BBB';
  });

  const failed = mod.captureTabScreenshot(1).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  const next = mod.captureTabScreenshot(2);

  assert.match(await failed, /rejected: capture blew up/);
  assert.equal(await next, 'data:image/jpeg;base64,BBB');
});

test('captures still come back in order', async () => {
  const { mod } = await loadHelpers((n) => `shot-${n}`);
  const results = await Promise.all([
    mod.captureTabScreenshot(1),
    mod.captureTabScreenshot(2),
    mod.captureTabScreenshot(3),
  ]);
  assert.deepEqual(results, ['shot-1', 'shot-2', 'shot-3']);
});
