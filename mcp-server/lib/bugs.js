// Bugs the explorer found (lib/explore.js): kept once each across explorations, with a test
// that reproduces it — the page, the click that caused it, the check it fails — replayed at
// once to confirm it does fail. The test passes the day the bug is fixed.

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { saveTest } from './test-store.js';
import { listSessions } from './session.js';
import { explore, fingerprintOf, severityOf, titleOf, reproStepsOf, pathOf } from './explore.js';

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
  const proof = bug.reproduced == null ? '' : bug.reproduced ? ' — reproduced by its test' : ' — its test did not reproduce it (intermittent?)';
  return [
    `#${bug.id} [${bug.severity}] ${bug.title}${bug.isNew === false ? ` (known, seen ${bug.occurrences} times, ${bug.status})` : ''}`,
    `  test: ${bug.repro_test}${proof}`,
  ].join('\n');
}
