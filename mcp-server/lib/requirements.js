// Requirements: what tests are for. One comes from a prompt (a developer's "test that a wrong
// password is refused"), is written in the dashboard by a tester, or is imported from a file or
// a tool (a Jira story, a GitHub issue: lib/connectors) — the same record whatever its source: a key, a title, a description, its
// acceptance criteria, and the test cases that cover them. A case is planned first (its
// title, the criterion it checks, what kind of case it is), then linked to the test that
// checks it. Coverage is read from those links and from each test's last run.

import { createHash } from 'node:crypto';
import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { keywordsOf } from './gherkin/language.js';
import { projectLanguage } from './gherkin/step-definition-store.js';

// Where a requirement comes from: a request, a person, a file — or a tool, by the id of its
// connector (lib/connectors: jira, github…).
export const SOURCES = ['prompt', 'manual', 'import'];
const SOURCE = /^[a-z][a-z0-9_-]*$/;
export const PRIORITIES = ['high', 'medium', 'low'];
// The kinds of case a requirement is tested with: the expected path, another way through,
// an error the app must handle, a value at the edge of what is allowed.
export const CASE_KINDS = ['nominal', 'alternative', 'error', 'boundary'];
// How a case was found (lib/requirement-design.js): the expected path and other ways through,
// one value per class of inputs that behave the same, the values at a limit, the combinations
// of conditions that change the result, the moves between states, what usually goes wrong.
export const TECHNIQUES = ['use_case', 'equivalence_partitioning', 'boundary_values', 'decision_table', 'state_transition', 'error_guessing'];

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
  if (!SOURCE.test(String(source))) throw new Error(`No such source: ${source} (${SOURCES.join(', ')}, or a connector's id)`);
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

/**
 * A requirement with its criteria, its cases (their test and its last run) and its coverage —
 * and the last test design proposed for it, stale once its content changed since.
 */
