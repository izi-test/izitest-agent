// Requirements: what tests are for. One comes from a prompt (a developer's "test that a wrong
// password is refused"), is written in the dashboard by a tester, or is imported from a tool
// (a Jira story) — the same record whatever its source: a key, a title, a description, its
// acceptance criteria, and the test cases that cover them. A case is planned first (its
// title, the criterion it checks, what kind of case it is), then linked to the test that
// checks it. Coverage is read from those links and from each test's last run.

import { createHash } from 'node:crypto';
import { db } from './db.js';
import { log } from './logger.js';

export const SOURCES = ['prompt', 'manual', 'jira', 'import'];
export const PRIORITIES = ['high', 'medium', 'low'];
// The kinds of case a requirement is tested with: the expected path, another way through,
// an error the app must handle, a value at the edge of what is allowed.
export const CASE_KINDS = ['nominal', 'alternative', 'error', 'boundary'];

/** What makes two versions of a requirement the same: its title, description and criteria. */
export function contentHash({ title, description, criteria }) {
  return createHash('sha256').update(JSON.stringify([title ?? '', description ?? '', criteria ?? []])).digest('hex').slice(0, 16);
}

/** A requirement row by its key ("REQ-12", "SHOP-123") or its id ("12", 12). */
function rowOf(ref) {
  if (ref == null || ref === '') return null;
  return db.prepare('SELECT * FROM requirements WHERE key = ?').get(String(ref))
    ?? (/^\d+$/.test(String(ref)) ? db.prepare('SELECT * FROM requirements WHERE id = ?').get(Number(ref)) : null);
}

/**
 * Save a requirement: a new one, or — same key — the one already there, updated. Its
 * criteria are replaced by `criteria` (texts, or `{ id, text }` to keep a criterion and the
 * cases that check it). A requirement with no key of its own is REQ-<id>. The requirement,
 * whether it is new, and whether its content changed.
 */
