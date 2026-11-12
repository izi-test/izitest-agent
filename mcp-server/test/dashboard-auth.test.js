// Unit tests for the dashboard's sign-in when the server has a token.
// Run with: node --test test/dashboard-auth.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKIE_NAME, sessionValue, cookieOf, fromOwnOrigin, cookieAuthorized, wantsSignIn, safeNext,
  signInCookie, signOutCookie, overHttps, signInPage,
} from '../lib/dashboard-auth.js';

const TOKEN = 'a-token-made-up-for-the-tests';
const cookie = `${COOKIE_NAME}=${sessionValue(TOKEN)}`;
const own = { host: '127.0.0.1:3467', 'sec-fetch-site': 'same-origin' };

test('the cookie holds a value derived from the token, never the token', () => {
  const value = sessionValue(TOKEN);
  assert.match(value, /^[0-9a-f]{64}$/);
  assert.ok(!value.includes(TOKEN));
  assert.notEqual(sessionValue('another-token'), value, 'a new token signs every browser out');
  assert.ok(!signInCookie(TOKEN).includes(TOKEN));
});

test('the sign-in cookie is HttpOnly and SameSite=Strict, Secure behind HTTPS', () => {
  const header = signInCookie(TOKEN);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=']) assert.ok(header.includes(part), part);
  assert.ok(!header.includes('Secure'));
  assert.ok(signInCookie(TOKEN, true).endsWith('; Secure'));
  assert.ok(signOutCookie().includes('Max-Age=0'));
});

test('the cookie is read among the others', () => {
  assert.equal(cookieOf(`theme=dark; ${cookie}; other=1`), sessionValue(TOKEN));
  assert.equal(cookieOf('theme=dark'), null);
  assert.equal(cookieOf(undefined), null);
  assert.equal(cookieOf(`x${COOKIE_NAME}=nope`), null);
});

test('a request of the dashboard with the cookie passes', () => {
  assert.equal(cookieAuthorized({ ...own, cookie }, TOKEN), true);
  assert.equal(cookieAuthorized({ host: own.host, cookie, 'sec-fetch-site': 'none' }, TOKEN), true, 'typed in the address bar');
  assert.equal(cookieAuthorized({ ...own, cookie, origin: 'http://127.0.0.1:3467' }, TOKEN), true, 'a POST of the dashboard');
  assert.equal(cookieAuthorized({ host: own.host, cookie }, TOKEN), true, 'an older browser without Sec-Fetch-Site');
});

test('a wrong, old or missing cookie does not pass', () => {
  assert.equal(cookieAuthorized(own, TOKEN), false);
  assert.equal(cookieAuthorized({ ...own, cookie: `${COOKIE_NAME}=${sessionValue('old-token')}` }, TOKEN), false);
  assert.equal(cookieAuthorized({ ...own, cookie: `${COOKIE_NAME}=${TOKEN}` }, TOKEN), false, 'the token itself is not the cookie');
  assert.equal(cookieAuthorized({ ...own, cookie }, ''), false, 'no token on the server: no cookie sign-in');
});

test('the cookie does not count on a request another page makes, even on the same host', () => {
  // The app under test on localhost:8080 is "same site" as the server: SameSite lets the cookie go.
  assert.equal(cookieAuthorized({ ...own, cookie, 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:8080' }, TOKEN), false);
  assert.equal(cookieAuthorized({ ...own, cookie, 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }, TOKEN), false);
  assert.equal(cookieAuthorized({ host: own.host, cookie, origin: 'http://127.0.0.1:8080' }, TOKEN), false, 'without Sec-Fetch-Site, the Origin decides');
  assert.equal(cookieAuthorized({ host: own.host, cookie, origin: 'null' }, TOKEN), false);
  assert.equal(fromOwnOrigin({ host: 'tests.example.com', origin: 'https://tests.example.com' }), true);
});

test('only a browser opening a page gets the sign-in page; the API and MCP keep their 403', () => {
  const html = { accept: 'text/html,application/xhtml+xml' };
  assert.equal(wantsSignIn('GET', '/', html), true);
  assert.equal(wantsSignIn('GET', '/campaigns/36', html), true);
  assert.equal(wantsSignIn('GET', '/api/campaigns', html), false);
  assert.equal(wantsSignIn('GET', '/api', html), false);
  assert.equal(wantsSignIn('GET', '/live/tabs/1/stream', html), false);
  assert.equal(wantsSignIn('GET', '/sse', html), false);
  assert.equal(wantsSignIn('GET', '/', { accept: 'application/json' }), false);
  assert.equal(wantsSignIn('GET', '/', {}), false, 'an MCP client or curl');
  assert.equal(wantsSignIn('POST', '/', html), false);
});

test('after signing in, the browser goes back to a page of this server only', () => {
  assert.equal(safeNext('/campaigns/36?project=10'), '/campaigns/36?project=10');
  for (const next of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '', null, undefined]) {
    assert.equal(safeNext(next), '/', String(next));
  }
});

test('HTTPS is seen directly or through a proxy', () => {
  assert.equal(overHttps({ socket: { encrypted: true }, headers: {} }), true);
  assert.equal(overHttps({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(overHttps({ socket: {}, headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(overHttps({ socket: {}, headers: {} }), false);
});

test('the sign-in page escapes what it echoes and posts the token, never in the URL', () => {
  const page = signInPage({ next: '/tests?q="><script>alert(1)</script>', error: '<b>no</b>' });
  assert.ok(!page.includes('<script>alert(1)'));
  assert.ok(page.includes('&lt;b&gt;no&lt;/b&gt;'));
  assert.match(page, /<form method="post" action="\/signin">/);
  assert.match(page, /type="password"/);
  assert.ok(signInPage({ next: 'https://evil.com' }).includes('name="next" value="/"'));
});
