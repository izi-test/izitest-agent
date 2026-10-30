#!/usr/bin/env node

// Make sure exactly one IziTest Agent server is running, then exit.
//
// IziTest Agent is a single shared server that many agents connect to at once: one
// WebSocket bridge to Chrome, one session per connected agent. Two agents starting it at
// the same moment used to fight over port 3466 — so this script is the only supported way
// to start it from an agent, and it is safe to run concurrently.
//
//   node bin/ensure-server.js          # start it if needed, wait until it answers
//   node bin/ensure-server.js --quiet  # same, without the log lines
//
// Exit code 0 means a healthy server is listening; anything else means it could not be
// started, and the reason is on stderr.

import { spawn } from 'child_process';
import { openSync, closeSync, writeSync, statSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.js');
const LOG_DIR = join(__dirname, '..', 'data');
const LOG_FILE = join(LOG_DIR, 'server.log');

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3467;
const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';

// Probe every interface the server may answer on. It always binds loopback, but a setup
// with MCP_HOST (a LAN or Tailscale address) also answers there — and a server started
// before loopback was served answers *only* there. Missing it would start a second
// instance, which is exactly what parallel sessions must not get.
const asHost = (host) => (host.includes(':') ? `[${host}]` : host); // IPv6 literal
const HEALTH_URLS = [...new Set(['127.0.0.1', MCP_HOST])]
  .map((host) => `http://${asHost(host)}:${MCP_PORT}/health`);
const HEALTH_URL = HEALTH_URLS[0];
const LOCK_FILE = join(tmpdir(), `izitest-agent-${MCP_PORT}.lock`);

const QUIET = process.argv.includes('--quiet');
const STARTUP_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 200;
// A lock older than this was left behind by a process that died before releasing it.
const LOCK_STALE_MS = 60000;

const say = (msg) => { if (!QUIET) console.error(`[ensure-server] ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isHealthy() {
  for (const url of HEALTH_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* try the next interface */ }
  }
  return false;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive create ('wx' fails if the file exists): the one caller that wins gets to spawn
 * the server, every other one waits for it. This is the whole race protection.
 */
function acquireLock() {
  let fd;
  try {
    fd = openSync(LOCK_FILE, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

function clearStaleLock() {
  if (!existsSync(LOCK_FILE)) return;
  let holder = null;
  let age = Infinity;
  try {
    holder = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    age = Date.now() - statSync(LOCK_FILE).mtimeMs;
  } catch { /* unreadable lock: treat as stale */ }

  const holderGone = !Number.isInteger(holder) || !processAlive(holder);
  if (holderGone || age > LOCK_STALE_MS) {
    say(`clearing stale lock (holder ${holder ?? 'unknown'}${holderGone ? ' is gone' : ''})`);
    try { unlinkSync(LOCK_FILE); } catch { /* another caller got there first */ }
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

function spawnServer() {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  closeSync(out);
  return child.pid;
}

async function main() {
  if (await isHealthy()) {
    say(`already running on ${HEALTH_URL}`);
    return 0;
  }

  clearStaleLock();

  if (!acquireLock()) {
    // Someone else is starting it right now — wait for their server rather than racing.
    say('another process is starting the server, waiting for it...');
    if (await waitForHealth(STARTUP_TIMEOUT_MS)) return 0;
    console.error(`[ensure-server] the other process did not bring the server up within ${STARTUP_TIMEOUT_MS}ms.`);
    return 1;
  }

  try {
    const pid = spawnServer();
    say(`started server (pid ${pid}), logging to ${LOG_FILE}`);
    if (await waitForHealth(STARTUP_TIMEOUT_MS)) {
      say(`healthy on ${HEALTH_URL}`);
      return 0;
    }
    console.error(`[ensure-server] server did not answer ${HEALTH_URL} within ${STARTUP_TIMEOUT_MS}ms. See ${LOG_FILE}.`);
    return 1;
  } finally {
    releaseLock();
  }
}

process.exit(await main());