export function saveRequirement({ key, title, description = '', criteria = [], source = 'manual', url = null, projectId = null, priority = 'medium' }) {
  if (!title?.trim()) throw new Error('A requirement needs a title');
  if (!SOURCES.includes(source)) throw new Error(`No such source: ${source}`);
  if (!PRIORITIES.includes(priority)) throw new Error(`No such priority: ${priority}`);
  const items = criteria.map((c) => (typeof c === 'string' ? { text: c } : c)).filter((c) => c.text?.trim());
  const hash = contentHash({ title: title.trim(), description, criteria: items.map((c) => c.text.trim()) });
  const known = key ? rowOf(key) : null;

  return db.transaction(() => {
    let id = known?.id;
    if (known) {
      db.prepare(`UPDATE requirements SET title = ?, description = ?, source = ?, external_url = ?, project_id = COALESCE(?, project_id),
                    priority = ?, content_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(title.trim(), description, source, url, projectId, priority, hash, id);
    } else {
      id = db.prepare(`INSERT INTO requirements (key, project_id, title, description, source, external_url, priority, content_hash)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(key ?? null, projectId, title.trim(), description, source, url, priority, hash).id;
      if (!key) db.prepare('UPDATE requirements SET key = ? WHERE id = ?').run(`REQ-${id}`, id);
    }
    replaceCriteria(id, items);
    return { requirement: getRequirement(id), isNew: !known, changed: !!known && known.content_hash !== hash };
  })();
}

/**
 * The requirement's criteria become `items`, in order. One given an id, or with the text of
 * one already there, is kept with the cases that check it: saved again as texts (a story
 * imported again), the criteria that did not change keep their tests.
 */
function replaceCriteria(requirementId, items) {
  const rows = db.prepare('SELECT id, text FROM acceptance_criteria WHERE requirement_id = ?').all(requirementId);
  const existing = rows.map((r) => r.id);
  const byText = new Map(rows.map((r) => [r.text.trim().toLowerCase(), r.id]));
  for (const item of items) if (item.id == null) item.id = byText.get(item.text.trim().toLowerCase());
  const kept = new Set(items.map((c) => c.id).filter((id) => existing.includes(id)));
  for (const id of existing) if (!kept.has(id)) db.prepare('DELETE FROM acceptance_criteria WHERE id = ?').run(id);
  items.forEach((item, i) => {
    if (kept.has(item.id)) db.prepare('UPDATE acceptance_criteria SET text = ?, position = ? WHERE id = ?').run(item.text.trim(), i + 1, item.id);
    else db.prepare('INSERT INTO acceptance_criteria (requirement_id, position, text) VALUES (?, ?, ?)').run(requirementId, i + 1, item.text.trim());
  });
}

export function deleteRequirement(ref) {
  const row = rowOf(ref);
  if (!row) throw new Error(`No requirement ${ref}`);
  db.prepare('DELETE FROM requirements WHERE id = ?').run(row.id);
  return row;
}

/** The last run of a test that says how it does: not a repair being checked, nor a bug's confirmation. */
const lastRunOf = (testId) => db.prepare(
  `SELECT id, status, started_at FROM test_executions WHERE test_id = ? AND trigger NOT IN ('repair', 'explore') ORDER BY id DESC LIMIT 1`
).get(testId) ?? null;

/**
 * Where a requirement stands, from its criteria and cases:
 * - not_covered: a criterion has no test (or, with no criteria, nothing is linked yet);
 * - failing: a linked test failed its last run;
 * - not_run: a linked test never ran;
 * - passing: every criterion is covered and every test passed.
 */
export function coverageOf(criteria, cases) {
  const tested = cases.filter((c) => c.test);
  const uncovered = criteria.filter((criterion) => !tested.some((c) => c.criterion_id === criterion.id));
  const runs = tested.map((c) => c.last_run?.status ?? null);
  const status = runs.includes('failed') ? 'failing'
    : (criteria.length ? uncovered.length > 0 : tested.length === 0) ? 'not_covered'
      : runs.includes(null) ? 'not_run'
        : 'passing';
  return {
    status,
    criteria: criteria.length,
    covered: criteria.length - uncovered.length,
    tests: new Set(tested.map((c) => c.test)).size,
    planned: cases.filter((c) => !c.test).length,
  };
}

/** A requirement with its criteria, its cases (their test and its last run) and its coverage. */
export function getRequirement(ref) {
  const row = rowOf(ref);
  if (!row) return null;
  const criteria = db.prepare('SELECT id, position, text FROM acceptance_criteria WHERE requirement_id = ? ORDER BY position').all(row.id);
  const cases = db.prepare(
    `SELECT c.id, c.criterion_id, c.title, c.kind, c.position, t.name AS test, t.id AS test_id
     FROM requirement_cases c LEFT JOIN tests t ON t.id = c.test_id
     WHERE c.requirement_id = ? ORDER BY c.position, c.id`
  ).all(row.id).map((c) => ({ ...c, last_run: c.test_id ? lastRunOf(c.test_id) : null }));
  return { ...row, criteria, cases, coverage: coverageOf(criteria, cases) };
}

/** Requirements, newest first, each with its coverage: of a project, or all. */
export function listRequirements({ projectId } = {}) {
  const rows = projectId
    ? db.prepare('SELECT id FROM requirements WHERE project_id = ? ORDER BY id DESC').all(projectId)
    : db.prepare('SELECT id FROM requirements ORDER BY id DESC').all();
  return rows.map((r) => getRequirement(r.id));
}

/** The criterion of a requirement by its number (1-based, as listed) or its id. */
function criterionOf(requirement, criterion) {
  if (criterion == null || criterion === '') return null;
  const n = Number(criterion);
  const found = requirement.criteria.find((c) => c.position === n) ?? requirement.criteria.find((c) => c.id === n);
  if (!found) throw new Error(`${requirement.key} has no criterion ${criterion} (it has ${requirement.criteria.length})`);
  return found;
}

/** Plan test cases for a requirement: what to test, for which criterion, which kind. Not tests yet. */
export function planCases(ref, cases) {
  const requirement = getRequirement(ref);
  if (!requirement) throw new Error(`No requirement ${ref}`);
  const next = requirement.cases.reduce((max, c) => Math.max(max, c.position), 0);
  const insert = db.prepare('INSERT INTO requirement_cases (requirement_id, criterion_id, title, kind, position) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    cases.forEach((c, i) => {
      const kind = c.kind ?? 'nominal';
      if (!CASE_KINDS.includes(kind)) throw new Error(`No such case kind: ${kind}`);
      if (!c.title?.trim()) throw new Error('A case needs a title');
      insert.run(requirement.id, criterionOf(requirement, c.criterion)?.id ?? null, c.title.trim(), kind, next + i + 1);
    });
  })();
  return getRequirement(requirement.id);
}

/**
 * Link a test to a requirement: to a planned case (`caseId`), or as a case of its own — for
 * a criterion, or the whole requirement. Linked already in that place: left as it is.
 */
