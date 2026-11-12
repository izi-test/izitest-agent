// Code run in a page right after it changed. A click that navigates leaves the connection kept
// for the tab pointing at the page that was there: page.evaluate then answers "Cannot find
// context with specified id", every time, as long as that connection is kept. A test's check of
// the URL read that error for 23 s instead of the new page's URL. execute_js connects again and
// runs the code once more, as the replay's actions do.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'queries.ts');

// queries.ts reaches into Chrome and Puppeteer through these modules: each is a stand-in the
// test drives through globalThis.__js.
const STUBS = {
  '../puppeteer-client': `
    export const getPage = async (tabId) => globalThis.__js.pages.shift();
    export const detachBrowser = (tabId) => { globalThis.__js.detached.push(tabId); };
    export const isBrowserAttached = () => true;`,
  '../helpers': `
    export const resolveTabId = async (tabId) => tabId ?? 7;
    export const delay = async () => {};
    export const ensureContentScript = async () => {};
    export const captureTabScreenshot = async () => '';
    export const TOP_FRAME = 0;`,
  '../frames': `export const findFrame = async () => ({}); export const framesWithRefs = async () => []; export const sendToFrame = async () => ({}); export const snapshotAllFrames = async () => [];`,
  '../owned-windows': `export const isOwnedWindow = () => false; export const forgetOwnedWindow = () => {}; export const getWindowOwner = () => null; export const listOwnedWindows = () => []; export const listPopupWindows = () => []; export const popupParent = () => null; export const popupsOf = () => [];`,
  '../cursor': `export const hideCursor = () => {};`,
};

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'execute-js-'));
  const outfile = join(dir, 'queries.mjs');
  await build({
    entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/(puppeteer-client|helpers|frames|owned-windows|cursor)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ loader: 'js', contents: STUBS[args.path] }));
      },
    }],
  });
  return import(outfile);
}
const { cmdExecuteJs } = await load();

const stale = { evaluate: async () => { throw new Error('Protocol error (Runtime.evaluate): Cannot find context with specified id'); } };
const fresh = (value) => ({ evaluate: async () => value });

test('a connection left on the page that was there is dropped, and the code runs on the new page', async () => {
  globalThis.__js = { pages: [stale, fresh({ value: 'https://portal.test/workflowmanagement/createupdateuserrequestfirststep' })], detached: [] };
  const result = await cmdExecuteJs({ code: 'location.href', tabId: 7 });
  assert.equal(result.value, 'https://portal.test/workflowmanagement/createupdateuserrequestfirststep');
  assert.deepEqual(globalThis.__js.detached, [7]);
});

test('an error of the code itself is not run twice', async () => {
  let runs = 0;
  globalThis.__js = { pages: [{ evaluate: async () => { runs++; throw new Error('ReferenceError: foo is not defined'); } }], detached: [] };
  await assert.rejects(cmdExecuteJs({ code: 'foo', tabId: 7 }), /foo is not defined/);
  assert.equal(runs, 1);
  assert.deepEqual(globalThis.__js.detached, []);
});

test('still lost on the new connection, the error is told', async () => {
  globalThis.__js = { pages: [stale, stale], detached: [] };
  await assert.rejects(cmdExecuteJs({ code: 'location.href', tabId: 7 }), /Cannot find context/);
});
