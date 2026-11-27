// WebSocket Bridge — manages browser profile connections and command dispatching

import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { log } from './logger.js';
import { isExtensionOrigin } from './origin-guard.js';

const profiles = new Map();       // profileId → ws
// The profiles of a Chrome without windows (lib/headless.js): only for what names them —
// never the profile a command that names none goes to, whatever connected first.
const headlessProfiles = new Set();

// What the extension's service worker logged. Its console is otherwise only visible by
// opening its DevTools by hand, which leaves a test run blind to anything it reports.
const MAX_CLIENT_ERRORS = 100;
const clientErrors = [];

export function getClientErrors() {
  return [...clientErrors];
}

export function clearClientErrors() {
  const n = clientErrors.length;
  clientErrors.length = 0;
  return n;
}
const pendingCommands = new Map(); // commandId → { resolve, reject, timeout, …, work }

// When each browser last had work, and how much it has under way: what tells IziTest's Chrome
// without windows it can stop (lib/headless.js). The server's own upkeep is no work: the live
// view lists the tabs of every browser every few seconds, and films what it shows.
const activity = new Map(); // profileId → { lastAt, inFlight }

function noteWork(profileId, delta) {
  if (!profileId) return;
  const entry = activity.get(profileId) ?? { lastAt: 0, inFlight: 0 };
  entry.lastAt = Date.now();
  entry.inFlight = Math.max(0, entry.inFlight + delta);
  activity.set(profileId, entry);
}

/** A command answered, timed out, or lost with its browser: no longer under way. */
function forgetCommand(id) {
  const pending = pendingCommands.get(id);
  pendingCommands.delete(id);
  if (pending?.work) noteWork(pending.work, -1);
}

/** When the browser of `profileId` last had work, and how many commands it runs: { lastAt, inFlight }, or null. */
export function profileActivity(profileId) {
  const entry = activity.get(profileId);
  return entry ? { ...entry } : null;
}

const profileOf = (ws) => [...profiles].find(([, socket]) => socket === ws)?.[0] ?? null;
const profileEvents = new EventEmitter();
const extensionMessages = new EventEmitter();

/** Called with each message of `type` an extension pushes on its own (no command id). */
export function onExtensionMessage(type, listener) {
  extensionMessages.on(type, listener);
}
let commandCounter = 0;
let wss;

export function getProfiles() {
  return profiles;
}

export function isHeadlessProfile(profileId) {
  return headlessProfiles.has(profileId);
}

/**
 * Gives the profile `from` the name `to`, where it stands among the others: the first Chrome that
 * connected stays where a command naming no profile goes. A profile already named `to` gives way,
 * as it does to a browser registering under its name.
 */
function renameProfile(from, to) {
  const renamed = [...profiles].filter(([id]) => id !== to).map(([id, ws]) => [id === from ? to : id, ws]);
  profiles.clear();
  for (const [id, ws] of renamed) profiles.set(id, ws);
}

/** Where a command that names no profile goes: the first Chrome with windows that connected. */
function defaultWs() {
  for (const [profileId, ws] of profiles) {
    if (!headlessProfiles.has(profileId)) return ws;
  }
  return undefined;
}

/**
 * A command's parameters as the log shows them: what is typed (every `value`) only by its length.
 * The log is read by whoever reaches the server's files; a password an agent types while
 * recording is not known as a secret yet when the command leaves, and a replay carries the values
 * of the secrets it types.
 */
export function loggedParams(params) {
  if (Array.isArray(params)) return params.map(loggedParams);
  if (!params || typeof params !== 'object') return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key,
    key === 'value' && typeof value === 'string' && !/^\{\{.+\}\}$/.test(value) ? `«${value.length} chars»` : loggedParams(value),
  ]));
}

/** Whether a Chrome with windows (the user's, with the extension) is connected. */
export function hasWindowedProfile() {
  return defaultWs() !== undefined;
}

