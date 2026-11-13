// The elements of a project, kept (lib/elements.js says what an element is): registered as
// the steps acting on them are seen, named, renamed by the user, listed with their uses.
//
// An element is known by every key and mark its steps gave it (element_keys): the same field
// recorded by its label in one test and by its selector in another is one element as soon as
// a step shows both, or two steps of its page share its id, test ID, name or placeholder —
// merged then, under the name the user gave one of them. Marks never merge two elements a
// person reads under two names: the "Next" and the "Finish" of a wizard can share an id.
//
// Each step keeps its own copy of how it finds its element (selector, locators): a replay reads
// the step alone, an export too. When one changes — a repair applied, a step edited in the
// dashboard —, the other steps acting on the same element are given the same on the user's
// word (relocateElement), and the element keeps its name under its new key.

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { elementKey, marksOf, nameInKey, baseName, uniqueName, selectorOf, foundLike, findsDifferently } from './elements.js';

const isMark = (identity, page) => identity.slice(page.length + 1).startsWith('~');

/** What is known of a project's elements: each by id, and the element of each key or mark. */
function loadIndex(projectId) {
  return {
    projectId,
    elements: new Map(db.prepare('SELECT id, key, name, page, renamed FROM elements WHERE project_id = ?').all(projectId).map((row) => [row.id, row])),
    elementOf: new Map(db.prepare('SELECT key, element_id FROM element_keys WHERE project_id = ?').all(projectId).map((row) => [row.key, row.element_id])),
  };
}

const nameOf = (row) => nameInKey(row.key, row.page);
const byCss = (row) => (row.key.slice(row.page.length + 1).startsWith('css ') ? 1 : 0);

/**
 * Which of elements merged stays: the one the user named, else `preferred` (the element a
 * repaired step acted on: it keeps its name), else one a person reads a name on, else the oldest.
 */
function survivorOf(index, ids, preferred = null) {
  return ids.map((id) => index.elements.get(id))
    .sort((a, b) => (b.renamed - a.renamed) || ((b.id === preferred) - (a.id === preferred)) || (byCss(a) - byCss(b)) || (a.id - b.id))[0].id;
}

/** Element `from` is `into`: its keys and marks are `into`'s, its row goes. */
function merge(index, from, into) {
  const gone = index.elements.get(from);
  db.prepare('UPDATE element_keys SET element_id = ? WHERE element_id = ?').run(into, from);
  db.prepare('DELETE FROM elements WHERE id = ?').run(from);
  for (const [identity, id] of index.elementOf) if (id === from) index.elementOf.set(identity, into);
  index.elements.delete(from);
  log(`Element "${gone.name}" merged into "${index.elements.get(into).name}" (project #${index.projectId})`);
}

/**
 * The element `step` acts on, registered: the one its key or a mark is known by — several
 * merged into one when they are several —, else a new one named after what a person reads
 * on it. `joined`: elements known to be this one whatever their names (the element a step
 * acted on before it was repaired). Its id; null when the step acts on no element.
 */
function attach(index, step, joined = []) {
  const key = elementKey(step);
  if (!key) return null;
  const marks = marksOf(step);
  const valid = (id) => index.elements.has(id);
  const own = [...joined, index.elementOf.get(key)].filter(valid);
  // A mark joins an element read under the same name, or under none.
  let named = nameInKey(key, step.page) ?? own.map((id) => nameOf(index.elements.get(id))).find(Boolean) ?? null;
  const byMarks = [];
  for (const id of marks.map((mark) => index.elementOf.get(mark)).filter(valid)) {
    const name = nameOf(index.elements.get(id));
    if (named && name && name !== named) continue;
    named ??= name;
    byMarks.push(id);
  }
  const hits = [...new Set([...own, ...byMarks])];

  let id;
  if (hits.length) {
    id = survivorOf(index, hits, joined.find(valid));
    for (const other of hits) if (other !== id) merge(index, other, id);
    // Known by a selector alone until now, and not named by the user: named after what a
    // person reads on it, as if this step had been recorded first.
    const row = index.elements.get(id);
    if (!row.renamed && byCss(row) && nameInKey(key, step.page)) {
      const taken = new Set([...index.elements.values()].filter((other) => other.id !== id).map((other) => other.name));
      const name = uniqueName(baseName(step), step.page, taken);
      db.prepare('UPDATE elements SET key = ?, name = ? WHERE id = ?').run(key, name, id);
      Object.assign(row, { key, name });
    }
  } else {
    const taken = new Set([...index.elements.values()].map((row) => row.name));
    const row = db.prepare('INSERT INTO elements (project_id, key, name, page) VALUES (?, ?, ?, ?) RETURNING id, key, name, page, renamed')
      .get(index.projectId, key, uniqueName(baseName(step), step.page, taken), step.page);
    index.elements.set(row.id, row);
    id = row.id;
  }
  for (const identity of [key, ...marks]) {
    const current = index.elementOf.get(identity);
    // A mark another element, named otherwise, already has stays with it.
    if (current === id || (valid(current) && isMark(identity, step.page))) continue;
    db.prepare(`INSERT INTO element_keys (project_id, key, element_id) VALUES (?, ?, ?)
                ON CONFLICT (project_id, key) DO UPDATE SET element_id = excluded.element_id`).run(index.projectId, identity, id);
    index.elementOf.set(identity, id);
  }
  return id;
}

