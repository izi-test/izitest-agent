// Unit tests for test design (lib/requirement-design.js): the method laid out for a
// requirement, an agent's answer checked, its scenarios resolved against the project's
// phrases, kept, planned — and what the agent recording a case is told. The agent is a
// stand-in that answers what a real one would. On a database of their own, thrown away after.
// Run with: node --test test/requirement-design.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'requirement-design-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveRequirement, getRequirement, planCases, updateCase, linkTest, formatRequirement, nonConformityOf } = await import('../lib/requirements.js');
const { designBrief, parseDesign, resolveScenario, withResolution, designTests, planDesigned, recordingBrief, projectBrief, definitionsFor } = await import('../lib/requirement-design.js');
const { seedProjectStepDefinitions, createStepDefinition } = await import('../lib/gherkin/step-definition-store.js');
const { cliInvocation } = await import('../lib/agent/complete.js');

const project = db.prepare("INSERT INTO projects (name, base_url, context) VALUES ('Shop', 'https://shop.test', 'The login form: #email, #password, button Sign in.') RETURNING id").get().id;
seedProjectStepDefinitions(project);
createStepDefinition(project, {
  keyword: 'Given', pattern: 'I am logged in as {string}', command: 'composite',
  steps_template: [{ command: 'navigate', params: { url: 'https://shop.test/login' } }, { command: 'fill', params: { selector: '#email', value: '{0}' } }],
});

const LOGIN = {
  title: 'Un mauvais mot de passe est refusé', projectId: project, source: 'jira', key: 'SHOP-7',
  criteria: ['Un mauvais mot de passe affiche "Identifiants invalides"', 'La connexion doit être rapide', 'Après 3 échecs le compte est bloqué'],
};

// What an agent answers: fenced, with a scenario of each sort, and things to drop.
const ANSWER = '```json\n' + JSON.stringify({
  review: [
    { criterion: 2, issue: '« Rapide » ne se mesure pas.', question: 'En combien de secondes ?', suggestion: 'La connexion répond en moins de 2 secondes' },
    { criterion: 9, issue: 'No such criterion' },
    { criterion: 2, issue: 'Twice the same criterion' },
  ],
  missing: ['Un mot de passe vide affiche une erreur', ''],
  scenarios: [
    {
      title: 'Mot de passe erroné', criterion: 1, kind: 'error', technique: 'equivalence_partitioning', priority: 'high', rationale: 'La classe invalide.',
      gherkin: 'Scenario: Mot de passe erroné\n  Given I am on "https://shop.test/login"\n  When I fill "#email" with "a@b.c"\n  And I type "wrong" as the password\n  And I click on the text "Sign in"\n  Then I should see "Identifiants invalides"',
    },
    { title: 'Troisième échec', criterion: 3, technique: 'boundary_values', priority: 'urgent', gherkin: 'Given I am logged in as "a@b.c"\nThen I should see "Compte bloqué"' },
    { title: 'Sur tout le parcours', criterion: null, technique: 'made_up' },
    { criterion: 1, technique: 'use_case' },
  ],
}) + '\n```\nVoilà.';

