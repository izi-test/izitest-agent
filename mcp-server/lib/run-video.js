// The video of a test run: the images of its tab, as the screen changed (up to 5 a second),
// recorded by the extension from the moment the run's tab is known (extension/src/live.ts
// recordRun) and pushed with the run's id. Kept when the run failed, or when it was asked
// (record video): otherwise thrown away at its end. A run too fast to follow live can be
// watched again, its steps beside it (the dashboard's player).
//
//   data/videos/<executionId>/<n>.jpg      the images, numbered from 1
//   data/videos/<executionId>/index.json   { startedAt, frames: [{ n, at }] }
//
// While the run goes, its images wait in data/videos/.<executionId>/. Videos are kept
// VIDEO_DAYS days (IZITEST_VIDEO_DAYS, 30 by default); IZITEST_RUN_VIDEO=off records none.

import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

// Beside the database when it is elsewhere (a test's own): never in the real data folder then.
const VIDEOS_DIR = process.env.IZITEST_VIDEOS_DIR
  || (process.env.IZITEST_DB_PATH ? join(dirname(process.env.IZITEST_DB_PATH), 'videos') : null)
  || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'data', 'videos');
const VIDEO_DAYS = Number(process.env.IZITEST_VIDEO_DAYS) || 30;
// A run longer than this keeps its first images only: a stuck run does not fill the disk.
const MAX_FRAMES = Number(process.env.IZITEST_VIDEO_MAX_FRAMES) || 3000;

/** Whether runs are recorded at all (IZITEST_RUN_VIDEO=off: never). */
export const runVideoOn = () => !/^(off|false|0|no)$/i.test(process.env.IZITEST_RUN_VIDEO ?? '');

const pendingDir = (id) => join(VIDEOS_DIR, `.${Number(id)}`);
const finalDir = (id) => join(VIDEOS_DIR, String(Number(id)));

// The runs being recorded: their images so far.
const running = new Map();

/** A run starts: its images are taken from now on (pushed with its id). */
export function startRunVideo(executionId) {
  if (!runVideoOn() || !Number.isInteger(Number(executionId))) return false;
  const dir = pendingDir(executionId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  running.set(Number(executionId), { dir, count: 0, startedAt: Date.now() });
  return true;
}

/** An image of run `executionId`'s tab (a JPEG), taken at `at`. Ignored for a run not recorded. */
export function addRunFrame(executionId, jpeg, at = Date.now()) {
  const run = running.get(Number(executionId));
  if (!run || run.count >= MAX_FRAMES || !jpeg?.length) return false;
  run.count += 1;
  writeFileSync(join(run.dir, `${run.count}.jpg`), jpeg);
  appendFileSync(join(run.dir, 'frames.jsonl'), `${JSON.stringify({ n: run.count, at: Number(at) || Date.now() })}\n`);
  return true;
}

/**
 * Run `executionId` ended: its video kept (`keep`, as `index.json` beside its images) or thrown
 * away. The number of images kept (0 when none was, or the run was not recorded).
 */
export function finishRunVideo(executionId, { keep }) {
  const id = Number(executionId);
  const run = running.get(id);
  running.delete(id);
  if (!run) return 0;
  if (!keep || !run.count) {
    rmSync(run.dir, { recursive: true, force: true });
    return 0;
  }
  const frames = readFileSync(join(run.dir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .sort((a, b) => a.at - b.at || a.n - b.n);
  writeFileSync(join(run.dir, 'index.json'), JSON.stringify({ startedAt: run.startedAt, frames }));
  rmSync(join(run.dir, 'frames.jsonl'), { force: true });
  rmSync(finalDir(id), { recursive: true, force: true });
  renameSync(run.dir, finalDir(id));
  log(`Run #${id}: video kept (${frames.length} images)`);
  return frames.length;
}

/** The video of run `executionId`: `{ startedAt, frames: [{ n, at }] }`, or null. */
export function runVideo(executionId) {
  const file = join(finalDir(executionId), 'index.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The file of image `n` of run `executionId`'s video, or null. */
export function runVideoFrame(executionId, n) {
  if (!/^\d+$/.test(String(n))) return null;
  const file = join(finalDir(executionId), `${Number(n)}.jpg`);
  return existsSync(file) ? file : null;
}

/** Throw away the video of run `executionId` (its run deleted). */
export function deleteRunVideo(executionId) {
  rmSync(finalDir(executionId), { recursive: true, force: true });
}

/**
 * Videos older than VIDEO_DAYS days, and those of runs that no longer exist (`exists(id)`), thrown
 * away; images left by a run the server stopped during. How many videos went.
 */
export function purgeRunVideos(exists = () => true, now = Date.now()) {
  if (!existsSync(VIDEOS_DIR)) return 0;
  let gone = 0;
  for (const name of readdirSync(VIDEOS_DIR)) {
    const dir = join(VIDEOS_DIR, name);
    const pending = name.startsWith('.');
    const id = Number(pending ? name.slice(1) : name);
    if (!Number.isInteger(id)) continue;
    if (pending && running.has(id)) continue;
    const old = now - statSync(dir).mtimeMs > VIDEO_DAYS * 24 * 60 * 60 * 1000;
    if (pending || old || !exists(id)) {
      rmSync(dir, { recursive: true, force: true });
      if (!pending) gone += 1;
    }
  }
  if (gone) log(`Videos: ${gone} thrown away (older than ${VIDEO_DAYS} days, or of runs deleted)`);
  return gone;
}
