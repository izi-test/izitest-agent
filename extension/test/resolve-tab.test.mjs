// Which tab a command acts on. The rule that matters: a session with no window of its own
// must fail loudly, never fall back to the foreground tab.
//
// Reported live: a fresh session calling snapshot/execute_js before any navigate returned
// the user's own foreground page (their platform.claude.com tab).
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'helpers.ts');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param tabs  [{ id, windowId, active, url }]
 */
function fakeChrome(tabs) {
  let storage = {};
  return {
    storage: {
      session: {
        get: async (keys) => {
          await delay(1);
          const out = {};
          for (const key of [].concat(keys)) if (key in storage) out[key] = storage[key];
          return out;
        },
        set: async (obj) => { await delay(1); storage = { ...storage, ...structuredClone(obj) }; },
      },
    },
    windows: { get: async (id) => ({ id }), onRemoved: { addListener: () => {} } },
    tabs: {
      get: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error('no tab')),
      onCreated: { addListener: () => {} },
      query: async (q) => tabs.filter((t) =>
        (q.active === undefined || t.active === q.active) &&
        (q.windowId === undefined || t.windowId === q.windowId)),
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    scripting: { executeScript: async () => [] },
  };
}

async function loadHelpers(tabs) {
  globalThis.chrome = fakeChrome(tabs);
  const dir = await mkdtemp(join(tmpdir(), 'helpers-'));
  const outfile = join(dir, 'helpers.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}

// The user's own foreground tab, plus a IziTest Agent working window.
const TABS = [
  { id: 1, windowId: 10, active: true, url: 'https://platform.claude.com/' }, // the user's
  { id: 2, windowId: 20, active: true, url: 'https://a.example/' },           // session A
  { id: 3, windowId: 20, active: false, url: 'https://a.example/other' },
];

test('an explicit tabId always wins', async () => {
  const helpers = await loadHelpers(TABS);
  assert.equal(await helpers.resolveTabId(3, 's:A'), 3);
});

test('a session resolves to the active tab of its own window', async () => {
  const helpers = await loadHelpers(TABS);
  // Session A owns window 20, whose active tab is 2 — not the foreground tab 1.
  await chrome.storage.session.set({ ownedWindows: { 20: 's:A' } });
  assert.equal(await helpers.resolveTabId(undefined, 's:A'), 2);
});

test('a session with no window of its own refuses to touch the foreground tab', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: { 20: 's:A' } });

  await assert.rejects(
    () => helpers.resolveTabId(undefined, 's:brand-new'),
    (err) => {
      assert.match(err.message, /no window of its own yet/);
      assert.match(err.message, /Call navigate\(\) first/);
      assert.match(err.message, /will not fall back to the foreground tab/);
      return true;
    },
    'a fresh session must not be handed the user\'s foreground tab'
  );
});

test('the refusal is flagged as expected, so it is not logged as an extension error', async () => {
  // Without the flag, console.error put every "call navigate() first" in the error list of
  // chrome://extensions, as if the extension had crashed. It is an answer, not a fault.
  const helpers = await loadHelpers(TABS);
  const err = await helpers.resolveTabId(undefined, 's:brand-new').then(
    () => null, (e) => e);
  assert.ok(err, 'expected a refusal');
  assert.equal(helpers.isExpectedRefusal(err), true);
  assert.equal(helpers.isExpectedRefusal(new Error('something actually broke')), false);
});

test('it refuses even when no other session is working', async () => {
  const helpers = await loadHelpers(TABS);
  // Nothing in the ownership store at all: the earlier guard only fired when *another*
  // session held a window, which let the very first session read the user's page.
  await assert.rejects(() => helpers.resolveTabId(undefined, 's:first'), /no window of its own yet/);
});

test('a session whose window was closed is told to navigate again', async () => {
  const helpers = await loadHelpers([TABS[0]]); // session A's window is gone
  await assert.rejects(() => helpers.resolveTabId(undefined, 's:A'), /Call navigate\(\) first/);
});

test('a caller with no session at all still gets the active tab (popup debug panel)', async () => {
  const helpers = await loadHelpers(TABS);
  assert.equal(await helpers.resolveTabId(undefined, undefined), 1);
});

// ─── Taking over another session's tab ──────────────────────────────
//
// Seen live: session B passed session A's tabId, read A's page and navigated in it. The
// window changed owner, A could no longer close its own window, and B's close_window
// closed A's instead.

const OWNED = { 20: 's:A' }; // window 20 (tabs 2 and 3) is session A's working window

test('another live session\'s tab is refused', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: OWNED });

  await assert.rejects(
    () => helpers.assertTabIsNotAnotherSessions(2, 's:B', { liveSessions: ['s:A', 's:B'] }),
    (err) => {
      assert.match(err.message, /working window of session s:A/);
      assert.match(err.message, /force: true/);
      assert.equal(helpers.isExpectedRefusal(err), true);
      return true;
    },
  );
});

test('force: true lets the caller through', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: OWNED });
  await helpers.assertTabIsNotAnotherSessions(2, 's:B', { liveSessions: ['s:A', 's:B'], force: true });
});

test('your own tab is never refused', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: OWNED });
  await helpers.assertTabIsNotAnotherSessions(2, 's:A', { liveSessions: ['s:A'] });
});

test('an orphan — owner no longer alive — is not protected', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: OWNED });
  await helpers.assertTabIsNotAnotherSessions(2, 's:B', { liveSessions: ['s:B'] });
});

test('the user\'s own tab is not someone else\'s working window', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: OWNED });
  await helpers.assertTabIsNotAnotherSessions(1, 's:B', { liveSessions: ['s:A', 's:B'] });
});

test('a tab that no longer exists is left to fail on its own terms', async () => {
  const helpers = await loadHelpers(TABS);
  await chrome.storage.session.set({ ownedWindows: OWNED });
  await helpers.assertTabIsNotAnotherSessions(404, 's:B', { liveSessions: ['s:A', 's:B'] });
});
