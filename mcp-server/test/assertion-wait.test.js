// Unit tests for how long an assertion waits (lib/test-execute.js evaluateAssertion): read
// again until it holds, as Playwright's expect does — a form sent with Enter is still loading
// its next page when the assertions are read —, then told with what it read last; and a wait
// told neither how long nor what for, refused rather than recorded (lib/recording.js).
// Run with: node --test test/assertion-wait.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion } from '../lib/test-execute.js';
import { waitsForNothing } from '../lib/recording.js';

const PROV = { type: 'text_contains', selector: 'body', expected: 'PROV' };

/** A page answering `answers` in turn (an Error is thrown), the last one for good; and how often it was read. */
function page(...answers) {
  const reads = { count: 0 };
  const send = async (_profile, command) => {
    assert.equal(command, 'execute_js');
    const answer = answers[Math.min(reads.count++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return { result: { value: answer, pageUrl: 'http://localhost:8090/comm/propal/card.php?id=45' } };
  };
  return { send, reads };
}

const replaced = () => new Error('Protocol error (Runtime.evaluate): {"code":-32000,"message":"Cannot find context with specified id"}');

test('a page being replaced is read again: the assertion holds once the next page is there', async () => {
  const { send, reads } = page(replaced(), replaced(), 'Proposition (PROV45) - Fiche');
  const result = await evaluateAssertion(send, PROV, 7, { timeoutMs: 3000 });
  assert.equal(result.passed, true);
  assert.equal(reads.count, 3);
  assert.equal(result.pageUrl, 'http://localhost:8090/comm/propal/card.php?id=45');
});

test('a page still on its way: read again until it shows what is expected', async () => {
  const { send, reads } = page('Chargement…', 'Chargement…', 'Proposition PROV45');
  assert.equal((await evaluateAssertion(send, PROV, 7, { timeoutMs: 3000 })).passed, true);
  assert.equal(reads.count, 3);
});

test('one that never holds fails once the time is up, with what it read last', async () => {
  const { send, reads } = page('Brouillon', 'Validée');
  const started = Date.now();
  const result = await evaluateAssertion(send, PROV, 7, { timeoutMs: 600 });
  assert.equal(result.passed, false);
  assert.ok(Date.now() - started >= 600, 'it waited');
  assert.ok(reads.count >= 2);
  assert.equal(result.actual, 'Validée');
  assert.equal('unknown' in result, false);
});

test('a page that cannot be read until the end: its error, as before', async () => {
  const { send } = page(replaced());
  await assert.rejects(evaluateAssertion(send, PROV, 7, { timeoutMs: 300 }), /Cannot find context/);
});

test('read once: with no time to wait, and for a type it does not know', async () => {
  const once = page('Brouillon', 'PROV45');
  assert.equal((await evaluateAssertion(once.send, PROV, 7, { timeoutMs: 0 })).passed, false);
  assert.equal(once.reads.count, 1);
  const unknown = page('x');
  const started = Date.now();
  const result = await evaluateAssertion(unknown.send, { type: 'made_up', expected: 'x' }, 7, { timeoutMs: 5000 });
  assert.deepEqual([result.passed, result.actual, 'unknown' in result], [false, 'Unknown assertion type: made_up', false]);
  assert.ok(Date.now() - started < 1000, 'not waited for');
});

test('a wait needs how long or what for: else refused, nothing recorded', () => {
  assert.match(waitsForNothing(undefined, undefined), /wait needs ms \(milliseconds: 3 seconds is 3000\) or selector/);
  assert.match(waitsForNothing(0, '  '), /Nothing was waited for, nor recorded/);
  assert.equal(waitsForNothing(3000), null);
  assert.equal(waitsForNothing(undefined, '#result'), null);
});
