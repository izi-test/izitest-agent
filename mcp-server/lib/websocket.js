// WebSocket Bridge — manages browser profile connections and command dispatching

import { WebSocketServer } from 'ws';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { log } from './logger.js';

const profiles = new Map();       // profileId → ws
const pendingCommands = new Map(); // commandId → { resolve, reject, timeout }
const profileEvents = new EventEmitter();
let commandCounter = 0;
let wss;

export function getProfiles() {
  return profiles;
}

export function closeWebSocket() {
  if (wss) wss.close();
}

export function startWebSocketServer(port) {
  wss = new WebSocketServer({ port, host: '127.0.0.1' });

  wss.on('listening', () => {
    log(`WebSocket bridge listening on port ${port}`);
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} is in use. Attempting to kill zombie process...`);
      try {
        execSync(`lsof -ti:${port} | grep . | xargs kill -9`);
        log(`Successfully killed zombie process on port ${port}. Restarting server...`);
        setTimeout(() => startWebSocketServer(port), 500);
      } catch (killErr) {
        log(`Could not kill port ${port} automatically. You may need to free it manually. Message: ${killErr.message}`);
        setTimeout(() => startWebSocketServer(port), 5000);
      }
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
          profileEvents.emit('connected', msg.profileId);
          log(`Profile registered: ${msg.profileId}`);
        }

        // Keepalive ping from the extension — just ignore (keeps the WS alive)
        if (msg.type === 'ping') {
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
              log(`[IN]  ❌ Error for ${msg.id}: ${msg.error}`);
              pending.reject(new Error(msg.error));
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
      if (registeredProfileId) {
        profiles.delete(registeredProfileId);
        log(`Profile disconnected: ${registeredProfileId}`);
      }
    });
  });
}

// Wait for at least one browser profile to connect (up to waitMs)
function waitForProfile(profileId, waitMs = 8000) {
  return new Promise((resolve) => {
    const getWs = () => profileId ? profiles.get(profileId) : profiles.values().next().value;
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
              : 'No browser profiles connected. Make sure Chrome is open with the Browser Pilot extension.'
          ));
          return;
        }

        const id = `cmd-${++commandCounter}`;
        const timeout = setTimeout(() => {
          pendingCommands.delete(id);
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingCommands.set(id, { resolve, reject, timeout, onProgress });

        log(`[OUT] ➡️ ${command}`);
        log(`  Params: ${JSON.stringify(params).substring(0, 500)}`);

        ws.send(JSON.stringify({ type: 'command', id, command, params }));
      } catch (err) {
        reject(err);
      }
    })();
  });
}

export function pushOverlayState(profileId, state, tabId = null) {
  const ws = getProfiles().get(profileId) || getProfiles().values().next().value;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'set_overlay_state', state, tabId }));
  }
}
