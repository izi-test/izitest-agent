// Bugs, from two sources, kept once each:
// - the explorer's (lib/explore.js), across explorations: each with a test that reproduces
//   it — the page, the click that caused it, the check it fails — replayed at once to confirm
//   it does fail. The test passes the day the bug is fixed.
// - a test's run, whose failure the diagnosis puts on the app (lib/triage.js): the app does
//   not do what the requirement asks (non_conformity), or fails where the test used to pass
//   (app_regression). The test that failed reproduces it; no other is made. Seen again, the
//   same bug; fixed when that test passes again, as it was when it failed.

import { createHash } from 'crypto';
import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { saveTest, loadTest } from './test-store.js';
import { listSessions } from './session.js';
import { explore, fingerprintOf, severityOf, titleOf, reproStepsOf, pathOf } from './explore.js';
import { pathOf as routeOf } from './footprint.js';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function toBug(row) {
  return row && { ...row, details: parseJson(row.details) ?? {}, reproduced: row.reproduced == null ? null : !!row.reproduced };
}

function toExploration(row) {
  return row && { ...row, options: parseJson(row.options) ?? {}, pages: parseJson(row.pages) ?? [] };
}

export function getBug(id) {
  return toBug(db.prepare('SELECT * FROM bugs WHERE id = ?').get(id));
}

/** Bugs, worst first: open ones by default. */
export function listBugs({ status = 'open', projectId, explorationId } = {}) {
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (projectId) { where.push('project_id = ?'); args.push(projectId); }
  if (explorationId) { where.push('exploration_id = ?'); args.push(explorationId); }
  const rows = db.prepare(`SELECT * FROM bugs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC LIMIT 200`).all(...args);
  return rows.map(toBug).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Mark a bug open, dismissed (not a bug, or not one to fix) or fixed. */
export function setBugStatus(id, status) {
  if (!['open', 'dismissed', 'fixed'].includes(status)) throw new Error(`No such status: ${status}`);
  if (!db.prepare('UPDATE bugs SET status = ? WHERE id = ?').run(status, id).changes) throw new Error(`No bug #${id}`);
  return getBug(id);
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
                  status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END,
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
 * one, or the one this test already met at this step (a fixed one opens again, a dismissed one
 * stays dismissed). The run is linked to it. { bug, isNew, reopened }, or null for no bug.
 */
export function recordRunBug({ testName, projectId = null, executionId, campaignId = null, dataRow = null, stepOrder, triage, requirements = [] }) {
  if (!isAppBug(triage) || !stepOrder) return null;
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
                  status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END,
                  fixed_execution_id = CASE WHEN status = 'fixed' THEN NULL ELSE fixed_execution_id END,
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
  log(`Bug #${id} ${known ? (known.status === 'fixed' ? 'open again' : `seen again (${bug.occurrences} times)`) : 'opened'}: ${title}`);
  return { bug, isNew: !known, reopened: known?.status === 'fixed' };
}

/**
 * A test passed, from its first step: the bugs it met are fixed — those met on this dataset
 * row, the test unchanged since. One changed since stays open: it may pass for not checking
 * any more what failed. The bugs fixed, and those left open for that.
 */
export function fixRunBugs({ testName, dataRow = null, executionId }) {
  const open = db.prepare(`SELECT * FROM bugs WHERE source = 'test' AND repro_test = ? AND data_row IS ? AND status = 'open'`).all(testName, dataRow).map(toBug);
  if (!open.length) return { fixed: [], changed: [] };
  const now = stepsHash(loadTest(testName)?.steps);
  const fixed = [];
  const changed = [];
  for (const bug of open) {
    if (bug.details.steps_hash && bug.details.steps_hash !== now) {
      db.prepare('UPDATE bugs SET details = ? WHERE id = ?').run(JSON.stringify({ ...bug.details, passed_after_change: executionId }), bug.id);
      changed.push(bug.id);
      continue;
    }
    db.prepare(`UPDATE bugs SET status = 'fixed', fixed_execution_id = ? WHERE id = ?`).run(executionId, bug.id);
    fixed.push(bug.id);
  }
  if (fixed.length) log(`Bug(s) ${fixed.map((id) => `#${id}`).join(', ')} fixed: ${testName} passes again`);
  if (changed.length) log(`Bug(s) ${changed.map((id) => `#${id}`).join(', ')} left open: ${testName} passes, but was changed since`);
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

export function formatBug(bug) {
  if (bug.source === 'test') {
    const d = bug.details ?? {};
    const seen = `seen ${bug.occurrences} time${bug.occurrences > 1 ? 's' : ''}${bug.status !== 'open' ? `, ${bug.status}${bug.fixed_execution_id ? ` by run #${bug.fixed_execution_id}` : ''}` : ''}`;
    return [
      `#${bug.id} [${bug.severity}] ${bug.kind === 'non_conformity' ? 'Non-conformity' : 'Regression'}: ${bug.title} (${seen})`,
      `  test: ${bug.repro_test}, step ${d.step?.order ?? '?'}${bug.data_row ? `, row ${bug.data_row}` : ''} — last in ${d.campaign ? `campaign #${d.campaign.id}` : `run #${bug.execution_id}`}`,
      ...(d.summary ? [`  ${cut(d.summary, 400)}`] : []),
      ...(d.passed_after_change && bug.status === 'open' ? [`  Its test passed in run #${d.passed_after_change}, but was changed since the bug was seen: check by hand that it is fixed.`] : []),
    ].join('\n');
  }
  const proof = bug.reproduced == null ? '' : bug.reproduced ? ' — reproduced by its test' : ' — its test did not reproduce it (intermittent?)';
  return [
    `#${bug.id} [${bug.severity}] ${bug.title}${bug.isNew === false ? ` (known, seen ${bug.occurrences} times, ${bug.status})` : ''}`,
    `  test: ${bug.repro_test}${proof}`,
  ].join('\n');
}
