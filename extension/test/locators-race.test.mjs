// The locators of a step look at once; a less precise one found first waits a moment for a more
// precise one. On Auchan, the text "chocolat" was on the page before the suggestion list opened
// and won the race against the suggestion's own selector: the click went to another element.
// The page is a stand-in: each selector shows up after its own delay, or never.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'locators.ts');
const dir = await mkdtemp(join(tmpdir(), 'locators-'));
await build({ entryPoints: [SRC], outfile: join(dir, 'locators.mjs'), bundle: true, format: 'esm', target: 'node20', logLevel: 'silent', external: ['puppeteer-core/*'] });
const { findElementWithLocators } = await import(join(dir, 'locators.mjs'));

/** A page whose selectors show up after `delays[selector]` ms (never when absent), as handles named by them. */
function page(delays) {
  const disposed = [];
  return {
    disposed,
    waitForSelector: (selector, { timeout }) => new Promise((resolve, reject) => {
      const delay = delays[selector];
      if (delay === undefined || delay > timeout) { setTimeout(() => reject(new Error('timeout')), Math.min(timeout, 50)); return; }
      setTimeout(() => resolve({ name: selector, dispose: async () => { disposed.push(selector); } }), delay);
    }),
  };
}

const suggestion = 'a[aria-label$=": chocolat"]';
const locators = [{ type: 'text', value: 'chocolat' }, { type: 'css', value: suggestion }];

test('a text found at once waits for the suggestion\'s selector, which wins when it comes', async () => {
  const p = page({ '::-p-text(chocolat)': 5, [suggestion]: 300 });
  const { result } = await findElementWithLocators(p, locators, 'any', 3000);
  assert.equal(result.handle.name, suggestion);
  assert.equal(result.locatorUsed, 'css');
  assert.deepEqual(p.disposed, ['::-p-text(chocolat)']);
});

test('the precise one never coming, the text is taken after the wait', async () => {
  const p = page({ '::-p-text(chocolat)': 5 });
  const started = Date.now();
  const { result } = await findElementWithLocators(p, locators, 'any', 3000);
  assert.equal(result.locatorUsed, 'text');
  assert.ok(Date.now() - started < 2000, 'not the whole timeout');
});

test('the most precise found first is taken at once; none found tells each', async () => {
  const p = page({ '::-p-text(chocolat)': 200, [suggestion]: 5 });
  const started = Date.now();
  assert.equal((await findElementWithLocators(p, locators, 'any', 3000)).result.locatorUsed, 'css');
  assert.ok(Date.now() - started < 150);
  const none = await findElementWithLocators(page({}), locators, 'any', 100);
  assert.equal(none.result, null);
  assert.equal(none.errors.length, 2);
});
