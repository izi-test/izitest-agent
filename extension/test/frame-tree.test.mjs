// Merging cross-origin iframe snapshots into the page's tree.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'frame-tree.ts');
const dir = await mkdtemp(join(tmpdir(), 'frame-tree-'));
await build({ entryPoints: [SRC], outfile: join(dir, 'ft.mjs'), bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
const { mergeFrameTrees } = await import(join(dir, 'ft.mjs'));

const trees = (entries) => new Map(entries.map(([id, text]) => [id, text.split('\n')]));

test('a frame\'s lines go right under its <iframe> line, one level deeper', () => {
  const merged = mergeFrameTrees(
    trees([
      [0, '@e1 [heading] "Shop"\n  @e2 [iframe] "pay" [cross-origin]\n@e3 [button] "Back"'],
      [7, '@e4 [textbox] "Card number"\n@e5 [button] "Pay"'],
    ]),
    [{ parentFrameId: 0, ref: '@e2', childFrameId: 7, src: 'https://js.stripe.com/x' }],
  );
  assert.deepEqual(merged, [
    '@e1 [heading] "Shop"',
    '  @e2 [iframe] "pay" [cross-origin]',
    '    @e4 [textbox] "Card number"',
    '    @e5 [button] "Pay"',
    '@e3 [button] "Back"',
  ]);
});

test('nested cross-origin frames stack their indentation', () => {
  const merged = mergeFrameTrees(
    trees([
      [0, '@e1 [iframe] "outer" [cross-origin]'],
      [5, '@e2 [iframe] "inner" [cross-origin]'],
      [9, '@e3 [button] "OK"'],
    ]),
    [
      { parentFrameId: 0, ref: '@e1', childFrameId: 5, src: 'a' },
      { parentFrameId: 5, ref: '@e2', childFrameId: 9, src: 'b' },
    ],
  );
  assert.deepEqual(merged, ['@e1 [iframe] "outer" [cross-origin]', '  @e2 [iframe] "inner" [cross-origin]', '    @e3 [button] "OK"']);
});

test('a frame whose <iframe> line was filtered out is still shown, at the end', () => {
  const merged = mergeFrameTrees(
    trees([[0, '@e3 [button] "Accept"'], [4, '@e9 [button] "Accept all"']]),
    [{ parentFrameId: 0, ref: '@e2', childFrameId: 4, src: 'https://cmp.example/consent' }],
  );
  assert.deepEqual(merged, ['@e3 [button] "Accept"', '[cross-origin frame] "https://cmp.example/consent"', '  @e9 [button] "Accept all"']);
});

test('a frame placed inside a merged same-origin frame (no ref) is shown at the end', () => {
  const merged = mergeFrameTrees(
    trees([[0, '@e1 [link] "Home"'], [6, '@e2 [button] "Play"']]),
    [{ parentFrameId: 3, ref: null, childFrameId: 6, src: 'https://player.example' }],
  );
  assert.deepEqual(merged, ['@e1 [link] "Home"', '[cross-origin frame] "https://player.example"', '  @e2 [button] "Play"']);
});

test('a frame with nothing left after filtering adds nothing', () => {
  const merged = mergeFrameTrees(
    trees([[0, '@e1 [link] "Home"'], [6, '']]),
    [{ parentFrameId: 0, ref: '@e9', childFrameId: 6, src: 'x' }],
  );
  assert.deepEqual(merged, ['@e1 [link] "Home"']);
});

test('the page alone comes out unchanged', () => {
  const page = '@e1 [link] "Home"\n  @e2 [button] "Go"';
  assert.deepEqual(mergeFrameTrees(trees([[0, page]]), []), page.split('\n'));
});