// When no Chrome with windows has the extension — a company laptop that blocks extensions —,
// a command naming no profile goes to IziTest's Chrome without windows instead (lib/headless.js
// sets how: it starts it if it is installed). Not while the user's Chrome was connected moments
// ago: its extension reconnects after a restart of its service worker, and the agent's session
// would move to another browser in the middle of its work.
const WINDOWED_GRACE_MS = 30_000;
let windowedSeenAt = Date.now();
let fallbackBrowser = null;

/** How to get a browser when no Chrome with windows is there: a function resolving to a profile, or null. */
export function setFallbackBrowser(provider) {
  fallbackBrowser = provider;
}

// How to get the browser a command names when it is not running: lib/headless.js starts its
// Chrome without windows, stopped when it had nothing to do (a function of the profile named,
// resolving once it is connected; null for a profile that is no Chrome of its own).
let profileStarter = null;

export function setProfileStarter(starter) {
  profileStarter = starter;
}

/**
 * The profile a command naming `profileId` goes to: that one — started if it is IziTest's Chrome
 * without windows, stopped —; naming none, the user's Chrome — or, none connected for a while, the
 * fallback browser when there is one (undefined otherwise). The server's own upkeep (`upkeep`: the
 * live view's) never starts a browser.
 */
export async function routeProfile(profileId, now = Date.now(), { upkeep = false } = {}) {
  if (profileId) {
    if (!upkeep && profileStarter) {
      await profileStarter(profileId)?.catch((err) => log(`Starting the browser of profile "${profileId}": ${err.message}`));
    }
    return profileId;
  }
  if (defaultWs() || !fallbackBrowser || upkeep) return profileId;
  if (now - windowedSeenAt < WINDOWED_GRACE_MS) return profileId;
  return (await fallbackBrowser().catch((err) => {
    log(`Fallback browser: ${err.message}`);
    return null;
  })) ?? undefined;
}

/** For tests: a Chrome with windows last seen at `at`. */
export function markWindowedSeen(at = Date.now()) {
  windowedSeenAt = at;
}

export function closeWebSocket() {
  if (wss) wss.close();
}

