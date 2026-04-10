// SQLite database connection and schema initialization

import Database from 'better-sqlite3';
import { log } from './logger.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'browser-pilot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      variables TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS test_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      command TEXT NOT NULL,
      params TEXT DEFAULT '{}',
      locators TEXT,
      intent TEXT,
      variable TEXT,
      assertion TEXT,
      UNIQUE(test_id, step_order)
    );

    CREATE TABLE IF NOT EXISTS test_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      test_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at TEXT,
      duration_ms INTEGER,
      total_steps INTEGER DEFAULT 0,
      completed_steps INTEGER DEFAULT 0,
      failed_step INTEGER,
      error TEXT,
      variables TEXT DEFAULT '{}',
      new_window INTEGER DEFAULT 0,
      trigger TEXT DEFAULT 'manual',
      assertions_total INTEGER DEFAULT 0,
      assertions_passed INTEGER DEFAULT 0,
      assertions_failed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS execution_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      command TEXT NOT NULL,
      intent TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      locator_used TEXT,
      error TEXT,
      assertion_result TEXT,
      UNIQUE(execution_id, step_order)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  // Migrations: add project_id column to tests if it doesn't exist
  try {
    const hasProjectId = db.prepare("PRAGMA table_info(tests)").all().some(col => col.name === 'project_id');
    if (!hasProjectId) {
      db.exec(`ALTER TABLE tests ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);
      log('Migration applied: added project_id column to tests table');
    }
  } catch (err) {
    log(`Migration warning: ${err.message}`);
  }

  // Migrations: add viewport column to tests if it doesn't exist
  try {
    const hasViewport = db.prepare("PRAGMA table_info(tests)").all().some(col => col.name === 'viewport');
    if (!hasViewport) {
      db.exec(`ALTER TABLE tests ADD COLUMN viewport TEXT DEFAULT NULL`);
      log('Migration applied: added viewport column to tests table');
    }
  } catch (err) {
    log(`Migration warning (viewport): ${err.message}`);
  }

  log('SQLite database initialized');
}

/** Parse a JSON TEXT column, returning the parsed object or the original value. */
export function parseJson(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return val; }
}

export { db };
