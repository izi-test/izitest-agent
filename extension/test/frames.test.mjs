// Clicking inside same-origin iframes. Reported live: a button drawn at (350,169) inside an
// iframe placed at (300,150) reported (50,19) — its position relative to the iframe — and
// the click went to the top page at (50,19).
//
// Pure geometry over plain objects shaped like documents and frames.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'hit-test.ts');
const dir = await mkdtemp(join(tmpdir(), 'frames-'));
await build({ entryPoints: [SRC], outfile: join(dir, 'h.mjs'), bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
const ht = await import(join(dir, 'h.mjs'));

/**
 * A document whose elementFromPoint answers from a list of boxes, topmost last:
 * [{ node, left, top, width, height }].
 */
function doc(boxes = []) {
  const d = {
    boxes,
    defaultView: { frameElement: null, getComputedStyle: () => ({ paddingLeft: '0px', paddingTop: '0px' }) },
    elementFromPoint(x, y) {
      for (const b of [...this.boxes].reverse()) {
        if (x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height) return b.node;
      }
      return null;
    },
  };
  return d;
}

/** An <iframe> placed in `parent` at (left, top), whose document is `inner`. */
function iframe(parent, inner, { left, top, width = 400, height = 200, border = 0, padding = 0 }) {
  const frame = {
    nodeType: 1, tagName: 'IFRAME', parentNode: null, ownerDocument: parent,
    clientLeft: border, clientTop: border,
    getBoundingClientRect: () => ({ left, top }),
  };
  parent.boxes.push({ node: frame, left, top, width: width + 2 * border + 2 * padding, height: height + 2 * border + 2 * padding });
  inner.defaultView.frameElement = frame;
  parent.defaultView.getComputedStyle = (el) =>
    el === frame ? { paddingLeft: `${padding}px`, paddingTop: `${padding}px` } : { paddingLeft: '0px', paddingTop: '0px' };
  return frame;
}

const el = (tagName, ownerDocument) => ({ nodeType: 1, tagName, parentNode: null, ownerDocument });

test('an element of the top page has a single level at the origin', () => {
  const top = doc();
  const button = el('BUTTON', top);
  assert.deepEqual(ht.frameLevels(button, top), [{ doc: top, originX: 0, originY: 0, expect: button }]);
});

test('an iframe shifts its content by its position — the reported case', () => {
  const top = doc();
  const inner = doc();
  const frame = iframe(top, inner, { left: 300, top: 150 });
  const button = el('BUTTON', inner);

  const levels = ht.frameLevels(button, top);
  assert.equal(levels.length, 2);
  assert.equal(levels[0].expect, frame);
  assert.deepEqual([levels[1].originX, levels[1].originY], [300, 150]);
});

test('border and padding of the iframe are part of the shift', () => {
  const top = doc();
  const inner = doc();
  iframe(top, inner, { left: 300, top: 150, border: 2, padding: 5 });
  const levels = ht.frameLevels(el('INPUT', inner), top);
  assert.deepEqual([levels[1].originX, levels[1].originY], [307, 157]);
});

test('nested iframes add up', () => {
  const top = doc();
  const middle = doc();
  const inner = doc();
  iframe(top, middle, { left: 100, top: 50 });
  iframe(middle, inner, { left: 20, top: 10 });
  const levels = ht.frameLevels(el('A', inner), top);
  assert.equal(levels.length, 3);
  assert.deepEqual([levels[2].originX, levels[2].originY], [120, 60]);
});

test('a cross-origin frame on the way gives up instead of guessing', () => {
  const top = doc();
  const inner = doc(); // frameElement stays null: what a cross-origin parent exposes
  assert.equal(ht.frameLevels(el('A', inner), top), null);
});

test('a click on an iframe button passes through the iframe and reaches it', () => {
  const top = doc();
  const inner = doc();
  iframe(top, inner, { left: 300, top: 150 });
  const button = el('BUTTON', inner);
  inner.boxes.push({ node: button, left: 10, top: 5, width: 80, height: 30 });

  const levels = ht.frameLevels(button, top);
  assert.deepEqual(ht.hitTestThroughFrames(levels, 350, 169), { ok: true, blocker: null });
  // The old, frame-relative coordinates land on the top page, not on the button.
  assert.equal(ht.hitTestThroughFrames(levels, 50, 19).ok, false);
});

test('something on the page over the iframe blocks the click', () => {
  const top = doc();
  const inner = doc();
  iframe(top, inner, { left: 300, top: 150 });
  const button = el('BUTTON', inner);
  inner.boxes.push({ node: button, left: 10, top: 5, width: 80, height: 30 });
  const banner = { nodeType: 1, tagName: 'DIV', id: 'cookie-banner', parentNode: null };
  top.boxes.push({ node: banner, left: 0, top: 140, width: 1000, height: 100 });

  const verdict = ht.hitTestThroughFrames(ht.frameLevels(button, top), 350, 169);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocker, banner);
});

test('something inside the iframe over the button blocks it too', () => {
  const top = doc();
  const inner = doc();
  iframe(top, inner, { left: 300, top: 150 });
  const button = el('BUTTON', inner);
  inner.boxes.push({ node: button, left: 10, top: 5, width: 80, height: 30 });
  const spinner = { nodeType: 1, tagName: 'DIV', id: 'loading', parentNode: null };
  inner.boxes.push({ node: spinner, left: 0, top: 0, width: 400, height: 200 });

  const verdict = ht.hitTestThroughFrames(ht.frameLevels(button, top), 350, 169);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocker, spinner);
});
