// A click replayed when the page can take it, and seen to have done something.
//
// The replay clicked as soon as its element was there and visible. On an app still starting up
// (an identity portal's home page), the button was drawn before its handler was attached: the click was
// "done", nothing happened, and the next step found nothing. So, like Playwright's
// actionability checks, before a click the element has to be:
//   - visible, and not disabled (disabled, aria-disabled, in a disabled fieldset);
//   - still — the same box twice in a row, not sliding in;
//   - the one the click lands on: what is at its middle is the element, or inside it, or a label
//     standing for it (not a loading veil, a banner, a dialog over it).
// And after the click something has to happen within a second: the DOM changes, the page
// navigates, or a request leaves. A click after which nothing at all happened is made once more.
// A click on a link to another page has to open it: a page still drawing itself changes its DOM
// anyway, and took a lost click on its menu for one that worked.

import type { ElementHandle, Frame, Page } from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';

export interface ActionState {
  state: 'ok' | 'detached' | 'hidden' | 'disabled' | 'covered';
  detail?: string;
  rect?: { x: number; y: number; w: number; h: number };
}

const POLL_MS = 100;
const LEFT_THE_PAGE = 'the element left the page before it could be clicked';

/** Whether a click was not made because its element was replaced before it (replay.ts looks again). */
export const isLeftThePage = (err: unknown): boolean =>
  (err instanceof Error ? err.message : String(err)).includes(LEFT_THE_PAGE);
const EFFECT_WAIT_MS = 1000;

/** In the page: whether `el` can take a click now. Serialised: everything it uses is inside. */
export function actionStateOf(el: Element): ActionState {
  const describe = (node: Element | null): string => {
    if (!node) return 'nothing';
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `<${node.tagName.toLowerCase()}${id}${cls}>${text ? ` "${text}"` : ''}`;
  };
  if (!el.isConnected) return { state: 'detached' };
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { state: 'hidden' };
  const rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  const disabled = (el as HTMLButtonElement).disabled === true
    || el.getAttribute('aria-disabled') === 'true'
    || !!el.closest('fieldset[disabled]');
  if (disabled) return { state: 'disabled', rect };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Out of the viewport: scrolled into view before the click, nothing to hit-test here.
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { state: 'ok', rect };
  // Inside a shadow root, its own elementFromPoint sees past the host.
  const root = el.getRootNode() as Document | ShadowRoot;
  const hit = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
  if (!hit) return { state: 'ok', rect };
  // The element, or something inside it (an icon in a button), or a label standing for it —
  // the rule of the agent's own clicks (dom/hit-test.ts). An ancestor taking the click does not.
  for (let node: Element | null = hit; node; node = node.parentElement) {
    if (node === el) return { state: 'ok', rect };
    if (node.tagName === 'LABEL' && (node as HTMLLabelElement).control === el) return { state: 'ok', rect };
  }
  if (el.tagName === 'LABEL' && (el as HTMLLabelElement).control === hit) return { state: 'ok', rect };
  return { state: 'covered', detail: describe(hit), rect };
}

const same = (a?: ActionState['rect'], b?: ActionState['rect']) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** Why a click could not be made, in words for the step's error. */
export function notActionable(state: ActionState, timeoutMs: number): string {
  const within = `within ${timeoutMs / 1000} s`;
  switch (state.state) {
    case 'detached': return LEFT_THE_PAGE;
    case 'hidden': return `the element stayed hidden ${within}`;
    case 'disabled': return `the element stayed disabled ${within}`;
    case 'covered': return `the element stayed covered by ${state.detail} ${within}, which would receive the click instead`;
    default: return `the element kept moving ${within}`;
  }
}

/**
 * Waits until the element can take a click (see above), up to `timeoutMs`. Resolves to null
 * when it can, else to why not.
 */
