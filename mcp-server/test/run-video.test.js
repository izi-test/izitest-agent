// The video of a test run: the images of its tab, recorded by the extension from the moment the
// tab is known and pushed with the run's id; kept when the run failed or Record video was asked,
// thrown away otherwise; watched again in the dashboard, its steps beside it. On a database and
// a videos folder of their own; the extension is a stand-in.
// Run with: node --test test/run-video.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, utimes } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'run-video-'));
process.env.IZITEST_DB_PATH = join(root, 'test.db');
process.env.IZITEST_VIDEOS_DIR = join(root, 'videos');
process.env.IZITEST_VIDEO_SETTLE_MS = '0';
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { startRunVideo, addRunFrame, finishRunVideo, runVideo, runVideoFrame, purgeRunVideos } = await import('../lib/run-video.js');
const { saveTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');

const jpeg = (n) => Buffer.from(`fake-jpeg-${n}`);

test('kept: its images numbered, their times in an index; thrown away: nothing left', () => {
  assert.equal(startRunVideo(1), true);
  addRunFrame(1, jpeg(1), 1000);
  addRunFrame(1, jpeg(2), 1250);
  assert.equal(addRunFrame(99, jpeg(1), 1000), false, 'a run not recorded');
  assert.equal(finishRunVideo(1, { keep: true }), 2);
  assert.deepEqual(runVideo(1).frames, [{ n: 1, at: 1000 }, { n: 2, at: 1250 }]);
  assert.ok(runVideoFrame(1, 2));
  assert.equal(runVideoFrame(1, 3), null);
  assert.equal(runVideoFrame(1, '../x'), null);

  startRunVideo(2);
  addRunFrame(2, jpeg(1), 1000);
  assert.equal(finishRunVideo(2, { keep: false }), 0);
  assert.equal(runVideo(2), null);
  assert.equal(existsSync(join(process.env.IZITEST_VIDEOS_DIR, '.2')), false);
});

test('old videos, those of deleted runs and the images of a run cut short are thrown away', async () => {
  startRunVideo(3); addRunFrame(3, jpeg(1)); finishRunVideo(3, { keep: true });
  startRunVideo(4); addRunFrame(4, jpeg(1)); finishRunVideo(4, { keep: true });
  mkdirSync(join(process.env.IZITEST_VIDEOS_DIR, '.77'), { recursive: true });
  writeFileSync(join(process.env.IZITEST_VIDEOS_DIR, '.77', '1.jpg'), jpeg(1));
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await utimes(join(process.env.IZITEST_VIDEOS_DIR, '3'), longAgo, longAgo);
  purgeRunVideos((id) => id !== 1);
  const left = await readdir(process.env.IZITEST_VIDEOS_DIR);
  assert.deepEqual(left.sort(), ['4'], 'run 1 deleted, 3 too old, .77 cut short');
});

/** A test whose second step fails or not; the extension stand-in sends two images per sequence. */
function run(name, { fails }) {
  saveTest({ name, steps: [
    { command: 'navigate', params: { url: 'https://shop.test/' }, intent: 'Open the shop' },
    { command: 'click', params: { selector: '#buy' }, intent: 'Buy' },
  ] });
  const calls = [];
  const sendCommand = async (_profile, command, params) => {
    calls.push({ command, params });
    if (command !== 'replay_sequence') return {};
    const id = params.record?.runId;
    if (id) { addRunFrame(id, jpeg(1), Date.now()); addRunFrame(id, jpeg(2), Date.now() + 200); }
    const results = [{ step: 1, command: 'navigate', status: 'success', tabId: 8 }, { step: 2, command: 'click', status: fails ? 'failed' : 'success', error: fails ? 'Element not found: #buy' : undefined, tabId: 8 }];
    if (fails) throw Object.assign(new Error('Element not found: #buy'), { results });
    return { results };
  };
  return { sendCommand, calls };
}

test('a run that fails keeps its video; its tab stops being recorded', async () => {
  const { sendCommand, calls } = run('fails', { fails: true });
  const failed = await executeTest('fails', {}, null, null, true, sendCommand, 'test').catch((err) => err);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(calls.find((c) => c.command === 'replay_sequence').params.record, { runId: failed.executionId }, 'the extension records the run');
  assert.deepEqual(calls.find((c) => c.command === 'live_record_stop')?.params, { tabId: 8 });
  assert.deepEqual(failed.video, { frames: 2 });
  assert.equal(db.prepare('SELECT video_frames FROM test_executions WHERE id = ?').get(failed.executionId).video_frames, 2);
  assert.equal(runVideo(failed.executionId).frames.length, 2);
});

test('while the run goes, its tab is asked again to be filmed: a capture lost comes back', async () => {
  process.env.IZITEST_VIDEO_KEEPALIVE_MS = '20';
  const { sendCommand, calls } = run('slow', { fails: false });
  // The run's steps take a while (a page loading after a login); its first step tells its tab as it goes.
  const slow = async (...args) => {
    if (args[1] === 'replay_sequence') {
      await args[4]?.({ type: 'step_complete', stepResult: { step: 1, command: 'navigate', status: 'success', tabId: 8 } });
      await new Promise((r) => setTimeout(r, 120));
    }
    return sendCommand(...args);
  };
  await executeTest('slow', {}, null, null, true, slow, 'test');
  const asked = calls.filter((c) => c.command === 'live_record_run');
  assert.ok(asked.length >= 1, `asked ${asked.length} time(s)`);
  assert.deepEqual(asked[0].params.tabId, 8);
  delete process.env.IZITEST_VIDEO_KEEPALIVE_MS;
});

test('a run that passes keeps none, unless Record video was asked', async () => {
  const passed = await executeTest('passes', {}, null, null, true, run('passes', { fails: false }).sendCommand, 'test');
  assert.equal(passed.video, undefined);
  assert.equal(runVideo(passed.executionId), null);
  assert.equal(db.prepare('SELECT video_frames FROM test_executions WHERE id = ?').get(passed.executionId).video_frames, 0);

  const asked = await executeTest('passes', {}, null, null, true, run('passes', { fails: false }).sendCommand, 'test', null, null, { recordVideo: true });
  assert.deepEqual(asked.video, { frames: 2 });
  assert.equal(runVideo(asked.executionId).frames.length, 2);
});

test('IZITEST_RUN_VIDEO=off: no run is recorded', async () => {
  process.env.IZITEST_RUN_VIDEO = 'off';
  try {
    const { sendCommand, calls } = run('off', { fails: true });
    const failed = await executeTest('off', {}, null, null, true, sendCommand, 'test').catch((err) => err);
    assert.equal(calls.find((c) => c.command === 'replay_sequence').params.record, undefined);
    assert.equal(failed.video, undefined);
  } finally {
    delete process.env.IZITEST_RUN_VIDEO;
  }
});
