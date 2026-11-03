// The elements of a project, kept (lib/elements.js says what an element is): registered as
// the steps acting on them are seen, named, renamed by the user, listed with their uses.

import { db, parseJson } from './db.js';
import { elementKey, baseName, uniqueName, selectorOf } from './elements.js';

/**
 * The elements `steps` act on, registered in `projectId` when they are not yet: a Map from
 * key to name. A new element is named after what a person reads on it.
 */
export function registerElements(projectId, steps) {
  return db.transaction(() => {
    const names = new Map(db.prepare('SELECT key, name FROM elements WHERE project_id = ?').all(projectId).map((row) => [row.key, row.name]));
    const taken = new Set(names.values());
    const insert = db.prepare('INSERT INTO elements (project_id, key, name, page) VALUES (?, ?, ?, ?)');
    for (const step of steps) {
      const key = elementKey(step);
      if (!key || names.has(key)) continue;
      const name = uniqueName(baseName(step), step.page, taken);
      insert.run(projectId, key, name, step.page);
      names.set(key, name);
      taken.add(name);
    }
    return names;
  })();
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
    `SELECT t.name AS test, s.step_order, s.command, s.params, s.locators, s.variable, s.assertion, s.page
     FROM test_steps s JOIN tests t ON t.id = s.test_id
     WHERE t.project_id = ? AND s.page IS NOT NULL
     ORDER BY t.updated_at, s.id`
  ).all(projectId).map((row) => ({
    test: row.test,
    order: row.step_order,
    command: row.command,
    params: parseJson(row.params) || {},
    locators: parseJson(row.locators) || [],
    ...(row.variable && { variable: parseJson(row.variable) }),
    ...(row.assertion && { assertion: parseJson(row.assertion) }),
    page: row.page,
  }));
}

/**
 * The elements of a project by name, each as the latest step acting on it recorded it:
 * selector, locators, page. A phrase naming one is read back as that (parse.js).
 */
export function elementTargets(projectId) {
  const latest = new Map();
  for (const step of projectSteps(projectId)) {
    const key = elementKey(step);
    if (key && typeof selectorOf(step) === 'string') latest.set(key, step);
  }
  const targets = new Map();
  for (const { key, name } of db.prepare('SELECT key, name FROM elements WHERE project_id = ?').all(projectId)) {
    const step = latest.get(key);
    if (step) targets.set(name, { selector: selectorOf(step), locators: step.locators, page: step.page });
  }
  return targets;
}

/** The elements of a project, page by page, each with the steps that act on it. */
export function listElements(projectId) {
  const steps = projectSteps(projectId);
  registerElements(projectId, steps);
  const uses = new Map();
  for (const step of steps) {
    const key = elementKey(step);
    if (!key) continue;
    if (!uses.has(key)) uses.set(key, new Map());
    const byTest = uses.get(key);
    byTest.set(step.test, [...(byTest.get(step.test) ?? []), step.order]);
  }
  return db.prepare('SELECT id, key, name, page, created_at FROM elements WHERE project_id = ? ORDER BY page, name').all(projectId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      page: row.page,
      target: row.key.slice(row.page.length + 1),
      created_at: row.created_at,
      used_by: [...(uses.get(row.key) ?? new Map())].map(([test, orders]) => ({ test, steps: orders })),
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
  db.prepare('UPDATE elements SET name = ? WHERE id = ?').run(wanted, id);
  return { name: wanted };
}

/** Deletes an element no step acts on any more; `{ error, status }` otherwise. */
export function deleteElement(id) {
  const element = db.prepare('SELECT id, project_id, key FROM elements WHERE id = ?').get(id);
  if (!element) return { error: 'Element not found', status: 404 };
  if (projectSteps(element.project_id).some((step) => elementKey(step) === element.key)) {
    return { error: 'Steps still act on this element', status: 409 };
  }
  db.prepare('DELETE FROM elements WHERE id = ?').run(id);
  return { deleted: true };
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