export async function waitActionable(
  handle: ElementHandle<Element>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let previous: ActionState | null = null;
  for (;;) {
    const now = await handle.evaluate(actionStateOf);
    if (now.state === 'ok' && previous?.state === 'ok' && same(now.rect, previous.rect)) return null;
    if (now.state === 'detached') return notActionable(now, timeoutMs);
    if (Date.now() >= deadline) return notActionable(now.state === 'ok' ? { state: 'ok' } as ActionState : now, timeoutMs);
    previous = now;
    await sleep(POLL_MS);
  }
}

/**
 * In the page: whether `el` is, or sits in, a link that opens another page in this tab — an
 * href to another address, not "#…", not javascript:, not a download, not a new tab.
 */
export function linkLeadsAway(el: Element): boolean {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return false;
  const raw = (a.getAttribute('href') || '').trim();
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw) || a.hasAttribute('download')) return false;
  if (a.target && a.target !== '_self') return false;
  try {
    const to = new URL(a.href, location.href);
    const here = new URL(location.href);
    to.hash = ''; here.hash = '';
    return to.href !== here.href;
  } catch {
    return false;
  }
}

export interface ClickWatch {
  /** Whether the click did something: waits up to a second for it. */
  hadEffect(): Promise<boolean>;
}

/**
 * Starts watching, before a click on `handle`, for what it does: the DOM of its document
 * changing, its page navigating, a request leaving the tab.
 */
export async function watchClick(page: Page, handle: ElementHandle<Element>): Promise<ClickWatch> {
  const frame: Frame = handle.frame;
  // A link to another page: what it does is open that page. A page still drawing itself
  // changes its DOM whether or not the click was taken (an identity portal's pages, seconds after they
  // load), so for a link only a navigation counts.
  const leadsAway = await handle.evaluate(linkLeadsAway).catch(() => false);
  let requested = false;
  const onRequest = (request: { isNavigationRequest(): boolean }) => {
    if (!leadsAway || request.isNavigationRequest()) requested = true;
  };
  page.on('request', onRequest);
  await handle.evaluate((el) => {
    const w = el.ownerDocument.defaultView as (Window & { __izitestClick?: { changes: number; url: string; observer: MutationObserver } }) | null;
    if (!w) return;
    w.__izitestClick?.observer.disconnect();
    const state = { changes: 0, url: w.location.href, observer: new MutationObserver((list) => { state.changes += list.length; }) };
    state.observer.observe(el.ownerDocument.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    w.__izitestClick = state;
  }).catch(() => {});
  const read = async (): Promise<boolean> => {
    try {
      return await frame.evaluate((onlyNavigation: boolean) => {
        const state = (window as Window & { __izitestClick?: { changes: number; url: string } }).__izitestClick;
        // Gone: the document was replaced, the click navigated.
        return !state || (!onlyNavigation && state.changes > 0) || location.href !== state.url;
      }, leadsAway);
    } catch {
      // The frame navigated or went away: the click did that.
      return true;
    }
  };
  return {
    async hadEffect() {
      const deadline = Date.now() + EFFECT_WAIT_MS;
      try {
        for (;;) {
          if (requested || await read()) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } finally {
        page.off('request', onRequest);
        await frame.evaluate(() => {
          const w = window as Window & { __izitestClick?: { observer: MutationObserver } };
          w.__izitestClick?.observer.disconnect();
          delete w.__izitestClick;
        }).catch(() => {});
      }
    },
  };
}

/**
 * Whether an action was refused because its element is not ready yet: something lies over it
 * (actions.ts), or the page does not show it yet.
 */
export const isNotReadyRefusal = (err: unknown): boolean =>
  /is covered at its centre|^Element not found: /.test(err instanceof Error ? err.message : String(err));

/**
 * Runs an action of a step that has no locators (clicked through its selector or text) and,
 * while it is refused because its element is not there yet or something lies over it — the
 * loading veil of an app changing page —, runs it again until `timeoutMs` is up: the wait the
 * steps with locators have (findElementWithLocators, waitActionable). Any other error is
 * thrown at once.
 */
export async function untilReady<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (!isNotReadyRefusal(err) || Date.now() >= deadline) throw err;
    }
    await sleep(POLL_MS * 2);
  }
}
