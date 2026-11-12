// SQLite database connection and schema initialization

import Database from 'better-sqlite3';
import { log } from './logger.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

// IZITEST_DB_PATH: another database file — a test's own, thrown away after.
const db = new Database(process.env.IZITEST_DB_PATH || join(DATA_DIR, 'izitest.db'));
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

    CREATE TABLE IF NOT EXISTS step_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL CHECK (keyword IN ('Given','When','Then')),
      pattern TEXT NOT NULL,
      command TEXT NOT NULL,
      params_template TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(project_id, pattern)
    );

    CREATE INDEX IF NOT EXISTS idx_step_definitions_project ON step_definitions(project_id);
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

  // Migrations: add step_definition_id column to test_steps if it doesn't exist
  try {
    const hasStepDefId = db.prepare("PRAGMA table_info(test_steps)").all().some(col => col.name === 'step_definition_id');
    if (!hasStepDefId) {
      db.exec(`ALTER TABLE test_steps ADD COLUMN step_definition_id INTEGER REFERENCES step_definitions(id) ON DELETE SET NULL`);
      log('Migration applied: added step_definition_id column to test_steps table');
    }
  } catch (err) {
    log(`Migration warning (step_definition_id): ${err.message}`);
  }

  // Migrations: add steps_template column to step_definitions for composite (multi-step) definitions
  try {
    const hasStepsTemplate = db.prepare("PRAGMA table_info(step_definitions)").all().some(col => col.name === 'steps_template');
    if (!hasStepsTemplate) {
      db.exec(`ALTER TABLE step_definitions ADD COLUMN steps_template TEXT DEFAULT NULL`);
      log('Migration applied: added steps_template column to step_definitions table');
    }
  } catch (err) {
    log(`Migration warning (steps_template): ${err.message}`);
  }

  // Migrations: add context fields to projects
  try {
    const cols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
    if (!cols.includes('context')) {
      db.exec(`ALTER TABLE projects ADD COLUMN context TEXT DEFAULT ''`);
      log('Migration applied: added context column to projects table');
    }
    if (!cols.includes('project_type')) {
      db.exec(`ALTER TABLE projects ADD COLUMN project_type TEXT DEFAULT NULL`);
      log('Migration applied: added project_type column to projects table');
    }
    if (!cols.includes('base_url')) {
      db.exec(`ALTER TABLE projects ADD COLUMN base_url TEXT DEFAULT NULL`);
      log('Migration applied: added base_url column to projects table');
    }
  } catch (err) {
    log(`Migration warning (project context): ${err.message}`);
  }

  // Conversations / messages tables for agent chat
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  `);

  // Migration: add cli_session_id to conversations (for CLI chat resumption)
  try {
    const convCols = db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name);
    if (!convCols.includes('cli_session_id')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN cli_session_id TEXT DEFAULT NULL`);
      log('Migration applied: added cli_session_id column to conversations table');
    }
  } catch (err) {
    log(`Migration warning (cli_session_id): ${err.message}`);
  }

  // Why a run failed, and the repairs proposed for it (lib/triage.js, lib/repairs.js).
  try {
    const execCols = db.prepare("PRAGMA table_info(test_executions)").all().map(c => c.name);
    if (!execCols.includes('triage')) {
      db.exec(`ALTER TABLE test_executions ADD COLUMN triage TEXT DEFAULT NULL`);
      log('Migration applied: added triage column to test_executions table');
    }
  } catch (err) {
    log(`Migration warning (triage): ${err.message}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      test_name TEXT NOT NULL,
      execution_id INTEGER REFERENCES test_executions(id) ON DELETE SET NULL,
      step_order INTEGER NOT NULL,
      kind TEXT NOT NULL,
      cause TEXT NOT NULL,
      summary TEXT NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      change TEXT NOT NULL,
      before TEXT,
      run_options TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'proposed',
      verify_execution_id INTEGER,
      verify_error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_test_repairs_test ON test_repairs(test_id);
  `);

  // What the explorer found (lib/explore.js): its runs, and the bugs, each with a test that
  // reproduces it (lib/bugs.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS explorations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_url TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running',
      options TEXT DEFAULT '{}',
      pages TEXT DEFAULT '[]',
      bugs_found INTEGER DEFAULT 0,
      bugs_new INTEGER DEFAULT 0,
      error TEXT,
      started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      exploration_id INTEGER REFERENCES explorations(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      page_url TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      repro_test TEXT,
      reproduced INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_seen TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  // A bug a test's run met (lib/bugs.js recordRunBug): where it comes from (an exploration, or
  // a test), the run and the campaign it was last seen in, the dataset row, the run that saw it
  // fixed; and, on a run, the bug it met.
  try {
    const bugCols = db.prepare('PRAGMA table_info(bugs)').all().map(c => c.name);
    if (!bugCols.includes('source')) db.exec("ALTER TABLE bugs ADD COLUMN source TEXT NOT NULL DEFAULT 'exploration'");
    for (const column of ['execution_id', 'campaign_id', 'data_row', 'fixed_execution_id']) {
      if (!bugCols.includes(column)) db.exec(`ALTER TABLE bugs ADD COLUMN ${column} INTEGER DEFAULT NULL`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_bugs_repro_test ON bugs(repro_test)');
    const execCols = db.prepare('PRAGMA table_info(test_executions)').all().map(c => c.name);
    if (!execCols.includes('bug_id')) db.exec('ALTER TABLE test_executions ADD COLUMN bug_id INTEGER DEFAULT NULL');
  } catch (err) {
    log(`Migration warning (bugs of runs): ${err.message}`);
  }

  // What a test is for (lib/requirements.js): requirements — from a prompt, written in the
  // dashboard, imported from a tool — their acceptance criteria, and the test cases that
  // cover them, planned first, then linked to the test that checks them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      external_url TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      content_hash TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS acceptance_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requirement_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      criterion_id INTEGER REFERENCES acceptance_criteria(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'nominal',
      test_id INTEGER REFERENCES tests(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_criteria_requirement ON acceptance_criteria(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_cases_requirement ON requirement_cases(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_cases_test ON requirement_cases(test_id);
  `);

  // Test design (lib/requirement-design.js): a case designed with a technique, its priority,
  // why it is there, its scenario in Gherkin; the last design an agent proposed for a requirement.
  try {
    const caseCols = db.prepare('PRAGMA table_info(requirement_cases)').all().map(c => c.name);
    for (const column of ['technique', 'priority', 'rationale', 'gherkin']) {
      if (!caseCols.includes(column)) db.exec(`ALTER TABLE requirement_cases ADD COLUMN ${column} TEXT DEFAULT NULL`);
    }
    const requirementCols = db.prepare('PRAGMA table_info(requirements)').all().map(c => c.name);
    if (!requirementCols.includes('design')) db.exec('ALTER TABLE requirements ADD COLUMN design TEXT DEFAULT NULL');
  } catch (err) {
    log(`Migration warning (test design): ${err.message}`);
  }

  // Campaigns (lib/campaigns.js): tests replayed together for a version of the app — a
  // project's, a requirement's, or a list — and the runs that belong to each.
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      version TEXT,
      tests TEXT NOT NULL,
      concurrency INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'running',
      errors TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_scope ON campaigns(scope_key);
  `);
  try {
    const execCols = db.prepare('PRAGMA table_info(test_executions)').all().map(c => c.name);
    if (!execCols.includes('campaign_id')) {
      db.exec('ALTER TABLE test_executions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_executions_campaign ON test_executions(campaign_id)');
    // Run in the Chrome without windows (lib/headless.js): "Run again" does it again.
    const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map(c => c.name);
    if (!campaignCols.includes('headless')) {
      db.exec('ALTER TABLE campaigns ADD COLUMN headless INTEGER NOT NULL DEFAULT 0');
    }
    // Why a test was not run: a stage after one that did not pass (lib/campaigns.js).
    if (!campaignCols.includes('skips')) {
      db.exec("ALTER TABLE campaigns ADD COLUMN skips TEXT NOT NULL DEFAULT '{}'");
    }
    // The commit a campaign tested ({ sha, branch, message }), and the tests chosen for what it
    // changed, each with why, and those left out (lib/regression.js).
    if (!campaignCols.includes('commit_info')) db.exec('ALTER TABLE campaigns ADD COLUMN commit_info TEXT DEFAULT NULL');
    if (!campaignCols.includes('selection')) db.exec('ALTER TABLE campaigns ADD COLUMN selection TEXT DEFAULT NULL');
    // What a run that passed touched: its pages, the API it called (lib/footprint.js).
    if (!execCols.includes('footprint')) db.exec('ALTER TABLE test_executions ADD COLUMN footprint TEXT DEFAULT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_executions_test_name ON test_executions(test_name)');
  } catch (err) {
    log(`Migration warning (campaigns): ${err.message}`);
  }

  // Where Jira and Xray kept, before connectors, the comment IziTest keeps on a story and the Test
  // Execution a campaign was sent to: moved to connector_refs below.
  try {
    const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map(c => c.name);
    if (!campaignCols.includes('xray_execution_key')) db.exec('ALTER TABLE campaigns ADD COLUMN xray_execution_key TEXT DEFAULT NULL');
    const requirementCols = db.prepare('PRAGMA table_info(requirements)').all().map(c => c.name);
    if (!requirementCols.includes('jira_comment_id')) db.exec('ALTER TABLE requirements ADD COLUMN jira_comment_id TEXT DEFAULT NULL');
  } catch (err) {
    log(`Migration warning (Xray, Jira comments): ${err.message}`);
  }

  // What a connector (lib/connectors) keeps of what it sent: the comment IziTest keeps on a story,
  // the Test Execution a campaign went to — sent again, they are updated, not repeated. Those kept
  // above are moved here; a requirement or a campaign deleted takes its own along (an id may come back).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_refs (
        connector TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        ref TEXT NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (connector, kind, item_id)
      );
      INSERT OR IGNORE INTO connector_refs (connector, kind, item_id, ref)
        SELECT 'jira', 'requirement', id, jira_comment_id FROM requirements WHERE jira_comment_id IS NOT NULL;
      INSERT OR IGNORE INTO connector_refs (connector, kind, item_id, ref)
        SELECT 'xray', 'campaign', id, xray_execution_key FROM campaigns WHERE xray_execution_key IS NOT NULL;
      UPDATE requirements SET jira_comment_id = NULL WHERE jira_comment_id IS NOT NULL;
      UPDATE campaigns SET xray_execution_key = NULL WHERE xray_execution_key IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS connector_refs_of_requirement AFTER DELETE ON requirements
        BEGIN DELETE FROM connector_refs WHERE kind = 'requirement' AND item_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS connector_refs_of_campaign AFTER DELETE ON campaigns
        BEGIN DELETE FROM connector_refs WHERE kind = 'campaign' AND item_id = OLD.id; END;
    `);
  } catch (err) {
    log(`Migration warning (connectors): ${err.message}`);
  }

  // The elements of a project (lib/elements.js): what its steps act on, known by their page and
  // their role and name. A step keeps the page it was recorded on (host and path, ids starred).
  try {
    const stepCols = db.prepare('PRAGMA table_info(test_steps)').all().map(c => c.name);
    if (!stepCols.includes('page')) db.exec('ALTER TABLE test_steps ADD COLUMN page TEXT DEFAULT NULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS elements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        page TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(project_id, key),
        UNIQUE(project_id, name)
      );
    `);
  } catch (err) {
    log(`Migration warning (elements): ${err.message}`);
  }

  // The language a project's tests are written in (lib/gherkin/language.js), and that of each
  // built-in phrase: the ones seeded so far are English.
  try {
    const projectCols = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
    if (!projectCols.includes('language')) db.exec("ALTER TABLE projects ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
    const definitionCols = db.prepare('PRAGMA table_info(step_definitions)').all().map(c => c.name);
    if (!definitionCols.includes('language')) {
      db.exec('ALTER TABLE step_definitions ADD COLUMN language TEXT DEFAULT NULL');
      db.exec("UPDATE step_definitions SET language = 'en' WHERE is_default = 1");
    }
  } catch (err) {
    log(`Migration warning (language): ${err.message}`);
  }

  // The datasets of a project (lib/datasets.js): a test bound to one runs once per row; a run
  // says which row it played.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source TEXT,
        columns TEXT NOT NULL DEFAULT '[]',
        rows TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(project_id, name)
      );
    `);
    const testCols = db.prepare('PRAGMA table_info(tests)').all().map(c => c.name);
    if (!testCols.includes('dataset_id')) db.exec('ALTER TABLE tests ADD COLUMN dataset_id INTEGER REFERENCES datasets(id) ON DELETE SET NULL');
    const executionCols = db.prepare('PRAGMA table_info(test_executions)').all().map(c => c.name);
    if (!executionCols.includes('data_row')) db.exec('ALTER TABLE test_executions ADD COLUMN data_row INTEGER DEFAULT NULL');
  } catch (err) {
    log(`Migration warning (datasets): ${err.message}`);
  }

  // What a test manager plans and follows (ISTQB CTFL 5): the product risk of a requirement — how
  // likely it is to go wrong, what it costs when it does (lib/requirements.js riskOf) —, the plan
  // of a campaign and its exit criteria (lib/campaigns.js exitOf), and a bug's handling: how
  // urgent its fix is, who has it, the bug it repeats (lib/bugs.js updateBug).
  try {
    const requirementCols = db.prepare('PRAGMA table_info(requirements)').all().map(c => c.name);
    if (!requirementCols.includes('likelihood')) db.exec('ALTER TABLE requirements ADD COLUMN likelihood TEXT DEFAULT NULL');
    if (!requirementCols.includes('impact')) db.exec('ALTER TABLE requirements ADD COLUMN impact TEXT DEFAULT NULL');
    const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map(c => c.name);
    if (!campaignCols.includes('objective')) db.exec('ALTER TABLE campaigns ADD COLUMN objective TEXT DEFAULT NULL');
    if (!campaignCols.includes('scope_note')) db.exec('ALTER TABLE campaigns ADD COLUMN scope_note TEXT DEFAULT NULL');
    if (!campaignCols.includes('exit_criteria')) db.exec('ALTER TABLE campaigns ADD COLUMN exit_criteria TEXT DEFAULT NULL');
    const bugCols = db.prepare('PRAGMA table_info(bugs)').all().map(c => c.name);
    if (!bugCols.includes('priority')) db.exec('ALTER TABLE bugs ADD COLUMN priority TEXT DEFAULT NULL');
    if (!bugCols.includes('assignee')) db.exec('ALTER TABLE bugs ADD COLUMN assignee TEXT DEFAULT NULL');
    if (!bugCols.includes('duplicate_of')) db.exec('ALTER TABLE bugs ADD COLUMN duplicate_of INTEGER DEFAULT NULL');
    if (!bugCols.includes('fixed_at')) {
      db.exec('ALTER TABLE bugs ADD COLUMN fixed_at TEXT DEFAULT NULL');
      // Those fixed before: when the run that saw them fixed ended, else when they were last seen.
      db.exec(`UPDATE bugs SET fixed_at = COALESCE((SELECT e.finished_at FROM test_executions e WHERE e.id = bugs.fixed_execution_id), last_seen) WHERE status = 'fixed'`);
    }
  } catch (err) {
    log(`Migration warning (risk, test plan, bug handling): ${err.message}`);
  }

  // The secrets of a project (lib/secrets.js): a password, a key a test types, its value
  // encrypted with a key of this machine; {{secret.NAME}} in a step.
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(project_id, name)
    );
  `);

  // The business steps the agent proposes for a test, until accepted or dismissed (lib/business-steps.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_proposals (
      test_id INTEGER PRIMARY KEY REFERENCES tests(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      proposals TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      agent TEXT,
      updated_at TEXT
    );
  `);

  log('SQLite database initialized');
}

/** Parse a JSON TEXT column, returning the parsed object or the original value. */
export function parseJson(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return val; }
}

export { db };