/** Each key and mark of a project with the name of its element. */
const namesOf = (index) => new Map([...index.elementOf]
  .filter(([, id]) => index.elements.has(id))
  .map(([identity, id]) => [identity, index.elements.get(id).name]));

/**
 * The elements `steps` act on, registered in `projectId` when they are not yet, merged when a
 * step shows two are one: a Map from each key to the name of its element. A new element is
 * named after what a person reads on it.
 */
export function registerElements(projectId, steps) {
  return db.transaction(() => {
    const index = loadIndex(projectId);
    for (const step of steps) attach(index, step);
    return namesOf(index);
  })();
}

/**
 * The elements of every project, registered from all their steps — at start: an element
 * registered before its marks were kept is merged with the others its steps show it is.
 */
export function registerAllElements() {
  for (const { id } of db.prepare('SELECT id FROM projects').all()) registerElements(id, projectSteps(id));
}

/** `test`, each step with the name of its element (`element`): what the dashboard's Gherkin says. */
export function withElementNames(test) {
  if (!test?.project_id) return test;
  const names = registerElements(test.project_id, test.steps ?? []);
  return {
    ...test,
    steps: (test.steps ?? []).map((step) => {
      const name = names.get(elementKey(step));
      return name ? { ...step, element: name } : step;
    }),
  };
}

/** The steps of a project's tests, in the order they were last saved, each with its test and order. */
function projectSteps(projectId) {
  return db.prepare(
    `SELECT s.id, s.test_id, t.name AS test, s.step_order, s.command, s.params, s.locators, s.intent, s.variable, s.assertion, s.page
     FROM test_steps s JOIN tests t ON t.id = s.test_id
     WHERE t.project_id = ? AND s.page IS NOT NULL
     ORDER BY t.updated_at, s.id`
  ).all(projectId).map((row) => ({
    id: row.id,
    test_id: row.test_id,
    test: row.test,
    order: row.step_order,
    command: row.command,
    params: parseJson(row.params) || {},
    locators: parseJson(row.locators) || [],
    ...(row.intent && { intent: row.intent }),
    ...(row.variable && { variable: parseJson(row.variable) }),
    ...(row.assertion && { assertion: parseJson(row.assertion) }),
    page: row.page,
  }));
}

/** The element of each step, by the step, once all are registered. */
function elementsOfSteps(projectId, steps) {
  registerElements(projectId, steps);
  const index = loadIndex(projectId);
  return { index, elementOfStep: (step) => index.elementOf.get(elementKey(step)) ?? null };
}

/**
 * The elements of a project by name, each as the latest step acting on it recorded it:
 * selector, locators, page. A phrase naming one is read back as that (parse.js).
 */
export function elementTargets(projectId) {
  const index = loadIndex(projectId);
  const latest = new Map();
  for (const step of projectSteps(projectId)) {
    const id = index.elementOf.get(elementKey(step));
    if (id && typeof selectorOf(step) === 'string') latest.set(id, step);
  }
  const targets = new Map();
  for (const { id, name } of index.elements.values()) {
    const step = latest.get(id);
    if (step) targets.set(name, { selector: selectorOf(step), locators: step.locators, page: step.page });
  }
  return targets;
}

