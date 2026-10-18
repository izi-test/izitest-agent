// Window-ownership bookkeeping, against a fake chrome.storage.session with real latency.
//
// The bug this guards: chrome.storage has no read-modify-write, so two sessions opening a
// window at the same instant both read the old map and both write their own version back.
// The second write erased the first, and close_window then refused a window Browser Pilot
// had genuinely opened ("window Browser Pilot did not open", seen on 4 of 5 windows).
//
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'owned-windows.ts');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Latency is what makes the race observable: without it, get and set resolve in the same
// microtask queue drain and the interleaving never happens.
const LATENCY_MS = 5;

function fakeChrome() {
  let data = {};
  const tabCreated = [];
  return {
    peek: () => data,
    /** Fire chrome.tabs.onCreated, as Chrome does when a page opens a tab or a popup. */
    createTab: (tab) => tabCreated.forEach((listener) => listener(tab)),
    api: {
      storage: {
        session: {
          get: async (keys) => {
            await delay(LATENCY_MS);
            const out = {};
            for (const key of [].concat(keys)) if (key in data) out[key] = data[key];
            return out;
          },
          set: async (obj) => {
            await delay(LATENCY_MS);
            data = { ...data, ...structuredClone(obj) };
          },
        },
      },
      windows: {
        get: async (id) => ({ id }),
        onRemoved: { addListener: () => {} },
      },
      tabs: {
        get: async (id) => ({ id, windowId: 900 + id }),
        onCreated: { addListener: (listener) => tabCreated.push(listener) },
      },
    },
  };
}

/** Fresh module instance (fresh queue) bound to a fresh fake storage. */
async function loadModule() {
  const chrome = fakeChrome();
  globalThis.chrome = chrome.api;
  const ts = await readFile(SRC, 'utf8');
  const { code } = await transform(ts, { loader: 'ts', format: 'esm' });
  const dir = await mkdtemp(join(tmpdir(), 'owned-windows-'));
  const file = join(dir, 'owned-windows.mjs');
  await writeFile(file, code);
  return { mod: await import(file), chrome };
}

test('concurrent rememberOwnedWindow calls all survive (the lost-write race)', async () => {
  const { mod, chrome } = await loadModule();

  await Promise.all([
    mod.rememberOwnedWindow(11, 'c:alpha'),
    mod.rememberOwnedWindow(22, 's:recherche-A'),
    mod.rememberOwnedWindow(33, 's:recherche-B'),
    mod.rememberOwnedWindow(44, 'c:delta'),
    mod.rememberOwnedWindow(55, 'c:epsilon'),
  ]);

  assert.deepEqual(chrome.peek().ownedWindows, {
    11: 'c:alpha', 22: 's:recherche-A', 33: 's:recherche-B', 44: 'c:delta', 55: 'c:epsilon',
  });

  // And every one of them is closable, which is what the bug broke.
  for (const id of [11, 22, 33, 44, 55]) {
    assert.equal(await mod.isOwnedWindow(id), true, `window ${id} lost its ownership record`);
  }
});

test('the same pattern without serialising does lose writes — why the queue is there', async () => {
  // Deliberately reproduces the old implementation against the same fake storage, so this
  // file fails if someone removes the queue believing it is unnecessary.
  const chrome = fakeChrome();
  const unserialized = async (windowId, sessionId) => {
    const stored = await chrome.api.storage.session.get(['ownedWindows']);
    const owned = stored.ownedWindows ?? {};
    owned[String(windowId)] = sessionId;
    await chrome.api.storage.session.set({ ownedWindows: owned });
  };

  await Promise.all([
    unserialized(11, 'c:alpha'),
    unserialized(22, 's:recherche-A'),
    unserialized(33, 's:recherche-B'),
  ]);

  assert.notDeepEqual(chrome.peek().ownedWindows, {
    11: 'c:alpha', 22: 's:recherche-A', 33: 's:recherche-B',
  });
});

test('concurrent writers and readers agree on the owner of each window', async () => {
  const { mod } = await loadModule();

  await Promise.all([
    mod.rememberOwnedWindow(11, 's:A'),
    mod.rememberOwnedWindow(22, 's:B'),
  ]);

  const [windowA, windowB, owners] = await Promise.all([
    mod.getSessionWindow('s:A'),
    mod.getSessionWindow('s:B'),
    mod.listOwnedWindows(),
  ]);

  assert.equal(windowA, 11);
  assert.equal(windowB, 22);
  assert.deepEqual(new Map(owners), new Map([[11, 's:A'], [22, 's:B']]));
  assert.equal(await mod.getWindowOwner(22), 's:B');
});

