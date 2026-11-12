// Bugs, from three sources, kept once each:
// - the explorer's (lib/explore.js), across explorations: each with a test that reproduces
//   it — the page, the click that caused it, the check it fails — replayed at once to confirm
//   it does fail. The test passes the day the bug is fixed.
// - a test's run, whose failure the diagnosis puts on the app (lib/triage.js): the app does
//   not do what the requirement asks (non_conformity), or fails where the test used to pass
//   (app_regression). The test that failed reproduces it; no other is made. Seen again, the
//   same bug; fixed when that test passes again, as it was when it failed.
// - a person's report (reportBug): what they saw, in their words. The agent reproduces it and
//   records the test that fails while it is there (reproBrief, linkReproTest); from then on it
//   lives as a run's bug does.
//
// A bug is handled (updateBug): how urgent its fix is, who has it, and where it stands — open,
// deferred (not fixed now), duplicate (of another), to_retest (said fixed: its test has to
// confirm it), fixed, dismissed (not a bug).

import { createHash, randomUUID } from 'crypto';
import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { saveTest, loadTest } from './test-store.js';
import { listSessions } from './session.js';
import { explore, fingerprintOf, severityOf, titleOf, reproStepsOf, pathOf } from './explore.js';
import { pathOf as routeOf } from './footprint.js';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export const BUG_STATUSES = ['open', 'to_retest', 'deferred', 'duplicate', 'fixed', 'dismissed'];
export const BUG_PRIORITIES = ['high', 'medium', 'low'];
// Still to be dealt with: what a campaign's exit criteria and a progress report count.
export const UNRESOLVED_STATUSES = ['open', 'to_retest', 'deferred'];
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function toBug(row) {
  return row && { ...row, details: parseJson(row.details) ?? {}, reproduced: row.reproduced == null ? null : !!row.reproduced };
}

function toExploration(row) {
  return row && { ...row, options: parseJson(row.options) ?? {}, pages: parseJson(row.pages) ?? [] };
}

export function getBug(id) {
  return toBug(db.prepare('SELECT * FROM bugs WHERE id = ?').get(id));
}

