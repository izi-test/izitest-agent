// Repairs proposed for a failed run (lib/triage.js): kept here, proved by replaying the test
// with them, and saved into the test only when someone accepts — the agent on the user's
// word, or the user in the dashboard. Nothing repairs a test by itself.
//
// A repair changes one step: `replace` it (its selector and locators, an assertion's
// selector or expected value) or `insert` a step before it (a wait). `before` is that step
// as it was when the repair was proposed: a test edited since is not repaired blindly.

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { loadTest, updateTestStep, insertTestStep } from './test-store.js';

// What a repair can still become: verified, applied, rejected.
const OPEN = new Set(['proposed', 'verified', 'failed']);
const APPLICABLE = new Set(['proposed', 'verified']);

const stepKey = (step) => JSON.stringify(step ? {
  command: step.command, params: step.params ?? {}, locators: step.locators ?? null, assertion: step.assertion ?? null,
} : null);

/**
 * Keep a diagnosis's proposals; their ids, in order. `test` is the test the run played. A
 * failure seen again proposes the same repair again: the open one is reused, not doubled.
 */
export function saveRepairs(testName, executionId, diagnosis, runOptions = {}, test = null) {
  const testRow = db.prepare('SELECT id FROM tests WHERE name = ?').get(testName);
  if (!testRow || !diagnosis?.proposals?.length) return [];
  const same = db.prepare(
    `SELECT id FROM test_repairs WHERE test_id = ? AND step_order = ? AND change = ? AND before = ?
       AND status IN (${[...OPEN].map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT INTO test_repairs (test_id, test_name, execution_id, step_order, kind, cause, summary, needs_review, change, before, run_options)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  );
  return diagnosis.proposals.map((proposal) => {
    const change = JSON.stringify(proposal.change);
    const before = JSON.stringify(test?.steps?.[proposal.step_order - 1] ?? null);
    return same.get(testRow.id, proposal.step_order, change, before, ...OPEN)?.id ?? insert.get(
      testRow.id, testName, executionId, proposal.step_order, proposal.kind, diagnosis.cause, proposal.summary,
      proposal.needs_review ? 1 : 0, change, before, JSON.stringify(runOptions),
    ).id;
  });
}

/** Repairs by id, in the order given: those a run's diagnosis proposed. */
export function repairsById(ids) {
  return ids.map(getRepair).filter(Boolean);
}

function toRepair(row) {
  if (!row) return null;
  return {
    ...row,
    needs_review: !!row.needs_review,
    change: parseJson(row.change),
    before: parseJson(row.before),
    run_options: parseJson(row.run_options) ?? {},
  };
}

export function getRepair(id) {
  return toRepair(db.prepare('SELECT * FROM test_repairs WHERE id = ?').get(id));
}

/** Repairs of a test, or of one run, newest first; only the open ones with `open`. */
export function listRepairs({ testName, executionId, open } = {}) {
  const where = [];
  const args = [];
  if (testName) { where.push('test_name = ?'); args.push(testName); }
  if (executionId) { where.push('execution_id = ?'); args.push(executionId); }
  if (open) {
    where.push(`status IN (${[...OPEN].map(() => '?').join(', ')})`);
    args.push(...OPEN);
  }
  const sql = `SELECT * FROM test_repairs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 50`;
  return db.prepare(sql).all(...args).map(toRepair);
}

/** `test` with the repair's change made: a copy, the saved test is not touched. */
export function withRepair(test, repair) {
  const steps = [...test.steps];
  const { op, step_order: order, step } = repair.change;
  if (op === 'insert') steps.splice(order - 1, 0, step);
  else steps[order - 1] = step;
  return { ...test, steps };
}

/** Why a repair cannot be acted on now — gone, decided, or its step edited since — or null. */
function refusal(repair, test, allowed) {
  if (!repair) return 'No such repair';
  if (!allowed.has(repair.status)) return `Repair #${repair.id} is ${repair.status}`;
  if (!test) return `Test "${repair.test_name}" no longer exists`;
  if (stepKey(test.steps[repair.step_order - 1]) !== stepKey(repair.before)) {
    return `Step ${repair.step_order} of "${repair.test_name}" has changed since repair #${repair.id} was proposed: run the test again for a new diagnosis`;
  }
  return null;
}

function setStatus(id, status, extra = {}) {
  const decided = ['applied', 'rejected', 'superseded', 'stale'].includes(status);
  db.prepare(
    `UPDATE test_repairs SET status = ?, verify_execution_id = COALESCE(?, verify_execution_id), verify_error = ?,
       decided_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE decided_at END
     WHERE id = ?`
  ).run(status, extra.executionId ?? null, extra.error ?? null, decided ? 1 : 0, id);
}

/**
 * Replay the test with the repair made, without saving it, as the failed run was played
 * (same variables and substitutions). Verified when the whole test passes.
 */
export async function verifyRepair(id, sendCommand) {
  const repair = getRepair(id);
  const test = repair && loadTest(repair.test_name);
  const why = refusal(repair, test, OPEN);
  if (why) {
    if (repair && test && /has changed since/.test(why)) setStatus(id, 'stale');
    throw new Error(why);
  }
  const { executeTest } = await import('./test-execute.js');
  const { variables, substitutions } = repair.run_options;
  try {
    const run = await executeTest(repair.test_name, variables, substitutions, null, true, sendCommand, 'repair', null, null, { test: withRepair(test, repair) });
    setStatus(id, 'verified', { executionId: run.executionId });
    log(`Repair #${id} of "${repair.test_name}" verified by execution #${run.executionId}`);
    return { repair: getRepair(id), passed: true, tabId: run.results?.findLast?.((r) => r.tabId != null)?.tabId };
  } catch (err) {
    setStatus(id, 'failed', { executionId: err.executionId, error: err.message });
    log(`Repair #${id} of "${repair.test_name}" did not fix it: ${err.message}`);
    return { repair: getRepair(id), passed: false, error: err.message, tabId: err.tabId };
  }
}

/** Save the repair into the test. Other open repairs of that step are superseded. */
export function applyRepair(id) {
  const repair = getRepair(id);
  const test = repair && loadTest(repair.test_name);
  const why = refusal(repair, test, APPLICABLE);
  if (why) {
    if (repair && test && /has changed since/.test(why)) setStatus(id, 'stale');
    throw new Error(why);
  }
  const { op, step_order: order, step } = repair.change;
  const apply = db.transaction(() => {
    if (op === 'insert') insertTestStep(repair.test_id, order, step);
    else if (!updateTestStep(repair.test_name, order, step)) throw new Error(`Step ${order} of "${repair.test_name}" not found`);
    setStatus(id, 'applied');
    db.prepare(`UPDATE test_repairs SET status = 'superseded', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE test_id = ? AND step_order = ? AND id != ? AND status IN ('proposed', 'verified', 'failed')`)
      .run(repair.test_id, order, id);
  });
  apply();
  log(`Repair #${id} applied to step ${order} of "${repair.test_name}" (${repair.kind})`);
  return getRepair(id);
}

export function rejectRepair(id) {
  const repair = getRepair(id);
  if (!repair) throw new Error('No such repair');
  if (!OPEN.has(repair.status)) throw new Error(`Repair #${id} is ${repair.status}`);
  setStatus(id, 'rejected');
  return getRepair(id);
}

/** What a repair changes, line by line: `selector: "#old" → "#new"`. */
export function repairDiff(repair) {
  const { op, step } = repair.change;
  if (op === 'insert') return [`insert before step ${repair.step_order}: ${step.command} ${JSON.stringify(step.params ?? {})}`];
  const before = repair.before ?? {};
  const lines = [];
  const changed = (label, was, now) => {
    if (JSON.stringify(was) !== JSON.stringify(now)) lines.push(`${label}: ${JSON.stringify(was ?? null)} → ${JSON.stringify(now ?? null)}`);
  };
  changed('selector', before.params?.selector, step.params?.selector);
  changed('drop target', before.params?.target, step.params?.target);
  changed('assertion selector', before.assertion?.selector, step.assertion?.selector);
  changed('expected', before.assertion?.expected, step.assertion?.expected);
  if (!lines.length && JSON.stringify(before.locators ?? null) !== JSON.stringify(step.locators ?? null)) lines.push('locators updated');
  return lines;
}

/** A repair as the agent reads it: where it stands, what it changes, why. */
export function describeRepair(repair) {
  const verified = repair.verify_execution_id ? ` (execution #${repair.verify_execution_id})` : '';
  const lines = [
    `#${repair.id} [${repair.status}${verified}] "${repair.test_name}" step ${repair.step_order} — ${repair.kind}${repair.needs_review ? ', for a person to judge' : ''}: ${repair.summary}`,
    ...repairDiff(repair).map((line) => `  ${line}`),
  ];
  if (repair.verify_error) lines.push(`  replayed with it, the test still fails: ${repair.verify_error.split('\n')[0]}`);
  return lines.join('\n');
}