test('an explicit owner is never downgraded by a later anonymous record', async () => {
  const { mod } = await loadModule();
  // cmdNavigate records the window twice: on create, then from the resolved tab.
  await mod.rememberOwnedWindow(11, 's:A');
  await mod.rememberOwnedWindow(11, undefined);
  assert.equal(await mod.getWindowOwner(11), 's:A');
});

test('forgetting one window leaves the others alone', async () => {
  const { mod, chrome } = await loadModule();
  await Promise.all([
    mod.rememberOwnedWindow(11, 's:A'),
    mod.rememberOwnedWindow(22, 's:B'),
    mod.rememberOwnedWindow(33, 's:C'),
  ]);

  await Promise.all([mod.forgetOwnedWindow(22), mod.forgetOwnedWindow(33)]);

  assert.deepEqual(chrome.peek().ownedWindows, { 11: 's:A' });
});

test('restoreOwnedWindows re-adopts by window, or by tab when the window is unknown', async () => {
  const { mod } = await loadModule();

  const restored = await mod.restoreOwnedWindows([
    { windowId: 11, sessionId: 's:A' },
    { tabId: 7, sessionId: 's:B' },          // no windowId: resolved from the tab (907)
    { sessionId: 's:C' },                    // neither: skipped
  ]);

  assert.equal(restored, 2);
  assert.equal(await mod.getSessionWindow('s:A'), 11);
  assert.equal(await mod.getSessionWindow('s:B'), 907);
  assert.equal(await mod.getSessionWindow('s:C'), undefined);
});

test('a legacy bare-array record stays closable', async () => {
  const { mod, chrome } = await loadModule();
  await chrome.api.storage.session.set({ ownedWindowIds: [99] });
  assert.equal(await mod.isOwnedWindow(99), true);
});

// ─── Popups a page opens ──────────────────────────────────────────────
// Seen live: "Continue with Google" opened a popup window from the session's window; it
// belonged to nobody, so get_tabs called it the user's and close_window refused it.

const settle = () => delay(LATENCY_MS * 8);

test('a window opened from a session window joins that session, as a popup', async () => {
  const { mod, chrome } = await loadModule();
  await mod.rememberOwnedWindow(907, 's:A');          // tab 7 lives in window 907

  chrome.createTab({ id: 50, windowId: 950, openerTabId: 7 });
  await settle();

  assert.equal(await mod.getWindowOwner(950), 's:A');
  assert.equal(await mod.popupParent(950), 907);
  assert.deepEqual(await mod.popupsOf(907), [950]);
  // Commands without tabId stay in the working window, never in the popup.
  assert.equal(await mod.getSessionWindow('s:A'), 907);
});

test('a popup opened from a popup hangs off the same working window', async () => {
  const { mod } = await loadModule();
  await mod.rememberOwnedWindow(907, 's:A');
  await mod.adoptOpenedWindow(907, 950);
  await mod.adoptOpenedWindow(950, 960);

  assert.equal(await mod.getWindowOwner(960), 's:A');
  assert.deepEqual((await mod.popupsOf(907)).sort(), [950, 960]);
});

test('windows opened from the user\'s own windows are left alone', async () => {
  const { mod, chrome } = await loadModule();
  await mod.rememberOwnedWindow(11, 's:A');

  chrome.createTab({ id: 50, windowId: 950, openerTabId: 7 });   // opener in window 907: the user's
  await settle();
  assert.equal(await mod.isOwnedWindow(950), false);
  // A tab opened in the same window is not a popup.
  await mod.adoptOpenedWindow(11, 11);
  assert.equal(await mod.popupParent(11), undefined);
});

test('a window already owned keeps its owner when something opens a tab into it', async () => {
  const { mod } = await loadModule();
  await mod.rememberOwnedWindow(11, 's:A');
  await mod.rememberOwnedWindow(22, 's:B');
  assert.equal(await mod.adoptOpenedWindow(11, 22), 's:B');
  assert.equal(await mod.popupParent(22), undefined);
});

test('forgetting a popup drops its popup record too', async () => {
  const { mod } = await loadModule();
  await mod.rememberOwnedWindow(907, 's:A');
  await mod.adoptOpenedWindow(907, 950);
  await mod.forgetOwnedWindow(950);
  assert.equal(await mod.isOwnedWindow(950), false);
  assert.deepEqual(await mod.popupsOf(907), []);
});
