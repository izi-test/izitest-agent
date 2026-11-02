// Where a drag goes: the point of the target it drops on, and the moves on the way there.
// izitest-test.html's priority list puts an item before another when it is dropped on the
// top half of it, after when on the bottom half.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'drag.ts');
const dir = await mkdtemp(join(tmpdir(), 'drag-'));
const outfile = join(dir, 'drag.mjs');
await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent', external: ['puppeteer-core*'] });
const { dropPoint, dragPath, DROP_POSITIONS } = await import(outfile);

// An item of the list: centred at (300, 200), 400 × 40.
const ITEM = { x: 300, y: 200, width: 400, height: 40 };

test('the drop goes on the centre, or a quarter of the way in from an edge', () => {
  assert.deepEqual(dropPoint(ITEM), { x: 300, y: 200 });
  assert.deepEqual(dropPoint(ITEM, 'center'), { x: 300, y: 200 });
  assert.deepEqual(dropPoint(ITEM, 'top'), { x: 300, y: 190 });
  assert.deepEqual(dropPoint(ITEM, 'bottom'), { x: 300, y: 210 });
  assert.deepEqual(dropPoint(ITEM, 'left'), { x: 200, y: 200 });
  assert.deepEqual(dropPoint(ITEM, 'right'), { x: 400, y: 200 });
  assert.deepEqual([...DROP_POSITIONS], ['center', 'top', 'bottom', 'left', 'right']);
  assert.deepEqual(dropPoint(ITEM, 'middle'), { x: 300, y: 200 }, 'a step written by hand, with another word');
});

test('the top of an item is on its upper half, the bottom on its lower half, at any size', () => {
  for (const height of [12, 31, 40, 120]) {
    const box = { ...ITEM, height };
    const top = box.y - height / 2;
    assert.ok(dropPoint(box, 'top').y > top && dropPoint(box, 'top').y < box.y, `top, ${height}px`);
    assert.ok(dropPoint(box, 'bottom').y > box.y && dropPoint(box, 'bottom').y < top + height, `bottom, ${height}px`);
  }
});

test('the moves: a few pixels toward the drop first, then steps that end on it', () => {
  const path = dragPath({ x: 300, y: 400 }, { x: 300, y: 190 }, 4);
  assert.deepEqual(path[0], { x: 300, y: 394 }, 'past Chrome\'s drag threshold, toward the drop');
  assert.equal(path.length, 5);
  assert.deepEqual(path.at(-1), { x: 300, y: 190 });
  for (let i = 1; i < path.length; i++) assert.ok(path[i].y < path[i - 1].y, 'always closer');
});

test('a drop where the drag starts still moves the mouse, or no drag would start', () => {
  const path = dragPath({ x: 50, y: 50 }, { x: 52, y: 50 }, 2);
  assert.deepEqual(path[0], { x: 50, y: 56 });
  assert.deepEqual(path.at(-1), { x: 52, y: 50 });
});