// IziTest Agent is a single shared server that many agents connect to at once, so the port
// being taken means a usable instance is already running — never a zombie to kill. The old
// behaviour here (lsof | xargs kill -9) made two agents starting in parallel kill each
// other's bridge, which is exactly what parallel sessions must not do.
export function startWebSocketServer(port) {
  wss = new WebSocketServer({
    port,
    host: '127.0.0.1',
    // Any page open in the piloted Chrome can open a WebSocket to 127.0.0.1. Registered as
    // a profile, it would receive the commands meant for the extension (values typed,
    // cookies read) and answer them. See origin-guard.js.
    verifyClient: ({ origin }) => {
      if (isExtensionOrigin(origin)) return true;
      log(`WebSocket refused: origin "${origin}" is not an extension`);
      return false;
    },
  });

  wss.on('listening', () => {
    log(`WebSocket bridge listening on port ${port}`);
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} is already in use: another IziTest Agent server is running. ` +
          `Connect to it instead of starting a second one (see bin/ensure-server.js). Exiting.`);
      process.exit(1);
    } else {
      log(`WebSocket error: ${err.message}`);
    }
  });

  wss.on('connection', (ws) => {
    let registeredProfileId = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'register') {
          // The same browser under another name (its profile renamed in the extension's popup):
          // its former name is no longer a profile. Kept, it stayed listed until the server
          // restarted and, that browser closed, what names no profile waited for it.
          if (registeredProfileId && registeredProfileId !== msg.profileId && profiles.get(registeredProfileId) === ws) {
            renameProfile(registeredProfileId, msg.profileId);
            headlessProfiles.delete(registeredProfileId);
            log(`Profile renamed: ${registeredProfileId} → ${msg.profileId}`);
          }
          registeredProfileId = msg.profileId;
          profiles.set(msg.profileId, ws);
          // Just started: as if it had just had work, not idle since it last ran.
          activity.set(msg.profileId, { lastAt: Date.now(), inFlight: 0 });
          if (msg.headless === true) headlessProfiles.add(msg.profileId);
          else {
            headlessProfiles.delete(msg.profileId);
            windowedSeenAt = Date.now();
          }
          profileEvents.emit('connected', msg.profileId);
          log(`Profile registered: ${msg.profileId}`);
        }

        // Keepalive ping from the extension — just ignore (keeps the WS alive)
        if (msg.type === 'ping') {
          return;
        }

        if (msg.type === 'client_error') {
          const entry = {
            kind: String(msg.kind || 'error'),
            message: String(msg.message || ''),
            stack: msg.stack ? String(msg.stack) : undefined,
            profileId: registeredProfileId,
            at: new Date(Number(msg.at) || Date.now()).toISOString(),
          };
          clientErrors.push(entry);
          if (clientErrors.length > MAX_CLIENT_ERRORS) clientErrors.shift();
          log(`[EXT] ${entry.kind}: ${entry.message}`);
          return;
        }

        // Unsolicited messages with no command id (live view frames, …).
        if (msg.type && !msg.id && extensionMessages.listenerCount(msg.type)) {
          extensionMessages.emit(msg.type, msg, registeredProfileId);
          return;
        }

        if (msg.type === 'progress') {
          const pending = pendingCommands.get(msg.id);
          if (pending && pending.onProgress) {
            pending.onProgress(msg.data);
          }
        }

        if (msg.type === 'result') {
          const pending = pendingCommands.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            forgetCommand(msg.id);
            if (msg.error) {
              if (!pending.quiet) log(`[IN]  ❌ Error for ${msg.id}: ${msg.error}`);
              pending.reject(new Error(msg.error));
            } else if (pending.quiet) {
              pending.resolve(msg.result);
            } else {
              const resStr = JSON.stringify(msg.result);
              log(`[IN]  ✅ Success for ${msg.id}. Output: ${resStr ? resStr.substring(0, 100) + (resStr.length > 100 ? '...' : '') : 'none'}`);
              pending.resolve(msg.result);
            }
          }
        }
      } catch (err) {
        log(`WS parse error: ${err.message}`);
      }
    });

    ws.on('close', () => {
      // A command sent over this socket gets no answer now: told at once, not at its timeout
      // (a replay waited its 120 s for a Chrome stopped under it).
      for (const [id, pending] of pendingCommands) {
        if (pending.ws !== ws) continue;
        clearTimeout(pending.timeout);
        forgetCommand(id);
        pending.reject(new Error(`The browser${registeredProfileId ? ` of profile "${registeredProfileId}"` : ''} disconnected while it ran ${pending.command}: it was closed, stopped or reloaded`));
      }
      // A register under the same id from a newer socket replaced this one: it stays.
      if (registeredProfileId && profiles.get(registeredProfileId) === ws) {
        if (!headlessProfiles.has(registeredProfileId)) windowedSeenAt = Date.now();
        profiles.delete(registeredProfileId);
        headlessProfiles.delete(registeredProfileId);
        log(`Profile disconnected: ${registeredProfileId}`);
      }
    });
  });
}

// Wait for the profile named — or, naming none, a Chrome with windows — to connect (up to waitMs)
export function waitForProfile(profileId, waitMs = 8000) {
  return new Promise((resolve) => {
    const getWs = () => profileId ? profiles.get(profileId) : defaultWs();
    const ws = getWs();
    if (ws && ws.readyState === 1) return resolve(ws);

    const timer = setTimeout(() => {
      profileEvents.removeListener('connected', onConnected);
      resolve(null);
    }, waitMs);

    function onConnected() {
      const ws = getWs();
      if (ws && ws.readyState === 1) {
        clearTimeout(timer);
        profileEvents.removeListener('connected', onConnected);
        resolve(ws);
      }
    }

    profileEvents.on('connected', onConnected);
  });
}

/**
 * Sends `command` to the browser of `profileId` (naming none: routeProfile), resolving with its
 * answer. `upkeep`: a command of the server's own upkeep (the live view's, every `live_*`), which
 * starts no browser and is no work that keeps one running (profileActivity).
 */
export function sendCommand(profileId, command, params, timeoutMs = 30000, onProgress = null, { upkeep = false } = {}) {
  upkeep ||= command.startsWith('live_');
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const asked = profileId;
        profileId = await routeProfile(profileId, Date.now(), { upkeep });
        const ws = await waitForProfile(profileId);
        if (!ws) {
          reject(new Error(
            asked
              ? `Profile "${asked}" not connected. Connected profiles: ${[...profiles.keys()].join(', ') || 'none'}`
              : profileId
                ? `No Chrome with the IziTest Agent extension is connected, and IziTest's browser without windows did not start either: ${[...profiles.keys()].join(', ') || 'nothing is connected'}.`
                : profiles.size
                  ? `Only the headless browser is connected (${[...profiles.keys()].join(', ')}): name it as the profile to use it, or open Chrome with the IziTest Agent extension.`
                  : 'No browser profiles connected. Open Chrome with the IziTest Agent extension — or, where Chrome may not have extensions, install IziTest\'s browser without windows (dashboard: Settings → Headless browser → Install): the agent then works there.'
          ));
          return;
        }

        const id = `cmd-${++commandCounter}`;
        const timeout = setTimeout(() => {
          forgetCommand(id);
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        // Live view commands run every few seconds per recorded tab, and after every
        // action: logging them would bury the agents' own commands.
        const quiet = command.startsWith('live_');
        const work = upkeep ? null : (profileId ?? profileOf(ws));
        noteWork(work, +1);
        pendingCommands.set(id, { resolve, reject, timeout, onProgress, quiet, ws, command, work });

        if (!quiet) {
          const sessionTag = params?.sessionId ? `[${params.sessionId}] ` : '';
          log(`[OUT] ➡️ ${sessionTag}${command}`);
          log(`  Params: ${JSON.stringify(loggedParams(params)).substring(0, 500)}`);
        }

        ws.send(JSON.stringify({ type: 'command', id, command, params }));
      } catch (err) {
        reject(err);
      }
    })();
  });
}

