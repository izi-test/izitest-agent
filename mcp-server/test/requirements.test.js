// Unit tests for requirements: one saved from a request, its criteria, the cases planned for
// them, the tests linked, the coverage read from their last run — and what it changes in the
// triage of a failure and in exported code. On a database of their own, thrown away after.
// Run with: node --test test/requirements.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'requirements-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const {
  saveRequirement, getRequirement, listRequirements, planCases, linkTest, deleteCase, requirementsOfTest, coverageOf, linkRecorded, formatRequirement,
} = await import('../lib/requirements.js');
const { againstRequirements } = await import('../lib/triage.js');
const { generatePlaywrightPlain } = await import('../lib/codegen/playwright-plain.js');
const { generatePlaywrightCucumber } = await import('../lib/codegen/playwright-cucumber.js');
const { DEFAULT_STEP_DEFINITIONS } = await import('../lib/gherkin/default-step-definitions.js');

const addTest = (name) => db.prepare('INSERT INTO tests (name) VALUES (?) RETURNING id').get(name).id;
const run = (testId, status, trigger = 'manual') =>
  db.prepare('INSERT INTO test_executions (test_id, test_name, status, trigger) VALUES (?, ?, ?, ?)').run(testId, 'x', status, trigger);

const LOGIN = {
  title: 'Test that a wrong password is refused', source: 'prompt',
  criteria: ['A wrong password shows "Invalid credentials"', 'The user stays on the login page', 'After 3 failures the account is locked for 5 minutes'],
};

test('a request saved as a requirement: REQ-<id>, its criteria in order', () => {
  const { requirement, isNew } = saveRequirement(LOGIN);
  assert.equal(isNew, true);
  assert.match(requirement.key, /^REQ-\d+$/);
  assert.deepEqual(requirement.criteria.map((c) => [c.position, c.text]), LOGIN.criteria.map((t, i) => [i + 1, t]));
  assert.equal(requirement.coverage.status, 'not_covered');
  assert.throws(() => saveRequirement({ title: ' ' }), /needs a title/);
  assert.throws(() => saveRequirement({ title: 'x', source: 'email' }), /No such source/);
});

