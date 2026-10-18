// Detaching from a tab that has just been closed must not leave an unhandled rejection.
//
// The bug: Browser.disconnect() returns a Promise, and it detaches the debugger, which
// rejects with "No tab with given id N" once the tab is gone — the normal case here, since
// detachBrowser runs from chrome.tabs.onRemoved. The code wrapped it in a try/catch, which
// only catches a synchronous throw, so every closed working window left an
// "Uncaught (in promise)" entry in chrome://extensions.
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'puppeteer-client.ts');

// puppeteer-core is 1.8 MB of browser plumbing with nothing to say about this bug. The stub
// hands back whatever browser the test asked for, through the module's real attach path —
// so no test-only export has to exist in the production file.
function stubPuppeteer() {
  return {
    name: 'stub-puppeteer',
    setup(b) {
      b.onResolve({ filter: /puppeteer-core/ }, () => ({ path: 'puppeteer', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'js',
        contents: `
          export const connect = async () => globalThis.__nextBrowser;
          export const ExtensionTransport = { connectTab: async () => ({}) };
          export class Browser {}
          export class Page {}
          export class Dialog {}
        `,
      }));
    },
  };
}

/** A browser whose disconnect fails the way a closed tab makes it fail. */
function browserWhoseDisconnect(fail) {
  return {
    on: () => {},
    pages: async () => [{}],
    disconnect: fail,
  };
}

async function loadClient() {
  globalThis.chrome = {
    tabs: { onRemoved: { addListener: () => {} } },
    debugger: { onDetach: { addListener: () => {} } },
  };
  const dir = await mkdtemp(join(tmpdir(), 'pptr-client-'));
  const outfile = join(dir, 'puppeteer-client.mjs');
  await build({
    entryPoints: [SRC], outfile, bundle: true, format: 'esm',
    target: 'node20', logLevel: 'silent', plugins: [stubPuppeteer()],
  });
  return import(outfile);
}

/** Unhandled rejections raised while fn runs, plus a tick for them to surface. */
async function withUnhandledRejections(fn) {
  const seen = [];
  const onUnhandled = (reason) => seen.push(String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

test('detachBrowser swallows the async rejection of disconnect()', async () => {
  const mod = await loadClient();
  globalThis.__nextBrowser = browserWhoseDisconnect(
    async () => { throw new Error('No tab with given id 230891637.'); });
  await mod.ensureBrowserAttached(1);

  const unhandled = await withUnhandledRejections(async () => mod.detachBrowser(1));

  assert.deepEqual(unhandled, [], 'closing a tab must not leave an uncaught rejection');
  assert.equal(mod.isBrowserAttached(1), false);
});

test('a synchronous throw from disconnect() is swallowed too', async () => {
  const mod = await loadClient();
  globalThis.__nextBrowser = browserWhoseDisconnect(
    () => { throw new Error('No tab with given id 2.'); });
  await mod.ensureBrowserAttached(2);

  const unhandled = await withUnhandledRejections(async () => mod.detachBrowser(2));

  assert.deepEqual(unhandled, []);
  assert.equal(mod.isBrowserAttached(2), false);
});

test('a clean disconnect still forgets the tab', async () => {
  const mod = await loadClient();
  globalThis.__nextBrowser = browserWhoseDisconnect(async () => {});
  await mod.ensureBrowserAttached(3);
  assert.equal(mod.isBrowserAttached(3), true);

  mod.detachBrowser(3);
  assert.equal(mod.isBrowserAttached(3), false);
});

test('detaching a tab that was never attached is a no-op', async () => {
  const mod = await loadClient();
  const unhandled = await withUnhandledRejections(async () => mod.detachBrowser(999));
  assert.deepEqual(unhandled, []);
  assert.equal(mod.isBrowserAttached(999), false);
});
