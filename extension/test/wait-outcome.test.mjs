// A replayed wait whose element never comes fails its step: the replay no longer goes on to act
// on a page that is not the one the test was recorded on.
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wait-outcome.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'wait-outcome-'));
  const outfile = join(dir, 'wait-outcome.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}

test('a wait whose element never came fails, saying what it waited for and how long', async () => {
  const { missedWait } = await load();
  const row = 'tr[data-testid=note-row][data-description="Train e2e-x"][data-status=submitted]';
  const error = missedWait('wait', { found: false, selector: row, timeout: true, waitedMs: 10000 });
  assert.equal(error, `Waited 10 s for ${row}: not found`);
  // Read as an element not found by the diagnosis (mcp-server/lib/triage.js failureKind).
  assert.match(error, /not found/);
});

test('a wait whose element came, a pause, or another command: nothing to fail', async () => {
  const { missedWait } = await load();
  assert.equal(missedWait('wait', { found: true, selector: '#done' }), null);
  assert.equal(missedWait('wait', { waited: 500 }), null);
  assert.equal(missedWait('wait', undefined), null);
  assert.equal(missedWait('click', { timeout: true, selector: '#x' }), null);
  assert.equal(missedWait('wait', { found: false, selector: '#late', timeout: true }), 'Waited its time for #late: not found');
});
