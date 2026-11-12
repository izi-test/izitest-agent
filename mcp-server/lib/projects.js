// Projects: what an app's tests belong to — its base URL, its context, the language its tests are
// written in, its datasets, secrets and requirements. Created from the dashboard, the API, or by
// an agent (create_project), which first looks for the one it needs (list_projects).

import { db } from './db.js';
import { seedProjectStepDefinitions } from './gherkin/step-definition-store.js';
import { languageOf } from './gherkin/language.js';

export const PROJECT_TYPES = ['frontend', 'backend', 'fullstack'];

// How long a replayed step waits for its element to show, and a check for what it expects: a
// page still loading after a click or a navigation is waited for, up to that. Like Playwright's
// expect timeout, longer than the 2 s the agent's own clicks wait, since nobody is there to look
// again. Set per project: a slow environment (a test server, a company laptop) asks for more.
export const DEFAULT_ELEMENT_TIMEOUT_MS = 10_000;
export const MIN_ELEMENT_TIMEOUT_MS = 1_000;
export const MAX_ELEMENT_TIMEOUT_MS = 120_000;

/** A wait asked for, checked: null keeps the default; throws on what is not a number of ms in range. */
export function elementTimeoutOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < MIN_ELEMENT_TIMEOUT_MS || ms > MAX_ELEMENT_TIMEOUT_MS) {
    throw new Error(`element_timeout_ms is a whole number of milliseconds from ${MIN_ELEMENT_TIMEOUT_MS} to ${MAX_ELEMENT_TIMEOUT_MS}`);
  }
  return ms;
}

/**
 * Whether a test of this project starts logged out in the browser without windows: what the app
 * left there (cookies, storage) is cleared first, so that a session kept from the test before —
 * or from the agent recording it — does not lead the app elsewhere. On by default; off for an app
 * whose tests count on staying logged in from one to the next. Never done in the user's Chrome.
 */
export function cleanStartFor(projectId) {
  if (projectId == null) return true;
  const row = db.prepare('SELECT clean_start FROM projects WHERE id = ?').get(projectId);
  return row ? row.clean_start !== 0 : true;
}

/** How long a replayed step of this project waits for its element, in ms. */
export function elementTimeoutFor(projectId) {
  if (projectId == null) return DEFAULT_ELEMENT_TIMEOUT_MS;
  const row = db.prepare('SELECT element_timeout_ms FROM projects WHERE id = ?').get(projectId);
  return row?.element_timeout_ms ?? DEFAULT_ELEMENT_TIMEOUT_MS;
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** The projects, newest first, with how many tests each has; `url`: those whose app it is. */
export function listProjects({ url } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.project_type, p.base_url, p.language, p.element_timeout_ms, p.clean_start, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM tests t WHERE t.project_id = p.id) AS test_count
    FROM projects p ORDER BY p.updated_at DESC
  `).all();
  if (!url) return rows;
  // Its app: the URL starts with its base URL, or is on the same origin.
  const origin = originOf(url);
  return rows.filter((p) => p.base_url && (url.startsWith(p.base_url) || (origin && originOf(p.base_url) === origin)));
}

/**
 * Create a project, its built-in Gherkin phrases seeded in its language. Throws when the name is
 * missing or taken — telling which project has it.
 */
export function createProject({ name, description = '', context = '', project_type = null, base_url = null, language, element_timeout_ms = null } = {}) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('name is required');
  if (project_type && !PROJECT_TYPES.includes(project_type)) throw new Error(`project_type is one of ${PROJECT_TYPES.join(', ')}`);
  const taken = db.prepare('SELECT id FROM projects WHERE name = ?').get(trimmed);
  if (taken) {
    const error = new Error(`A project is already called "${trimmed}": #${taken.id}`);
    error.code = 'PROJECT_EXISTS';
    error.projectId = taken.id;
    throw error;
  }
  const timeout = elementTimeoutOf(element_timeout_ms);
  const project = db.prepare(
    `INSERT INTO projects (name, description, context, project_type, base_url, language, element_timeout_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(trimmed, description || '', context || '', project_type || null, base_url || null, languageOf(language), timeout);
  seedProjectStepDefinitions(project.id);
  return project;
}
