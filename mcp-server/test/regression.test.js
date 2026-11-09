// Unit tests for the tests a change needs: what a run touched (lib/footprint.js), how a changed
// file is weighed and the tests chosen for it, each with why (lib/regression.js), and a campaign
// of those tests, its commit kept, compared test by test with each one's last campaign
// (lib/campaigns.js). The extension is a stand-in. On a database of their own, thrown away after.
// Run with: node --test test/regression.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'regression-')), 'test.db');
process.env.IZITEST_HOME = await mkdtemp(join(tmpdir(), 'regression-home-'));
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTest } = await import('../lib/test-store.js');
const { saveRequirement, linkTest } = await import('../lib/requirements.js');
const { footprintOfRun, footprintOfSteps, footprintOfTest, pathOf } = await import('../lib/footprint.js');
const { classifyFile, selectTests, formatSelection, wordsOf } = await import('../lib/regression.js');
const { startCampaign, getCampaign, formatCampaign } = await import('../lib/campaigns.js');

const APP = 'http://127.0.0.1:5173';
const project = db.prepare("INSERT INTO projects (name, base_url) VALUES ('Notes', ?) RETURNING id").get(APP).id;

function addTest(name, steps = [{ command: 'navigate', params: { url: `${APP}/` }, intent: 'Open the app' }]) {
  saveTest({ name, variables: {}, steps });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
}

/** A run of `name` that ended `status`, keeping `footprint` when it passed. */
function ran(name, status, footprint = null) {
  const testId = db.prepare('SELECT id FROM tests WHERE name = ?').get(name).id;
  db.prepare(`INSERT INTO test_executions (test_id, test_name, status, footprint) VALUES (?, ?, ?, ?)`)
    .run(testId, name, status, footprint ? JSON.stringify(footprint) : null);
}

test('a run\'s footprint: its pages, and what its pages asked the app for — not the rest', () => {
  assert.equal(pathOf(`${APP}/notes/42?x=1#top`), '/notes/*');
  assert.equal(pathOf('about:blank'), null);
  const at = 1000;
  const fp = footprintOfRun({
    since: at,
    pageUrls: [`${APP}/`, `${APP}/notes/42`],
    requests: [
      { url: 'http://127.0.0.1:3001/api/notes', method: 'GET', resourceType: 'fetch', timestamp: 1500 },
      { url: 'http://127.0.0.1:3001/api/notes/7', method: 'put', resourceType: 'xhr', timestamp: 1600 },
      { url: `${APP}/api/auth/login`, method: 'POST', resourceType: 'fetch', timestamp: 900 },
      { url: `${APP}/src/NoteForm.tsx`, method: 'GET', resourceType: 'script', timestamp: 1200 },
      { url: `${APP}/@vite/client`, method: 'GET', resourceType: 'fetch', timestamp: 1200 },
      { url: 'https://analytics.example/collect', method: 'POST', resourceType: 'xhr', timestamp: 1300 },
      { url: `${APP}/settings`, method: 'GET', resourceType: 'document', timestamp: 1700 },
    ],
    serverCalls: ['DELETE http://127.0.0.1:3001/api/notes/9'],
  });
  assert.deepEqual(fp, {
    pages: ['/', '/notes/*', '/settings'],
    api: ['DELETE /api/notes/*', 'GET /api/notes', 'PUT /api/notes/*'],
  }, 'the API on another port of the same host counts; one before the run, a script, the dev server and another site do not');

  const ofSteps = footprintOfSteps([
    { command: 'navigate', params: { url: '{{base_url}}/notes/{{note_id}}' } },
    { command: 'click', params: {}, page: '127.0.0.1:5173/review' },
    { command: 'http', params: { method: 'post', url: '{{api}}/x' } },
    { command: 'http', params: { method: 'post', url: `${APP}/api/notes/{{id}}/submit` } },
  ], { baseUrl: `${APP}/` });
  assert.deepEqual(ofSteps, { pages: ['/notes/*', '/review'], api: ['POST /api/notes/*/submit', 'POST /x'] }, 'a call\'s path, whatever its host');
});

