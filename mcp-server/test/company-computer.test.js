// What a company computer asked for: the system's certificates trusted (a proxy inspecting
// HTTPS), each test starting logged out in the browser without windows, and a password typed
// while recording kept as a secret of the project instead of in the test. On a database of its
// own, thrown away after; the extension and Node's tls are stand-ins.
// Run with: node --test test/company-computer.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'company-computer-'));
process.env.IZITEST_DB_PATH = join(dir, 'test.db');
process.env.IZITEST_SECRET_KEY_FILE = join(dir, 'secret.key');
delete process.env.IZITEST_SECRET_KEY;
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { trustSystemCertificates } = await import('../lib/system-ca.js');
const { createProject, cleanStartFor } = await import('../lib/projects.js');
const { saveTest } = await import('../lib/test-store.js');
const { executeTest, startOrigins } = await import('../lib/test-execute.js');
const { recordedPassword, secretNameOf, secretValue, listSecrets } = await import('../lib/secrets.js');
const { getToolMap } = await import('../lib/agent/tools.js');

// ─── Certificates ───────────────────────────────────────────────────

function tlsStandIn({ bundled = ['A', 'B'], system = ['B', 'CORP'], readable = true } = {}) {
  const state = { set: null };
  const module = readable
    ? { getCACertificates: (which) => (which === 'system' ? system : bundled), setDefaultCACertificates: (list) => { state.set = list; } }
    : {};
  return { module, state };
}

test('the system\'s roots are trusted as well as Node\'s, each once', () => {
  const { module, state } = tlsStandIn();
  assert.equal(trustSystemCertificates({ env: {}, tlsModule: module }), 1);
  assert.deepEqual(state.set, ['A', 'B', 'CORP']);
});

test('an older Node, or IZITEST_SYSTEM_CA=0: nothing changes', () => {
  assert.equal(trustSystemCertificates({ env: {}, tlsModule: tlsStandIn({ readable: false }).module }), 0);
  const { module, state } = tlsStandIn();
  assert.equal(trustSystemCertificates({ env: { IZITEST_SYSTEM_CA: '0' }, tlsModule: module }), 0);
  assert.equal(state.set, null);
  const same = tlsStandIn({ system: ['A'] });
  assert.equal(trustSystemCertificates({ env: {}, tlsModule: same.module }), 0, 'nothing new: left as it is');
  assert.equal(same.state.set, null);
});

// ─── Logged out at the start of each test ───────────────────────────

/** The extension: what it was sent, in order. */
function extension() {
  const sent = [];
  const sendCommand = async (_profile, command, params) => {
    sent.push({ command, params });
    if (command === 'replay_sequence') return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 })) };
    if (command === 'clear_site_data') return { cleared: true, origins: params.origins };
    return {};
  };
  return { sendCommand, sent };
}

const portal = createProject({ name: 'Portal', base_url: 'https://portal.corp.test/ECM/' });
const steps = [
  { command: 'navigate', params: { url: 'https://portal.corp.test/ECM/login/auth' } },
  { command: 'navigate', params: { url: 'https://sso.corp.test/start' } },
  { command: 'click', params: {}, locators: [{ type: 'css', value: '#login' }] },
];
saveTest({ name: 'portal_login', variables: {}, steps });
db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(portal.id, 'portal_login');

test('the origins a test goes to: its pages and its project\'s base URL, each once', () => {
  assert.deepEqual(startOrigins(steps, portal.id), ['https://portal.corp.test', 'https://sso.corp.test']);
  assert.deepEqual(startOrigins([{ command: 'navigate', params: { url: '{{base_url}}/x' } }], null), [], 'a URL still holding a variable is left out');
});

test('a test started from its first step clears what the app left, before anything else', async () => {
  assert.equal(cleanStartFor(portal.id), true, 'on by default');
  const { sendCommand, sent } = extension();
  await executeTest('portal_login', {}, null, null, true, sendCommand, 'test');
  assert.equal(sent[0].command, 'clear_site_data');
  assert.deepEqual(sent[0].params.origins, ['https://portal.corp.test', 'https://sso.corp.test']);
  assert.ok(sent.some((s) => s.command === 'replay_sequence'));
});