test('the method laid out for a requirement: its criteria, cases, app, phrases and which arguments are selectors', () => {
  const { requirement } = saveRequirement(LOGIN);
  const planned = planCases(requirement.key, [{ title: 'Déjà prévu', criterion: 1, kind: 'error' }]);
  const brief = designBrief(planned);
  assert.match(brief, /# Test design for SHOP-7 — Un mauvais mot de passe est refusé/);
  assert.match(brief, /1\. Un mauvais mot de passe affiche "Identifiants invalides"\n2\. La connexion doit être rapide/);
  assert.match(brief, /- criterion 1, error: Déjà prévu \(planned\)/);
  assert.match(brief, /Project "Shop", at https:\/\/shop\.test\.[\s\S]*#email, #password/);
  assert.match(brief, /- When I fill \{string\} with \{string\} — the 1st \{string\} is a CSS selector/);
  assert.match(brief, /- When I drag \{string\} to \{string\} — the 1st and 2nd \{string\} are CSS selectors/);
  assert.match(brief, /- When I click on the text \{string\}\n/);
  assert.match(brief, /- Given I am logged in as \{string\} — business step \(2 actions of this app\)/);
  assert.match(brief, /never a\s+guessed one/);
  assert.match(brief, /## Answer\nAnswer with this JSON and nothing else/);
  const mcp = designBrief(planned, { answer: 'mcp' });
  assert.doesNotMatch(mcp, /## Answer/);
  assert.match(mcp, /plan_tests\(requirement: "SHOP-7"[\s\S]*create_test_from_gherkin[\s\S]*start_recording/);
  db.prepare('DELETE FROM requirement_cases').run();
});

test('an agent\'s answer checked: known criteria, kinds, techniques and priorities; each scenario a whole feature', () => {
  const requirement = getRequirement('SHOP-7');
  const design = parseDesign(ANSWER, requirement);
  assert.deepEqual(design.review, [{
    criterion: 2, criterion_text: 'La connexion doit être rapide', issue: '« Rapide » ne se mesure pas.',
    question: 'En combien de secondes ?', suggestion: 'La connexion répond en moins de 2 secondes',
  }]);
  assert.deepEqual(design.missing, ['Un mot de passe vide affiche une erreur']);
  assert.deepEqual(design.scenarios.map((s) => [s.id, s.title, s.criterion, s.kind, s.technique, s.priority]), [
    ['s1', 'Mot de passe erroné', 1, 'error', 'equivalence_partitioning', 'high'],
    ['s2', 'Troisième échec', 3, 'boundary', 'boundary_values', 'medium'],
    ['s3', 'Sur tout le parcours', null, 'nominal', null, 'medium'],
  ]);
  assert.match(design.scenarios[1].gherkin, /^Feature: Un mauvais mot de passe est refusé\n\n {2}Scenario: Troisième échec\n {4}Given I am logged in as "a@b\.c"\n {4}Then I should see "Compte bloqué"\n$/);
  assert.throws(() => parseDesign('Je ne peux pas répondre.', requirement), /did not answer with the test design \(JSON\): Je ne peux pas/);
  assert.throws(() => parseDesign('', requirement), /\(empty answer\)/);
});

test('a scenario resolved against the project\'s phrases: ready, or the steps an agent records', () => {
  const requirement = getRequirement('SHOP-7');
  const [wrong, third] = parseDesign(ANSWER, requirement).scenarios;
  const definitions = definitionsFor(requirement);
  assert.deepEqual(resolveScenario(wrong.gherkin, definitions), { phrases: 5, unresolved: ['And I type "wrong" as the password'], ready: false });
  assert.deepEqual(resolveScenario(third.gherkin, definitions), { phrases: 2, unresolved: [], ready: true }, 'a business step resolves');
  assert.match(resolveScenario('Scenario: no feature', definitions).error, /Feature|expected/i);
  assert.equal(resolveScenario(null, definitions), null);
});

test('the design asked of the agent is kept on the requirement, stale once its content changes', async () => {
  let asked = null;
  const requirement = await designTests('SHOP-7', { agent: 'stand-in', complete: async ({ system, prompt }) => { asked = { system, prompt }; return ANSWER; } });
  assert.match(asked.system, /test analyst/);
  assert.match(asked.prompt, /# Test design for SHOP-7/);
  assert.equal(requirement.design.agent, 'stand-in');
  assert.equal(requirement.design_stale, false);
  assert.deepEqual(requirement.design.scenarios.map((s) => s.resolution?.ready ?? null), [false, true, null]);
  assert.equal(getRequirement('SHOP-7').design.scenarios.length, 3, 'kept');

  const reworded = LOGIN.criteria.map((c, i) => (i === 1 ? 'La connexion répond en moins de 2 secondes' : c));
  saveRequirement({ ...LOGIN, criteria: reworded });
  assert.equal(getRequirement('SHOP-7').design_stale, true);
  await assert.rejects(designTests('SHOP-7', { complete: async () => 'no json' }), /did not answer/);
  assert.equal(getRequirement('SHOP-7').design.scenarios.length, 3, 'a failed design leaves the last one');
});

test('the chosen scenarios planned: of their criterion found by its text, gone from the design', () => {
  // Criterion 1 moved down: its text still finds it.
  saveRequirement({ ...LOGIN, criteria: ['Un compte inconnu affiche la même erreur', ...LOGIN.criteria] });
  const requirement = planDesigned('SHOP-7', ['s1', 's2']);
  const planned = requirement.cases.map((c) => [c.title, requirement.criteria.find((x) => x.id === c.criterion_id)?.position ?? null, c.kind, c.technique, c.priority]);
  assert.deepEqual(planned, [
    ['Mot de passe erroné', 2, 'error', 'equivalence_partitioning', 'high'],
    ['Troisième échec', 4, 'boundary', 'boundary_values', 'medium'],
  ]);
  assert.deepEqual(requirement.design.scenarios.map((s) => s.id), ['s3']);
  assert.equal(requirement.cases[0].rationale, 'La classe invalide.');
  assert.deepEqual(requirement.cases.map((c) => c.resolution.ready), [false, true]);
  assert.throws(() => planDesigned('SHOP-7', ['s1']), /None of these scenarios/);
  assert.match(formatRequirement(requirement), /case #\d+ \(error, equivalence_partitioning, high\) Mot de passe erroné: planned, scenario has 1 step\(s\) no phrase covers \("And I type "wrong" as the password"\): record it/);
  assert.match(formatRequirement(requirement), /Troisième échec: planned, scenario ready: create_test_from_gherkin/);
});

test('a planned case edited: its scenario, its technique; checked', () => {
  const [wrong] = getRequirement('SHOP-7').cases;
  const fixed = updateCase(wrong.id, { gherkin: wrong.gherkin.replace('And I type "wrong" as the password', 'And I fill "#password" with "wrong"') });
  assert.equal(withResolution(fixed).cases[0].resolution.ready, true);
  assert.equal(fixed.cases[0].title, 'Mot de passe erroné', 'what is not given stays');
  assert.throws(() => updateCase(wrong.id, { technique: 'guessing' }), /No such technique: guessing/);
  assert.throws(() => updateCase(wrong.id, { priority: 'urgent' }), /No such priority/);
  assert.throws(() => planCases('SHOP-7', [{ title: 'x', technique: 'nope' }]), /No such technique/);
});

test('what the agent recording a case is told: the criteria, its own, and where expected results come from', () => {
  const requirement = getRequirement('SHOP-7');
  const third = requirement.cases[1];
  const brief = recordingBrief(requirement, third.id, { viaMcp: true });
  assert.match(brief, new RegExp(`checks requirement SHOP-7 — Un mauvais mot de passe est refusé: case #${third.id} \\(boundary\\), "Troisième échec"`));
  assert.match(brief, /4\. Après 3 échecs le compte est bloqué\nThis case checks criterion 4\.\nIts scenario — follow it[^\n]*\nFeature: [^\n]*\n\n {2}Scenario: Troisième échec\n {4}Given I am logged in as "a@b\.c"/);
  assert.match(brief, /non_conformity: true/);
  assert.match(brief, new RegExp(`Pass requirement: "SHOP-7", case_id: ${third.id} to start_recording\\.$`));
  assert.doesNotMatch(recordingBrief(requirement), /case #|start_recording/, 'the internal agent links by itself');
});

test('what the agent recording a test is told of the app: its project, where to start, its context, and to stop when it cannot', () => {
  const brief = projectBrief({ name: 'Shop', base_url: 'https://shop.test', context: 'Login at /login.\n' });
  assert.match(brief, /^The app under test is the project "Shop"\.\nIts tests are written in English: write the intent of each step in English\.\nIt is at https:\/\/shop\.test: start there, unless the description gives another URL\.\nWhat to know about it:\nLogin at \/login\.\n/);
  assert.match(projectBrief({ name: 'Boutique', language: 'fr' }), /Its tests are written in French: write the intent of each step in French\./);
  assert.match(brief, /Nobody answers questions during this run\./);
  assert.match(brief, /close_window/);
  // Without a project, or one with no base URL nor context: only what to do when it cannot record.
  assert.match(projectBrief(null), /^Nobody answers questions/);
  assert.doesNotMatch(projectBrief({ name: 'Bare', base_url: null, context: '' }), /It is at|What to know/);
});

test('a failing assertion is a non-conformity only when claimed, on a test checking a requirement, the element found', () => {
  db.prepare("INSERT INTO tests (name) VALUES ('login_wrong')").run();
  db.prepare("INSERT INTO tests (name) VALUES ('unlinked')").run();
  linkTest('SHOP-7', 'login_wrong', { criterion: 2 });
  const shows = { passed: false, actual: 'Bienvenue' };
  assert.equal(nonConformityOf('login_wrong', shows, true).nonConformity, true);
  assert.equal(nonConformityOf('login_wrong', shows, undefined).nonConformity, false);
  assert.equal(nonConformityOf('login_wrong', { passed: false, actual: 'Element not found' }, true).nonConformity, false);
  assert.equal(nonConformityOf('login_wrong', { passed: false, actual: 'Error: Cannot read properties of null' }, true).nonConformity, false, 'not evaluated');
  assert.equal(nonConformityOf('unlinked', shows, true).nonConformity, false);
});

test('one answer from a CLI: no tools, no MCP server, nothing kept', () => {
  const claude = cliInvocation({ provider: 'claude', command: 'claude --verbose' }, 'SYSTEM', 'PROMPT');
  assert.equal(claude.command, 'claude');
  assert.deepEqual(claude.args, ['-p', 'PROMPT', '--system-prompt', 'SYSTEM', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json']);
  assert.deepEqual(cliInvocation({ provider: 'gemini' }, 'S', 'P').args, ['-p', 'S\n\n---\n\nP']);
  assert.deepEqual(cliInvocation({ provider: 'opencode', command: 'opencode' }, 'S', 'P').args, ['run', 'S\n\n---\n\nP']);
});
