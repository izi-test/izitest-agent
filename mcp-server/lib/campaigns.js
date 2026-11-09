// Campaigns: tests replayed together — a project's, a requirement's, or a list of them — for
// a version of the app. Each test runs in a window of its own, a few at a time, in a session
// of the campaign's own; a failure is diagnosed as any run's is (lib/triage.js). The report
// says, for that version: what passed, what failed and why, what regressed or was fixed since
// the last campaign of the same tests, and where each requirement they check stands —
// criterion by criterion, from this campaign's runs. It is also written as JUnit XML, for a
// CI, and as an HTML page to share.

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { ensureHeadless, inHeadless, laneProfile, stopHeadless } from './headless.js';
import { createAdHocSession, destroySession, runInSession, listSessions } from './session.js';
import { datasetOfTest } from './datasets.js';
import { loadTest } from './test-store.js';
import { keptNames } from './server-steps.js';
import { getRequirement, coverageOf, requirementsOfTest } from './requirements.js';

// The campaigns running now, and whether each was asked to stop.
const running = new Map();
// The headless campaigns running now: the Chromes of lanes 2… stop when none is.
let headlessCampaigns = 0;

export const MAX_CONCURRENCY = 6;

/** The tests a scope stands for: a list, the tests linked to a requirement, or a project's. */
export function testsOfScope({ tests, requirement, projectId }) {
  if (tests?.length) {
    const missing = tests.filter((name) => !db.prepare('SELECT 1 FROM tests WHERE name = ?').get(name));
    if (missing.length) throw new Error(`No test ${missing.map((name) => `"${name}"`).join(', ')}`);
    return [...new Set(tests)];
  }
  if (requirement) {
    const found = getRequirement(requirement);
    if (!found) throw new Error(`No requirement ${requirement}`);
    return [...new Set(found.cases.filter((c) => c.test).map((c) => c.test))];
  }
  if (projectId) return db.prepare('SELECT name FROM tests WHERE project_id = ? ORDER BY name').all(projectId).map((r) => r.name);
  throw new Error('A campaign needs its tests: a project, a requirement, or a list of tests');
}

/** The project the tests all belong to, or null if they belong to several or to none. */
function projectOfTests(names) {
  const projects = new Set(names.map((name) => db.prepare('SELECT project_id FROM tests WHERE name = ?').get(name)?.project_id ?? null));
  return projects.size === 1 ? [...projects][0] : null;
}

/** What makes two campaigns comparable: the same project, the same requirement, or the same tests. */
function scopeKeyOf(scope, names) {
  if (scope.requirement) return `requirement:${scope.requirement}`;
  if (scope.project_id) return `project:${scope.project_id}`;
  return `tests:${[...names].sort().join(',')}`;
}

function defaultName(scope, projectId, names) {
  if (scope.requirement) {
    const requirement = getRequirement(scope.requirement);
    return `${requirement.key} — ${requirement.title}`;
  }
  const project = projectId ? db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) : null;
  return scope.project_id && project ? project.name : `${names.length} test${names.length === 1 ? '' : 's'}`;
}

/**
 * The stages of a campaign, checked: each its tests (by name, each in one stage only), run
 * side by side (`parallel`) or one after the other in their order (`sequential`); one with
 * `needs_previous` runs only when every test of the stages before it passed.
 */
export function checkStages(stages) {
  if (!Array.isArray(stages) || !stages.length) throw new Error('stages: a list of stages, each with its tests');
  const seen = new Set();
  return stages.map((stage, i) => {
    const tests = Array.isArray(stage?.tests) ? stage.tests.map(String) : [];
    if (!tests.length) throw new Error(`Stage ${i + 1} has no test`);
    const mode = stage.mode ?? 'parallel';
    if (!['parallel', 'sequential'].includes(mode)) throw new Error(`Stage ${i + 1}: mode is "parallel" or "sequential", not "${mode}"`);
    for (const name of tests) {
      if (seen.has(name)) throw new Error(`"${name}" is in two stages: a test runs once in a campaign`);
      seen.add(name);
      if (!db.prepare('SELECT 1 FROM tests WHERE name = ?').get(name)) throw new Error(`No test "${name}"`);
    }
    return {
      ...(stage.name?.trim() ? { name: stage.name.trim() } : {}),
      mode, tests, needs_previous: i > 0 && stage.needs_previous === true,
    };
  });
}

