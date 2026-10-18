// Windows Browser Pilot opened itself (navigate with newWindow), and which session owns
// each one. close_window only ever closes one of these — never a window holding the user's
// own tabs — and tab resolution for a session stays inside that session's window, so two
// agents working at the same time cannot click in each other's pages.
//
// chrome.storage.session, not a module variable: it survives the MV3 service worker being
// suspended between commands. It is cleared when the browser restarts (those windows are
// gone then) and when the extension is reloaded; the server hands its windows back on
// reconnect (see restoreOwnedWindows).

const KEY = 'ownedWindows';
const LEGACY_KEY = 'ownedWindowIds';
const POPUPS_KEY = 'ownedPopups';

/** windowId → owning session id ('' when the caller did not name one). */
type OwnedWindows = Record<string, string>;

/**
 * Popup windows a page opened from a session's window (window.open, "Continue with Google"),
 * each with the working window it hangs off. They belong to that session like its working
 * window does, but are never taken for it: a command without tabId stays in the window
 * navigate() opened.
 */
type Popups = Record<string, number>;

// Every access is queued, because the storage API offers no read-modify-write.
// Two sessions opening a window at the same instant both read the old map and both wrote
// their own version back, so the second write erased the first — and close_window then
// refused a window Browser Pilot had genuinely opened. Serialising makes each
// read-then-write indivisible with respect to the others.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  // .then(op, op): a failed operation must not wedge the queue for the next one.
  const run = queue.then(operation, operation);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function read(): Promise<OwnedWindows> {
  const stored = await chrome.storage.session.get([KEY, LEGACY_KEY]);
  const owned = (stored[KEY] as OwnedWindows | undefined) ?? {};
  // A build from before sessions stored a bare id array; keep those windows closable.
  const legacy = stored[LEGACY_KEY] as number[] | undefined;
  if (legacy?.length) {
    for (const id of legacy) if (!(id in owned)) owned[String(id)] = '';
  }
  return owned;
}

async function write(owned: OwnedWindows): Promise<void> {
  await chrome.storage.session.set({ [KEY]: owned });
}

async function readPopups(): Promise<Popups> {
  const stored = await chrome.storage.session.get(POPUPS_KEY);
  return (stored[POPUPS_KEY] as Popups | undefined) ?? {};
}

export function rememberOwnedWindow(windowId: number, sessionId?: string): Promise<void> {
  return serialized(async () => {
    const owned = await read();
    // An explicit owner is never downgraded to anonymous: cmdNavigate records the window
    // twice (on create, then from the resolved tab) and one of those calls may lack the id.
    const previous = owned[String(windowId)];
    owned[String(windowId)] = sessionId || previous || '';
    await write(owned);
  });
}

export function isOwnedWindow(windowId: number): Promise<boolean> {
  return serialized(async () => String(windowId) in (await read()));
}

/** The window a session is working in, if it still has one. */
export function getSessionWindow(sessionId: string): Promise<number | undefined> {
  return serialized(async () => {
    const [owned, popups] = await Promise.all([read(), readPopups()]);
    for (const [windowId, owner] of Object.entries(owned)) {
      if (owner === sessionId && !(windowId in popups)) return Number(windowId);
    }
    return undefined;
  });
}

/** Which session opened this window, '' when it was opened without one. */
export function getWindowOwner(windowId: number): Promise<string | undefined> {
  return serialized(async () => (await read())[String(windowId)]);
}

/** Every Browser Pilot window with its owning session, as [windowId, sessionId] pairs. */
export function listOwnedWindows(): Promise<[number, string][]> {
  return serialized(async () =>
    Object.entries(await read()).map(([windowId, owner]) => [Number(windowId), owner] as [number, string]));
}

export function forgetOwnedWindow(windowId: number): Promise<void> {
  return serialized(async () => {
    const [owned, popups] = await Promise.all([read(), readPopups()]);
    if (String(windowId) in owned) {
      delete owned[String(windowId)];
      await write(owned);
    }
    if (String(windowId) in popups) {
      delete popups[String(windowId)];
      await chrome.storage.session.set({ [POPUPS_KEY]: popups });
    }
  });
}

/**
 * A page in a Browser Pilot window opened another window: it joins the same session.
 *
 * Seen live: "Continue with Google" opened accounts.google.com in a popup window; the agent
 * drove it with the newTabId the click returned, but the window belonged to nobody —
 * get_tabs showed it as the user's, and close_window refused it ("no ownership record").
 * Windows opened from the user's own windows are left alone. Returns the new owner.
 */
export function adoptOpenedWindow(openerWindowId: number, windowId: number): Promise<string | undefined> {
  return serialized(async () => {
    const [owned, popups] = await Promise.all([read(), readPopups()]);
    if (String(windowId) in owned) return owned[String(windowId)];
    const owner = owned[String(openerWindowId)];
    if (owner === undefined || windowId === openerWindowId) return undefined;

    owned[String(windowId)] = owner;
    // A popup opened from a popup hangs off the same working window.
    popups[String(windowId)] = popups[String(openerWindowId)] ?? openerWindowId;
    await chrome.storage.session.set({ [KEY]: owned, [POPUPS_KEY]: popups });
    return owner;
  });
}

/** The working window a popup was opened from, or undefined for a window that is no popup. */
export function popupParent(windowId: number): Promise<number | undefined> {
  return serialized(async () => (await readPopups())[String(windowId)]);
}

/** Every popup window opened from `windowId`. */
export function popupsOf(windowId: number): Promise<number[]> {
  return serialized(async () =>
    Object.entries(await readPopups()).filter(([, parent]) => parent === windowId).map(([id]) => Number(id)));
}

/** popup windowId → the working window it was opened from. */
export function listPopupWindows(): Promise<Map<number, number>> {
  return serialized(async () =>
    new Map(Object.entries(await readPopups()).map(([id, parent]) => [Number(id), parent])));
}

/**
 * Re-adopt windows after the extension restarted (chrome.storage.session is wiped by a
 * reload). The server is the authority here: it only lists windows it opened itself
 * through navigate, so this does not widen what close_window is allowed to touch.
 *
 * An entry may carry only `tabId` — a session opened by an extension build that did not
 * report windowId back. The window is then resolved from the tab. Entries whose window or
 * tab no longer exists are skipped.
 */
export function restoreOwnedWindows(
  entries: { windowId?: number; tabId?: number; sessionId?: string }[]
): Promise<number> {
  return serialized(async () => {
    const owned = await read();
    let restored = 0;

    for (const entry of entries ?? []) {
      let windowId = typeof entry?.windowId === 'number' ? entry.windowId : undefined;

      if (windowId === undefined && typeof entry?.tabId === 'number') {
        try {
          windowId = (await chrome.tabs.get(entry.tabId)).windowId;
        } catch {
          continue; // tab closed while the extension was restarting
        }
      }
      if (windowId === undefined) continue;

      try {
        await chrome.windows.get(windowId);
      } catch {
        continue; // window closed while the extension was restarting
      }

      owned[String(windowId)] = entry.sessionId ?? '';
      restored++;
    }

    if (restored) await write(owned);
    return restored;
  });
}

// window.open and target=_blank report the tab that opened them. A click also adopts what it
// opened (cmdClick), for the case where Chrome leaves openerTabId unset.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined || tab.windowId === undefined) return;
  chrome.tabs.get(tab.openerTabId)
    .then((opener) => adoptOpenedWindow(opener.windowId, tab.windowId))
    .catch(() => {});
});

// Also when the user closes the window by hand.
chrome.windows.onRemoved.addListener((windowId) => {
  forgetOwnedWindow(windowId).catch(() => {});
});
