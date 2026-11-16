// A business step reused: recognised in a test whatever waits of a time only it or the test
// holds, played by an agent as one action (its steps recorded linked to it), inserted from the
// dashboard; and the elements of a project offered with their selector. On a database of its
// own, thrown away after; the extension is a stand-in.
// Run with: node --test test/business-reuse.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'business-reuse-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { createProject } = await import('../lib/projects.js');
const { saveTest, loadTest, insertTestStep } = await import('../lib/test-store.js');
const { createStepDefinition, listStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { serializeTestToFeature, scenarioPhrases } = await import('../lib/gherkin/serialize.js');
const { buildBusinessStep } = await import('../lib/gherkin/business-step.js');
const { stepsOfBusinessPhrase, businessStepsOf, playBusinessSteps } = await import('../lib/business-play.js');
const { listElements } = await import('../lib/element-store.js');

const PAGE = 'portal.test/ECM/login/auth';
const field = (selector, name, value) => ({
  command: 'fill', params: { selector, value }, page: PAGE,
  locators: [{ type: 'css', value: selector }, { type: 'aria', value: name }],
});
const login = { command: 'click', params: { selector: 'button.btn' }, page: PAGE, locators: [{ type: 'aria', value: 'Login' }, { type: 'css', value: 'button.btn' }] };
const time = (ms) => ({ command: 'wait', params: { ms } });

const project = createProject({ name: 'Portal', language: 'fr', base_url: 'https://portal.test/ECM/' });

// The business step as the user made it: the login, then two waits of a time only.
saveTest({ name: 'source', variables: {}, steps: [field('#username', 'Username', '{{j_username}}'), field('input[name="j_password"]', 'Password', '{{j_password}}'), login, time(4000), time(3000)] });
db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project.id, 'source');
const withWaits = buildBusinessStep(loadTest('source'), {
  from_step: 1, to_step: 5, pattern: "je me connecte au portail avec l'identifiant {string} et le mot de passe {string}",
  args: [{ variable: 'j_username' }, { variable: 'j_password' }],
});
const loginStep = createStepDefinition(project.id, {
  keyword: 'When', pattern: "je me connecte au portail avec l'identifiant {string} et le mot de passe {string}",
  command: 'composite', params_template: {},
  // Made before waits were left out: they are in it.
  steps_template: [...withWaits.steps_template, time(4000), time(3000)],
});

const phrasesOf = (name) => serializeTestToFeature(loadTest(name), project.id).split('\n').filter((l) => /^\s{4}\S/.test(l)).map((l) => l.trim());

test('made now, a business step leaves its waits of a time only out', () => {
  assert.deepEqual(withWaits.steps_template.map((s) => s.command), ['fill', 'fill', 'click']);
});

test('a test holding the login with a wait of its own after it reads as the business step, the wait no phrase but kept with it', () => {
  saveTest({ name: 'user_access', variables: {}, steps: [{ command: 'navigate', params: { url: 'https://portal.test/ECM/' } }, field('#username', 'Username', '{{j_username}}'), field('input[name="j_password"]', 'Password', '{{j_password}}'), login, time(4000), { command: 'click', params: { selector: '#start' }, locators: [{ type: 'css', value: '#start' }] }] });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project.id, 'user_access');
  const phrases = phrasesOf('user_access');
  assert.ok(phrases.some((p) => p.includes("je me connecte au portail avec l'identifiant \"{{j_username}}\" et le mot de passe \"{{j_password}}\"")), phrases.join('\n'));
  assert.ok(!phrases.some((p) => /4 secondes|4 seconds/.test(p)), 'a wait of a time only says how the test runs, not what it does: no phrase');
  const business = scenarioPhrases(loadTest('user_access'), listStepDefinitions(project.id)).find((p) => p.business);
  assert.deepEqual(business.steps.map((s) => s.command), ['fill', 'fill', 'click', 'wait'], 'it goes with the phrase before it');
});