/**
 * Start a campaign: its tests replayed `concurrency` at a time, each in a new window closed
 * after — with `headless`, of a headless Chrome per lane (lib/headless.js), started if it is
 * not: each lane has its cookies, and its tests run side by side whatever they log in to. In
 * the user's Chrome, whose windows share its cookies, the tests of a site one of them logs in
 * to run one at a time (sharedSessions).
 * With `stages` (checkStages), the tests run stage after stage; the values a test kept
 * (capture) are given to the tests after it (runCampaign).
 * `sendCommand` is the extension's, unscoped: the campaign runs in a session of its own. The
 * campaign as it starts, and `finished`, settled once its last test ran.
 */
export function startCampaign({ name, tests, requirement, projectId = null, version = null, concurrency = 3, headless = false, stages = null }, { sendCommand }) {
  const staged = stages?.length ? checkStages(stages) : null;
  if (staged) tests = staged.flatMap((stage) => stage.tests);
  const scope = tests?.length ? { tests: [...new Set(tests)], ...(staged ? { stages: staged } : {}) }
    : requirement ? { requirement: getRequirement(requirement)?.key ?? String(requirement) }
      : { project_id: projectId };
  const names = testsOfScope({ tests, requirement, projectId });
  if (!names.length) throw new Error('No test to run: none in that scope');
  // Without stages, the tests are one stage, side by side.
  const plan = staged ?? [{ mode: 'parallel', tests: names, needs_previous: false }];
  // A test bound to a dataset (lib/datasets.js) runs once per row.
  const entries = plan.flatMap((stage, s) => stage.tests.flatMap((name) => {
    const dataset = datasetOfTest(name);
    const rows = dataset ? dataset.rows.map((_, i) => i + 1) : [null];
    return rows.map((row) => (staged ? { test: name, ...(row ? { row } : {}), stage: s } : row ? { test: name, row } : name));
  }));
  const lanes = Math.min(Math.max(1, Math.floor(Number(concurrency)) || 3), MAX_CONCURRENCY);
  // Chosen tests all of one project belong to it: the campaign is listed with the project's.
  const project = projectId ?? (scope.requirement ? getRequirement(scope.requirement).project_id : projectOfTests(names));
  const { id } = db.prepare(
    `INSERT INTO campaigns (name, project_id, scope, scope_key, version, tests, concurrency, headless)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(name?.trim() || defaultName(scope, project, names), project, JSON.stringify(scope), scopeKeyOf(scope, names),
    version?.trim() || null, JSON.stringify(entries), lanes, headless ? 1 : 0);
  const state = { stop: false };
  running.set(id, state);
  log(`Campaign #${id} started: ${entries.length} run(s) of ${names.length} test(s), ${lanes} at a time${staged ? `, in ${staged.length} stage(s)` : ''}${version ? `, version ${version}` : ''}`);
  const finished = runCampaign(id, plan, entries.map(entryOf), lanes, state, sendCommand, headless)
    .catch((err) => log(`Campaign #${id} failed: ${err.message}`))
    .finally(() => running.delete(id));
  return { campaign: getCampaign(id), finished };
}

/**
 * Stages proposed for `names`: a test using a value another one keeps (capture) runs in a stage
 * after it, only if it passed; the others side by side in the first. Without such a value, one
 * stage. A stage of one test is sequential.
 */
export function proposeStages(names) {
  const tests = [...new Set(names)].map((name) => loadTest(name)).filter(Boolean);
  const keeper = new Map();
  for (const test of tests) for (const kept of keptNames(test.steps)) if (!keeper.has(kept)) keeper.set(kept, test.name);
  const needs = new Map(tests.map((test) => {
    const own = new Set([...Object.keys(test.variables ?? {}), ...keptNames(test.steps)]);
    const used = new Set([...JSON.stringify(test.steps).matchAll(/\{\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1]));
    return [test.name, new Set([...used].filter((v) => !own.has(v) && keeper.has(v)).map((v) => keeper.get(v)).filter((n) => n !== test.name))];
  }));
  const stageOf = new Map();
  const depth = (name, path = new Set()) => {
    if (stageOf.has(name)) return stageOf.get(name);
    if (path.has(name)) return 0; // a cycle: not ordered
    path.add(name);
    const d = Math.max(-1, ...[...needs.get(name) ?? []].map((n) => depth(n, path))) + 1;
    path.delete(name);
    stageOf.set(name, d);
    return d;
  };
  for (const test of tests) depth(test.name);
  const count = Math.max(0, ...stageOf.values()) + 1;
  return Array.from({ length: count }, (_, i) => {
    const inIt = tests.map((t) => t.name).filter((name) => stageOf.get(name) === i);
    return { mode: inIt.length > 1 ? 'parallel' : 'sequential', tests: inIt, needs_previous: i > 0 };
  }).filter((stage) => stage.tests.length);
}

// A field a password is typed into, by its selector.
const PASSWORD_FIELD = /pass(word)?|pwd|mot.?de.?passe|passwort|contrase/i;

/** Whether a test logs in: it types a secret ({{secret.NAME}}), or into a password field. */
export function logsIn(steps) {
  return (steps ?? []).some((step) => step.command === 'fill'
    && (String(step.params?.value ?? '').includes('{{secret.') || PASSWORD_FIELD.test(String(step.params?.selector ?? ''))));
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** The site a test plays on: where it first goes, else its project's base URL; null if neither says. */
function siteOf(test) {
  const first = test.steps?.find((step) => step.command === 'navigate' && step.params?.url && !step.params.url.includes('{{'));
  const base = test.project_id ? db.prepare('SELECT base_url FROM projects WHERE id = ?').get(test.project_id)?.base_url : null;
  return (first && originOf(first.params.url)) || (base && originOf(base)) || null;
}

/**
 * The tests that cannot run side by side: those of a site one of them logs in to. The windows
 * of one Chrome share its cookies: a test logging in as a manager logged out the one logged in
 * as an employee next to it, and both failed. Per site, its tests — two or more.
 */
export function sharedSessions(names) {
  const sites = new Map();
  for (const name of new Set(names)) {
    const test = loadTest(name);
    if (!test) continue;
    const site = siteOf(test) ?? 'a site not known';
    const group = sites.get(site) ?? { site, tests: [], logsIn: false };
    group.tests.push(name);
    group.logsIn ||= logsIn(test.steps);
    sites.set(site, group);
  }
  return [...sites.values()].filter((g) => g.logsIn && g.tests.length > 1).map(({ site, tests }) => ({ site, tests }));
}

/** A campaign's entry: a test, or a row of the dataset of one; the stage it runs in. */
function entryOf(entry) {
  return typeof entry === 'string' ? { name: entry, row: null, stage: 0 } : { name: entry.test, row: entry.row ?? null, stage: entry.stage ?? 0 };
}

/** How a run of a campaign is told apart: its test, and its row when it plays one. */
export const labelOf = ({ name, row }) => (row ? `${name} [row ${row}]` : name);

async function runCampaign(id, plan, entries, lanes, state, dispatch, headless) {
  const { executeTest } = await import('./test-execute.js');
  // As many lanes as tests to run at once, at most.
  const widest = Math.max(1, ...plan.map((stage, s) => (stage.mode === 'parallel' ? entries.filter((e) => e.stage === s).length : 1)));
  lanes = Math.max(1, Math.min(lanes, widest));
  if (headless) {
    headlessCampaigns++;
    // No headless Chrome to run in: every test is told why it did not run.
    try {
      await ensureHeadless(lanes);
    } catch (err) {
      for (const entry of entries) noteError(id, labelOf(entry), `Not run: ${err.message}`);
      entries = [];
    }
  }
  const session = createAdHocSession(`campaign-${id}`);
  // The commands of lane `n`: to its own headless Chrome, or to the user's.
  const commandsOf = (n) => {
    const to = headless ? inHeadless(dispatch, laneProfile(n)) : dispatch;
    return (profile, command, params, ...rest) => to(profile, command, session.scope(params), ...rest);
  };
  // The values tests kept (capture), given to the tests after them that do not make their own.
  const kept = {};
  const givenTo = (name, values) => {
    const test = loadTest(name);
    const own = new Set([...Object.keys(test?.variables ?? {}), ...keptNames(test?.steps)]);
    const given = Object.fromEntries(Object.entries(values).filter(([key]) => !own.has(key)));
    return Object.keys(given).length ? given : null;
  };
  const keep = (name, values) => {
    if (!values) return;
    for (const key of keptNames(loadTest(name)?.steps)) if (values[key] !== undefined) kept[key] = values[key];
  };

  /** Plays the entries of one stage, `width` at a time. True when they all passed. */
  const playStage = async (stageEntries, width, snapshot) => {
    // In the user's Chrome, the tests of a site one of them logs in to run one at a time; the
    // others, side by side. Each headless lane has cookies of its own.
    const siteOfTest = new Map(width > 1 && !headless ? sharedSessions(stageEntries.map((e) => e.name)).flatMap((g) => g.tests.map((name) => [name, g.site])) : []);
    const pending = [...stageEntries];
    const busy = new Set();
    let wake = [];
    let allPassed = true;
    const take = async () => {
      for (;;) {
        if (state.stop || !pending.length) return null;
        const i = pending.findIndex((e) => !busy.has(siteOfTest.get(e.name)));
        if (i >= 0) {
          const [entry] = pending.splice(i, 1);
          if (siteOfTest.has(entry.name)) busy.add(siteOfTest.get(entry.name));
          return entry;
        }
        await new Promise((resolve) => wake.push(resolve));
      }
    };
    const done = (entry) => {
      busy.delete(siteOfTest.get(entry.name));
      const waiting = wake;
      wake = [];
      for (const resolve of waiting) resolve();
    };
    const lane = async (n) => {
      const sendCommand = commandsOf(n);
      for (let entry = await take(); entry; entry = await take()) {
        let tabId = null;
        // Side by side, the values kept before the stage; one after the other, those kept so far.
        const variables = givenTo(entry.name, snapshot ?? kept);
        try {
          const result = await executeTest(entry.name, variables, null, null, true, sendCommand, 'campaign', null, null, { campaignId: id, ...(entry.row ? { row: entry.row } : {}) });
          tabId = result.results?.findLast?.((r) => r.tabId != null)?.tabId ?? null;
          keep(entry.name, result.values);
        } catch (err) {
          allPassed = false;
          tabId = err.tabId ?? null;
          keep(entry.name, err.values);
          // A failed run is kept with its execution; one that never started is told here.
          if (!err.executionId) noteError(id, labelOf(entry), err.message);
        }
        if (tabId) await sendCommand(undefined, 'close_window', { tabId, liveSessions: listSessions().map((s) => s.id) }).catch(() => {});
        done(entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, stageEntries.length) }, (_, i) => lane(i + 1)));
    return allPassed && !pending.length;
  };

  try {
    await runInSession(session, {}, async () => {
      let passedSoFar = true;
      for (let s = 0; s < plan.length && !state.stop; s++) {
        const stage = plan[s];
        const stageEntries = entries.filter((e) => e.stage === s);
        if (!stageEntries.length) continue;
        if (stage.needs_previous && !passedSoFar) {
          for (const entry of stageEntries) noteSkip(id, labelOf(entry), `not run: ${stageName(plan, s - 1)} did not pass`);
          passedSoFar = false;
          continue;
        }
        const parallel = stage.mode === 'parallel';
        const passed = await playStage(stageEntries, parallel ? lanes : 1, parallel ? { ...kept } : null);
        passedSoFar &&= passed;
      }
    });
  } finally {
    destroySession(session.id);
    if (headless && --headlessCampaigns === 0) {
      await stopHeadless({ from: 2 }).catch((err) => log(`Campaign #${id}: the headless Chromes of its lanes did not stop: ${err.message}`));
    }
    db.prepare(`UPDATE campaigns SET status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(state.stop ? 'stopped' : 'done', id);
    log(`Campaign #${id} ${state.stop ? 'stopped' : 'done'}`);
  }
}

/** How a stage is called: its name, else its number. */
const stageName = (plan, s) => (plan[s]?.name ? `the stage "${plan[s].name}"` : `stage ${s + 1}`);

function noteSkip(id, label, why) {
  const skips = parseJson(db.prepare('SELECT skips FROM campaigns WHERE id = ?').get(id)?.skips) ?? {};
  skips[label] = why;
  db.prepare('UPDATE campaigns SET skips = ? WHERE id = ?').run(JSON.stringify(skips), id);
}

function noteError(id, name, message) {
  const errors = parseJson(db.prepare('SELECT errors FROM campaigns WHERE id = ?').get(id)?.errors) ?? {};
  errors[name] = message;
  db.prepare('UPDATE campaigns SET errors = ? WHERE id = ?').run(JSON.stringify(errors), id);
}

/** Stop a campaign: the tests running finish, the others are not started. */
export function stopCampaign(id) {
  const state = running.get(Number(id));
  if (!state) throw new Error(`Campaign #${id} is not running`);
  state.stop = true;
  return getCampaign(id);
}

/** Campaigns left running when the server stopped: they will not finish. */
export function closeInterruptedCampaigns() {
  const { changes } = db.prepare(`UPDATE campaigns SET status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'`).run();
  if (changes) log(`${changes} campaign(s) left running by the last server marked interrupted`);
}

/** Where each test of a campaign stands, from its run in the campaign. */
function testsOf(row) {
  const errors = parseJson(row.errors) ?? {};
  const skips = parseJson(row.skips) ?? {};
  const runs = new Map(db.prepare(
    `SELECT id, test_name, data_row, status, failed_step, total_steps, error, duration_ms, triage, assertions_total, assertions_failed
     FROM test_executions WHERE campaign_id = ? ORDER BY id`
  ).all(row.id).map((run) => [labelOf({ name: run.test_name, row: run.data_row }), run]));
  const live = running.has(row.id);
  return parseJson(row.tests).map((entry) => {
    const { name, row: dataRow, stage } = entryOf(entry);
    const label = labelOf({ name, row: dataRow });
    const run = runs.get(label);
    const triage = parseJson(run?.triage);
    const status = run ? ({ success: 'passed', failed: 'failed' }[run.status] ?? 'running')
      : errors[label] ? 'error' : skips[label] ? 'skipped' : live ? 'pending' : 'skipped';
    return {
      name, row: dataRow, label, stage, status, execution_id: run?.id ?? null, duration_ms: run?.duration_ms ?? null,
      // Why it did not run: the campaign stopped, or a stage before it did not pass.
      ...(status === 'skipped' ? { skipped_because: skips[label] ?? 'not run: the campaign was stopped' } : {}),
      failed_step: run?.failed_step ?? null, total_steps: run?.total_steps ?? null,
      error: status === 'failed' || status === 'error' ? (run?.error ?? errors[label]) : null,
      triage: triage ? { cause: triage.cause, confidence: triage.confidence, summary: triage.summary } : null,
    };
  });
}

const STATUSES = ['passed', 'failed', 'error', 'running', 'pending', 'skipped'];

/**
 * The stages of a campaign run in stages, each with where it stands: passed (all its tests),
 * failed (one of them failed or could not run), skipped (none ran), running, pending (not
 * started yet); null without.
 */
function stagesOf(stages, runs) {
  if (!stages?.length) return null;
  return stages.map((stage, s) => {
    const its = runs.filter((t) => t.stage === s);
    const status = its.every((t) => t.status === 'pending') ? 'pending'
      : its.some((t) => t.status === 'running' || t.status === 'pending') ? 'running'
        : its.every((t) => t.status === 'skipped') ? 'skipped'
        : its.every((t) => t.status === 'passed') ? 'passed' : 'failed';
    return { ...stage, number: s + 1, status, totals: Object.fromEntries(STATUSES.map((x) => [x, its.filter((t) => t.status === x).length])) };
  });
}

/**
 * Where each requirement the campaign's tests check stands, from the campaign's runs: per
 * criterion, failing (a test of it failed), passing (all of them passed), not_run (one of
 * them was not run here), not_covered (it has no test at all).
 */
function requirementsOf(tests) {
  if (!tests.length) return [];
  // A test played on several rows failed when one of them did, passed when all of them did.
  const statusOf = new Map();
  for (const t of tests) {
    const before = statusOf.get(t.name);
    if (before === undefined) statusOf.set(t.name, t.status);
    else if (before === 'failed' || t.status === 'failed') statusOf.set(t.name, 'failed');
    else if (before === 'passed') statusOf.set(t.name, t.status);
  }
  const ids = db.prepare(
    `SELECT DISTINCT c.requirement_id AS id FROM requirement_cases c JOIN tests t ON t.id = c.test_id
     WHERE t.name IN (${[...statusOf.keys()].map(() => '?').join(',')}) ORDER BY c.requirement_id`
  ).all(...[...statusOf.keys()]).map((r) => r.id);
  return ids.map((id) => {
    const requirement = getRequirement(id);
    const asRun = (c) => {
      const status = c.test ? statusOf.get(c.test) : null;
      return { ...c, last_run: status === 'passed' ? { status: 'success' } : status === 'failed' ? { status: 'failed' } : null };
    };
    const cases = requirement.cases.map(asRun);
    const criterionStatus = (criterion) => {
      const tested = cases.filter((c) => c.criterion_id === criterion.id && c.test);
      if (!tested.length) return 'not_covered';
      if (tested.some((c) => c.last_run?.status === 'failed')) return 'failing';
      return tested.every((c) => c.last_run?.status === 'success') ? 'passing' : 'not_run';
    };
    return {
      // Where it comes from: a tool's (lib/connectors) is told its coverage there.
      key: requirement.key, title: requirement.title, source: requirement.source,
      status: coverageOf(requirement.criteria, cases).status,
      criteria: requirement.criteria.map((c) => ({ number: c.position, text: c.text, status: criterionStatus(c) })),
    };
  });
}

/** The last campaign of the same tests before this one that went to its end. */
function previousOf(row) {
  return db.prepare(`SELECT * FROM campaigns WHERE scope_key = ? AND id < ? AND status = 'done' ORDER BY id DESC LIMIT 1`).get(row.scope_key, row.id) ?? null;
}

/**
 * A campaign: its tests and how each did, the totals, the requirements they check, and —
 * against the last campaign of the same tests — what regressed (passed there, fails here)
 * and what was fixed.
 */
export function getCampaign(id) {
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id));
  if (!row) return null;
  const tests = testsOf(row);
  const totals = Object.fromEntries(STATUSES.map((s) => [s, tests.filter((t) => t.status === s).length]));
  const previous = previousOf(row);
  let changes = null;
  if (previous) {
    const before = new Map(testsOf(previous).map((t) => [t.label, t.status]));
    changes = {
      since: { id: previous.id, version: previous.version, created_at: previous.created_at },
      regressed: tests.filter((t) => t.status === 'failed' && before.get(t.label) === 'passed').map((t) => t.label),
      fixed: tests.filter((t) => t.status === 'passed' && before.get(t.label) === 'failed').map((t) => t.label),
    };
  }
  const project = row.project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id)?.name ?? null : null;
  return {
    ...row, scope: parseJson(row.scope), tests: undefined, errors: undefined, project, headless: !!row.headless,
    running: running.has(row.id), totals, total: tests.length,
    duration_ms: row.finished_at ? Date.parse(row.finished_at) - Date.parse(row.created_at) : null,
    changes, requirements: requirementsOf(tests),
    one_at_a_time: row.concurrency > 1 && !row.headless ? sharedSessions(tests.map((t) => t.name)) : [],
    stages: stagesOf(parseJson(row.scope)?.stages, tests),
    non_conformities: tests.filter((t) => t.triage?.cause === 'non_conformity').map((t) => t.label),
    runs: tests,
  };
}

