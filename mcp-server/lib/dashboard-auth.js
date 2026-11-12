// The dashboard in a browser, when the server has a token (IZITEST_TOKEN).
//
// A browser cannot add an Authorization header to the pages it opens: without help, every page
// of the dashboard answers 403. So a browser that opens a page without the token gets a sign-in
// page instead; the person pastes the token once, and the server answers with a cookie that the
// browser then sends with every request of the dashboard (its pages, its API calls, the live
// view).
//
// The cookie does not hold the token: it holds a value derived from it (HMAC), so that it reveals
// nothing of the token and stops working as soon as the token changes.
//
// A cookie is sent by the browser on its own, also with requests that other pages make — the
// risk the token header did not have. Hence:
// - HttpOnly (no script reads it) and SameSite=Strict (no other site's request carries it);
// - and, since SameSite does not tell one port from another (an app under test on
//   localhost:8080 is "same site" as the server on localhost:3467), the cookie only counts on a
//   request from the dashboard's own origin: Sec-Fetch-Site same-origin or none (typed in the
//   address bar), and an Origin, when there is one, equal to the server's.

import { createHmac, timingSafeEqual } from 'crypto';

export const COOKIE_NAME = 'izitest_session';
const MAX_AGE = 30 * 24 * 3600;

/** What the cookie holds for a token: derived from it, never the token itself. */
export function sessionValue(token) {
  return createHmac('sha256', token).update('izitest-dashboard-session-v1').digest('hex');
}

function sameText(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The value of a cookie in a Cookie header, or null. */
export function cookieOf(header, name = COOKIE_NAME) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

/** Whether a request comes from the dashboard's own pages (or from the address bar). */
export function fromOwnOrigin(headers) {
  const site = headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return false;
  const { origin, host } = headers;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Whether the request carries a valid dashboard cookie, sent by the dashboard itself. */
export function cookieAuthorized(headers, token) {
  if (!token) return false;
  const given = cookieOf(headers.cookie);
  return !!given && sameText(given, sessionValue(token)) && fromOwnOrigin(headers);
}

/** Whether to answer a refused request with the sign-in page: a browser opening a page. */
export function wantsSignIn(method, pathname, headers) {
  if (method !== 'GET') return false;
  if (['/sse', '/messages', '/health'].includes(pathname) || /^\/(api|live)(\/|$)/.test(pathname)) return false;
  return String(headers.accept ?? '').includes('text/html');
}

/** Where to go after signing in: a path of this server only, never another site. */
export function safeNext(next) {
  const path = String(next ?? '');
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
}

/** The Set-Cookie header that signs the browser in (Secure behind HTTPS). */
export function signInCookie(token, secure = false) {
  return `${COOKIE_NAME}=${sessionValue(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie header that signs the browser out. */
export function signOutCookie(secure = false) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Whether the request reached the server over HTTPS (directly or through a proxy). */
export function overHttps(req) {
  return !!req.socket?.encrypted || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The sign-in page: one field, the token. */
export function signInPage({ next = '/', error = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>IziTest — sign in</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #5d6677; --line: #d9dde5; --accent: #2f5bea; --error: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11141a; --card: #1a1e26; --text: #e7eaf0; --muted: #9aa3b2; --line: #2c323d; --accent: #6d8dff; --error: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: var(--muted); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: var(--error); margin: 12px 0 0; }
  .help { font-size: 13px; margin: 18px 0 0; }
  code { font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>IziTest</h1>
  <p>This server asks for its token. Paste it once: this browser then stays signed in for 30 days.</p>
  <form method="post" action="/signin">
    <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
    <label for="token">Token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
    <button type="submit">Sign in</button>
  </form>
  <p class="help">It is the value of <code>IZITEST_TOKEN</code> the server was started with. Whoever installed IziTest has it.</p>
</main>
</body>
</html>`;
}
