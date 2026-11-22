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

// ─── A wait for an element's own time ───────────────────────────────

const { waitTimeoutOf, waitsExtraMs, waitNow, keptWaitParams } = await import('../lib/recorded-waits.js');

test('a wait\'s own time is in whole seconds, from 1 s to 5 min', () => {
  assert.equal(waitTimeoutOf(30000), 30000);
  assert.equal(waitTimeoutOf('45000'), 45000);
  // A phrase says seconds: 2.5 s is waited 3 s.
  assert.equal(waitTimeoutOf(2500), 3000);
  assert.equal(waitTimeoutOf(undefined), null);
  assert.equal(waitTimeoutOf(''), null);
  assert.throws(() => waitTimeoutOf(0), /from 1000 \(1 s\) to 300000 \(5 min\)/);
  assert.throws(() => waitTimeoutOf('soon'), /milliseconds/);
  assert.throws(() => waitTimeoutOf(301000), /5 min/);
  assert.equal(waitTimeoutOf(300000), 300000);
});

test('a wait asked now: its own time sent and kept, the project\'s sent only', () => {
  const own = waitNow({ selector: '#report', timeout: 60000, elementTimeoutMs: 10000 });
  assert.deepEqual(own.sent, { ms: undefined, selector: '#report', timeout: 60000 });
  assert.deepEqual(own.kept, { ms: undefined, selector: '#report', timeout: 60000 });
  // The command is given longer than the wait: it answers before it times out.
  assert.equal(own.commandMs, 75000);

  // Without its own time: as long as the project says, which the step does not keep — the
  // project's setting may change, and the replay applies it then.
  const project = waitNow({ selector: '#list', elementTimeoutMs: 20000 });
  assert.deepEqual(project.sent, { ms: undefined, selector: '#list', timeout: 20000 });
  assert.deepEqual(project.kept, { ms: undefined, selector: '#list' });
  assert.equal(project.commandMs, 35000);

  // A pause has no time of its own to wait for.
  const pause = waitNow({ ms: 2000, timeout: 60000, elementTimeoutMs: 10000 });
  assert.deepEqual(pause.kept, { ms: 2000, selector: undefined });
  assert.equal(pause.commandMs, 30000);

  const refused = waitNow({ selector: '#x', timeout: 900000 });
  assert.match(refused.error, /5 min.*Nothing was waited for, nor recorded\./);
});

test('a replay is given the time of its long waits on top of its own', () => {
  assert.equal(waitsExtraMs([click('#a'), forElement('#b')]), 0);
  assert.equal(waitsExtraMs([{ command: 'wait', params: { selector: '#b', timeout: 90000 } }, time(3000)]), 93000);
  // From a Gherkin phrase: a string. Beyond 5 min, the browser waits 5 min.
  assert.equal(waitsExtraMs([{ command: 'wait', params: { selector: '#b', timeout: '30000' } }]), 30000);
  assert.equal(waitsExtraMs([{ command: 'wait', params: { selector: '#b', timeout: 900000 } }]), 300000);
  assert.equal(waitsExtraMs(undefined), 0);
});

test('a wait step saved from the step editor: its time rounded, or refused', () => {
  assert.deepEqual(keptWaitParams({ selector: '#b', timeout: 12500 }), { selector: '#b', timeout: 13000 });
  assert.deepEqual(keptWaitParams({ selector: '#b', timeout: '' }), { selector: '#b' });
  assert.deepEqual(keptWaitParams({ ms: 3000, timeout: 30000 }), { ms: 3000 });
  assert.deepEqual(keptWaitParams({ selector: '#b' }), { selector: '#b' });
  assert.throws(() => keptWaitParams({ selector: '#b', timeout: -1 }), /milliseconds/);
});
