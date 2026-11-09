// A Chrome without windows, to replay tests out of the user's sight: a campaign or a run asked
// "headless" goes to it, and the user's Chrome keeps its windows and its focus.
//
// It is Chrome for Testing — the Chrome of Google's own builds no longer loads an unpacked
// extension from the command line —, installed here on request (~/.izitest/browsers), started
// with the extension of this repository and a profile of its own (~/.izitest/profiles/headless),
// and stopped with the server. Its extension registers as the "headless" profile
// (extension/src/headless.ts), which a command naming no profile never goes to (websocket.js).
//
// Its profile is its own: cookies, logins and storage are not the user's Chrome's. A test of
// an app behind a login logs in itself.
//
// A campaign run a few at a time starts one per lane, each with a profile of its own
// (~/.izitest/profiles/headless-2, …) and registering under its name (headless-2, …): the
// windows of one Chrome share its cookies, and a test logging in as a manager logged out the
// one next to it, logged in as an employee. Each Chrome is told its name by the page it starts
// on (data:text/html,headless-2#izitest-profile=headless-2: Chrome opens a
// new tab in place of an about:blank given on its command line).

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from '@puppeteer/browsers';
import { getProfiles, waitForProfile } from './websocket.js';
import { log } from './logger.js';

export const HEADLESS_PROFILE = 'headless';
// As many as a campaign has lanes, at most (lib/campaigns.js).
export const HEADLESS_LANES = 6;

const HOME = process.env.IZITEST_HOME || join(homedir(), '.izitest');
export const BROWSERS_DIR = join(HOME, 'browsers');
/** The profile lane `n` registers as: headless, then headless-2, headless-3… */
export const laneProfile = (n = 1) => (n <= 1 ? HEADLESS_PROFILE : `${HEADLESS_PROFILE}-${n}`);
/** Where the Chrome of lane `n` keeps its profile: cookies, logins, storage. */
export const laneDir = (n = 1) => join(HOME, 'profiles', laneProfile(n));
export const PROFILE_DIR = laneDir(1);
export const EXTENSION_DIR = process.env.IZITEST_EXTENSION_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'dist');
const pidFile = (n) => join(laneDir(n), 'izitest-headless.pid');

// How long the extension of a Chrome just started takes to connect, at most.
const CONNECT_TIMEOUT_MS = 30_000;

// Per lane: the Chrome started here, and its start under way.
const children = new Map();
const startings = new Map();
let installing = null;   // { promise, downloaded, total }
let lastError = null;

/**
 * The arguments Chrome is started with: no window, this extension only, a profile of its own,
 * and the page that tells its extension which profile it is.
 */
export function chromeArgs({ profileDir = PROFILE_DIR, extensionDir = EXTENSION_DIR, profile = HEADLESS_PROFILE } = {}) {
  return [
    '--headless',
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // The extension's debugger is the point: no infobar about it.
    '--silent-debugger-extension-api',
    // Nobody looks at these pages: nothing of them is slowed down for being out of sight.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1440,900',
    `data:text/html,${profile}#izitest-profile=${profile}`,
  ];
}

/** Sends a run's commands that name no profile to the headless Chrome — of lane `profile`. */
export function inHeadless(sendCommand, profile = HEADLESS_PROFILE) {
  return (name, command, params, ...rest) => sendCommand(name ?? profile, command, params, ...rest);
}

/** The newest Chrome for Testing installed here, or null. */
async function installedChrome() {
  const browsers = await getInstalledBrowsers({ cacheDir: BROWSERS_DIR }).catch(() => []);
  const chromes = browsers.filter((b) => b.browser === Browser.CHROME)
    .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }));
  return chromes[0] ?? null;
}

export function isHeadlessConnected(n = 1) {
  return getProfiles().has(laneProfile(n));
}

/** The lanes whose Chrome is connected. */
const connectedLanes = () => Array.from({ length: HEADLESS_LANES }, (_, i) => i + 1).filter((n) => isHeadlessConnected(n));

/** Where the headless Chrome stands: installed (which version), being installed, running, connected. */
export async function headlessStatus() {
  const chrome = await installedChrome();
  return {
    installed: chrome ? { version: chrome.buildId } : null,
    installing: installing ? { downloaded: installing.downloaded, total: installing.total } : null,
    starting: startings.size > 0,
    running: children.size > 0 || isHeadlessConnected(),
    connected: isHeadlessConnected(),
    // Lanes 2… run for a campaign, a few tests at a time, and stop after it.
    lanes: connectedLanes().map(laneProfile),
    extension_built: existsSync(join(EXTENSION_DIR, 'manifest.json')),
    error: lastError,
    browsers_dir: BROWSERS_DIR,
    profile_dir: PROFILE_DIR,
  };
}

