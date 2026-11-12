// A wait of a time only, recorded by an agent before a step that waits by itself, is not kept:
// the replay waits for each step's element and each check already.
// Run with: node --test test/recorded-waits.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { redundantTimeWaits, waitsByItself } = await import('../lib/recorded-waits.js');
const { cleanRecoverySteps } = await import('../lib/tools/test.js');

const time = (ms) => ({ command: 'wait', params: { ms } });
const forElement = (selector) => ({ command: 'wait', params: { selector } });
const click = (value) => ({ command: 'click', params: {}, locators: [{ type: 'css', value }] });
const check = { command: 'assert', params: {}, assertion: { type: 'url_contains', expected: '/home' } };
const go = (url) => ({ command: 'navigate', params: { url } });

test('what waits by itself: an element step, a wait for an element, a check', () => {
  assert.equal(waitsByItself(click('#go')), true);
  assert.equal(waitsByItself(forElement('.tile')), true);
  assert.equal(waitsByItself(check), true);
  assert.equal(waitsByItself(time(500)), false);
  assert.equal(waitsByItself(go('https://x.test')), false);
  assert.equal(waitsByItself(undefined), false);
});

test('the reported test: 4 s before a wait for the tile goes; nothing else', () => {
  const steps = [go('https://portal.test/login'), click('button.btn'), time(4000), forElement('button.Nav_ShortcutTile'), click('button.Nav_ShortcutTile')];
  assert.deepEqual(redundantTimeWaits(steps), [2]);
  const { steps: kept, removed } = cleanRecoverySteps(steps);
  assert.deepEqual(kept.map((s) => s.command), ['navigate', 'click', 'wait', 'click']);
  assert.match(removed[0], /a wait of 4000 ms \(the step after it waits for its element by itself\)/);
});

test('several time waits in a row before an element step all go; one before a navigate stays', () => {
  assert.deepEqual(redundantTimeWaits([time(1000), time(2000), click('#a')]), [0, 1]);
  assert.deepEqual(redundantTimeWaits([click('#a'), time(1500), go('https://x.test'), click('#b')]), []);
  assert.deepEqual(redundantTimeWaits([time(1000), check]), [0]);
});
