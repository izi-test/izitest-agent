// A saved test, read and changed after it was recorded — by an agent (the tools get_test,
// add_test_step, delete_test_step, update_test_gherkin of lib/tools/test.js; the conversation a
// test page opens with one, lib/agent/test-chat.js) and by the dashboard's own routes
// (lib/api.js), the same way.

import { db, parseJson } from './db.js';
import { loadTest, saveTest, insertTestStep } from './test-store.js';
import { withElementNames, elementTargets } from './element-store.js';
import { stepsForEditedFeature } from './gherkin/reconcile.js';
import { examplesOf } from './gherkin/parse.js';
import { rowsFromExamples } from './gherkin/outline.js';
import { datasetOfTest, testRows, saveTestRows, rowsOfTest, rowsSource } from './datasets.js';
import { lastRunOfTest } from './test-status.js';
import { listRepairs } from './repairs.js';

/** A project's step definitions, in the order the Gherkin parser and serializer read them. */
export function projectDefinitions(projectId) {
  return db.prepare('SELECT * FROM step_definitions WHERE project_id = ?').all(projectId).map((r) => ({
    ...r,
    params_template: parseJson(r.params_template) || {},
    steps_template: parseJson(r.steps_template) || null,
  }));
}

const short = (value, max = 80) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** What a step acts on, as a person and an agent name it: its element's name, then how it is found. */
function targetOf(step) {
  const css = (step.locators ?? []).find((locator) => locator.type === 'css')?.value;
  const found = step.params?.selector || css || (step.params?.text ? `text "${step.params.text}"` : '');
  if (step.element) return `on "${step.element}"${found ? ` (${short(found, 60)})` : ''}`;
  return found ? `on ${short(found, 60)}` : '';
}

/** One step as a line: what it does, on what, with which value. */
function stepLine(step, number) {
  const parts = [step.command];
  if (step.intent) parts.push(`"${short(step.intent, 120)}"`);
  if (step.command === 'assert' && step.assertion) {
    const { type, selector, expected, attribute } = step.assertion;
    parts.push([type, selector && `on ${short(selector, 60)}`, attribute && `attribute ${attribute}`, expected !== undefined && expected !== '' && `expects "${short(expected)}"`].filter(Boolean).join(' '));
  } else {
    const target = targetOf(step);
    if (target) parts.push(target);
    if (step.params?.url) parts.push(`url ${short(step.params.url, 120)}`);
    if (step.params?.value !== undefined && step.params.value !== '') parts.push(`value "${short(step.params.value)}"`);
    if (step.params?.key) parts.push(`key ${step.params.key}`);
    if (step.command === 'wait' && step.params?.ms && !step.params?.selector) parts.push(`${step.params.ms} ms`);
  }
  if (step.variable?.name) parts.push(`variable {{${step.variable.name}}}`);
  if (step.optional) parts.push('optional');
  return `  ${number}. ${parts.join(' · ')}`;
}

/**
 * The test as it is now, for an agent to read before it changes it: its steps numbered — the
 * numbers fix_test_step, add_test_step, delete_test_step, add_assertion and set_step_optional
 * take —, its variables, the rows it plays, how its last run went and the repairs proposed.
 * Null when there is no such test.
 */
export function testText(name) {
  const test = loadTest(name);
  if (!test) return null;
  const row = db.prepare('SELECT id, updated_at FROM tests WHERE name = ?').get(name);
  const project = test.project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(test.project_id) : null;
  const { steps } = withElementNames(test);
  const lines = [
    `Test "${test.name}"${project ? ` — project "${project.name}" (project_id ${test.project_id})` : ' — in no project'} — ${steps.length} step${steps.length === 1 ? '' : 's'}`,
  ];
  if (test.description) lines.push(`Description: ${short(test.description, 300)}`);
  lines.push('Steps:', ...(steps.length ? steps.map((step, i) => stepLine(step, i + 1)) : ['  (none)']));

  const variables = Object.entries(test.variables ?? {});
  if (variables.length) {
    lines.push('Variables:', ...variables.map(([key, info]) => `  {{${key}}} — ${info?.type ?? 'text'}, default "${short(info?.defaultValue ?? '')}"`));
  }
  const played = rowsOfTest(name);
  if (played) lines.push(`Rows: ${played.row_count} of ${rowsSource(played)} (${played.columns.join(', ')}) — a run plays every row, a run each`);

  const last = lastRunOfTest(row.id);
  if (!last) {
    lines.push('Last run: never run.');
  } else {
    const failed = db.prepare("SELECT step_order, command, error FROM execution_steps WHERE execution_id = ? AND status = 'failed' ORDER BY step_order LIMIT 1").get(last.id);
    lines.push(`Last run: ${last.status === 'success' ? 'passed' : last.status} (run #${last.id}, ${last.started_at})${failed ? ` — step ${failed.step_order} (${failed.command}) failed: ${short(failed.error, 240)}` : ''}`);
    if (last.rows?.failed?.length) lines.push(`  Rows failed: ${last.rows.failed.join(', ')} of ${last.rows.total}`);
  }
  const repairs = listRepairs({ testName: name, open: true });
  if (repairs.length) {
    lines.push('Repairs proposed (list_repairs tells each whole):', ...repairs.map((r) => `  #${r.id} [${r.status}] step ${r.step_order} — ${short(r.summary, 200)}`));
  }
  return lines.join('\n');
}

