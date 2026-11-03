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

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from '@puppeteer/browsers';
import { getProfiles, waitForProfile } from './websocket.js';
import { log } from './logger.js';

export const HEADLESS_PROFILE = 'headless';

const HOME = process.env.IZITEST_HOME || join(homedir(), '.izitest');
export const BROWSERS_DIR = join(HOME, 'browsers');
export const PROFILE_DIR = join(HOME, 'profiles', HEADLESS_PROFILE);
export const EXTENSION_DIR = process.env.IZITEST_EXTENSION_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'dist');
const PID_FILE = join(PROFILE_DIR, 'izitest-headless.pid');

// How long the extension of a Chrome just started takes to connect, at most.
const CONNECT_TIMEOUT_MS = 30_000;

let child = null;
let installing = null;   // { promise, downloaded, total }
let starting = null;
let lastError = null;

/** The arguments Chrome is started with: no window, this extension only, a profile of its own. */
export function chromeArgs({ profileDir = PROFILE_DIR, extensionDir = EXTENSION_DIR } = {}) {
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
    'about:blank',
  ];
}

/** Sends a run's commands that name no profile to the headless Chrome. */
export function inHeadless(sendCommand) {
  return (profile, command, params, ...rest) => sendCommand(profile ?? HEADLESS_PROFILE, command, params, ...rest);
}

/** The newest Chrome for Testing installed here, or null. */
async function installedChrome() {
  const browsers = await getInstalledBrowsers({ cacheDir: BROWSERS_DIR }).catch(() => []);
  const chromes = browsers.filter((b) => b.browser === Browser.CHROME)
    .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }));
  return chromes[0] ?? null;
}

export function isHeadlessConnected() {
  return getProfiles().has(HEADLESS_PROFILE);
}

/** Where the headless Chrome stands: installed (which version), being installed, running, connected. */
export async function headlessStatus() {
  const chrome = await installedChrome();
  return {
    installed: chrome ? { version: chrome.buildId } : null,
    installing: installing ? { downloaded: installing.downloaded, total: installing.total } : null,
    starting: !!starting,
    running: !!child || isHeadlessConnected(),
    connected: isHeadlessConnected(),
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

/** Starts the headless Chrome, and resolves once its extension has connected. */
export function startHeadless() {
  if (isHeadlessConnected()) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    lastError = null;
    const chrome = await installedChrome();
    if (!chrome) throw new Error('No headless browser installed yet: Settings → Headless browser → Install (or POST /api/headless/install)');
    if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error(`The extension is not built (${EXTENSION_DIR}): run npm run build in extension/`);
    }
    mkdirSync(PROFILE_DIR, { recursive: true });
    log(`Headless: starting Chrome for Testing ${chrome.buildId}`);
    const proc = spawn(chrome.executablePath, chromeArgs(), { stdio: 'ignore' });
    child = proc;
    writeFileSync(PID_FILE, String(proc.pid));
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      rmSync(PID_FILE, { force: true });
      log(`Headless: Chrome stopped (${signal ?? `code ${code}`})`);
    });
    proc.on('error', (err) => { lastError = `Chrome did not start: ${err.message}`; });

    const ws = await waitForProfile(HEADLESS_PROFILE, CONNECT_TIMEOUT_MS);
    if (!ws) {
      proc.kill('SIGKILL');
      throw new Error(lastError ?? `The headless Chrome started, but its extension did not connect within ${CONNECT_TIMEOUT_MS / 1000}s`);
    }
    log('Headless: connected');
  })().catch((err) => {
    lastError = err.message;
    log(`Headless: ${err.message}`);
    throw err;
  }).finally(() => { starting = null; });
  return starting;
}

/** The headless Chrome, connected: started if it is not. */
export async function ensureHeadless() {
  if (!isHeadlessConnected()) await startHeadless();
}

/** Stops the headless Chrome — the one started here, or one a previous server left running. */
export async function stopHeadless() {
  const proc = child;
  if (proc) {
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    const done = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    if (!done) proc.kill('SIGKILL');
    return;
  }
  // Left by a server that stopped without closing it: its pid is kept in its profile.
  const pid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8')) : null;
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    rmSync(PID_FILE, { force: true });
  }
}

// It goes with the server.
process.on('exit', () => child?.kill('SIGTERM'));