/** Downloads Chrome for Testing, its stable version, once (~150 MB). Resolves when it is there. */
export function installHeadless() {
  if (installing) return installing.promise;
  lastError = null;
  const state = { downloaded: 0, total: 0, promise: null };
  state.promise = (async () => {
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error('This platform has no Chrome for Testing');
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    log(`Headless: installing Chrome for Testing ${buildId} in ${BROWSERS_DIR}`);
    mkdirSync(BROWSERS_DIR, { recursive: true });
    await install({
      browser: Browser.CHROME, buildId, cacheDir: BROWSERS_DIR,
      downloadProgressCallback: (downloaded, total) => { state.downloaded = downloaded; state.total = total; },
    });
    log(`Headless: Chrome for Testing ${buildId} installed`);
    return buildId;
  })().catch((err) => {
    lastError = `Install failed: ${err.message}`;
    log(`Headless: ${lastError}`);
    throw err;
  }).finally(() => { installing = null; });
  installing = state;
  return state.promise;
}

/** Starts the headless Chrome of lane `n`, and resolves once its extension has connected. */
export function startHeadless(n = 1) {
  if (isHeadlessConnected(n)) return Promise.resolve();
  if (startings.has(n)) return startings.get(n);
  const profile = laneProfile(n);
  const starting = (async () => {
    lastError = null;
    const chrome = await installedChrome();
    if (!chrome) throw new Error('No headless browser installed yet: Settings → Headless browser → Install (or POST /api/headless/install)');
    if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error(`The extension is not built (${EXTENSION_DIR}): run npm run build in extension/`);
    }
    const profileDir = laneDir(n);
    mkdirSync(profileDir, { recursive: true });
    log(`Headless: starting Chrome for Testing ${chrome.buildId}${n > 1 ? ` (${profile})` : ''}`);
    const proc = spawn(chrome.executablePath, chromeArgs({ profileDir, profile }), { stdio: 'ignore' });
    children.set(n, proc);
    writeFileSync(pidFile(n), String(proc.pid));
    proc.on('exit', (code, signal) => {
      if (children.get(n) === proc) children.delete(n);
      rmSync(pidFile(n), { force: true });
      log(`Headless: Chrome${n > 1 ? ` ${profile}` : ''} stopped (${signal ?? `code ${code}`})`);
    });
    proc.on('error', (err) => { lastError = `Chrome did not start: ${err.message}`; });

    const ws = await waitForProfile(profile, CONNECT_TIMEOUT_MS);
    if (!ws) {
      proc.kill('SIGKILL');
      throw new Error(lastError ?? `The headless Chrome started, but its extension did not connect within ${CONNECT_TIMEOUT_MS / 1000}s`);
    }
    log(`Headless: connected${n > 1 ? ` (${profile})` : ''}`);
  })().catch((err) => {
    lastError = err.message;
    log(`Headless: ${err.message}`);
    throw err;
  }).finally(() => { startings.delete(n); });
  startings.set(n, starting);
  return starting;
}

/** The headless Chromes of lanes 1 to `lanes`, connected: started if they are not. */
export async function ensureHeadless(lanes = 1) {
  const count = Math.min(Math.max(1, lanes), HEADLESS_LANES);
  await Promise.all(Array.from({ length: count }, (_, i) => i + 1).filter((n) => !isHeadlessConnected(n)).map((n) => startHeadless(n)));
}

/** Stops the Chrome of lane `n` — the one started here, or one a previous server left running. */
async function stopLane(n) {
  const proc = children.get(n);
  if (proc) {
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    const done = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    if (!done) proc.kill('SIGKILL');
    return;
  }
  // Left by a server that stopped without closing it: its pid is kept in its profile.
  const file = pidFile(n);
  const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    rmSync(file, { force: true });
  }
}

/** Stops the headless Chromes: all of them, or those of the lanes from `from` on (a campaign's). */
export async function stopHeadless({ from = 1 } = {}) {
  const lanes = Array.from({ length: HEADLESS_LANES }, (_, i) => i + 1).filter((n) => n >= from);
  await Promise.all(lanes.map((n) => stopLane(n)));
}

// It goes with the server.
process.on('exit', () => { for (const proc of children.values()) proc.kill('SIGTERM'); });