/** Bugs, worst first: open ones by default; `unresolved` for all those still to be dealt with. */
export function listBugs({ status = 'open', projectId, explorationId } = {}) {
  const where = [];
  const args = [];
  if (status === 'unresolved') where.push(`status IN (${UNRESOLVED_STATUSES.map((s) => `'${s}'`).join(', ')})`);
  else if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (projectId) { where.push('project_id = ?'); args.push(projectId); }
  if (explorationId) { where.push('exploration_id = ?'); args.push(explorationId); }
  const rows = db.prepare(`SELECT * FROM bugs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC LIMIT 200`).all(...args);
  return rows.map(toBug).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Handles a bug: its status, how urgent its fix is (`priority`), who has it (`assignee`), the
 * bug it repeats (`duplicate_of`: makes it a duplicate), its severity or title, the test that
 * reproduces it (`repro_test`, see linkReproTest). What is not given is kept; null or '' removes
 * a priority or an assignee.
 */
export function updateBug(id, changes = {}) {
  const bug = getBug(id);
  if (!bug) throw new Error(`No bug #${id}`);
  const set = [];
  const args = [];
  const put = (column, value) => { set.push(`${column} = ?`); args.push(value); };
  let { status } = changes;
  let duplicateOf = changes.duplicate_of;
  if (duplicateOf != null && duplicateOf !== '') {
    duplicateOf = Number(duplicateOf);
    const original = getBug(duplicateOf);
    if (!original) throw new Error(`No bug #${changes.duplicate_of} for #${id} to be a duplicate of`);
    if (original.id === bug.id) throw new Error(`Bug #${id} cannot be a duplicate of itself`);
    if (original.duplicate_of === bug.id) throw new Error(`Bug #${original.id} is already a duplicate of #${id}`);
    status = 'duplicate';
    put('duplicate_of', original.id);
  }
  if (status != null) {
    if (!BUG_STATUSES.includes(status)) throw new Error(`No such status: ${status} (${BUG_STATUSES.join(', ')})`);
    if (status === 'duplicate' && !(duplicateOf ?? bug.duplicate_of)) throw new Error('Say which bug it is a duplicate of: duplicate_of');
    put('status', status);
    if (status !== 'duplicate' && bug.duplicate_of) put('duplicate_of', null);
    if (status === 'fixed' && bug.status !== 'fixed') set.push(`fixed_at = ${NOW}`);
    if (status !== 'fixed' && bug.status === 'fixed') { set.push('fixed_at = NULL'); put('fixed_execution_id', null); }
  }
  for (const field of ['priority', 'severity']) {
    const value = changes[field];
    if (value === undefined) continue;
    if (value == null || value === '') {
      if (field === 'severity') throw new Error('A bug has a severity: high, medium or low');
      put(field, null);
    } else if (!BUG_PRIORITIES.includes(value)) throw new Error(`No such ${field}: ${value} (high, medium, low)`);
    else put(field, value);
  }
  if (changes.assignee !== undefined) put('assignee', String(changes.assignee ?? '').trim() || null);
  if (changes.title !== undefined) {
    const title = String(changes.title ?? '').trim();
    if (!title) throw new Error('A bug needs a title');
    put('title', title);
  }
  if (set.length) db.prepare(`UPDATE bugs SET ${set.join(', ')} WHERE id = ?`).run(...args, id);
  if (changes.repro_test !== undefined) linkReproTest(id, changes.repro_test);
  return getBug(id);
}

/** Mark a bug open, to retest, deferred, fixed or dismissed. */
export const setBugStatus = (id, status) => updateBug(id, { status });

// ─── The bugs a person reports ────────────────────────────────────────

/**
 * Keeps a bug a person reports: what happens (`description`, in their words, with how they got
 * there), what they expected, where. It has no test yet: the agent reproduces it (reproBrief).
 */
export function reportBug({ title, description = '', expected = '', pageUrl = '', severity = 'medium', priority = null, assignee = null, projectId = null, requirement = null } = {}) {
  const name = String(title ?? '').trim();
  if (!name) throw new Error('A bug needs a title: what goes wrong, in a line');
  if (!BUG_PRIORITIES.includes(severity)) throw new Error(`No such severity: ${severity} (high, medium, low)`);
  if (priority != null && priority !== '' && !BUG_PRIORITIES.includes(priority)) throw new Error(`No such priority: ${priority} (high, medium, low)`);
  if (projectId != null && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error(`No project #${projectId}`);
  const requirements = [];
  if (requirement) {
    const row = db.prepare('SELECT key, title FROM requirements WHERE key = ? COLLATE NOCASE').get(String(requirement).trim());
    if (!row) throw new Error(`No requirement ${requirement}`);
    requirements.push({ key: row.key, title: row.title, criteria: [] });
  }
  const details = { description: String(description ?? '').trim(), expected: String(expected ?? '').trim(), requirements };
  const { id } = db.prepare(
    `INSERT INTO bugs (fingerprint, source, project_id, kind, severity, priority, assignee, title, page_url, details)
     VALUES (?, 'report', ?, 'reported', ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(`report|${randomUUID()}`, projectId, severity, priority || null, String(assignee ?? '').trim() || null, name, String(pageUrl ?? '').trim(), JSON.stringify(details));
  log(`Bug #${id} reported: ${name}`);
  return getBug(id);
}

/** The name the test reproducing a reported bug is recorded under. */
export const reproTestName = (bug) => `bug_${bug.id}_repro`;

/**
 * Makes a test the one that reproduces a bug: failing, the bug is there; passing — after having
 * failed, and unchanged since — it is fixed. null takes the test away.
 */
export function linkReproTest(id, testName) {
  const bug = getBug(id);
  if (!bug) throw new Error(`No bug #${id}`);
  if (bug.source === 'test') throw new Error(`Bug #${id} was met by the test ${bug.repro_test}: that test reproduces it`);
  const name = String(testName ?? '').trim();
  if (!name) {
    db.prepare('UPDATE bugs SET repro_test = NULL, reproduced = NULL WHERE id = ?').run(id);
    return getBug(id);
  }
  const test = loadTest(name);
  if (!test) throw new Error(`No test "${name}": record it first`);
  const project = db.prepare('SELECT project_id FROM tests WHERE name = ?').get(name)?.project_id ?? null;
  db.prepare('UPDATE bugs SET repro_test = ?, reproduced = NULL, project_id = COALESCE(project_id, ?), details = ? WHERE id = ?')
    .run(name, project, JSON.stringify({ ...bug.details, steps_hash: stepsHash(test.steps), passed_unreproduced: undefined }), id);
  log(`Bug #${id}: reproduced by the test ${name}`);
  return getBug(id);
}

/**
 * A test named as a reported bug's (bug_<id>_repro) is that bug's test, when it has none yet:
 * whoever recorded it need not say so.
 */
export function adoptReproTest(testName) {
  const id = Number(/^bug_(\d+)_repro$/.exec(testName ?? '')?.[1]);
  if (!id) return null;
  const bug = getBug(id);
  if (!bug || bug.source !== 'report' || bug.repro_test || !loadTest(testName)) return null;
  return linkReproTest(id, testName);
}

/** What the agent is asked, to reproduce a reported bug and keep the test of it. */
export function reproBrief(bug) {
  const d = bug.details ?? {};
  const project = bug.project_id ? db.prepare('SELECT name, base_url FROM projects WHERE id = ?').get(bug.project_id) : null;
  const name = reproTestName(bug);
  return [
    `Reproduce bug #${bug.id} of IziTest, reported by a person, and keep the test that shows it.`,
    '',
    `Title: ${bug.title}`,
    ...(d.description ? [`What happens, as reported: ${d.description}`] : []),
    ...(d.expected ? [`What was expected: ${d.expected}`] : []),
    ...(bug.page_url ? [`Where: ${bug.page_url}`] : []),
    ...(project ? [`Project: ${project.name}${project.base_url ? ` (${project.base_url})` : ''} — project_id ${bug.project_id}`] : []),
    ...((d.requirements ?? []).length ? [`Requirement: ${d.requirements.map((r) => `${r.key} ${r.title}`).join(', ')} — get_requirement for its acceptance criteria`] : []),
    '',
    'How:',
    `1. get_project_context${bug.project_id ? `(${bug.project_id})` : ''} for how to log in, then follow the report in the browser until you see what it describes.`,
    `2. If you see it: record the path as the test "${name}" (start_recording … stop_recording${bug.project_id ? `, project_id ${bug.project_id}` : ''}), ending on a check of what was EXPECTED — an assertion that fails today, because of the bug, and will pass the day it is fixed. Check the expected behaviour, never the faulty one.`,
    `3. That name is what makes it the bug's test: keep it exactly. Then run_test("${name}") once: it has to fail on that last check. That failure is the proof; the bug then closes by itself when the test passes again.`,
    `4. If you cannot reproduce it: record nothing, and say what you tried and what the app did instead, so that the person can complete the report or dismiss the bug.`,
  ].join('\n');
}

export function getExploration(id) {
  return toExploration(db.prepare('SELECT * FROM explorations WHERE id = ?').get(id));
}

export function listExplorations(limit = 10) {
  return db.prepare('SELECT * FROM explorations ORDER BY id DESC LIMIT ?').all(limit).map(toExploration);
}

/** The project whose base URL the explored URL starts with, if any. */
function projectOf(url, projectId) {
  if (projectId) return projectId;
  const projects = db.prepare("SELECT id, base_url FROM projects WHERE base_url IS NOT NULL AND base_url != ''").all();
  return projects.find((p) => url.startsWith(p.base_url))?.id ?? null;
}

/**
 * Keep one finding as a bug: a new one gets a reproducing test; one already known is seen
 * once more (a dismissed one stays dismissed). The bug, and whether it is new.
 */
function recordFinding(finding, explorationId, projectId) {
  const fingerprint = fingerprintOf(finding);
  const known = db.prepare('SELECT * FROM bugs WHERE fingerprint = ?').get(fingerprint);
  if (known) {
    // Fixed, then seen again: open again.
    db.prepare(`UPDATE bugs SET occurrences = occurrences + 1, exploration_id = ?, details = ?,
                  ${SEEN_AGAIN},
                  last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(explorationId, JSON.stringify(finding), known.id);
    return { bug: getBug(known.id), isNew: false };
  }
  const { id } = db.prepare(
    `INSERT INTO bugs (fingerprint, project_id, exploration_id, kind, severity, title, page_url, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(fingerprint, projectId, explorationId, finding.kind, severityOf(finding), titleOf(finding), finding.page, JSON.stringify(finding));
  const name = `bug_${id}_${finding.kind}`;
  saveTest({ name, description: `Reproduces bug #${id}: ${titleOf(finding)}`, steps: reproStepsOf(finding), variables: {} });
  if (projectId) db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(projectId, name);
  db.prepare('UPDATE bugs SET repro_test = ? WHERE id = ?').run(name, id);
  return { bug: getBug(id), isNew: true };
}

// ─── The bugs a test's run met ────────────────────────────────────────

// Seen again: one fixed, or waiting for its test to confirm the fix, is open again; one deferred,
// dismissed or a duplicate stays as it was decided.
const SEEN_AGAIN = `status = CASE WHEN status IN ('fixed', 'to_retest') THEN 'open' ELSE status END,
                  fixed_at = CASE WHEN status = 'fixed' THEN NULL ELSE fixed_at END,
                  fixed_execution_id = CASE WHEN status = 'fixed' THEN NULL ELSE fixed_execution_id END`;
const reopens = (status) => status === 'fixed' || status === 'to_retest';

/**
 * A run of the test that reproduces a reported bug failed: the bug is there, seen once more.
 * { bug, isNew: false, reopened }, or null when the test reproduces no reported bug.
 */
function seeReportedBug({ testName, executionId, campaignId }) {
  adoptReproTest(testName);
  const known = db.prepare(`SELECT * FROM bugs WHERE source = 'report' AND repro_test = ? AND status NOT IN ('dismissed', 'duplicate') ORDER BY id LIMIT 1`).get(testName);
  if (!known) return null;
  db.prepare(`UPDATE bugs SET occurrences = occurrences + CASE WHEN reproduced = 1 THEN 1 ELSE 0 END, reproduced = 1,
                execution_id = ?, campaign_id = COALESCE(?, campaign_id), ${SEEN_AGAIN}, last_seen = ${NOW} WHERE id = ?`)
    .run(executionId, campaignId, known.id);
  db.prepare('UPDATE test_executions SET bug_id = ? WHERE id = ?').run(known.id, executionId);
  log(`Bug #${known.id} ${reopens(known.status) ? 'open again' : known.reproduced ? 'seen again' : 'reproduced'} by ${testName}`);
  return { bug: getBug(known.id), isNew: false, reopened: reopens(known.status) };
}

// The kind of bug a diagnosis cause is.
const RUN_BUG_KINDS = { non_conformity: 'non_conformity', app_regression: 'regression' };

/** Whether a run's diagnosis puts the failure on the app, with a reason to: a bug to keep. */
export function isAppBug(triage) {
  return !!triage && triage.cause in RUN_BUG_KINDS && triage.confidence !== 'low';
}

const cut = (text, length) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

/**
 * What a run's bug is, in a line: the criterion not met, then what went wrong — the value
 * the page shows, else the request the app refused, else the step.
 */
export function runBugTitle({ triage, requirements = [], stepOrder, intent }) {
  const { expected, actual, page = {} } = triage.evidence ?? {};
  const request = (page.failedRequests ?? [])[0];
  const what = expected != null && actual != null
    ? `expected "${cut(expected, 40)}", the page shows "${cut(actual, 50)}"`
    : request
      ? `${request.method ?? 'GET'} ${routeOf(request.url) ?? request.url} answered ${request.status || 'nothing'}`
      : `step ${stepOrder}${intent ? ` (${cut(intent, 60)})` : ''} fails`;
  const [requirement] = requirements;
  const criterion = triage.cause === 'non_conformity' && requirement
    ? `${requirement.key}${requirement.criteria?.[0] ? ` criterion ${requirement.criteria[0].number}` : ''} not met: `
    : '';
  return `${criterion}${what}`;
}

/** What a test does, for knowing it changed: its steps' commands, parameters and checks. */
export function stepsHash(steps = []) {
  const shape = steps.map((s) => [s.command, s.params ?? {}, s.assertion ?? null]);
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

/**
 * Keep the bug a run met, when its diagnosis puts the failure on the app (isAppBug): a new
 * one, or the one this test already met at this step (a fixed one, or one to retest, opens
 * again; a deferred or dismissed one stays so). A test that reproduces a reported bug shows that
 * bug, whatever the diagnosis. The run is linked to it. { bug, isNew, reopened }, or null.
 */
export function recordRunBug({ testName, projectId = null, executionId, campaignId = null, dataRow = null, stepOrder, triage, requirements = [] }) {
  if (!stepOrder) return null;
  const reported = seeReportedBug({ testName, executionId, campaignId });
  if (reported) return reported;
  if (!isAppBug(triage)) return null;
  const test = loadTest(testName);
  const step = test?.steps?.[stepOrder - 1];
  const { evidence = {} } = triage;
  const kind = RUN_BUG_KINDS[triage.cause];
  const failedRequests = evidence.page?.failedRequests ?? [];
  const severity = kind === 'non_conformity' || failedRequests.some((r) => r.status >= 500 || r.status === 0) ? 'high' : 'medium';
  const title = runBugTitle({ triage, requirements, stepOrder, intent: step?.intent });
  const campaign = campaignId ? db.prepare('SELECT id, name, version, commit_info FROM campaigns WHERE id = ?').get(campaignId) : null;
  const details = {
    test: testName, step: evidence.step ?? { order: stepOrder }, cause: triage.cause, confidence: triage.confidence,
    // The criteria are kept below, each on its own: not said again at the end of the diagnosis.
    summary: requirements.length ? String(triage.summary ?? '').replace(/ — the test checks [\s\S]*$/, '') : triage.summary,
    expected: evidence.expected, actual: evidence.actual, failed_requests: failedRequests, alerts: evidence.page?.alerts ?? [],
    requirements: requirements.map((r) => ({ key: r.key, title: r.title, criteria: (r.criteria ?? []).map((c) => ({ number: c.number, text: c.text })) })),
    campaign: campaign ? { id: campaign.id, name: campaign.name, version: campaign.version, commit: parseJson(campaign.commit_info)?.sha?.slice(0, 7) ?? null } : null,
    // How the test was when it met the bug: passing changed, it does not show the bug fixed.
    steps_hash: stepsHash(test?.steps),
  };
  const fingerprint = `run|${testName}|${dataRow ?? ''}|${stepOrder}`;
  const known = db.prepare('SELECT * FROM bugs WHERE fingerprint = ?').get(fingerprint);
  let id;
  if (known) {
    id = known.id;
    db.prepare(`UPDATE bugs SET occurrences = occurrences + 1, kind = ?, severity = ?, title = ?, page_url = ?, details = ?,
                  execution_id = ?, campaign_id = ?, project_id = COALESCE(?, project_id),
                  ${SEEN_AGAIN},
                  last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(kind, severity, title, evidence.page?.url ?? '', JSON.stringify(details), executionId, campaignId, projectId, id);
  } else {
    ({ id } = db.prepare(
      `INSERT INTO bugs (fingerprint, source, project_id, kind, severity, title, page_url, details, repro_test, reproduced, execution_id, campaign_id, data_row)
       VALUES (?, 'test', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING id`
    ).get(fingerprint, projectId, kind, severity, title, evidence.page?.url ?? '', JSON.stringify(details), testName, executionId, campaignId, dataRow));
  }
  db.prepare('UPDATE test_executions SET bug_id = ? WHERE id = ?').run(id, executionId);
  const bug = getBug(id);
  log(`Bug #${id} ${known ? (reopens(known.status) ? 'open again' : `seen again (${bug.occurrences} times)`) : 'opened'}: ${title}`);
  return { bug, isNew: !known, reopened: !!known && reopens(known.status) };
}

/**
 * A test passed, from its first step: the bugs it met are fixed — those met on this dataset
 * row, the test unchanged since —, open, deferred or waiting for this confirmation (to_retest).
 * One changed since stays as it is: it may pass for not checking any more what failed. So does
 * a reported bug whose test never failed: passing, it shows nothing. The bugs fixed, and those
 * left for that.
 */
export function fixRunBugs({ testName, dataRow = null, executionId }) {
  adoptReproTest(testName);
  const open = db.prepare(
    `SELECT * FROM bugs WHERE repro_test = ? AND status IN ('open', 'to_retest', 'deferred')
       AND ((source = 'test' AND data_row IS ?) OR source = 'report')`,
  ).all(testName, dataRow).map(toBug);
  if (!open.length) return { fixed: [], changed: [] };
  const now = stepsHash(loadTest(testName)?.steps);
  const fixed = [];
  const changed = [];
  for (const bug of open) {
    if (bug.source === 'report' && !bug.reproduced) {
      db.prepare('UPDATE bugs SET reproduced = 0, details = ? WHERE id = ?').run(JSON.stringify({ ...bug.details, passed_unreproduced: executionId }), bug.id);
      changed.push(bug.id);
      continue;
    }
    if (bug.details.steps_hash && bug.details.steps_hash !== now) {
      db.prepare('UPDATE bugs SET details = ? WHERE id = ?').run(JSON.stringify({ ...bug.details, passed_after_change: executionId }), bug.id);
      changed.push(bug.id);
      continue;
    }
    db.prepare(`UPDATE bugs SET status = 'fixed', fixed_at = ${NOW}, fixed_execution_id = ? WHERE id = ?`).run(executionId, bug.id);
    fixed.push(bug.id);
  }
  if (fixed.length) log(`Bug(s) ${fixed.map((id) => `#${id}`).join(', ')} fixed: ${testName} passes again`);
  if (changed.length) log(`Bug(s) ${changed.map((id) => `#${id}`).join(', ')} left open: ${testName} passes, but was changed since or never showed the bug`);
  return { fixed, changed };
}

/**
 * Replay a bug's test: reproduced when it fails on its own check — the last step. Its
 * window is closed after, whatever it gave.
 */
async function confirmBug(bug, sendCommand) {
  const { executeTest } = await import('./test-execute.js');
  let reproduced = false;
  let tabId = null;
  try {
    const run = await executeTest(bug.repro_test, null, null, null, true, sendCommand, 'explore');
    tabId = run.results?.findLast?.((r) => r.tabId != null)?.tabId ?? null;
  } catch (err) {
    tabId = err.tabId ?? null;
    reproduced = err.failedStep === err.totalSteps && err.assertionsFailed > 0;
  }
  db.prepare('UPDATE bugs SET reproduced = ? WHERE id = ?').run(reproduced ? 1 : 0, bug.id);
  if (tabId) await closeWindowOf(tabId, sendCommand);
  return reproduced;
}

const closeWindowOf = (tabId, sendCommand) =>
  sendCommand(undefined, 'close_window', { tabId, liveSessions: listSessions().map((s) => s.id) }).catch(() => {});

/**
 * Explore from `url` and keep what is found: an exploration, its bugs, a test reproducing
 * each new one — replayed to confirm it (`confirm`). `onProgress` hears of each page.
 */
export async function runExploration({ url, sendCommand, projectId = null, maxPages, interact, checks, impacts, budgetMs, confirm = true, onProgress, onStart }) {
  const project = projectOf(url, projectId);
  const options = { maxPages, interact, checks, impacts, confirm };
  const { id } = db.prepare('INSERT INTO explorations (start_url, project_id, options) VALUES (?, ?, ?) RETURNING id').get(url, project, JSON.stringify(options));
  onStart?.(id);
  log(`Exploration #${id} of ${url} started`);
  let result;
  try {
    result = await explore({ startUrl: url, sendCommand, maxPages, interact, checks, impacts, budgetMs, onProgress: (progress) => {
      db.prepare('UPDATE explorations SET pages = ? WHERE id = ?').run(JSON.stringify(progress.pages ?? []), id);
      onProgress?.(progress);
    } });
  } catch (err) {
    db.prepare(`UPDATE explorations SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(err.message, id);
    throw err;
  }
  if (result.tabId) await closeWindowOf(result.tabId, sendCommand);

  const bugs = [];
  for (const finding of result.findings) {
    const { bug, isNew } = recordFinding(finding, id, project);
    if (isNew && confirm) bug.reproduced = await confirmBug(bug, sendCommand);
    bugs.push({ ...bug, isNew });
  }
  const fresh = bugs.filter((bug) => bug.isNew).length;
  db.prepare(`UPDATE explorations SET status = 'done', pages = ?, bugs_found = ?, bugs_new = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(JSON.stringify(result.pages), bugs.length, fresh, id);
  log(`Exploration #${id}: ${result.pages.length} page(s), ${bugs.length} bug(s), ${fresh} new`);
  return { exploration: getExploration(id), bugs, unvisited: result.unvisited, outOfTime: result.outOfTime };
}

/** An exploration's report as the agent reads it. */
export function formatExploration({ exploration, bugs, unvisited, outOfTime }) {
  const lines = [`Exploration #${exploration.id} of ${exploration.start_url}: ${exploration.pages.length} page(s) visited, ${bugs.length} bug(s) found, ${bugs.filter((b) => b.isNew).length} new.`];
  for (const page of exploration.pages) {
    lines.push(`  ${pathOf(page.url)} — ${page.findings} finding(s), ${page.clicks} click(s)${page.error ? `, failed: ${page.error}` : ''}${page.skipped ? `, skipped: ${page.skipped}` : ''}`);
  }
  if (unvisited) lines.push(`  ${unvisited} more page(s) found but not visited${outOfTime ? ' (out of time)' : ' (max_pages reached)'}.`);
  for (const bug of bugs) lines.push('', formatBug(bug));
  return lines.join('\n');
}

/** How a bug is handled, in a line: its fix's priority, who has it, the bug it repeats. */
function handlingOf(bug) {
  const parts = [
    bug.priority ? `fix priority ${bug.priority}` : null,
    bug.assignee ? `assigned to ${bug.assignee}` : null,
    bug.status === 'duplicate' && bug.duplicate_of ? `duplicate of #${bug.duplicate_of}` : null,
    bug.status === 'to_retest' ? 'said fixed: run its test to confirm' : null,
    bug.status === 'deferred' ? 'fix deferred' : null,
  ].filter(Boolean);
  return parts.length ? [`  ${parts.join(' · ')}`] : [];
}

export function formatBug(bug) {
  const d = bug.details ?? {};
  const state = bug.status !== 'open' ? `, ${bug.status}${bug.fixed_execution_id ? ` by run #${bug.fixed_execution_id}` : ''}` : '';
  if (bug.source === 'test') {
    const seen = `seen ${bug.occurrences} time${bug.occurrences > 1 ? 's' : ''}${state}`;
    return [
      `#${bug.id} [${bug.severity}] ${bug.kind === 'non_conformity' ? 'Non-conformity' : 'Regression'}: ${bug.title} (${seen})`,
      `  test: ${bug.repro_test}, step ${d.step?.order ?? '?'}${bug.data_row ? `, row ${bug.data_row}` : ''} — last in ${d.campaign ? `campaign #${d.campaign.id}` : `run #${bug.execution_id}`}`,
      ...handlingOf(bug),
      ...(d.summary ? [`  ${cut(d.summary, 400)}`] : []),
      ...(d.passed_after_change && bug.status === 'open' ? [`  Its test passed in run #${d.passed_after_change}, but was changed since the bug was seen: check by hand that it is fixed.`] : []),
    ].join('\n');
  }
  if (bug.source === 'report') {
    const test = !bug.repro_test
      ? `  no test yet: reproduce it and record ${reproTestName(bug)}, then update_bug(${bug.id}, repro_test)`
      : `  test: ${bug.repro_test}${bug.reproduced ? ' — reproduced by it' : bug.reproduced === false ? ' — it passed without ever failing: it does not show the bug' : ' — not run yet: run it, it has to fail'}`;
    return [
      `#${bug.id} [${bug.severity}] Reported: ${bug.title} (${bug.status}${bug.fixed_execution_id ? ` by run #${bug.fixed_execution_id}` : ''})`,
      test,
      ...handlingOf(bug),
      ...(d.description ? [`  ${cut(d.description, 400)}`] : []),
      ...(d.expected ? [`  expected: ${cut(d.expected, 200)}`] : []),
    ].join('\n');
  }
  const proof = bug.reproduced == null ? '' : bug.reproduced ? ' — reproduced by its test' : ' — its test did not reproduce it (intermittent?)';
  return [
    `#${bug.id} [${bug.severity}] ${bug.title}${bug.isNew === false ? ` (known, seen ${bug.occurrences} times, ${bug.status})` : ''}`,
    `  test: ${bug.repro_test}${proof}`,
    ...handlingOf(bug),
  ].join('\n');
}