export function getRequirement(ref) {
  const row = rowOf(ref);
  if (!row) return null;
  const criteria = db.prepare('SELECT id, position, text FROM acceptance_criteria WHERE requirement_id = ? ORDER BY position').all(row.id);
  const cases = db.prepare(
    `SELECT c.id, c.criterion_id, c.title, c.kind, c.technique, c.priority, c.rationale, c.gherkin, c.position, t.name AS test, t.id AS test_id
     FROM requirement_cases c LEFT JOIN tests t ON t.id = c.test_id
     WHERE c.requirement_id = ? ORDER BY c.position, c.id`
  ).all(row.id).map((c) => ({ ...c, last_run: c.test_id ? lastRunOf(c.test_id) : null }));
  const design = parseJson(row.design);
  return {
    ...row, design, design_stale: !!design && design.content_hash !== row.content_hash,
    criteria, cases, coverage: coverageOf(criteria, cases),
  };
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

/**
 * A case's scenario as a whole feature, the way it is parsed and created from: given as a
 * scenario alone (its steps, or "Scenario:" and its steps), it is put in a Feature named
 * after the requirement, and a Scenario named after the case. Empty: null.
 */
export function scenarioFeature(gherkin, featureTitle, scenarioTitle, language = 'en') {
  const text = gherkin?.trim();
  if (!text) return null;
  if (/^\s*(Feature|Fonctionnalité):/m.test(text) || /^#\s*language:/.test(text)) return `${text}\n`;
  // In the language of the project's tests: a French one starts with # language: fr.
  const words = keywordsOf(language);
  const indent = (block, by) => block.split('\n').map((line) => (line.trim() ? `${by}${line.trim()}` : '')).join('\n');
  const [, head, steps] = text.match(/^\s*((?:Scenario(?: Outline)?|Scénario|Plan du scénario|Exemple):.*)\n?([\s\S]*)$/mi)
    ?? [null, `${words.scenario}: ${scenarioTitle}`, text];
  return `${words.header ? `${words.header}\n` : ''}${words.feature}: ${featureTitle}\n\n  ${head.trim()}\n${indent(steps, '    ')}\n`;
}

/** A case's fields checked: kind, technique, priority — what a planned case or an edit gives. */
function caseFields(requirement, c) {
  const kind = c.kind ?? 'nominal';
  if (!CASE_KINDS.includes(kind)) throw new Error(`No such case kind: ${kind}`);
  if (c.technique != null && !TECHNIQUES.includes(c.technique)) throw new Error(`No such technique: ${c.technique} (${TECHNIQUES.join(', ')})`);
  if (c.priority != null && !PRIORITIES.includes(c.priority)) throw new Error(`No such priority: ${c.priority}`);
  if (!c.title?.trim()) throw new Error('A case needs a title');
  return {
    title: c.title.trim(), kind, technique: c.technique ?? null, priority: c.priority ?? null,
    rationale: c.rationale?.trim() || null, gherkin: scenarioFeature(c.gherkin, requirement.title, c.title.trim(), projectLanguage(requirement.project_id)),
  };
}

/**
 * Plan test cases for a requirement: what to test, for which criterion, which kind — and,
 * designed (lib/requirement-design.js), with which technique, its priority, why, and its
 * scenario in Gherkin. Not tests yet.
 */
export function planCases(ref, cases) {
  const requirement = getRequirement(ref);
  if (!requirement) throw new Error(`No requirement ${ref}`);
  const next = requirement.cases.reduce((max, c) => Math.max(max, c.position), 0);
  const insert = db.prepare(`INSERT INTO requirement_cases (requirement_id, criterion_id, title, kind, technique, priority, rationale, gherkin, position)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    cases.forEach((c, i) => {
      const f = caseFields(requirement, c);
      insert.run(requirement.id, criterionOf(requirement, c.criterion)?.id ?? null, f.title, f.kind, f.technique, f.priority, f.rationale, f.gherkin, next + i + 1);
    });
  })();
  return getRequirement(requirement.id);
}

/** Change a case: its title, kind, technique, priority, scenario — what `changes` gives. */
export function updateCase(caseId, changes) {
  const row = db.prepare('SELECT * FROM requirement_cases WHERE id = ?').get(caseId);
  if (!row) throw new Error(`No case #${caseId}`);
  const requirement = getRequirement(row.requirement_id);
  const f = caseFields(requirement, { ...row, ...changes, title: changes.title ?? row.title });
  db.prepare('UPDATE requirement_cases SET title = ?, kind = ?, technique = ?, priority = ?, rationale = ?, gherkin = ? WHERE id = ?')
    .run(f.title, f.kind, f.technique, f.priority, f.rationale, f.gherkin, row.id);
  return getRequirement(row.requirement_id);
}

/** Keep the test design an agent proposed for a requirement (null: none any more). */
export function saveDesign(ref, design) {
  const row = rowOf(ref);
  if (!row) throw new Error(`No requirement ${ref}`);
  db.prepare('UPDATE requirements SET design = ? WHERE id = ?').run(design ? JSON.stringify(design) : null, row.id);
  return getRequirement(row.id);
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

/**
 * Whether an assertion that failed is kept as a non-conformity: the agent says so, the test
 * checks a requirement, and the element is there — not found, it is a wrong selector, the
 * test's mistake. A click that missed its button leaves the page as it was: the agent says
 * so only once it checked the steps before did what they should.
 */
export function nonConformityOf(testName, result, claimed) {
  const requirements = requirementsOfTest(testName);
  // Not found, or not evaluated at all ("Error: …"): nothing says what the page shows.
  const elementFound = !/not found|^Error: /i.test(String(result.actual ?? ''));
  return { requirements, elementFound, nonConformity: !result.passed && claimed === true && requirements.length > 0 && elementFound };
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

/** What a planned case's scenario lets the agent do: create the test from it, or record the steps no phrase covers. */
function plannedScenario(c) {
  if (!c.gherkin) return '';
  const r = c.resolution;
  if (!r) return ', scenario written';
  if (r.error) return `, scenario does not parse: ${r.error}`;
  return r.ready ? ', scenario ready: create_test_from_gherkin'
    : `, scenario has ${r.unresolved.length} step(s) no phrase covers (${r.unresolved.map((u) => `"${u}"`).join(', ')}): record it`;
}

/** A requirement as the agent reads it: criteria, the cases of each, coverage. */
export function formatRequirement(requirement) {
  const { coverage } = requirement;
  const lines = [
    `${requirement.key} — ${requirement.title} [${requirement.source}, ${requirement.priority}]${requirement.external_url ? ` ${requirement.external_url}` : ''}`,
    `Coverage: ${STATUS_LABELS[coverage.status]} — ${coverage.criteria ? `${coverage.covered}/${coverage.criteria} criteria covered, ` : ''}${coverage.tests} test(s)${coverage.planned ? `, ${coverage.planned} case(s) planned, not recorded yet` : ''}`,
  ];
  if (requirement.description) lines.push(`  ${requirement.description.split('\n').join('\n  ')}`);
  const caseLine = (c) => `      case #${c.id} (${[c.kind, c.technique, c.priority].filter(Boolean).join(', ')}) ${c.title}: `
    + (c.test ? `test "${c.test}" — ${c.last_run ? c.last_run.status : 'never run'}` : `planned${plannedScenario(c)}`);
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
