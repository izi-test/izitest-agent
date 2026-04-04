// PostgreSQL connection pool and schema initialization

import pg from 'pg';
import { log } from './logger.js';

const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 54320,
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
});

pool.on('error', (err) => {
  log(`Unexpected PostgreSQL pool error: ${err.message}`);
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflows (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        variables JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id SERIAL PRIMARY KEY,
        workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        command TEXT NOT NULL,
        params JSONB DEFAULT '{}',
        locators JSONB,
        intent TEXT,
        variable JSONB,
        UNIQUE(workflow_id, step_order)
      );

      CREATE TABLE IF NOT EXISTS workflow_executions (
        id SERIAL PRIMARY KEY,
        workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TIMESTAMPTZ DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        duration_ms INTEGER,
        total_steps INTEGER DEFAULT 0,
        completed_steps INTEGER DEFAULT 0,
        failed_step INTEGER,
        error TEXT,
        variables JSONB DEFAULT '{}',
        new_window BOOLEAN DEFAULT false,
        trigger TEXT DEFAULT 'manual'
      );

      CREATE TABLE IF NOT EXISTS execution_steps (
        id SERIAL PRIMARY KEY,
        execution_id INTEGER NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        command TEXT NOT NULL,
        intent TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        duration_ms INTEGER,
        locator_used TEXT,
        error TEXT,
        UNIQUE(execution_id, step_order)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    log('PostgreSQL schema initialized');
  } finally {
    client.release();
  }
}

export { pool };
