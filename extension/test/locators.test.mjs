// How replay turns a recorded locator into a Puppeteer selector. A role locator read as
// CSS ("button") would find the page's first button.
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
const outfile = join(dir, 'locators.mjs');
await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent', external: ['puppeteer-core*'] });
const { locatorToPuppeteerSelector } = await import(outfile);

test('a role locator is an ARIA query by name and role, never the bare role as CSS', () => {
  assert.equal(locatorToPuppeteerSelector({ type: 'role', value: 'button', name: 'Sign in' }), 'aria/Sign in[role="button"]');
});

test('the other locator types are as they were', () => {
  assert.equal(locatorToPuppeteerSelector({ type: 'aria', value: 'Jardin' }), 'aria/Jardin');
  assert.equal(locatorToPuppeteerSelector({ type: 'css', value: '#go' }), '#go');
  assert.equal(locatorToPuppeteerSelector({ type: 'text', value: 'Voir' }), '::-p-text(Voir)');
});
