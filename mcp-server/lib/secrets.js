// The secrets of a project: a password, an API key, a token a test types without anyone reading
// it — not the agent recording the test, not the logs, not the run's record.
//
// - Kept encrypted (AES-256-GCM), with a key of this machine outside the database:
//   IZITEST_SECRET_KEY (32 bytes, base64), or ~/.izitest/secret.key, made on first use (0600).
// - Written {{secret.NAME}} in a step or a dataset (lib/values.js): worked out by the server
//   just before the extension types it, recording as replaying. The test keeps the reference.
// - IZITEST_SECRET_<NAME>, in the server's environment, is used instead of the stored value:
//   a CI gives its own.
// - Never sent back: the API lists names and descriptions only, and redact() puts the reference
//   back wherever a value would leave the server — a tool's answer to an agent, a log line, a
//   run's variables.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { db } from './db.js';
import { log, setLogFilter } from './logger.js';

/** What a secret may be named: {{secret.NAME}} reads it, an environment variable can replace it. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PREFIX = 'IZITEST_SECRET_';
// A shorter value would be put back as {{secret.…}} in every text that happens to hold it.
const MIN_REDACTED = 4;

// ─── The key ────────────────────────────────────────────────────────

let key = null;

function keyFile() {
  return process.env.IZITEST_SECRET_KEY_FILE || join(process.env.IZITEST_HOME || join(homedir(), '.izitest'), 'secret.key');
}

/**
 * This machine's key, made the first time a secret is saved. `make: false`: null when there is
 * none yet — nothing can be read then, and reading makes nothing.
 */
function secretKey({ make = true } = {}) {
  if (key) return key;
  let found;
  let from;
  let made = false;
  if (process.env.IZITEST_SECRET_KEY) {
    found = Buffer.from(process.env.IZITEST_SECRET_KEY, 'base64');
    from = 'IZITEST_SECRET_KEY';
  } else {
    from = keyFile();
    if (existsSync(from)) {
      found = Buffer.from(readFileSync(from, 'utf8').trim(), 'base64');
    } else if (!make) {
      return null;
    } else {
      mkdirSync(dirname(from), { recursive: true, mode: 0o700 });
      found = randomBytes(32);
      writeFileSync(from, found.toString('base64'), { mode: 0o600 });
      made = true;
    }
  }
  if (found.length !== 32) throw new Error(`${from} does not hold a key of 32 bytes in base64`);
  key = found;
  // Once the key is set: the log line goes through redact(), which may decrypt with it.
  if (made) log(`Secrets: a key was made for this machine in ${from}`);
  return key;
}

