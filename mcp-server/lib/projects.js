// Projects: what an app's tests belong to — its base URL, its context, the language its tests are
// written in, its datasets, secrets and requirements. Created from the dashboard, the API, or by
// an agent (create_project), which first looks for the one it needs (list_projects).

import { db } from './db.js';
import { seedProjectStepDefinitions } from './gherkin/step-definition-store.js';
import { languageOf } from './gherkin/language.js';

export const PROJECT_TYPES = ['frontend', 'backend', 'fullstack'];

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** The projects, newest first, with how many tests each has; `url`: those whose app it is. */
export function listProjects({ url } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.project_type, p.base_url, p.language, p.created_at, p.updated_at,
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
export function createProject({ name, description = '', context = '', project_type = null, base_url = null, language } = {}) {
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
  const project = db.prepare(
    `INSERT INTO projects (name, description, context, project_type, base_url, language)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(trimmed, description || '', context || '', project_type || null, base_url || null, languageOf(language));
  seedProjectStepDefinitions(project.id);
  return project;
}
