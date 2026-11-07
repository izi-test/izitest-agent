// The cursor of the driven mouse (src/cursor.ts): each move and press of a driven page's mouse
// is told to the tab's top frame, which draws it — in the live view, the action frames and the
// window. Hidden for a screenshot compared with a baseline; told again to a page loaded since.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cursor.ts');

const sent = [];
const removed = [];
globalThis.chrome = {
  tabs: {
    sendMessage: async (tabId, message, options) => { sent.push({ tabId, ...message, frameId: options?.frameId }); },
    onRemoved: { addListener: (fn) => removed.push(fn) },
  },
};

const dir = await mkdtemp(join(tmpdir(), 'cursor-'));
const outfile = join(dir, 'cursor.mjs');
await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
const { showCursorOf, cursorOf, hideCursor } = await import(outfile);

/** A page whose mouse clicks as Puppeteer's does: this.move, then this.down, then this.up. */
function page() {
  const done = [];
  const mouse = {
    async move(x, y) { done.push(['move', x, y]); },
    async down() { done.push(['down']); },
    async up() { done.push(['up']); },
    async click(x, y) { await Promise.all([this.move(x, y), this.down()]); await this.up(); },
  };
  return { page: { mouse }, done };
}

test('each move and press of a driven mouse is told to its tab, the mouse still does it', async () => {
  sent.length = 0;
  const { page: p, done } = page();
  showCursorOf(7, p);
  await p.mouse.move(10, 20);
  await p.mouse.click(300, 140);
  assert.deepEqual(done, [['move', 10, 20], ['move', 300, 140], ['down'], ['up']], 'the real mouse still moves and clicks');
  assert.deepEqual(sent, [
    { tabId: 7, type: 'cursor', x: 10, y: 20, frameId: 0 },
    { tabId: 7, type: 'cursor', x: 300, y: 140, frameId: 0 },
    { tabId: 7, type: 'cursor', x: 300, y: 140, press: true, frameId: 0 },
  ], 'in the top frame, where it pressed: a ring');
  assert.deepEqual(cursorOf(7), { x: 300, y: 140 }, 'a page loaded since asks where it is');
});

test('a page shown once: its mouse is not wrapped twice', async () => {
  sent.length = 0;
  const { page: p } = page();
  showCursorOf(8, p);
  showCursorOf(8, p);
  await p.mouse.move(1, 2);
  assert.equal(sent.length, 1);
});

test('hidden for a screenshot of a driven tab only; forgotten with its tab', async () => {
  sent.length = 0;
  await hideCursor(7, true);
  await hideCursor(7, false);
  await hideCursor(99, true);
  assert.deepEqual(sent, [{ tabId: 7, type: 'cursor', hidden: true, frameId: 0 }, { tabId: 7, type: 'cursor', hidden: false, frameId: 0 }],
    'a tab whose mouse never moved has no cursor to hide');
  assert.equal(cursorOf(99), null);
  assert.equal(cursorOf(undefined), null);
  for (const forget of removed) forget(7);
  assert.equal(cursorOf(7), null);
});

test('a page still loading does not fail the click: the message is not waited for', async () => {
  sent.length = 0;
  const failing = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  try {
    const { page: p, done } = page();
    showCursorOf(9, p);
    await p.mouse.click(5, 5);
    assert.deepEqual(done, [['move', 5, 5], ['down'], ['up']]);
  } finally {
    globalThis.chrome.tabs.sendMessage = failing;
  }
});