/**
 * The elements of a project, page by page, each with the steps that act on it, and the other
 * keys it was recorded under (`also`: `css #country-input` for the field "Country").
 */
export function listElements(projectId) {
  const steps = projectSteps(projectId);
  const { index, elementOfStep } = elementsOfSteps(projectId, steps);
  const uses = new Map();
  // How the latest step acting on each element found it: a step written by hand on that element
  // (the dashboard's step editor) starts from it.
  const latest = new Map();
  for (const step of steps) {
    const id = elementOfStep(step);
    if (!id) continue;
    if (typeof selectorOf(step) === 'string') latest.set(id, step);
    if (!uses.has(id)) uses.set(id, new Map());
    const byTest = uses.get(id);
    byTest.set(step.test, [...(byTest.get(step.test) ?? []), step.order]);
  }
  const keysOf = new Map();
  for (const [identity, id] of index.elementOf) {
    const row = index.elements.get(id);
    if (!row || identity === row.key || isMark(identity, row.page)) continue;
    keysOf.set(id, [...(keysOf.get(id) ?? []), identity.slice(row.page.length + 1)]);
  }
  return db.prepare('SELECT id, key, name, page, created_at FROM elements WHERE project_id = ? ORDER BY page, name').all(projectId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      page: row.page,
      target: row.key.slice(row.page.length + 1),
      ...(keysOf.has(row.id) && { also: keysOf.get(row.id).sort() }),
      created_at: row.created_at,
      used_by: [...(uses.get(row.id) ?? new Map())].map(([test, orders]) => ({ test, steps: orders })),
      ...(latest.has(row.id) && {
        selector: selectorOf(latest.get(row.id)),
        locators: latest.get(row.id).locators ?? [],
      }),
    }));
}

/** Renames an element; `{ error, status }` when the name is empty or another element has it. */
export function renameElement(id, name) {
  const wanted = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!wanted) return { error: 'A name is required', status: 400 };
  const element = db.prepare('SELECT id, project_id FROM elements WHERE id = ?').get(id);
  if (!element) return { error: 'Element not found', status: 404 };
  const other = db.prepare('SELECT id FROM elements WHERE project_id = ? AND name = ? AND id != ?').get(element.project_id, wanted, id);
  if (other) return { error: `Another element of this project is named "${wanted}"`, status: 409 };
  db.prepare('UPDATE elements SET name = ?, renamed = 1 WHERE id = ?').run(wanted, id);
  return { name: wanted };
}

/** Deletes an element no step acts on any more; `{ error, status }` otherwise. */
export function deleteElement(id) {
  const element = db.prepare('SELECT id, project_id FROM elements WHERE id = ?').get(id);
  if (!element) return { error: 'Element not found', status: 404 };
  const index = loadIndex(element.project_id);
  if (projectSteps(element.project_id).some((step) => index.elementOf.get(elementKey(step)) === id)) {
    return { error: 'Steps still act on this element', status: 409 };
  }
  db.prepare('DELETE FROM elements WHERE id = ?').run(id);
  return { deleted: true };
}

/** The other steps acting on the element `step` acts on, as saved, all but step `except` ({ test, order }). */
function stepsOnElement(projectId, step, except) {
  if (!projectId || !elementKey(step)) return { element: null, steps: [] };
  const steps = projectSteps(projectId);
  const { index, elementOfStep } = elementsOfSteps(projectId, [step, ...steps]);
  const id = elementOfStep(step);
  if (!id) return { element: null, steps: [] };
  return {
    element: { id, name: index.elements.get(id).name },
    steps: steps.filter((s) => elementOfStep(s) === id && !(except && s.test === except.test && s.order === except.order))
      .sort((a, b) => a.test.localeCompare(b.test) || a.order - b.order),
  };
}

const useOf = (step) => ({ test: step.test, step_order: step.order, command: step.command, ...(step.intent && { intent: step.intent }) });

/**
 * The element `step` acts on and the other steps of the project acting on it — all but step
 * `except` ({ test, order }), the step itself —: `{ element: { id, name }, uses: [{ test,
 * step_order, command, intent }], tests }`, `tests` how many tests they are in. With `after`,
 * only the steps it would change: those not yet finding the element as `after` does.
 */
