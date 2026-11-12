// Unit tests for how long a replayed step waits for its element: a project setting, 10 s by
// default, sent to the extension with every replay. The extension is a stand-in that keeps
// what it was sent. On a database of its own, thrown away after.
// Run with: node --test test/element-timeout.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'element-timeout-')), 'test.db');
delete process.env.IZITEST_ASSERT_TIMEOUT_MS;
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const {
  createProject, elementTimeoutOf, elementTimeoutFor, listProjects,
  DEFAULT_ELEMENT_TIMEOUT_MS, MIN_ELEMENT_TIMEOUT_MS, MAX_ELEMENT_TIMEOUT_MS,
} = await import('../lib/projects.js');
const { saveTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { getToolMap } = await import('../lib/agent/tools.js');

/** The extension, stood in for: the replay parameters it was sent. */
function extension() {
  const sent = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      sent.push(params);
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 })) };
    }
    return {};
  };
  return { sendCommand, sent };
}

const steps = [
  { command: 'navigate', params: { url: 'https://app.test/' } },
  { command: 'click', params: {}, locators: [{ type: 'css', value: '#go' }] },
];

test('a wait asked for is a whole number of ms from 1 s to 120 s; empty keeps the default', () => {
  assert.equal(DEFAULT_ELEMENT_TIMEOUT_MS, 10_000);
  assert.equal(elementTimeoutOf(null), null);
  assert.equal(elementTimeoutOf(undefined), null);
  assert.equal(elementTimeoutOf(''), null);
  assert.equal(elementTimeoutOf(15000), 15000);
  assert.equal(elementTimeoutOf('20000'), 20000);
  for (const bad of [MIN_ELEMENT_TIMEOUT_MS - 1, MAX_ELEMENT_TIMEOUT_MS + 1, 1500.5, 'ten', -1, 0]) {
    assert.throws(() => elementTimeoutOf(bad), /element_timeout_ms/, String(bad));
  }
});

test('a project without a setting waits the default; one with a setting waits that', () => {
  const plain = createProject({ name: 'Plain' });
  const slow = createProject({ name: 'Slow', element_timeout_ms: 30000 });
  assert.equal(elementTimeoutFor(plain.id), DEFAULT_ELEMENT_TIMEOUT_MS);
  assert.equal(elementTimeoutFor(slow.id), 30000);
  assert.equal(elementTimeoutFor(null), DEFAULT_ELEMENT_TIMEOUT_MS, 'a test without a project');
  assert.equal(listProjects().find((p) => p.id === slow.id).element_timeout_ms, 30000, 'the dashboard reads it');
  assert.throws(() => createProject({ name: 'Wrong', element_timeout_ms: 500 }), /element_timeout_ms/);
});

test('every replay sends the project\'s wait to the extension', async () => {
  const slow = db.prepare("SELECT id FROM projects WHERE name = 'Slow'").get().id;
  saveTest({ name: 'slow_page', variables: {}, steps });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(slow, 'slow_page');
  saveTest({ name: 'no_project', variables: {}, steps });

  const a = extension();
  const run = await executeTest('slow_page', {}, null, null, true, a.sendCommand, 'test');
  assert.ok(run.results.every((r) => r.status === 'success'));
  assert.ok(a.sent.length > 0);
  for (const params of a.sent) assert.equal(params.elementTimeoutMs, 30000);

  const b = extension();
  await executeTest('no_project', {}, null, null, true, b.sendCommand, 'test');
  for (const params of b.sent) assert.equal(params.elementTimeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
});

test('the agent can set it, and set it back to the default', () => {
  const tool = getToolMap().update_project_context;
  const id = db.prepare("SELECT id FROM projects WHERE name = 'Plain'").get().id;
  assert.equal(tool.handler({ project_id: id, element_timeout_ms: 25000 }).data.element_timeout_ms, 25000);
  assert.equal(elementTimeoutFor(id), 25000);
  assert.match(tool.handler({ project_id: id, element_timeout_ms: 999999 }).error, /element_timeout_ms/);
  assert.equal(tool.handler({ project_id: id, element_timeout_ms: null }).data.element_timeout_ms, DEFAULT_ELEMENT_TIMEOUT_MS);
});
