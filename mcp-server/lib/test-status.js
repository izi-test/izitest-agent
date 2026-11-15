// How a test last did. A test with rows (lib/datasets.js: those of its dataset, or its own)
// plays each in a run of its own: its last run alone told only how its last row did — row 1
// failing, row 2 passing, the test read "passed". So every row it plays now is counted, by its
// last run: the test failed when one of them failed. Read by the test list, a test's page, the
// coverage of requirements and the regression plan.
// Its own module: lib/datasets.js reaches lib/requirements.js through lib/requirement-import.js.

import { db, parseJson } from './db.js';

/** How many rows a test plays now: those of the dataset it is bound to, else its own; 0 for none. */
function rowCountOf(testId) {
  const row = db.prepare('SELECT t.data_rows, d.rows AS dataset_rows FROM tests t LEFT JOIN datasets d ON d.id = t.dataset_id WHERE t.id = ?').get(testId);
  const rows = parseJson(row?.dataset_rows) ?? parseJson(row?.data_rows);
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * The last run of a test, every row it plays counted: `{ id, status, started_at, duration_ms,
 * data_row }` of its latest run, its status `failed` when the last run of one of its rows
 * failed, `running` while one runs, `success` when every row played passed — and `rows`:
 * `{ total, played, failed: [row numbers] }`. Without rows, or none of them run yet, its last
 * run as it is. Null when it never ran. `excludeTriggers`: runs not counted (a repair being
 * checked); `finishedOnly`: only runs that passed or failed.
 */
export function lastRunOfTest(testId, { excludeTriggers = [], finishedOnly = false } = {}) {
  const where = ['test_id = ?'];
  const params = [testId];
  if (excludeTriggers.length) {
    where.push(`trigger NOT IN (${excludeTriggers.map(() => '?').join(', ')})`);
    params.push(...excludeTriggers);
  }
  if (finishedOnly) where.push("status IN ('success', 'failed')");
  const total = rowCountOf(testId);
  if (total > 0) {
    const runs = db.prepare(
      `SELECT id, status, started_at, duration_ms, data_row FROM test_executions
       WHERE id IN (SELECT MAX(id) FROM test_executions WHERE ${where.join(' AND ')} AND data_row BETWEEN 1 AND ? GROUP BY data_row)`
    ).all(...params, total);
    if (runs.length) {
      const latest = runs.reduce((a, b) => (b.id > a.id ? b : a));
      const failed = runs.filter((r) => r.status === 'failed').map((r) => r.data_row).sort((a, b) => a - b);
      const status = runs.some((r) => r.status === 'running') ? 'running'
        : failed.length ? 'failed'
          : runs.every((r) => r.status === 'success') ? 'success' : latest.status;
      return { ...latest, status, rows: { total, played: runs.length, failed } };
    }
  }
  return db.prepare(
    `SELECT id, status, started_at, duration_ms, data_row FROM test_executions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`
  ).get(...params) ?? null;
}