/** Campaigns, newest first: of a project, or all. Without their requirements. */
export function listCampaigns({ projectId, limit = 50 } = {}) {
  const rows = projectId
    ? db.prepare('SELECT id FROM campaigns WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit)
    : db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => {
    const { requirements, runs, ...campaign } = getCampaign(r.id);
    return { ...campaign, failing_requirements: requirements.filter((x) => x.status === 'failing').map((x) => x.key), failed: runs.filter((t) => t.status === 'failed').map((t) => t.label) };
  });
}

export function deleteCampaign(id) {
  if (running.has(Number(id))) throw new Error(`Campaign #${id} is running: stop it first`);
  const { changes } = db.prepare('DELETE FROM campaigns WHERE id = ?').run(Number(id));
  if (!changes) throw new Error(`No campaign #${id}`);
}

const seconds = (ms) => (ms == null ? '' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`);

/** A campaign as the agent reads it. */
export function formatCampaign(c) {
  const { totals } = c;
  const counts = STATUSES.filter((s) => totals[s]).map((s) => `${totals[s]} ${s}`).join(', ');
  const lines = [
    `Campaign #${c.id} "${c.name}"${c.version ? ` — version ${c.version}` : ''} — ${c.running ? 'RUNNING' : c.status}: ${counts} (${c.total} test(s), ${c.concurrency} at a time${c.headless ? ', headless' : ''}${c.duration_ms != null ? `, ${seconds(c.duration_ms)}` : ''})`,
  ];
  for (const st of c.stages ?? []) {
    const done = STATUSES.filter((x) => st.totals[x]).map((x) => `${st.totals[x]} ${x}`).join(', ');
    lines.push(`Stage ${st.number}${st.name ? ` "${st.name}"` : ''} (${st.mode}${st.needs_previous ? ', only if the stages before passed' : ''}) — ${st.status}: ${done} — ${st.tests.join(', ')}`);
  }
  for (const g of c.one_at_a_time ?? []) {
    lines.push(`One at a time: the ${g.tests.length} tests of ${g.site}, which log in there (the windows of one Chrome share its cookies)`);
  }
  if (c.changes) {
    const { since, regressed, fixed } = c.changes;
    lines.push(`Since campaign #${since.id}${since.version ? ` (version ${since.version})` : ''}: ${regressed.length ? `REGRESSED ${regressed.join(', ')}` : 'nothing regressed'}${fixed.length ? `; fixed ${fixed.join(', ')}` : ''}`);
  }
  const failed = c.runs.filter((t) => t.status === 'failed' || t.status === 'error');
  if (failed.length) {
    lines.push('Failed:');
    for (const t of failed) {
      lines.push(`  ${t.label ?? t.name}${t.failed_step ? ` — step ${t.failed_step}/${t.total_steps}` : ''}: ${String(t.error ?? '').split('\n')[0].slice(0, 200)}`);
      if (t.triage) lines.push(`    → ${t.triage.cause} (${t.triage.confidence}): ${t.triage.summary.slice(0, 300)}`);
    }
  }
  if (c.requirements.length) {
    lines.push('Requirements:');
    for (const r of c.requirements) {
      lines.push(`  ${r.key} — ${r.title}: ${r.status.replace('_', ' ')}${r.criteria.length ? ` (${r.criteria.map((x) => `${x.number}: ${x.status.replace('_', ' ')}`).join(', ')})` : ''}`);
    }
  }
  if (c.non_conformities.length) lines.push(`Non-conformities — the app does not do what its requirement says: ${c.non_conformities.join(', ')}. Report them; do not change the tests.`);
  if (c.running) lines.push(`Still running: get_campaign(id: ${c.id}) to follow it.`);
  return lines.join('\n');
}