test('how a changed file is weighed: ignored, shared, used everywhere, or by the words of its name', () => {
  const kinds = Object.fromEntries([
    'README.md', 'docs/setup.txt', 'api/test/notes.test.js', 'web/src/NoteForm.spec.tsx', '.github/workflows/ci.yml', 'test/fixtures/seed.sql',
    'package.json', 'web/package-lock.json', 'requirements.txt', 'web/vite.config.ts', '.env.example', 'api/src/middleware/auth.js',
    'api/migrations/003_status.sql', 'web/src/styles.css', 'web/index.html', 'web/src/locales/fr.json',
    'web/src/App.tsx', 'api/src/server.js', 'web/src/api.ts', 'web/src/components/Header.tsx',
    'api/src/routes/notes.js', 'web/src/ManagerPage.tsx', 'web/src/hooks/useExpenseCategories.ts',
  ].map((path) => [path, classifyFile(path).kind]));
  assert.deepEqual(kinds, {
    'README.md': 'ignored', 'docs/setup.txt': 'ignored', 'api/test/notes.test.js': 'ignored', 'web/src/NoteForm.spec.tsx': 'ignored',
    '.github/workflows/ci.yml': 'ignored', 'test/fixtures/seed.sql': 'ignored',
    'package.json': 'shared', 'web/package-lock.json': 'shared', 'requirements.txt': 'shared', 'web/vite.config.ts': 'shared',
    '.env.example': 'shared', 'api/src/middleware/auth.js': 'shared', 'api/migrations/003_status.sql': 'shared',
    'web/src/styles.css': 'shared', 'web/index.html': 'shared', 'web/src/locales/fr.json': 'shared',
    'web/src/App.tsx': 'general', 'api/src/server.js': 'general', 'web/src/api.ts': 'general', 'web/src/components/Header.tsx': 'general',
    'api/src/routes/notes.js': 'code', 'web/src/ManagerPage.tsx': 'code', 'web/src/hooks/useExpenseCategories.ts': 'code',
  });
  assert.deepEqual(classifyFile('web\\src\\hooks\\useExpenseCategories.ts').words, ['expense', 'category'], 'a Windows path, a hook, a plural');
  assert.deepEqual(wordsOf('/api/review/notes/*/approve'), ['api', 'review', 'note', 'approve']);
});

// The app: employees' notes, a manager's review, a login every test goes through.
addTest('notes_create');
addTest('notes_edit');
addTest('manager_approve');
addTest('login_wrong_password');
addTest('new_one');
addTest('order_create', [{ command: 'navigate', params: { url: `${APP}/` } }, { command: 'capture', params: { name: 'order_id', from: 'text', selector: '#id' } }]);
addTest('order_pay', [{ command: 'navigate', params: { url: `${APP}/orders/{{order_id}}` } }]);
const login = 'POST /api/auth/login';
ran('notes_create', 'success', { pages: ['/'], api: [login, 'GET /api/notes', 'POST /api/notes'] });
ran('notes_edit', 'success', { pages: ['/'], api: [login, 'GET /api/notes', 'PUT /api/notes/*'] });
ran('manager_approve', 'success', { pages: ['/'], api: [login, 'GET /api/review/notes', 'POST /api/review/notes/*/approve'] });
ran('login_wrong_password', 'success', { pages: ['/'], api: [login] });
ran('order_create', 'success', { pages: ['/'], api: ['POST /api/orders'] });
ran('order_pay', 'success', { pages: ['/orders/*'], api: ['POST /api/payments'] });
// new_one never passed: what its pages call is not known.

test('the tests a file of the code ties to: by the routes they went to or called, else by their name', () => {
  assert.equal(footprintOfTest('new_one').run, null);
  assert.ok(footprintOfTest('notes_edit').run);
  const s = selectTests({ projectId: project, changedFiles: ['api/src/routes/notes.js', 'README.md'] });
  assert.equal(s.full, false);
  assert.deepEqual(s.tests.map((t) => t.name), ['manager_approve', 'new_one', 'notes_create', 'notes_edit']);
  assert.deepEqual(s.tests.find((t) => t.name === 'notes_create').reasons, ['api/src/routes/notes.js → it calls GET /api/notes']);
  assert.deepEqual(s.tests.find((t) => t.name === 'new_one').reasons, ['no run of it kept what its pages call: what it touches is not known']);
  assert.deepEqual(s.left_out.map((t) => t.name), ['login_wrong_password', 'order_create', 'order_pay']);
  assert.match(s.left_out[0].why, /touches nothing the change does \(\/, POST \/api\/auth\/login\)/);
  assert.deepEqual(s.files.map((f) => [f.path, f.kind]), [['api/src/routes/notes.js', 'code'], ['README.md', 'ignored']]);

  const page = selectTests({ projectId: project, changedFiles: ['web/src/ManagerPage.tsx'] });
  assert.deepEqual(page.tests.map((t) => [t.name, t.reasons[0]]), [
    ['manager_approve', 'web/src/ManagerPage.tsx → its name says "manager"'],
    ['new_one', 'no run of it kept what its pages call: what it touches is not known'],
  ], 'one page for all: the test\'s name ties it');
});

