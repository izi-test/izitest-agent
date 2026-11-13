// The logout a test ends with, played even when the test failed before it: the app keeps the
// session a failed run opened, and the portal refused the next runs ("Concurrent Sessions Exceeded").
// The steps are those of the portal's tests; the extension is a stand-in. On a database of its own.
// Run with: node --test test/closing-logout.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'closing-logout-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { closingLogout, logoutToPlay } = await import('../lib/closing-logout.js');
const { saveTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');

const LOGOUT = 7;
const patternOf = (id) => (id === LOGOUT ? 'je me déconnecte du portail' : null);
const click = (intent, extra = {}) => ({ command: 'click', params: { selector: `#${intent.length}` }, intent, ...extra });
const check = (intent) => ({ command: 'assert', params: {}, intent, assertion: { type: 'url_contains', expected: '/x' } });

// "User Access": a check, then the logout business step (its second step has no intent).
const userAccess = [click('Ouvrir le portail'), click('Démarrer une demande'), check('Le profil est proposé'),
  click('je me déconnecte du portail', { step_definition_id: LOGOUT }), click('', { step_definition_id: LOGOUT })];

test('the logout business step a test ends with, all its steps', () => {
  assert.deepEqual(closingLogout(userAccess, patternOf), [3, 4]);
});

test('said by intents only: the click that opens the account menu goes with it, a check of the logged-out page does not', () => {
  const lisaConnexion = [click('Se connecter'), check('Connecté'), click('Ouvrir le menu du compte'), click('Se déconnecter'),
    check('Déconnecté : la page de déconnexion s\'affiche, la session est libérée')];
  assert.deepEqual(closingLogout(lisaConnexion), [2, 3]);
  const english = [click('Open the orders'), click('Open the user menu'), click('Log out')];
  assert.deepEqual(closingLogout(english), [1, 2]);
});

test('a test that does not end with a logout has none; a logout in its middle is not one', () => {
  assert.deepEqual(closingLogout([click('Ouvrir le portail'), check('La page s\'ouvre')]), []);
  assert.deepEqual(closingLogout([click('Se déconnecter'), click('Se connecter avec un autre compte'), check('Connecté')]), []);
});

test('played only when the run stopped before it', () => {
  assert.deepEqual(logoutToPlay(userAccess, 3, patternOf), [3, 4], 'the check before it failed');
  assert.deepEqual(logoutToPlay(userAccess, 4, patternOf), [], 'it failed in the logout itself: it was played');
  assert.deepEqual(logoutToPlay(userAccess, null, patternOf), []);
});

test('a run that fails before its logout still plays it, in its tab; the verdict stays failed', async () => {
  const definition = db.prepare("INSERT INTO projects (name) VALUES ('PORTAL')").run().lastInsertRowid;
  const stepDefinition = db.prepare("INSERT INTO step_definitions (project_id, keyword, pattern, command) VALUES (?, 'When', 'je me déconnecte du portail', 'composite')").run(definition).lastInsertRowid;
  saveTest({
    name: 'fails before its logout',
    steps: [
      { command: 'navigate', params: { url: 'https://portal.test/ECM/' }, intent: 'Ouvrir le portail' },
      { command: 'click', params: { selector: '#start' }, intent: 'Démarrer une demande' },
      { command: 'click', params: { selector: 'button.jss86' }, intent: 'je me déconnecte du portail', step_definition_id: stepDefinition },
      { command: 'click', params: { text: 'Log Out' }, step_definition_id: stepDefinition },
    ],
  });
  const sequences = [];
  const sendCommand = async (_profile, command, params) => {
    if (command !== 'replay_sequence') return {};
    sequences.push({ steps: params.steps.map((s) => s.params.selector ?? s.params.text ?? s.params.url), tabId: params.tabId ?? null, newWindow: params.newWindow });
    // As the extension does: a step that fails rejects the sequence, with the results so far.
    if (sequences.length === 1) {
      throw Object.assign(new Error('Element not found: #start'), { results: [
        { step: 1, command: 'navigate', status: 'success', tabId: 41 },
        { step: 2, command: 'click', status: 'failed', error: 'Element not found: #start', tabId: 41 },
      ] });
    }
    return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 41 })) };
  };
  const failed = await executeTest('fails before its logout', {}, null, null, true, sendCommand, 'test').catch((err) => err);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failedStep, 2);
  assert.deepEqual(sequences.at(-1), { steps: ['button.jss86', 'Log Out'], tabId: 41, newWindow: false }, 'its logout, in the tab it failed in');
  assert.deepEqual(failed.closingLogout, { steps: [3, 4], loggedOut: true });
  const statuses = db.prepare('SELECT step_order, status FROM execution_steps WHERE execution_id = ? ORDER BY step_order').all(failed.executionId).map((r) => r.status);
  assert.deepEqual(statuses, ['success', 'failed', 'success', 'success'], 'the report shows the logout played');
  assert.equal(db.prepare('SELECT status FROM test_executions WHERE id = ?').get(failed.executionId).status, 'failed');
});
