// A Chrome without windows, to replay tests out of the user's sight: a campaign or a run asked
// "headless" goes to it, and the user's Chrome keeps its windows and its focus.
//
// It is Chrome for Testing — the Chrome of Google's own builds no longer loads an unpacked
// extension from the command line —, installed here on request (~/.izitest/browsers), started
// with the extension of this repository and a profile of its own (~/.izitest/profiles/headless),
// and stopped with the server — or before, after minutes without work (idle stop, below): it
// starts again with what needs it. Its extension registers as the "headless" profile
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
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from '@puppeteer/browsers';
import { getProfiles, waitForProfile, setFallbackBrowser, setProfileStarter, profileActivity, hasWindowedProfile } from './websocket.js';
import { listSessions } from './session.js';
import { db, parseJson } from './db.js';
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
// Which build of the extension a profile's Chrome last started with: a digest of its background.js.
const BUILD_FILE = 'izitest-extension-build';

// How long the extension of a Chrome just started takes to connect, at most.
const CONNECT_TIMEOUT_MS = 30_000;

// Per lane: the Chrome started here, and its start under way.
const children = new Map();
const startings = new Map();
let installing = null;   // { promise, downloaded, total }
let lastError = null;
// Idle stop (below): the runs and campaigns under way in it, and its stop under way.
let holds = 0;
let idleStop = null;

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

/**
 * Makes a profile's Chrome run the extension as built now, not as it last ran there. Returns
 * whether it had to.
 *
 * Chrome keeps an extension's service worker in the profile, its script included, and registers it
 * again only when the extension's version changes. The headless Chrome is stopped and started
 * again, never reloaded (a reload left its extension disabled): every build since a profile's first
 * start, all of version 1.1.0, was never run there. Seen: the headless Chrome ran a build four days
 * old, without the fixes made since, the one of its navigate's 15 s wait among them.
 *
 * When background.js has changed since the last start, the profile's service workers are dropped,
 * and Chrome registers the extension's again from the build on disk. Those of the sites tested go
 * with them (and their Cache Storage); cookies, logins and storage stay.
 */