test('started from a later step, or with the setting off: nothing is cleared', async () => {
  const later = extension();
  await executeTest('portal_login', {}, null, 3, true, later.sendCommand, 'test');
  assert.equal(later.sent.some((s) => s.command === 'clear_site_data'), false, 'resumed: the session it has is the one it needs');

  const tool = getToolMap().update_project_context;
  assert.equal(tool.handler({ project_id: portal.id, clean_start: false }).data.clean_start, false);
  const off = extension();
  await executeTest('portal_login', {}, null, null, true, off.sendCommand, 'test');
  assert.equal(off.sent.some((s) => s.command === 'clear_site_data'), false);
  tool.handler({ project_id: portal.id, clean_start: true });
});

test('an extension that cannot clear does not stop the run', async () => {
  const sent = [];
  const sendCommand = async (_profile, command, params) => {
    sent.push(command);
    if (command === 'clear_site_data') throw new Error('Unknown command: clear_site_data');
    if (command === 'replay_sequence') return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 })) };
    return {};
  };
  const run = await executeTest('portal_login', {}, null, null, true, sendCommand, 'test');
  assert.ok(sent.includes('replay_sequence'));
  assert.ok(run.results.every((r) => r.status === 'success'));
});

// ─── A password typed while recording ───────────────────────────────

const field = (name) => ({ success: true, target: { role: 'textbox', name, secret: true } });

test('a secret is named after its field', () => {
  assert.equal(secretNameOf('Mot de passe'), 'MOT_DE_PASSE');
  assert.equal(secretNameOf('Password*'), 'PASSWORD');
  assert.equal(secretNameOf(''), 'PASSWORD');
  assert.equal(secretNameOf('2FA code'), '_2FA_CODE');
});

test('a password typed in plain becomes a secret of the project; the step keeps its reference', () => {
  const recording = { projectId: portal.id };
  const { recorded, note } = recordedPassword('Hunter2!', field('Mot de passe'), recording);
  assert.equal(recorded, '{{secret.MOT_DE_PASSE}}');
  assert.match(note, /secret MOT_DE_PASSE/);
  assert.ok(!note.includes('Hunter2!'), 'the agent is not told the value back');
  assert.equal(secretValue(portal.id, 'MOT_DE_PASSE'), 'Hunter2!');

  assert.equal(recordedPassword('Hunter2!', field('Mot de passe'), recording).recorded, '{{secret.MOT_DE_PASSE}}', 'the same value: the same secret');
  assert.equal(recordedPassword('Other1!', field('Mot de passe'), recording).recorded, '{{secret.MOT_DE_PASSE_2}}', 'another value: a secret of its own');
  assert.deepEqual(listSecrets(portal.id).map((s) => s.name), ['MOT_DE_PASSE', 'MOT_DE_PASSE_2']);
});

test('what is left as it is: a reference, a field that is no password, no recording', () => {
  const recording = { projectId: portal.id };
  assert.equal(recordedPassword('{{secret.PORTAL_PASSWORD}}', field('Mot de passe'), recording).recorded, '{{secret.PORTAL_PASSWORD}}');
  assert.equal(recordedPassword('{{password}}', field('Mot de passe'), recording).recorded, '{{password}}');
  assert.equal(recordedPassword('alice', { success: true, target: { role: 'textbox', name: 'Login' } }, recording).recorded, 'alice');
  assert.equal(recordedPassword('Hunter2!', field('Mot de passe'), null).recorded, 'Hunter2!', 'not recording: nothing is kept');
});

test('recording without a project: the agent is told the password stays in plain', () => {
  const { recorded, note } = recordedPassword('Hunter2!', field('Password'), { projectId: null });
  assert.equal(recorded, 'Hunter2!');
  assert.match(note, /start_recording\(project_id\)/);
});

// ─── The server's log ───────────────────────────────────────────────

test('the log shows what is typed by its length only, never the value', async () => {
  const { loggedParams } = await import('../lib/websocket.js');
  assert.deepEqual(
    loggedParams({ value: 'Hunter2!', ref: '@e3', steps: [{ command: 'fill', params: { value: 'S3cret', url: 'https://x.test' } }, { params: { value: '{{secret.PASSWORD}}' } }] }),
    { value: '«8 chars»', ref: '@e3', steps: [{ command: 'fill', params: { value: '«6 chars»', url: 'https://x.test' } }, { params: { value: '{{secret.PASSWORD}}' } }] },
  );
});
