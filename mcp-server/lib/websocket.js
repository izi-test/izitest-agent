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
const pendingCommands = new Map(); // commandId → { resolve, reject, timeout }
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

/** Where a command that names no profile goes: the first Chrome with windows that connected. */
function defaultWs() {
  for (const [profileId, ws] of profiles) {
    if (!headlessProfiles.has(profileId)) return ws;
  }
  return undefined;
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
          registeredProfileId = msg.profileId;
          profiles.set(msg.profileId, ws);
          if (msg.headless === true) headlessProfiles.add(msg.profileId);
          else headlessProfiles.delete(msg.profileId);
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
            pendingCommands.delete(msg.id);
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
      // A register under the same id from a newer socket replaced this one: it stays.
      if (registeredProfileId && profiles.get(registeredProfileId) === ws) {
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

export function sendCommand(profileId, command, params, timeoutMs = 30000, onProgress = null) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const ws = await waitForProfile(profileId);
        if (!ws) {
          reject(new Error(
            profileId
              ? `Profile "${profileId}" not connected. Connected profiles: ${[...profiles.keys()].join(', ') || 'none'}`
              : profiles.size
                ? `Only the headless browser is connected (${[...profiles.keys()].join(', ')}): name it as the profile to use it, or open Chrome with the IziTest Agent extension.`
                : 'No browser profiles connected. Make sure Chrome is open with the IziTest Agent extension.'
          ));
          return;
        }

        const id = `cmd-${++commandCounter}`;
        const timeout = setTimeout(() => {
          pendingCommands.delete(id);
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        // Live view commands run every few seconds per recorded tab, and after every
        // action: logging them would bury the agents' own commands.
        const quiet = command.startsWith('live_');
        pendingCommands.set(id, { resolve, reject, timeout, onProgress, quiet });

        if (!quiet) {
          const sessionTag = params?.sessionId ? `[${params.sessionId}] ` : '';
          log(`[OUT] ➡️ ${sessionTag}${command}`);
          log(`  Params: ${JSON.stringify(params).substring(0, 500)}`);
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