// The project and the name are part of what is encrypted (its additional data): a value copied
// to another row does not decrypt there.
function seal(projectId, name, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  cipher.setAAD(Buffer.from(`${projectId}:${name}`));
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function open(projectId, name, sealed) {
  const [version, iv, tag, data] = String(sealed).split(':');
  if (version !== 'v1') throw new Error(`unknown format "${version}"`);
  const found = secretKey({ make: false });
  if (!found) throw new Error(`no key on this machine (${keyFile()})`);
  const decipher = createDecipheriv('aes-256-gcm', found, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(`${projectId}:${name}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Reading and writing them ───────────────────────────────────────

function fromEnvironment(name) {
  const value = process.env[`${ENV_PREFIX}${name}`];
  return value === undefined || value === '' ? undefined : value;
}

/** The secrets of a project, without their values: { name, description, updated_at, from_environment }. */
export function listSecrets(projectId) {
  if (projectId == null) return [];
  return db.prepare('SELECT name, description, updated_at FROM secrets WHERE project_id = ? ORDER BY name').all(projectId)
    .map((row) => ({ ...row, from_environment: fromEnvironment(row.name) !== undefined }));
}

/**
 * Adds a secret to a project, or replaces it: `value` (needed for a new one; left out, the
 * stored one stays) and `description`, what it is for — the agent reads it, not the value.
 * Returns it as listSecrets does, or { error }.
 */
export function saveSecret(projectId, name, { value, description } = {}) {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) return { error: `No project ${projectId}` };
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
    return { error: `A secret's name is letters, digits and _, not starting with a digit: "${name}" is not one (TIIME_PASSWORD is)` };
  }
  const existing = db.prepare('SELECT id FROM secrets WHERE project_id = ? AND name = ?').get(projectId, name);
  const hasValue = typeof value === 'string' && value !== '';
  if (!existing && !hasValue) return { error: `The secret ${name} needs a value` };
  if (value !== undefined && !hasValue) return { error: `The value of ${name} is empty` };
  const text = typeof description === 'string' ? description.trim() : undefined;
  if (existing) {
    db.prepare(`UPDATE secrets SET value = COALESCE(?, value), description = COALESCE(?, description),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(hasValue ? seal(projectId, name, value) : null, text ?? null, existing.id);
  } else {
    db.prepare('INSERT INTO secrets (project_id, name, description, value) VALUES (?, ?, ?, ?)')
      .run(projectId, name, text ?? '', seal(projectId, name, value));
  }
  known = null;
  log(`Secret ${name} of project ${projectId} ${existing ? (hasValue ? 'replaced' : 'described') : 'added'}`);
  return listSecrets(projectId).find((secret) => secret.name === name);
}

/** Deletes a secret of a project: true when there was one. */
export function deleteSecret(projectId, name) {
  const { changes } = db.prepare('DELETE FROM secrets WHERE project_id = ? AND name = ?').run(projectId, name);
  if (changes) {
    known = null;
    log(`Secret ${name} of project ${projectId} deleted`);
  }
  return changes > 0;
}

/**
 * The value of a project's secret — the environment's IZITEST_SECRET_<NAME> first — or
 * undefined. Only for what types it: never for what goes back to an agent or a page of the
 * dashboard.
 */
export function secretValue(projectId, name) {
  const env = fromEnvironment(name);
  if (env !== undefined) return env;
  if (projectId == null) return undefined;
  const row = db.prepare('SELECT value FROM secrets WHERE project_id = ? AND name = ?').get(projectId, name);
  if (!row) return undefined;
  try {
    return open(projectId, name, row.value);
  } catch (err) {
    throw new Error(`The secret ${name} of project ${projectId} cannot be read with this machine's key (${err.message}): enter its value again`);
  }
}

/** What an agent is told of a project's secrets: one line each, its name and what it is for. */
export function secretLines(projectId) {
  return listSecrets(projectId).map((secret) => `- ${secret.name}${secret.description ? `: ${secret.description}` : ''}`);
}

// ─── Putting the reference back ─────────────────────────────────────

// value → name, longest first, of every secret known: those of every project and those of
// the environment. Made again after a change.
let known = null;
let building = false;

function knownValues() {
  if (known) return known;
  if (building) return [];
  building = true;
  try {
    const pairs = new Map();
    for (const [variable, value] of Object.entries(process.env)) {
      if (variable.startsWith(ENV_PREFIX) && value) pairs.set(value, variable.slice(ENV_PREFIX.length));
    }
    let rows = [];
    try {
      rows = db.prepare('SELECT project_id, name, value FROM secrets').all();
    } catch {
      rows = []; // no table yet: the database is being made
    }
    for (const row of rows) {
      try {
        const value = open(row.project_id, row.name, row.value);
        if (!pairs.has(value)) pairs.set(value, row.name);
      } catch {
        // Unreadable with this key: it cannot be typed either.
      }
    }
    const list = [];
    for (const [value, name] of pairs) {
      if (value.length < MIN_REDACTED) continue;
      const reference = `{{secret.${name}}}`;
      list.push([value, reference]);
      // As it reads inside JSON, when that differs: a value with a quote or a backslash.
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) list.push([escaped, reference]);
    }
    known = list.sort((a, b) => b[0].length - a[0].length);
    return known;
  } finally {
    building = false;
  }
}

/**
 * `value` with every secret's value replaced by its reference ({{secret.NAME}}): a text, or the
 * texts in an object or a list (a new one). Images (base64 data) are left as they are.
 */
export function redact(value) {
  const pairs = knownValues();
  if (!pairs.length) return value;
  const walk = (item) => {
    if (typeof item === 'string') {
      let out = item;
      for (const [secret, reference] of pairs) if (out.includes(secret)) out = out.split(secret).join(reference);
      return out;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object' && !Buffer.isBuffer(item)) {
      const out = {};
      for (const [k, v] of Object.entries(item)) out[k] = item.type === 'image' && k === 'data' ? v : walk(v);
      return out;
    }
    return item;
  };
  return walk(value);
}

/** Forgets what redact() knows: after a change made around saveSecret (a test's own database). */
export function forgetKnownSecrets() {
  known = null;
}

/**
 * Patches server.tool so that what every tool answers an agent goes through redact(). Comes
 * first, so it wraps all the others (lib/bench.js, lib/tools/session-scope.js).
 */
export function redactToolResults(server) {
  const registerTool = server.tool.bind(server);
  server.tool = (...args) => {
    const handler = args[args.length - 1];
    if (typeof handler === 'function') {
      args[args.length - 1] = async (...callArgs) => redact(await handler(...callArgs));
    }
    return registerTool(...args);
  };
}

// Every log line too: a value typed shows in a command's parameters.
setLogFilter(redact);
