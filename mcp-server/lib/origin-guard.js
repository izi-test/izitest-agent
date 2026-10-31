// Which browser pages may talk to the server.
//
// Without IZITEST_TOKEN the server listens on loopback only (server.js refuses anything
// else) and asks for no credentials: a local MCP client, curl or the dashboard just connect.
// Loopback is no wall against the browser it pilots, though: any page open in that Chrome
// can send requests to 127.0.0.1. With CORS open to every origin, a site the user merely
// visited could read /health and /live, open an MCP session on /sse and call execute_js or
// get_cookies with the user's real sessions, or connect to the extension's WebSocket and
// take its commands.
//
// Two checks close that without asking anything of local clients:
// - Origin: a browser sends it on every cross-origin request whose response a page may
//   read, on every POST and on every WebSocket. Only loopback pages (the dashboard, its
//   Vite dev server) and the origins listed in IZITEST_ALLOWED_ORIGINS pass. Node clients
//   send none.
// - Host: DNS rebinding points the attacker's own domain at 127.0.0.1, so its requests are
//   same-origin and a GET carries no Origin. Their Host is still that domain: only a
//   loopback Host passes.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** IZITEST_ALLOWED_ORIGINS: comma-separated origins, e.g. "https://cockpit.example.com". */
export function parseAllowedOrigins(value = '') {
  return new Set(
    String(value).split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean)
  );
}

export function isLoopbackHost(host) {
  if (!host) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin, allowed = new Set()) {
  if (allowed.has(origin)) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    // "null" lands here: sandboxed iframes and file:// pages, which any site can produce.
    return false;
  }
}

/** Why a request to a server without a token is refused, or null when it may go on. */
export function refuseBrowserRequest(headers, allowed = new Set()) {
  if (!isLoopbackHost(headers.host)) return `l'hôte « ${headers.host ?? ''} » n'est pas local`;
  const { origin } = headers;
  if (origin !== undefined && !isAllowedOrigin(origin, allowed)) return `l'origine « ${origin} » n'est pas autorisée`;
  return null;
}

/**
 * The extension's WebSocket bridge. Browsers apply no CORS to WebSockets but always send
 * the page's Origin: only an extension passes. Node clients (tests, tools) send none.
 */
export function isExtensionOrigin(origin) {
  return !origin || origin.startsWith('chrome-extension://');
}