test('a wait between the sub-steps does not keep it from reading as the business step', () => {
  saveTest({ name: 'slow_login', variables: {}, steps: [field('#username', 'Username', '{{j_username}}'), time(1000), field('input[name="j_password"]', 'Password', '{{j_password}}'), login] });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project.id, 'slow_login');
  assert.equal(phrasesOf('slow_login').length, 1);
});

test('a business step is listed with its parameters, and its phrase gives its steps, the first linked to it', () => {
  const listed = businessStepsOf(project.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].steps, 3, 'its waits are not counted');
  assert.deepEqual(listed[0].parameters, ['{string}', '{string}']);
  const found = stepsOfBusinessPhrase(project.id, `Quand je me connecte au portail avec l'identifiant "{{secret.PORTAL_USERNAME}}" et le mot de passe "{{secret.PORTAL_PASSWORD}}"`);
  assert.equal(found.steps.length, 3);
  assert.equal(found.steps[0].params.value, '{{secret.PORTAL_USERNAME}}');
  assert.equal(found.steps[1].params.value, '{{secret.PORTAL_PASSWORD}}');
  assert.equal(found.steps[0].step_definition_id, loginStep.id);
  assert.ok(found.steps[2].locators?.length, 'with its locators');
  assert.match(stepsOfBusinessPhrase(project.id, 'je fais autre chose').error, /No business step of the project reads/);
});

test('played, its actions go to the browser one by one with the session\'s values; a failure names the step', async () => {
  const found = stepsOfBusinessPhrase(project.id, `je me connecte au portail avec l'identifiant "{{secret.U}}" et le mot de passe "{{secret.P}}"`);
  const sent = [];
  const sendCommand = async (_p, command, params) => {
    sent.push(params.steps[0]);
    return { results: [{ status: 'success', tabId: 9 }] };
  };
  const live = (params) => JSON.parse(JSON.stringify(params).replace(/\{\{secret\.(\w)\}\}/g, 'value-$1'));
  assert.deepEqual(await playBusinessSteps(found, { sendCommand, live, tabId: 9, elementTimeoutMs: 1000 }), { tabId: 9 });
  assert.deepEqual(sent.map((s) => s.params.value ?? null), ['value-U', 'value-P', null]);
  assert.equal(found.steps[0].params.value, '{{secret.U}}', 'what is recorded keeps the reference');

  const failing = async () => ({ results: [{ status: 'failed', error: 'All 2 locators failed' }] });
  const played = await playBusinessSteps(found, { sendCommand: failing, live, tabId: 9, elementTimeoutMs: 1000 });
  assert.match(played.error, /stopped at its step 1 of 3 \(fill.*All 2 locators failed/);
});

test('inserted in a test, its steps keep the link and the test reads as the phrase', () => {
  saveTest({ name: 'inserted', variables: {}, steps: [{ command: 'navigate', params: { url: 'https://portal.test/ECM/login/auth' } }] });
  const t = db.prepare('SELECT id FROM tests WHERE name = ?').get('inserted');
  db.prepare('UPDATE tests SET project_id = ? WHERE id = ?').run(project.id, t.id);
  const found = stepsOfBusinessPhrase(project.id, `je me connecte au portail avec l'identifiant "alice" et le mot de passe "{{secret.P}}"`);
  found.steps.forEach((step, i) => insertTestStep(t.id, 2 + i, step));
  const saved = loadTest('inserted');
  assert.equal(saved.steps.length, 4);
  assert.equal(saved.steps[1].step_definition_id, loginStep.id, 'the link is kept');
  assert.deepEqual(phrasesOf('inserted').slice(1), [`Quand je me connecte au portail avec l'identifiant "alice" et le mot de passe "{{secret.P}}"`]);
});

test('the elements of a project come with the selector and locators of the latest step on them', () => {
  const login = listElements(project.id).find((e) => e.name === 'Login');
  assert.equal(login.selector, 'button.btn');
  assert.deepEqual(login.locators.map((l) => l.type), ['aria', 'css']);
});
