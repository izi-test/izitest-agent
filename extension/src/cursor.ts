// The pointer an agent or a test moves, shown in the page: the mouse driven through the DevTools
// protocol has no picture of its own, and the live view (mcp-server/lib/live.js) showed clicks
// land with nothing pointing at them. Each move and press of a driven page's mouse is told to
// the tab's top frame, which draws a blue cursor gliding there (dom/cursor.ts) — so it is in
// the live view, the action frames and the window itself. Only tabs IziTest drives: the user's
// own mouse is never followed.

import type { Page } from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';

// The tab's top frame (helpers.ts TOP_FRAME): not imported, helpers brings Chrome's listeners
// into the page driver, which imports this.
const TOP_FRAME = 0;

export interface CursorMessage {
  type: 'cursor';
  x?: number;
  y?: number;
  /** A button pressed there: drawn as a ring. */
  press?: boolean;
  /** Hidden while the tab is captured for a screenshot compared with a baseline. */
  hidden?: boolean;
}

// Where the cursor of each driven tab last was: a page loaded since asks for it, and shows it
// there before the next move.
const lastAt = new Map<number, { x: number; y: number }>();

type Mouse = Page['mouse'] & { izitestCursor?: true };

/** From now on, `page`'s mouse is shown in its tab. Once per page: getPage keeps it. */
export function showCursorOf(tabId: number, page: Page): void {
  const mouse = page.mouse as Mouse;
  if (mouse.izitestCursor) return;
  mouse.izitestCursor = true;
  // click() calls this.move then this.down: replaced on the instance, they are the ones it calls.
  const move = mouse.move.bind(mouse);
  const down = mouse.down.bind(mouse);
  mouse.move = async (x, y, options) => {
    lastAt.set(tabId, { x, y });
    tell(tabId, { type: 'cursor', x, y });
    return move(x, y, options);
  };
  mouse.down = async (options) => {
    const at = lastAt.get(tabId);
    if (at) tell(tabId, { type: 'cursor', ...at, press: true });
    return down(options);
  };
}

/** Where the cursor of `tabId` is, if it is a driven tab whose mouse moved. */
export function cursorOf(tabId: number | undefined): { x: number; y: number } | null {
  return tabId === undefined ? null : lastAt.get(tabId) ?? null;
}

/** Hide (or show again) the cursor of `tabId`: a screenshot compared with a baseline has none. */
export async function hideCursor(tabId: number, hidden: boolean): Promise<void> {
  if (!lastAt.has(tabId)) return;
  await chrome.tabs.sendMessage(tabId, { type: 'cursor', hidden } satisfies CursorMessage, { frameId: TOP_FRAME }).catch(() => {});
}

function tell(tabId: number, message: CursorMessage): void {
  // Not awaited: the click goes on whether the picture follows or not (a page still loading).
  chrome.tabs.sendMessage(tabId, message, { frameId: TOP_FRAME }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => lastAt.delete(tabId));