test('every test, when a file can break any of them — or says no part of the app and nothing tells what it changes', () => {
  const shared = selectTests({ projectId: project, changedFiles: ['package.json', 'api/src/routes/notes.js'] });
  assert.equal(shared.full, true);
  assert.equal(shared.tests.length, 7);
  assert.deepEqual(shared.why_full, ['package.json: the dependencies']);
  assert.deepEqual(shared.left_out, []);

  const general = selectTests({ projectId: project, changedFiles: ['api/src/server.js'] });
  assert.equal(general.full, true);
  assert.match(general.why_full[0], /^api\/src\/server\.js: its name says no part of the app — say what it changes \(touched\), or every test runs$/);

  const untied = selectTests({ projectId: project, changedFiles: ['web/src/StatusBadge.tsx'] });
  assert.equal(untied.full, true);
  assert.match(untied.why_full[0], /no test's routes nor name say "status" or "badge"/);
});

test('told what the change touches: the tests that go there, and a route no test reaches', () => {
  const s = selectTests({ projectId: project, changedFiles: ['api/src/server.js'], touched: ['POST /api/review/notes/:id/approve', 'GET /api/exports'] });
  assert.equal(s.full, false);
  assert.deepEqual(s.tests.map((t) => t.name), ['manager_approve', 'new_one']);
  assert.deepEqual(s.tests[0].reasons, ['the change touches POST /api/review/notes/:id/approve → it calls POST /api/review/notes/*/approve']);
  assert.deepEqual(s.uncovered, ['GET /api/exports']);
  assert.match(s.files[0].why, /taken as told by touched/);
  // A route without a method: its pages and every call under it.
  const under = selectTests({ projectId: project, touched: ['/api/notes'] });
  assert.deepEqual(under.tests.map((t) => t.name), ['new_one', 'notes_create', 'notes_edit']);
  // A shared file still runs everything.
  assert.equal(selectTests({ projectId: project, changedFiles: ['web/src/styles.css'], touched: ['/api/notes'] }).full, true);
});

test('also chosen: a requirement the commit names, a test that failed last time, one asked, one that keeps a value a chosen one uses', () => {
  const { requirement } = saveRequirement({ key: 'NOTE-7', title: 'Logging in', projectId: project, criteria: ['A wrong password is refused'] });
  linkTest(requirement.key, 'login_wrong_password', { criterion: 1 });
  ran('order_create', 'failed');
  const s = selectTests({ projectId: project, changedFiles: ['web/src/PaymentForm.tsx'], touched: ['/orders/*'], commitMessage: 'fix(NOTE-7): say why', include: ['notes_edit'] });
  const why = Object.fromEntries(s.tests.map((t) => [t.name, t.reasons]));
  assert.deepEqual(why.login_wrong_password, ['the commit names NOTE-7, which it checks']);
  assert.deepEqual(why.notes_edit, ['asked']);
  assert.deepEqual(why.order_pay, ['web/src/PaymentForm.tsx → it calls POST /api/payments', 'the change touches /orders/* → it goes to /orders/*']);
  assert.deepEqual(why.order_create, ['it failed last time: does the change fix it?', 'it keeps {{order_id}} for order_pay']);
  assert.deepEqual(s.requirements, ['NOTE-7']);
  assert.match(formatSelection(s), /^5 of 7 test\(s\) to run\.\n {2}web\/src\/PaymentForm\.tsx: → order_pay\nThe commit names NOTE-7\.\nChosen:\n/);
  assert.equal(selectTests({ projectId: project, changedFiles: ['x/y.js'], commitMessage: 'NOTE-70' }).requirements.length, 0, 'NOTE-70 is not NOTE-7');
  ran('order_create', 'success', { pages: ['/'], api: ['POST /api/orders'] });
});

test('what a selection refuses', () => {
  assert.throws(() => selectTests({ projectId: project }), /changed_files: the files the change touches/);
  assert.throws(() => selectTests({ projectId: project, touched: ['notes'] }), /"notes" is no route nor page/);
  assert.throws(() => selectTests({ projectId: project, changedFiles: ['a.js'], include: ['nope'] }), /include: no test "nope"/);
  assert.throws(() => selectTests({ changedFiles: ['a.js'] }), /project_id/);
});

/** The extension, stood in for: a replay succeeds, on a page whose script asked the app for its notes. */
function extension() {
  const calls = [];
  let nextTab = 100;
  const sendCommand = async (_profile, command, params) => {
    calls.push({ command, params });
    if (command === 'replay_sequence') {
      const tabId = nextTab++;
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId, pageUrl: `${APP}/` })), durationMs: 5 };
    }
    if (command === 'network_requests') {
      return { requests: [{ url: `${APP}/api/notes`, method: 'GET', resourceType: 'fetch', timestamp: Date.now() }, { url: `${APP}/main.js`, method: 'GET', resourceType: 'script', timestamp: Date.now() }] };
    }
    return {};
  };
  return { sendCommand, calls };
}