const xml = (value) => String(value ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch])
  // Characters XML 1.0 does not allow (a page's text can hold them).
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // eslint-disable-line no-control-regex

/**
 * The campaign as JUnit XML, for a CI: one testcase per test, a failure with the step that
 * failed and why (the triage's cause as its type), the requirements it checks as properties.
 */
export function junitReport(c) {
  const time = (ms) => ((ms ?? 0) / 1000).toFixed(3);
  const failures = c.totals.failed;
  const errors = c.totals.error;
  const skipped = c.totals.skipped + c.totals.pending + c.totals.running;
  const suite = `${c.name}${c.version ? ` (${c.version})` : ''}`;
  const cases = c.runs.map((t) => {
    const requirements = requirementsOfTest(t.name);
    const properties = requirements.length
      ? `\n      <properties>${requirements.map((r) => `\n        <property name="requirement" value="${xml(r.key)}"/>`).join('')}\n      </properties>`
      : '';
    const message = `${t.failed_step ? `Step ${t.failed_step}/${t.total_steps}: ` : ''}${String(t.error ?? '').split('\n')[0]}`;
    const body = t.status === 'failed'
      ? `\n      <failure message="${xml(message)}" type="${xml(t.triage?.cause ?? 'failed')}">${xml([t.triage && `${t.triage.cause} (${t.triage.confidence}): ${t.triage.summary}`, t.error].filter(Boolean).join('\n\n'))}</failure>`
      : t.status === 'error' ? `\n      <error message="${xml(message)}"/>`
        : t.status !== 'passed' ? `\n      <skipped message="${xml(t.status === 'skipped' ? t.skipped_because ?? 'not run: the campaign was stopped' : `still ${t.status}`)}"/>` : '';
    return `    <testcase name="${xml(t.label ?? t.name)}" classname="${xml(c.project ?? 'izitest')}" time="${time(t.duration_ms)}">${properties}${body}${properties || body ? '\n    ' : ''}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="IziTest" tests="${c.total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time(c.duration_ms)}">`,
    `  <testsuite name="${xml(suite)}" tests="${c.total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time(c.duration_ms)}" timestamp="${xml(c.created_at)}">`,
    '    <properties>',
    `      <property name="campaign" value="${c.id}"/>`,
    ...(c.version ? [`      <property name="version" value="${xml(c.version)}"/>`] : []),
    '    </properties>',
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

const html = (value) => String(value ?? '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);

const STATUS_COLORS = { passed: '#15803d', failed: '#b91c1c', error: '#b91c1c', running: '#1d4ed8', pending: '#6b7280', skipped: '#6b7280' };
const REQUIREMENT_COLORS = { passing: '#15803d', failing: '#b91c1c', not_run: '#1d4ed8', not_covered: '#b45309' };

/** The campaign as an HTML page of its own, to share: the totals, what changed, the requirements, each test. */
export function htmlReport(c) {
  const chip = (text, color) => `<span class="chip" style="color:${color};border-color:${color}">${html(text)}</span>`;
  const when = new Date(c.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const changes = c.changes
    ? `<section><h2>Since campaign #${c.changes.since.id}${c.changes.since.version ? ` (version ${html(c.changes.since.version)})` : ''}</h2>
       <p>${c.changes.regressed.length ? `<strong class="bad">Regressed:</strong> ${c.changes.regressed.map(html).join(', ')}` : 'Nothing regressed.'}
       ${c.changes.fixed.length ? `<br><strong class="good">Fixed:</strong> ${c.changes.fixed.map(html).join(', ')}` : ''}</p></section>`
    : '';
  const requirements = c.requirements.length
    ? `<section><h2>Requirements</h2>${c.requirements.map((r) => `
       <div class="requirement"><div><strong>${html(r.key)}</strong> ${html(r.title)} ${chip(r.status.replace('_', ' '), REQUIREMENT_COLORS[r.status])}</div>
       <ol>${r.criteria.map((x) => `<li>${html(x.text)} ${chip(x.status.replace('_', ' '), REQUIREMENT_COLORS[x.status])}</li>`).join('')}</ol></div>`).join('')}</section>`
    : '';
  const rows = c.runs.map((t) => `
    <tr><td>${html(t.label ?? t.name)}</td><td>${chip(t.status, STATUS_COLORS[t.status])}</td><td>${seconds(t.duration_ms)}</td>
    <td>${t.status === 'failed' || t.status === 'error'
      ? `${t.failed_step ? `Step ${t.failed_step}/${t.total_steps}: ` : ''}${html(String(t.error ?? '').split('\n')[0].slice(0, 300))}${t.triage ? `<div class="why"><strong>${html(t.triage.cause.replace('_', ' '))}</strong> — ${html(t.triage.summary)}</div>` : ''}`
      : ''}</td></tr>`).join('');
  const { totals } = c;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campaign #${c.id} — ${html(c.name)}</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #111827; background: #f9fafb; margin: 0; padding: 24px 16px; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 0 0 8px; }
  section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-top: 16px; }
  .meta { color: #6b7280; } .bad { color: #b91c1c; } .good { color: #15803d; }
  .totals { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; }
  .totals div { font-size: 22px; font-weight: 600; } .totals span { display: block; font-size: 12px; font-weight: 400; color: #6b7280; }
  .chip { display: inline-block; font-size: 11px; padding: 0 6px; border: 1px solid; border-radius: 999px; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 8px; border-top: 1px solid #f3f4f6; vertical-align: top; }
  th { font-size: 12px; color: #6b7280; font-weight: 500; } .why { color: #6b7280; margin-top: 2px; }
  .requirement + .requirement { margin-top: 10px; } ol { margin: 4px 0 0; padding-left: 20px; }
</style></head>
<body><main>
<h1>Campaign #${c.id} — ${html(c.name)}</h1>
<div class="meta">${c.version ? `Version ${html(c.version)} · ` : ''}${html(when)} · ${c.total} test(s), ${c.concurrency} at a time${c.headless ? ', headless' : ''}${c.duration_ms != null ? ` · ${seconds(c.duration_ms)}` : ''} · ${html(c.running ? 'running' : c.status)}</div>
<div class="totals">${STATUSES.filter((s) => totals[s]).map((s) => `<div style="color:${STATUS_COLORS[s]}">${totals[s]}<span>${s}</span></div>`).join('')}</div>
${c.non_conformities.length ? `<section><h2 class="bad">Non-conformities</h2><p>The app does not do what the requirement says: ${c.non_conformities.map(html).join(', ')}.</p></section>` : ''}
${changes}
${requirements}
<section><h2>Tests</h2><table><tr><th>Test</th><th>Result</th><th>Time</th><th>Failure</th></tr>${rows}</table></section>
</main></body></html>
`;
}