test('cases planned, then tests linked: coverage from each test\'s last run', () => {
  const { requirement } = saveRequirement({ ...LOGIN, key: 'SHOP-1', source: 'jira', url: 'https://jira.example/browse/SHOP-1' });
  let req = planCases('SHOP-1', [
    { title: 'Wrong password: error shown', criterion: 1 },
    { title: 'Wrong password: still on login', criterion: 2 },
    { title: 'Third failure locks the account', criterion: 3, kind: 'boundary' },
  ]);
  assert.equal(req.coverage.planned, 3);
  assert.throws(() => planCases('SHOP-1', [{ title: 'x', criterion: 9 }]), /has no criterion 9/);
  assert.throws(() => planCases('SHOP-1', [{ title: 'x', kind: 'happy' }]), /No such case kind/);

  const wrong = addTest('login_wrong_password');
  const lock = addTest('login_lockout');
  req = linkTest('SHOP-1', 'login_wrong_password', { caseId: req.cases[0].id });
  req = linkTest('SHOP-1', 'login_wrong_password', { caseId: req.cases[1].id });
  assert.deepEqual([req.coverage.covered, req.coverage.criteria, req.coverage.tests], [2, 3, 1]);
  assert.equal(req.coverage.status, 'not_covered', 'criterion 3 has no test');

  req = linkTest('SHOP-1', 'login_lockout', { caseId: req.cases[2].id });
  assert.equal(req.coverage.status, 'not_run');
  run(wrong, 'success');
  run(lock, 'success');
  assert.equal(getRequirement('SHOP-1').coverage.status, 'passing');
  run(lock, 'failed');
  run(lock, 'success', 'repair');
  assert.equal(getRequirement(requirement.id).coverage.status, 'failing', 'a repair being checked is not the test\'s last run');
  assert.match(formatRequirement(getRequirement('SHOP-1')), /Coverage: FAILING — 3\/3 criteria covered, 2 test\(s\)[\s\S]*3\. After 3 failures[\s\S]*case #\d+ \(boundary\) Third failure locks the account: test "login_lockout" — failed/);
});

test('saved again under its key: updated, the criteria whose text did not change keep their tests', () => {
  const { changed, requirement } = saveRequirement({ ...LOGIN, key: 'SHOP-1', source: 'jira', criteria: [LOGIN.criteria[0], 'The user stays on the login page, the email kept', LOGIN.criteria[2]] });
  assert.equal(changed, true);
  const kept = requirement.cases.filter((c) => c.criterion_id != null).map((c) => c.title);
  assert.deepEqual(kept, ['Wrong password: error shown', 'Third failure locks the account'], 'criterion 2 reworded: its case is no longer counted for it');
  assert.equal(saveRequirement({ ...LOGIN, key: 'SHOP-1', source: 'jira', criteria: requirement.criteria.map((c) => c.text) }).changed, false);
});

test('a test linked to the whole requirement, once; unlinked; what a test checks', () => {
  addTest('signup_smoke');
  const { requirement } = saveRequirement({ title: 'Sign up works' });
  linkTest(requirement.key, 'signup_smoke');
  const twice = linkTest(requirement.key, 'signup_smoke');
  assert.equal(twice.cases.length, 1);
  assert.equal(twice.coverage.status, 'not_run', 'no criteria: covered once a test is linked');
  assert.deepEqual(requirementsOfTest('login_lockout').map((r) => [r.key, r.criteria.map((c) => c.number)]), [['SHOP-1', [3]]]);
  assert.equal(deleteCase(twice.cases[0].id).cases.length, 0);
  assert.throws(() => linkTest(requirement.key, 'no_such_test'), /No test "no_such_test"/);
  assert.ok(listRequirements().length >= 3);
});

test('a test linked to a project\'s requirement joins that project, if in none yet', () => {
  const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
  const other = db.prepare("INSERT INTO projects (name) VALUES ('Other') RETURNING id").get().id;
  const { requirement } = saveRequirement({ title: 'Cart keeps its items', projectId: project });
  addTest('cart_keeps_items');
  const owned = addTest('owned_elsewhere');
  db.prepare('UPDATE tests SET project_id = ? WHERE id = ?').run(other, owned);
  linkTest(requirement.key, 'cart_keeps_items');
  linkTest(requirement.key, 'owned_elsewhere');
  const projectOf = (name) => db.prepare('SELECT project_id FROM tests WHERE name = ?').get(name).project_id;
  assert.equal(projectOf('cart_keeps_items'), project);
  assert.equal(projectOf('owned_elsewhere'), other, 'one in a project already stays there');
});

test('a recording started for a requirement is linked when saved', () => {
  addTest('login_wrong_email');
  const said = linkRecorded({ name: 'login_wrong_email', link: { requirement: 'SHOP-1', criterion: 1 } });
  assert.match(said, /Linked to SHOP-1, criterion 1\./);
  assert.match(linkRecorded({ name: 'login_wrong_email', link: { requirement: 'NOPE-1' } }), /Not linked to NOPE-1: No requirement NOPE-1/);
  assert.equal(linkRecorded({ name: 'x' }), '');
});

test('coverage, on its own', () => {
  const criteria = [{ id: 1 }, { id: 2 }];
  assert.equal(coverageOf(criteria, []).status, 'not_covered');
  assert.equal(coverageOf(criteria, [{ criterion_id: 1, test: 'a', last_run: { status: 'success' } }, { criterion_id: 2, test: null }]).status, 'not_covered');
  assert.equal(coverageOf(criteria, [{ criterion_id: 1, test: 'a', last_run: { status: 'success' } }, { criterion_id: 2, test: 'b', last_run: null }]).status, 'not_run');
  assert.equal(coverageOf([], [{ criterion_id: null, test: 'a', last_run: { status: 'failed' } }]).status, 'failing');
});

const REQUIREMENTS = [{ key: 'SHOP-1', title: 'Wrong password refused', criteria: [{ number: 1, text: 'A wrong password shows "Invalid credentials"' }] }];

test('a test checking a requirement fails on what the page shows: a non-conformity, no value to accept', () => {
  const changed = {
    cause: 'changed_value', confidence: 'low', summary: 'Expected "Invalid credentials", the page shows "Welcome"', evidence: {},
    proposals: [{ kind: 'expect', summary: 'Expect "Welcome"' }],
  };
  const judged = againstRequirements(changed, REQUIREMENTS);
  assert.equal(judged.cause, 'non_conformity');
  assert.deepEqual(judged.proposals, []);
  assert.match(judged.summary, /the test checks SHOP-1 \(Wrong password refused, criterion 1: A wrong password shows "Invalid credentials"\)/);
  const drift = { cause: 'test_drift', proposals: [{ kind: 'relocate' }] };
  assert.equal(againstRequirements(drift, REQUIREMENTS), drift, 'a broken selector is still the test\'s');
  assert.equal(againstRequirements(changed, []), changed);
});

test('exported code carries the requirements as tags', () => {
  const linked = { name: 'login_wrong_password', project_id: 1, requirements: REQUIREMENTS, steps: [{ command: 'navigate', params: { url: 'https://x' } }] };
  const plain = generatePlaywrightPlain(linked);
  assert.match(plain, /test\('login_wrong_password', \{ tag: \['@SHOP-1'\] \}, async \(\{ page \}\) => \{\n {2}\/\/ Checks SHOP-1 — Wrong password refused: criterion 1/);
  assert.match(generatePlaywrightPlain({ ...linked, requirements: [] }), /test\('login_wrong_password', async/);
  const defaults = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const feature = generatePlaywrightCucumber(linked, defaults).files.find((f) => f.path.endsWith('.feature')).content;
  assert.match(feature, /^@SHOP-1\nFeature: login_wrong_password/);
});