/** Fire-and-forget message to one extension. Returns false when it is not connected. */
export function sendToProfile(profileId, message) {
  const ws = profileId ? profiles.get(profileId) : defaultWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(message));
  return true;
}

/** Same, to every connected extension. Returns how many received it. */
export function broadcastToExtensions(message, { except = [] } = {}) {
  let sent = 0;
  for (const [profileId, ws] of profiles) {
    if (except.includes(profileId)) continue;
    if (ws.readyState === 1) { ws.send(JSON.stringify(message)); sent++; }
  }
  return sent;
}

/** Called with the profile id each time an extension (re)registers. */
export function onProfileRegistered(listener) {
  profileEvents.on('connected', listener);
}

/**
 * Resolves true when any extension registers again within the timeout.
 *
 * This is how a reload is confirmed rather than assumed: a reloaded extension drops its
 * socket and comes back with a fresh `register`. An extension running a build that does
 * not know the reload message simply ignores it and never re-registers, so the caller
 * learns the reload did not happen instead of being told it did.
 *
 * Start waiting BEFORE pushing the reload: the round trip can be faster than this call.
 */
export function waitForProfileReregister(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      profileEvents.removeListener('connected', onConnected);
      resolve(false);
    }, timeoutMs);

    function onConnected() {
      clearTimeout(timer);
      profileEvents.removeListener('connected', onConnected);
      resolve(true);
    }

    profileEvents.on('connected', onConnected);
  });
}

export function pushOverlayState(profileId, state, tabId = null) {
  const ws = getProfiles().get(profileId) || defaultWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'set_overlay_state', state, tabId }));
  }
}
