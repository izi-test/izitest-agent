// Ask the running Browser Pilot server to reload the unpacked extension in Chrome, so a
// rebuild lands in the browser without a trip to chrome://extensions.
//
// The server pushes the request down the WebSocket it already holds to the extension,
// which calls chrome.runtime.reload() on itself. Nothing here talks to Chrome directly.
//
// Best effort by design: if no server is running, or no extension is connected, this
// prints how to reload by hand and never fails the build.
// Set BROWSER_PILOT_NO_RELOAD=1 to skip it entirely.

const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';
const MCP_PORT = process.env.MCP_PORT || '3457';
const TOKEN = process.env.BROWSER_PILOT_TOKEN || '';
const HOST = MCP_HOST.includes(':') ? `[${MCP_HOST}]` : MCP_HOST; // IPv6 literal
const URL = `http://${HOST}:${MCP_PORT}/api/dev/reload-extension`;

// The server holds the request while it waits for the extension to register again (it
// confirms the reload instead of assuming it), so this has to outlast that wait.
const TIMEOUT_MS = 12000;
// watch mode builds background.js and content.js in two contexts: without this, one save
// would fire two reloads, and the second would land mid-restart.
const DEBOUNCE_MS = 400;

let lastRequestAt = 0;

const manually = 'reload it by hand in chrome://extensions';

async function reloadExtension({ quiet = false } = {}) {
  if (process.env.BROWSER_PILOT_NO_RELOAD === '1') return false;

  const now = Date.now();
  if (now - lastRequestAt < DEBOUNCE_MS) return false;
  lastRequestAt = now;

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) {
      // The server runs with BROWSER_PILOT_TOKEN set (it is reachable beyond this machine),
      // but this shell does not have it. Nothing is broken; the build just cannot authenticate.
      console.log('[BrowserPilot] The server requires a token and BROWSER_PILOT_TOKEN is not set in this shell,');
      console.log(`[BrowserPilot] so the extension was not reloaded — ${manually}, or export the token first.`);
      return false;
    }
    if (!res.ok) {
      if (!quiet) console.log(`[BrowserPilot] Server answered ${res.status} — ${manually}.`);
      return false;
    }
    // `reloaded` is confirmed by the extension registering again, not assumed from the
    // push: an extension running a build from before this feature ignores the message.
    const { notified, reloaded } = await res.json();
    if (reloaded) {
      console.log(`[BrowserPilot] Extension reloaded in Chrome (${notified} profile${notified > 1 ? 's' : ''}).`);
      return true;
    }
    if (notified > 0) {
      console.log('[BrowserPilot] The extension did not restart. It is most likely running a build from before');
      console.log(`[BrowserPilot] auto-reload existed — ${manually} ONCE, and later builds will reload themselves.`);
      return false;
    }
    if (!quiet) console.log(`[BrowserPilot] No extension connected to the bridge — ${manually}.`);
    return false;
  } catch {
    if (!quiet) console.log(`[BrowserPilot] Browser Pilot server not reachable on ${HOST}:${MCP_PORT} — ${manually}.`);
    return false;
  }
}

module.exports = { reloadExtension };
