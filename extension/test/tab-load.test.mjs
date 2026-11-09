// navigate waits for its tab's 'complete' once page.goto has returned (helpers.ts,
// waitForTabLoad). A page served from the cache fires DOMContentLoaded and load in the same
// instant, and the tab's 'complete' was told before the wait began: it then waited out its 15 s
// for an event that had already come. Seen in the headless Chrome on every navigate to a logout
// that redirects to the app's home, from the second visit on.
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

/** A Chrome whose tab 1 is in the status the test says, and that tells its updates on demand. */
const tabs = new Map();
const listeners = new Set();
globalThis.chrome = {
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      return { id, windowId: 10, status: tabs.get(id) };
    },
    onUpdated: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    },
    onCreated: { addListener: () => {} },
    query: async () => [],
  },
  windows: { get: async (id) => ({ id }), onRemoved: { addListener: () => {} } },
  storage: { session: { get: async () => ({}), set: async () => {} } },
};

function update(tabId, changeInfo) {
  if (changeInfo.status) tabs.set(tabId, changeInfo.status);
  for (const fn of [...listeners]) fn(tabId, changeInfo);
}

const dir = await mkdtemp(join(tmpdir(), 'helpers-load-'));
const outfile = join(dir, 'helpers.mjs');
await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
const { waitForTabLoad } = await import(outfile);

/** Whether the wait has settled within `ms`: far below its 15 s. */
const settledWithin = (wait, ms) =>
  Promise.race([wait.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

test('a page that has already loaded is not waited for: its complete came before the wait', async () => {
  tabs.set(1, 'complete');
  assert.equal(await settledWithin(waitForTabLoad(1), 200), true);
  assert.equal(listeners.size, 0, 'and it stops listening');
});

test('a page still loading is waited for, until its complete', async () => {
  tabs.set(1, 'loading');
  const wait = waitForTabLoad(1);
  assert.equal(await settledWithin(wait, 100), false, 'not before the page has loaded');

  update(2, { status: 'complete' });
  update(1, { title: 'Notes de frais' });
  assert.equal(await settledWithin(wait, 100), false, 'another tab, or another change, is not its load');

  update(1, { status: 'complete' });
  assert.equal(await settledWithin(wait, 200), true);
  assert.equal(listeners.size, 0, 'and it stops listening');
});

test('a tab gone is not waited for', async () => {
  tabs.delete(3);
  assert.equal(await settledWithin(waitForTabLoad(3), 200), true);
  assert.equal(listeners.size, 0);
});