export function forgetStaleExtension({ profileDir = PROFILE_DIR, extensionDir = EXTENSION_DIR } = {}) {
  const build = createHash('sha256').update(readFileSync(join(extensionDir, 'background.js'))).digest('hex');
  const file = join(profileDir, BUILD_FILE);
  if (existsSync(file) && readFileSync(file, 'utf8').trim() === build) return false;
  rmSync(join(profileDir, 'Default', 'Service Worker'), { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(file, build);
  return true;
}

/** Sends a run's commands that name no profile to the headless Chrome — of lane `profile`. */
export function inHeadless(sendCommand, profile = HEADLESS_PROFILE) {
  return (name, command, params, ...rest) => sendCommand(name ?? profile, command, params, ...rest);
}

/**
 * The newest Chrome for Testing installed here, or null. IZITEST_CHROME_PATH names one installed
 * by hand instead — where the download is blocked (a company network): unzipped from
 * https://googlechromelabs.github.io/chrome-for-testing/, its chrome.exe / chrome binary.
 */
async function installedChrome() {
  const own = process.env.IZITEST_CHROME_PATH;
  if (own) {
    if (existsSync(own)) return { executablePath: own, buildId: 'IZITEST_CHROME_PATH' };
    lastError = `IZITEST_CHROME_PATH names no file: ${own}`;
    return null;
  }
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
    // Stopped after that many minutes without work; 0: only with the server.
    idle_minutes: idleMinutes(),
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
  // Stopping for having had nothing to do: started again once it has stopped.
  if (idleStop) return idleStop.then(() => startHeadless(n));
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
    // Each lane's profile keeps the build it last ran: each is told of a new one.
    if (forgetStaleExtension({ profileDir })) log(`Headless: the extension was built again since the last start${n > 1 ? ` of ${profile}` : ''}, Chrome registers its new build`);
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
  if (idleStop) await idleStop;
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
  } else {
    // Left by a server that stopped without closing it: its pid is kept in its profile.
    const file = pidFile(n);
    const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      rmSync(file, { force: true });
    }
  }
  // Until its extension is seen gone: started again right after, it would be taken for running.
  for (const until = Date.now() + 3000; isHeadlessConnected(n) && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Stops the headless Chromes: all of them, or those of the lanes from `from` on (a campaign's). */
export async function stopHeadless({ from = 1 } = {}) {
  const lanes = Array.from({ length: HEADLESS_LANES }, (_, i) => i + 1).filter((n) => n >= from);
  await Promise.all(lanes.map((n) => stopLane(n)));
}

// No Chrome with the extension (a company laptop that blocks extensions): what names no
// browser — the agent recording a test, a run — goes to this one, started if it is installed.
// It is never downloaded unasked: installing it (Settings → Headless browser) is the go-ahead.
// The user follows the agent in the dashboard's Live page (/watch).
let toldFallback = false;
export async function fallbackBrowser() {
  if (idleStop) await idleStop;
  if (isHeadlessConnected(1)) return HEADLESS_PROFILE;
  if (!(await installedChrome())) return null;
  if (!toldFallback) {
    log('Headless: no Chrome with the IziTest extension is connected — what names no browser goes to the browser without windows');
    toldFallback = true;
  }
  await startHeadless(1);
  return HEADLESS_PROFILE;
}
setFallbackBrowser(fallbackBrowser);

// ─── Idle stop ──────────────────────────────────────────────────────
//
// Left running between two runs, it is a Chrome of some 750 MB on the user's computer, for
// nothing. Stopped after `idleMinutes` (Settings → Headless browser; 0: never) without work —
// no command sent to it or under way, no run or campaign in it (holdHeadless), no test being
// recorded in it —, every lane. What needs it starts it again: a run asked headless, a
// campaign, an agent that names it (below) or that has no other browser (fallbackBrowser). The
// live view's upkeep is no work (websocket.js): it lists every browser's tabs every 3 s.

export const DEFAULT_IDLE_MINUTES = 10;
export const MAX_IDLE_MINUTES = 24 * 60;
const IDLE_CHECK_MS = 30_000;

/** The minutes without work after which the headless Chromes stop; 0: never. */
export function idleMinutes() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'headless'").get();
    const minutes = row ? parseJson(row.value)?.idleMinutes : undefined;
    return Number.isInteger(minutes) && minutes >= 0 ? minutes : DEFAULT_IDLE_MINUTES;
  } catch {
    return DEFAULT_IDLE_MINUTES; // no database (unit tests)
  }
}

/** Keeps the minutes of the idle stop (an integer, 0 to MAX_IDLE_MINUTES). */
export function setIdleMinutes(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_IDLE_MINUTES) {
    throw new Error(`idle_minutes is a whole number of minutes, 0 (never) to ${MAX_IDLE_MINUTES}`);
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('headless', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(JSON.stringify({ idleMinutes: minutes }));
}

/**
 * A run or a campaign in the headless Chrome: it is not stopped for being idle — between two
 * tests, a test waiting — until the function returned is called.
 */
export function holdHeadless() {
  holds++;
  let released = false;
  return () => {
    if (!released) { released = true; holds--; }
  };
}

/** The lane `profile` names (headless: 1, headless-2: 2…), or null: no headless Chrome's. */
export function laneOf(profile) {
  const n = Array.from({ length: HEADLESS_LANES }, (_, i) => i + 1).find((lane) => laneProfile(lane) === profile);
  return n ?? null;
}

/**
 * A test being recorded in a headless Chrome: in the profile its session names, or — naming
 * none — where its commands go when no Chrome with windows is there. Between two of its
 * commands, the agent may wait for the user's answer (ask_user) longer than the idle delay.
 */
const recordingInHeadless = () => listSessions().some((s) => s.recording && (s.profile ? laneOf(s.profile) !== null : !hasWindowedProfile()));

/**
 * Stops the headless Chromes when none has had work for `minutes`, at `now`. Resolves whether it
 * did.
 */
export async function stopWhenIdle({ now = Date.now(), minutes = idleMinutes() } = {}) {
  if (!minutes || idleStop || startings.size || holds > 0) return false;
  const lanes = connectedLanes();
  if (!lanes.length || recordingInHeadless()) return false;
  const busy = lanes.some((n) => {
    const work = profileActivity(laneProfile(n));
    return work && (work.inFlight > 0 || now - work.lastAt < minutes * 60_000);
  });
  if (busy) return false;
  log(`Headless: stopped after ${minutes} min without work — it starts again with the next run that needs it`);
  idleStop = stopHeadless()
    .catch((err) => log(`Headless: the idle stop failed: ${err.message}`))
    .finally(() => { idleStop = null; });
  await idleStop;
  return true;
}
setInterval(() => { stopWhenIdle().catch(() => {}); }, IDLE_CHECK_MS).unref();

// A command naming a headless profile that is not running starts its Chrome (installed: the
// go-ahead), as the fallback does: an agent working in "headless" finds it again after an idle stop.
setProfileStarter((profile) => {
  const n = laneOf(profile);
  if (n === null || (!idleStop && isHeadlessConnected(n))) return null;
  return installedChrome().then((chrome) => (chrome ? startHeadless(n) : undefined));
});

// It goes with the server.
process.on('exit', () => { for (const proc of children.values()) proc.kill('SIGTERM'); });
