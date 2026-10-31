// Unit tests for the browser-origin guard of a server without a token.
// Run with: node --test test/origin-guard.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAllowedOrigins, isLoopbackHost, isAllowedOrigin, refuseBrowserRequest, isExtensionOrigin,
} from '../lib/origin-guard.js';

test('a loopback Host passes, with or without its port', () => {
  for (const host of ['127.0.0.1:3467', 'localhost:3467', '[::1]:3467', 'localhost', '127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
});

test('a Host left by DNS rebinding is refused', () => {
  for (const host of ['evil.com:3467', '127.0.0.1.nip.io:3467', 'localhost.evil.com', '127.0.0.1@evil.com', '', undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('local pages pass: the dashboard and its Vite dev server', () => {
  for (const origin of ['http://127.0.0.1:3467', 'http://localhost:3467', 'http://localhost:5175', 'http://[::1]:3467']) {
    assert.equal(isAllowedOrigin(origin), true, origin);
  }
});

test('any other page is refused, sandboxed iframes and file:// included', () => {
  for (const origin of ['https://evil.com', 'http://localhost.evil.com', 'null', 'file://', 'chrome-extension://abcdef', '']) {
    assert.equal(isAllowedOrigin(origin), false, origin);
  }
});

test('IZITEST_ALLOWED_ORIGINS lets a hosted cockpit through, trailing slash or not', () => {
  const allowed = parseAllowedOrigins(' https://cockpit.example.com/, https://other.example.com ,');
  assert.deepEqual([...allowed], ['https://cockpit.example.com', 'https://other.example.com']);
  assert.equal(isAllowedOrigin('https://cockpit.example.com', allowed), true);
  assert.equal(isAllowedOrigin('https://evil.com', allowed), false);
  assert.equal(parseAllowedOrigins(undefined).size, 0);
});

test('a local MCP client (no Origin, loopback Host) is let through', () => {
  assert.equal(refuseBrowserRequest({ host: '127.0.0.1:3467' }), null);
  assert.equal(refuseBrowserRequest({ host: 'localhost:3467', origin: 'http://localhost:5175' }), null);
});

test('a visited site is refused, and the reason says why', () => {
  assert.match(refuseBrowserRequest({ host: '127.0.0.1:3467', origin: 'https://evil.com' }), /origine « https:\/\/evil\.com »/);
  assert.match(refuseBrowserRequest({ host: 'evil.com:3467' }), /hôte « evil\.com:3467 »/);
  assert.match(refuseBrowserRequest({}), /hôte «\s+» n'est pas local/);
});

test('only the extension, or a client that is no browser, may open the WebSocket bridge', () => {
  assert.equal(isExtensionOrigin(undefined), true);
  assert.equal(isExtensionOrigin('chrome-extension://abcdefghijklmnop'), true);
  assert.equal(isExtensionOrigin('https://evil.com'), false);
  assert.equal(isExtensionOrigin('http://localhost:5175'), false);
  assert.equal(isExtensionOrigin('null'), false);
});
