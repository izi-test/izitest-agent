// What a check read in a long text — a whole <body>, its scripts with it — is told by an excerpt
// where what it looks for is: the report showed thousands of characters, and the run's record
// kept them. The comparison is still made on the whole text.
// Run with: node --test test/assertion-excerpt.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'excerpt-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase } = await import('../lib/db.js');
initDatabase();
const { textExcerpt, evaluateAssertion } = await import('../lib/test-execute.js');

const body = `Chargement du panier... ${'var G = G || {}; '.repeat(300)} Bonjour :) Nous sommes ravis de vous revoir ! ${'Promos '.repeat(300)}`;
const reading = (value) => async () => ({ result: { value, pageUrl: 'https://shop.test/' } });

test('a long text is told where the phrase is, with its length; a short one as it is', () => {
  const told = textExcerpt(body, 'Nous sommes ravis de vous revoir');
  assert.match(told, /^….*Bonjour :\) Nous sommes ravis de vous revoir !.*… \(\d+ characters\)$/);
  assert.ok(told.length < 300);
  assert.match(textExcerpt(body, 'absent'), /^Chargement du panier\.\.\. var G.*… \(\d+ characters\)$/);
  assert.match(textExcerpt(body, 'NOUS SOMMES RAVIS', true), /Nous sommes ravis/);
  assert.equal(textExcerpt('  Bonjour   Bob  ', 'Bob'), 'Bonjour Bob');
});

test('a check of a whole <body> passes or fails on the whole text, and tells an excerpt', async () => {
  const passed = await evaluateAssertion(reading(body), { type: 'text_contains', selector: 'body', expected: 'Nous sommes ravis de vous revoir' });
  assert.equal(passed.passed, true);
  assert.ok(passed.actual.length < 300);
  const failed = await evaluateAssertion(reading(body), { type: 'text_contains', selector: 'body', expected: 'Au revoir' });
  assert.equal(failed.passed, false);
  assert.match(failed.actual, /\(\d+ characters\)$/);
  // An equality keeps what it read whole: a repair may propose to expect it.
  const equals = await evaluateAssertion(reading(body), { type: 'text_equals', selector: 'body', expected: 'x' });
  assert.equal(equals.actual, body);
});
