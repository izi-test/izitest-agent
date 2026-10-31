// Step definitions CRUD — SQLite persistence.
// Built-in definitions (is_default = 1) cannot be updated or deleted.

import { db, parseJson } from '../db.js';
import { DEFAULT_STEP_DEFINITIONS } from './default-step-definitions.js';

function rowToDefinition(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    keyword: row.keyword,
    pattern: row.pattern,
    command: row.command,
    params_template: parseJson(row.params_template) || {},
    steps_template: parseJson(row.steps_template) || null,
    is_default: !!row.is_default,
    created_at: row.created_at,
  };
}

export function listStepDefinitions(projectId) {
  return db.prepare(
    `SELECT * FROM step_definitions
     WHERE project_id = ?
     ORDER BY is_default DESC, keyword, pattern`
  ).all(projectId).map(rowToDefinition);
}

export function getStepDefinition(id) {
  const row = db.prepare('SELECT * FROM step_definitions WHERE id = ?').get(id);
  return row ? rowToDefinition(row) : null;
}

export function createStepDefinition(projectId, { keyword, pattern, command, params_template, steps_template }) {
  const row = db.prepare(
    `INSERT INTO step_definitions (project_id, keyword, pattern, command, params_template, steps_template)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(
    projectId, keyword, pattern, command,
    JSON.stringify(params_template || {}),
    steps_template ? JSON.stringify(steps_template) : null
  );
  return rowToDefinition(row);
}

export function updateStepDefinition(id, { keyword, pattern, command, params_template, steps_template }) {
  const row = db.prepare(
    `UPDATE step_definitions
     SET keyword = ?, pattern = ?, command = ?, params_template = ?, steps_template = ?
     WHERE id = ? AND is_default = 0
     RETURNING *`
  ).get(
    keyword, pattern, command,
    JSON.stringify(params_template || {}),
    steps_template ? JSON.stringify(steps_template) : null,
    id
  );
  return row ? rowToDefinition(row) : null;
}

export function deleteStepDefinition(id) {
  const result = db.prepare(
    'DELETE FROM step_definitions WHERE id = ? AND is_default = 0'
  ).run(id);
  return result.changes > 0;
}

/** Add to every project the built-in definitions it lacks: those added since it was created. */
export function seedAllProjectsStepDefinitions() {
  for (const { id } of db.prepare('SELECT id FROM projects').all()) seedProjectStepDefinitions(id);
}

export function seedProjectStepDefinitions(projectId) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO step_definitions
       (project_id, keyword, pattern, command, params_template, is_default)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  const tx = db.transaction(() => {
    for (const def of DEFAULT_STEP_DEFINITIONS) {
      insert.run(
        projectId,
        def.keyword,
        def.pattern,
        def.command,
        JSON.stringify(def.params_template)
      );
    }
  });
  tx();
}