/**
 * Adds `step` to a test at `stepOrder` (1-indexed) — the step now there, and those after it,
 * move down by one; without it, or past the end, at the end. { order, count }: where it went
 * and how many steps the test has now. Null when there is no such test.
 */
export function addTestStep(testName, stepOrder, step) {
  const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(testName);
  if (!test) return null;
  const { last } = db.prepare('SELECT COALESCE(MAX(step_order), 0) AS last FROM test_steps WHERE test_id = ?').get(test.id);
  const order = Number.isInteger(stepOrder) && stepOrder >= 1 ? Math.min(stepOrder, last + 1) : last + 1;
  insertTestStep(test.id, order, step);
  return { order, count: last + 1 };
}

/**
 * Deletes step `stepOrder` (1-indexed) of a test: the steps after it move up by one, and the
 * variables told by a later step with them. The step deleted ({ command, intent }), or null
 * when the test or the step is not there.
 */
export function deleteTestStep(testName, stepOrder) {
  const test = db.prepare('SELECT id, variables FROM tests WHERE name = ?').get(testName);
  if (!test) return null;
  return db.transaction(() => {
    const step = db.prepare('SELECT command, intent FROM test_steps WHERE test_id = ? AND step_order = ?').get(test.id, stepOrder);
    if (!step) return null;
    db.prepare('DELETE FROM test_steps WHERE test_id = ? AND step_order = ?').run(test.id, stepOrder);
    db.prepare('UPDATE test_steps SET step_order = step_order - 1 WHERE test_id = ? AND step_order > ?').run(test.id, stepOrder);
    const variables = parseJson(test.variables) ?? {};
    for (const variable of Object.values(variables)) if (variable?.step > stepOrder) variable.step -= 1;
    db.prepare("UPDATE tests SET variables = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(JSON.stringify(variables), test.id);
    return { command: step.command, intent: step.intent };
  })();
}

/**
 * Rewrites a test's steps from its Gherkin, edited. A phrase left as it was keeps its step
 * whole (its locators, its variable, its intent); a new one reads as a phrase of the project —
 * one that does not is refused, and nothing is saved. The Examples of a Scenario Outline are
 * the rows the test plays: its own, saved with it; those of a dataset it is bound to are the
 * dataset's, and cannot be changed here.
 * Returns { step_count, row_count, variables_added? } or { error, status, errors? }.
 */
export function updateTestFeature(testName, featureText) {
  if (typeof featureText !== 'string' || !featureText.trim()) return { status: 400, error: 'feature (string) is required' };
  const existing = loadTest(testName);
  if (!existing) return { status: 404, error: 'Test not found' };
  const projectId = existing.project_id;
  if (!projectId) return { status: 400, error: 'Test is not assigned to a project; assign it first to use Gherkin' };

  let steps;
  let examples;
  try {
    // Unchanged phrases keep their steps whole: list variables, intents, locators.
    // A name of an element reads back as that element.
    steps = stepsForEditedFeature(featureText, projectDefinitions(projectId), withElementNames(existing), { targets: elementTargets(projectId) });
    examples = examplesOf(featureText);
  } catch (err) {
    if (err.code === 'GHERKIN_UNRESOLVED') return { status: 422, error: err.message, errors: err.errors };
    return { status: 400, error: err.message };
  }
  // The Examples of a Scenario Outline are the rows it plays: its own, saved with it. Bound
  // to a dataset, they are the dataset's: changed there, not here.
  const bound = datasetOfTest(existing.name);
  const own = testRows(existing.name);
  let rows = null;
  if (examples) {
    rows = rowsFromExamples(examples, bound ? bound.rows : own);
    const shown = (i, column) => String(bound?.rows[i]?.[column] ?? existing.variables?.[column]?.defaultValue ?? '');
    if (bound && (rows.length !== bound.rows.length || rows.some((row, i) => Object.entries(row).some(([column, value]) => value !== shown(i, column))))) {
      return { status: 400, error: `Its rows are those of the dataset "${bound.name}": change them in Datasets, or unbind it (Data tab) to type rows of the test's own` };
    }
  }

  saveTest({ ...existing, steps });
  let saved = { rows: own, added: [] };
  if (!bound) {
    // A Scenario, from an Outline: its rows are gone. One row is shown as a Scenario: kept.
    if (examples) saved = saveTestRows(existing.name, rows, { addVariables: true });
    else if (own.length > 1) saved = saveTestRows(existing.name, []);
    if (saved.error) return { status: saved.status, error: `Steps saved, not the rows: ${saved.error}` };
  }
  return { step_count: steps.length, row_count: saved.rows?.length ?? 0, ...(saved.added?.length ? { variables_added: saved.added } : {}) };
}