export function linkTest(ref, testName, { criterion = null, caseId = null, kind = 'nominal', title = null } = {}) {
  const requirement = getRequirement(ref);
  if (!requirement) throw new Error(`No requirement ${ref}`);
  const test = db.prepare('SELECT id, name FROM tests WHERE name = ?').get(testName);
  if (!test) throw new Error(`No test "${testName}"`);
  if (caseId != null) {
    const planned = requirement.cases.find((c) => c.id === Number(caseId));
    if (!planned) throw new Error(`${requirement.key} has no case #${caseId}`);
    db.prepare('UPDATE requirement_cases SET test_id = ? WHERE id = ?').run(test.id, planned.id);
  } else {
    const criterionId = criterionOf(requirement, criterion)?.id ?? null;
    const already = requirement.cases.some((c) => c.test_id === test.id && c.criterion_id === criterionId);
    if (!already) {
      if (!CASE_KINDS.includes(kind)) throw new Error(`No such case kind: ${kind}`);
      const next = requirement.cases.reduce((max, c) => Math.max(max, c.position), 0) + 1;
      db.prepare('INSERT INTO requirement_cases (requirement_id, criterion_id, title, kind, test_id, position) VALUES (?, ?, ?, ?, ?, ?)')
        .run(requirement.id, criterionId, title?.trim() || test.name, kind, test.id, next);
    }
  }
  // A test recorded for a project's requirement belongs to that project, if to none yet.
  if (requirement.project_id) db.prepare('UPDATE tests SET project_id = ? WHERE id = ? AND project_id IS NULL').run(requirement.project_id, test.id);
  log(`Test "${testName}" linked to ${requirement.key}`);
  return getRequirement(requirement.id);
}

/** Remove a case: planned, it is gone; linked, its test stays, only the link goes. */
export function deleteCase(caseId) {
  const row = db.prepare('SELECT requirement_id FROM requirement_cases WHERE id = ?').get(caseId);
  if (!row) throw new Error(`No case #${caseId}`);
  db.prepare('DELETE FROM requirement_cases WHERE id = ?').run(caseId);
  return getRequirement(row.requirement_id);
}

/** What a test checks: each requirement it is linked to, with the criteria it covers there. */
export function requirementsOfTest(testName) {
  const rows = db.prepare(
    `SELECT r.id, r.key, r.title, a.position AS criterion, a.text AS criterion_text, c.kind
     FROM requirement_cases c JOIN tests t ON t.id = c.test_id JOIN requirements r ON r.id = c.requirement_id
     LEFT JOIN acceptance_criteria a ON a.id = c.criterion_id
     WHERE t.name = ? ORDER BY r.id, a.position`
  ).all(testName);
  const byKey = new Map();
  for (const row of rows) {
    const entry = byKey.get(row.key) ?? { id: row.id, key: row.key, title: row.title, criteria: [] };
    if (row.criterion) entry.criteria.push({ number: row.criterion, text: row.criterion_text, kind: row.kind });
    byKey.set(row.key, entry);
  }
  return [...byKey.values()];
}

/** Link a recording's test to the requirement it was started for; what to tell the agent. */
export function linkRecorded(recording) {
  if (!recording.link) return '';
  try {
    const { key } = linkTest(recording.link.requirement, recording.name, recording.link);
    return `\nLinked to ${key}${recording.link.caseId ? `, case #${recording.link.caseId}` : recording.link.criterion ? `, criterion ${recording.link.criterion}` : ''}.`;
  } catch (err) {
    return `\nNot linked to ${recording.link.requirement}: ${err.message}`;
  }
}

const STATUS_LABELS = { passing: 'passing', failing: 'FAILING', not_run: 'not run yet', not_covered: 'not covered' };

/** A requirement as the agent reads it: criteria, the cases of each, coverage. */
export function formatRequirement(requirement) {
  const { coverage } = requirement;
  const lines = [
    `${requirement.key} — ${requirement.title} [${requirement.source}, ${requirement.priority}]${requirement.external_url ? ` ${requirement.external_url}` : ''}`,
    `Coverage: ${STATUS_LABELS[coverage.status]} — ${coverage.criteria ? `${coverage.covered}/${coverage.criteria} criteria covered, ` : ''}${coverage.tests} test(s)${coverage.planned ? `, ${coverage.planned} case(s) planned, not recorded yet` : ''}`,
  ];
  if (requirement.description) lines.push(`  ${requirement.description.split('\n').join('\n  ')}`);
  const caseLine = (c) => `      case #${c.id} (${c.kind}) ${c.title}: ${c.test ? `test "${c.test}" — ${c.last_run ? c.last_run.status : 'never run'}` : 'planned'}`;
  for (const criterion of requirement.criteria) {
    lines.push(`  ${criterion.position}. ${criterion.text}`);
    for (const c of requirement.cases.filter((x) => x.criterion_id === criterion.id)) lines.push(caseLine(c));
  }
  const whole = requirement.cases.filter((c) => c.criterion_id == null);
  if (whole.length) {
    lines.push('  (the whole requirement)');
    for (const c of whole) lines.push(caseLine(c));
  }
  return lines.join('\n');
}