export function usesOfStep(projectId, step, except = null, after = null) {
  const { element, steps } = stepsOnElement(projectId, step, except);
  if (!element) return { element: null, uses: [], tests: 0 };
  const uses = (after ? steps.filter((s) => changed(s, foundLike(s, after))) : steps).map(useOf);
  return { element, uses, tests: new Set(uses.map((use) => use.test)).size };
}

const changed = (step, next) => JSON.stringify([next.params, next.locators ?? [], next.assertion ?? null])
  !== JSON.stringify([step.params, step.locators ?? [], step.assertion ?? null]);

/**
 * Step `order` of test `test` now finds its element as `after` does, no longer as `before` did
 * (a repair applied, the step edited). With `allUses`, the other steps of the project acting on
 * that element find it so too, each still doing what it does (foundLike); their open repairs
 * relocating it are superseded. With `join` — a repair, or `allUses` —, `after` acts on the same
 * element as `before`: its new key is one more of that element, which keeps its name. `{ element,
 * relocated: [{ test, step_order }] }`.
 */
export function relocateElement(projectId, { test, order, before, after, allUses = false, join = allUses }) {
  // Unchanged, with `allUses`: the others are given the way it finds it now.
  if (!projectId || !before || !after || (!allUses && !findsDifferently(before, after))) return { element: null, relocated: [] };
  return db.transaction(() => {
    const { element, steps } = stepsOnElement(projectId, before, { test, order });
    if (!element) return { element: null, relocated: [] };
    const relocated = [];
    if (allUses) {
      const update = db.prepare('UPDATE test_steps SET params = ?, locators = ?, assertion = ? WHERE id = ?');
      const touch = db.prepare("UPDATE tests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?");
      const supersede = db.prepare(`UPDATE test_repairs SET status = 'superseded', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                                    WHERE test_id = ? AND step_order = ? AND kind = 'relocate' AND status IN ('proposed', 'verified', 'failed')`);
      for (const step of steps) {
        const next = foundLike(step, after);
        if (!changed(step, next)) continue;
        update.run(JSON.stringify(next.params ?? {}), next.locators?.length ? JSON.stringify(next.locators) : null,
          next.assertion ? JSON.stringify(next.assertion) : null, step.id);
        touch.run(step.test_id);
        supersede.run(step.test_id, step.order);
        relocated.push({ test: step.test, step_order: step.order });
      }
    }
    // Its new key, and those of the steps given its locators (an assertion's selector may say
    // it otherwise), are the element's: it keeps its name.
    let kept = element;
    if (join) {
      const index = loadIndex(projectId);
      const moved = steps.filter((s) => relocated.some((r) => r.test === s.test && r.step_order === s.order)).map((s) => foundLike(s, after));
      let id = element.id;
      for (const step of [{ ...after, page: after.page ?? before.page }, ...moved]) id = attach(index, step, [id]) ?? id;
      kept = { id, name: index.elements.get(id)?.name ?? element.name };
    }
    if (relocated.length) {
      log(`Element "${kept.name}": found as step ${order} of "${test}" finds it now in ${relocated.length} other step(s): ${relocated.map((r) => `"${r.test}" step ${r.step_order}`).join(', ')}`);
    }
    return { element: kept, relocated };
  })();
}

/**
 * The elements a project's steps act on, as an agent writing Gherkin reads them: page by page,
 * each name in quotes with what it is — `- shop.test/login: "E-mail" (field), "Sign in"
 * (button)`. At most `max` of them; empty when the project has none.
 */
export function elementLines(projectId, max = 150) {
  const used = listElements(projectId).filter((element) => element.used_by.length);
  const shown = used.slice(0, max);
  const lines = [...new Set(shown.map((element) => element.page))].map((page) => {
    const names = shown.filter((element) => element.page === page).map(({ name, target }) => {
      // What it is: its role or kind, or all of it when its name does not say it.
      const what = target.includes(JSON.stringify(name)) ? target.split(' ')[0] : target;
      return `${JSON.stringify(name)} (${what})`;
    });
    return `- ${page}: ${names.join(', ')}`;
  });
  if (used.length > shown.length) lines.push(`- … and ${used.length - shown.length} more`);
  return lines;
}