test('a campaign of what a commit changes: its tests only, its commit kept, its short sha the version; each test compared with its own last campaign', async () => {
  const commit = { sha: 'a1b2c3d4e5f6a7b8c9d0', branch: 'feature/review', message: 'Approve with a comment' };
  const { campaign, finished } = startCampaign({ projectId: project, changes: { changed_files: ['web/src/ManagerPage.tsx'] }, commit }, extension());
  await finished;
  const done = getCampaign(campaign.id);
  assert.deepEqual(done.runs.map((t) => [t.name, t.status]), [['manager_approve', 'passed'], ['new_one', 'passed']]);
  assert.equal(done.name, 'Notes — 2 of 7 tests');
  assert.equal(done.version, 'a1b2c3d');
  assert.deepEqual(done.commit, { sha: commit.sha, branch: 'feature/review', message: 'Approve with a comment' });
  assert.equal(done.selection.left_out.length, 5);
  assert.equal(done.changes, null, 'none of them ran in a campaign before');
  const text = formatCampaign(done);
  assert.match(text, /\nCommit a1b2c3d4e5 on feature\/review: Approve with a comment\nChosen for the change: 2 of 7 test\(s\); left out, touching nothing it does: login_wrong_password, notes_create, notes_edit, order_create, order_pay$/);

  // A run that passed keeps what it touched: new_one is known now.
  const fp = footprintOfTest('new_one');
  assert.ok(fp.run);
  assert.deepEqual(fp.api, ['GET /api/notes'], 'its page\'s call, not its script');

  // Another list: manager_approve is compared with the campaign above, notes_create with none.
  db.prepare(`UPDATE test_steps SET params = json_set(params, '$.url', 'nope') WHERE test_id = (SELECT id FROM tests WHERE name = 'manager_approve')`).run();
  const second = startCampaign({ tests: ['manager_approve', 'notes_create'] }, (() => {
    const ext = extension();
    const send = ext.sendCommand;
    // A replay that fails throws, its steps' results with it, as the extension does.
    return { sendCommand: async (p, command, params, ...rest) => {
      if (command !== 'replay_sequence' || params.steps[0]?.params?.url !== 'nope') return send(p, command, params, ...rest);
      throw Object.assign(new Error('Cannot navigate'), { results: [{ step: 1, command: 'navigate', status: 'failed', error: 'Cannot navigate', tabId: 300 }] });
    } };
  })());
  await second.finished;
  const after = getCampaign(second.campaign.id);
  assert.deepEqual(after.changes.regressed, ['manager_approve']);
  assert.equal(after.changes.since.id, done.id);
  assert.match(formatCampaign(after), new RegExp(`Since campaign #${done.id} \\(version a1b2c3d\\): REGRESSED manager_approve`));
});

test('a change that touches no test: nothing to run, told why', () => {
  // Failed last time, it is run whatever the change: once it passes, it is not.
  assert.deepEqual(selectTests({ projectId: project, changedFiles: ['README.md'] }).tests.map((t) => [t.name, t.reasons]), [['manager_approve', ['it failed last time: does the change fix it?']]]);
  ran('manager_approve', 'success', { pages: ['/'], api: [login, 'GET /api/review/notes'] });
  assert.throws(
    () => startCampaign({ projectId: project, changes: { changed_files: ['README.md'] } }, extension()),
    (err) => err.code === 'NOTHING_TO_RUN' && /^Nothing to run: the change touches no test\.\n0 of 7 test\(s\) to run\.\n {2}README\.md: ignored — documentation/.test(err.message),
  );
  assert.throws(() => startCampaign({ changes: { changed_files: ['a.js'] } }, extension()), /project_id/);
  assert.throws(() => startCampaign({ projectId: project, commit: { sha: 'not a sha' } }, extension()), /no commit hash/);
});
