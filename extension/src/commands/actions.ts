// Direct browser action commands (navigate, click, fill, keyboard, scroll).
import { getPage } from '../puppeteer-client';
import { resolveTabId, waitForTabLoad, delay, ensureContentScript, SCROLL_SETTLE_DELAY_MS, ExpectedRefusal, TOP_FRAME } from '../helpers';
import { sendToFrame, frameOfRef, measureInFrame, findInFrames } from '../frames';
import { CMD_KEY, MODIFIER_MAP, focusViaLocator, clearAndType } from './page-helpers';
import { attachNetworkCapture } from './network';
import { adoptOpenedWindow, rememberOwnedWindow } from '../owned-windows';
import { armEffects } from '../effects';
import { dragBetween, dropPoint } from './drag';
import type { NavigateParams, ClickParams, FillParams, SelectParams, UploadParams, DragParams, KeyboardParams, ScrollParams } from '../types';
import type { CDPSession, Page } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';

// ─── Ref resolution (content script element map) ────────────────────

interface ResolvedElement {
  x: number;
  y: number;
  tag: string;
  text: string;
  scrolled?: boolean;
  /** Something else is on top of the element at (x, y); this names it. */
  coveredBy?: string;
  /** The checkbox, radio or switch the click acts on, as it is before the click. */
  toggle?: { kind: 'checkbox' | 'radio' | 'switch'; checked: boolean };
  /** A checkbox or radio styled away: the click goes to its label. */
  viaLabel?: boolean;
  /** That label is a separate <label for>: the input's id. */
  labelFor?: string;
  /** A date, time, colour or range input (its type): its value is set, not typed. */
  picked?: string;
  width: number;
  height: number;
}

// Roles Playwright's getByRole finds by name.
const NAMED_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'textbox', 'searchbox', 'heading', 'slider', 'spinbutton', 'treeitem',
]);
const ACCESSIBLE_LOOKUP_MS = 400;

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Where a role and name found more than once on the page is the one clicked (see accessibleAt). */
export interface AccessibleTarget {
  role: string;
  name: string;
  /** The closest ancestor (data-testid, or an id a developer wrote) holding only this one. */
  scope?: { testid?: string; css?: string };
  /** No such ancestor: its rank among the page's elements of that role and name, from 0. */
  nth?: number;
}

// Run on the clicked element: its ancestors that can scope a locator, closest first —
// described (pick < 0), or the one at `pick`. An id with 3 digits or more is taken as generated.
const SCOPE_ANCESTORS = `function (pick) {
  const found = [];
  for (let el = this.parentElement; el && found.length < 8; el = el.parentElement) {
    const testid = el.getAttribute('data-testid');
    const id = /^[A-Za-z][\\w-]*$/.test(el.id) && !/\\d{3,}/.test(el.id) ? el.id : '';
    if (testid || id) found.push({ el, scope: testid ? { testid } : { css: '#' + id } });
  }
  return pick < 0 ? found.map((f) => f.scope) : found[pick].el;
}`;

/**
 * Where a role and name is in the page, when it is there more than once — the "Clear" of a
 * login form and the "Clear" of a contact form: getByRole('button', { name: 'Clear' }) found
 * both, and the generated test failed on Playwright's strict mode. Counted by Chrome, as
 * getByRole counts: hidden elements (a wizard's other steps) are not in it.
 */
async function placeOf(cdp: CDPSession, backendNodeId: number, role: string, name: string): Promise<Pick<AccessibleTarget, 'scope' | 'nth'>> {
  const count = async (root: { backendNodeId?: number; objectId?: string }) =>
    ((await cdp.send('Accessibility.queryAXTree', { ...root, accessibleName: name, role })) as { nodes: AXNode[] }).nodes;
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const same = await count({ backendNodeId: root.backendNodeId });
  if (same.length <= 1) return {};

  const objectGroup = 'izitest-place';
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId, objectGroup });
    const call = (pick: number, returnByValue: boolean) => cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: SCOPE_ANCESTORS, arguments: [{ value: pick }], returnByValue, objectGroup,
    });
    const scopes = ((await call(-1, true)).result.value ?? []) as NonNullable<AccessibleTarget['scope']>[];
    for (let i = 0; i < scopes.length; i++) {
      const { result } = await call(i, false);
      if ((await count({ objectId: result.objectId })).length === 1) return { scope: scopes[i] };
    }
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
  const nth = same.findIndex((n) => n.backendDOMNodeId === backendNodeId);
  return nth >= 0 ? { nth } : {};
}

/**
 * The role and accessible name Chrome gives the element at (x, y) — or the control it sits
 * in: the point is often on a text inside a button. What Playwright's getByRole matches,
 * where the name the snapshot computes can differ (hidden text, a title over the content).
 * Null when none is found, or Chrome takes too long: the click does not wait on it.
 */
async function accessibleAt(page: Page, x: number, y: number): Promise<AccessibleTarget | null> {
  const lookup = (async () => {
    const cdp = (page as unknown as { _client(): CDPSession })._client();
    // (x, y) is where the mouse goes, in the viewport; getNodeForLocation takes a point of
    // the document: on a scrolled page it found nothing ("No node found at given location").
    const { cssVisualViewport } = await cdp.send('Page.getLayoutMetrics');
    const { backendNodeId } = await cdp.send('DOM.getNodeForLocation', {
      x: Math.round(x + cssVisualViewport.pageX),
      y: Math.round(y + cssVisualViewport.pageY),
      ignorePointerEventsNone: true,
    });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true }) as { nodes: AXNode[] };
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    let node = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
    for (let level = 0; node && level < 6; level++, node = node.parentId ? byId.get(node.parentId) : undefined) {
      const role = node.role?.value ?? '';
      const raw = node.name?.value ?? '';
      const name = raw.trim();
      if (!node.ignored && NAMED_ROLES.has(role) && name) {
        const place = node.backendDOMNodeId ? await placeOf(cdp, node.backendDOMNodeId, role, raw) : {};
        return { role, name, ...place };
      }
    }
    return null;
  })();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ACCESSIBLE_LOOKUP_MS));
  return Promise.race([lookup.catch(() => null), timeout]);
}

/** The state wanted from a step's `checked`: a boolean, or "true"/"false" once a variable is filled in. */
export function wantedChecked(checked: unknown): boolean | undefined {
  if (typeof checked === 'boolean') return checked;
  if (checked === 'true') return true;
  if (checked === 'false') return false;
  return undefined;
}

const REF_SCROLL_SETTLE_MS = 50;
// How long a click waits to see whether it opened a tab (target=_blank, window.open).
const NEW_TAB_WATCH_MS = 700;

/** Ask one frame's content script to measure an element: by ref, or by selector or text. */
async function askFrameToMeasure(
  tabId: number,
  frameId: number,
  message: Record<string, unknown>,
  notFound: string
): Promise<ResolvedElement> {
  const response = await sendToFrame<{ success: boolean; element?: ResolvedElement; error?: string; stale?: boolean }>(tabId, frameId, message)
    .catch((err: Error) => {
      // The frame that handed out this ref is gone: its iframe closed or navigated.
      if (frameId !== TOP_FRAME && message.type === 'resolve_ref') {
        throw new ExpectedRefusal(`Stale ref ${message.ref}: the iframe it came from has closed or reloaded. Take a new snapshot.`);
      }
      throw err;
    });
  // A stale ref is the agent's to fix (take a new snapshot), not an extension fault.
  if (response?.stale) throw new ExpectedRefusal(response.error || notFound);
  if (!response?.success || !response.element) throw new Error(response?.error || notFound);
  return response.element;
}

/** Measure in `frameId`; for an iframe, also place the point on the page through its parents. */
function measureIn(tabId: number, frameId: number, message: Record<string, unknown>, notFound: string) {
  return (uncover: boolean): Promise<ResolvedElement> => {
    const local = (u: boolean) => askFrameToMeasure(tabId, frameId, { ...message, uncover: u }, notFound);
    return frameId === TOP_FRAME ? local(uncover) : measureInFrame(tabId, frameId, uncover, local);
  };
}

/**
 * The role, name and locators of a ref's element, for the server to record with the action.
 * Asked before acting: a click may take the element (or the whole page) away.
 */
async function describeRefTarget(tabId: number, ref: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!ref) return undefined;
  const frameId = await frameOfRef(tabId, ref);
  const answer = await sendToFrame<{ success: boolean; info?: Record<string, unknown> | null }>(tabId, frameId, { type: 'describe_ref', ref })
    .catch(() => null);
  return answer?.info ?? undefined;
}

export async function resolveElementRef(tabId: number, ref: string): Promise<ResolvedElement> {
  // A ref from a cross-origin iframe lives in that frame's content script, not the page's.
  const frameId = await frameOfRef(tabId, ref);
  if (frameId === TOP_FRAME) await ensureContentScript(tabId);
  return settleAndMeasure(measureIn(tabId, frameId, { type: 'resolve_ref', ref }, 'Failed to resolve ref: ' + ref));
}

/**
 * Where to click an element named by CSS selector or visible text.
 *
 * Measured from inside the page, like refs are. page.evaluate() through the extension
 * transport can land on a stale execution context and see an empty document, which made
 * every click by selector fail with "Element not found after handle disposal" — even for a
 * plain <a> that was right there. Looked for in the page (same-origin iframes included)
 * first, then in cross-origin iframes.
 */
export async function resolveElementBySelector(
  tabId: number,
  by: { selector?: string; text?: string }
): Promise<ResolvedElement> {
  await ensureContentScript(tabId);
  const message = { type: 'locate_element', ...by };
  const notFound = `Element not found: ${by.selector ?? by.text}`;
  try {
    return await settleAndMeasure(measureIn(tabId, TOP_FRAME, message, notFound));
  } catch (onPage) {
    const found = await findInFrames(tabId, (frameId) =>
      sendToFrame<{ success: boolean }>(tabId, frameId, { ...message, uncover: false }));
    if (!found) throw onPage;
    return settleAndMeasure(measureIn(tabId, found.frameId, message, notFound));
  }
}

/**
 * Ask once, allowing the page to scroll the element into view or out from under whatever
 * covers it; if it scrolled, let layout settle out here and ask again for the verdict.
 */
async function settleAndMeasure(ask: (uncover: boolean) => Promise<ResolvedElement>): Promise<ResolvedElement> {
  const element = await ask(true);
  if (!element.scrolled) return element;

  // Settle HERE — service worker timers are not throttled when the piloted window is
  // hidden, page timers are (see resolveRef) — then read the final position.
  await delay(REF_SCROLL_SETTLE_MS);
  return ask(false);
}

/**
 * Refuse to press a point that belongs to something else.
 *
 * The mouse event goes to whatever is topmost there. Clicking anyway used to answer
 * success, naming the target, while a cookie banner or a sticky header took the click —
 * the agent then carried on as if the button had been pressed.
 */
function assertNotCovered(element: ResolvedElement, action: string): void {
  if (!element.coveredBy) return;
  const what = `<${element.tag}>${element.text ? ` "${element.text.trim().slice(0, 40)}"` : ''}`;
  throw new ExpectedRefusal(
    `Not ${action}: ${what} is covered at its centre (${element.x},${element.y}) by ` +
    `${element.coveredBy}, which would receive the click instead. Something is on top of it — ` +
    `a cookie banner, a sticky header, a modal or a loading overlay. Close or dismiss it ` +
    `(snapshot can find its button), then retry.`
  );
}

// ─── Commands ────────────────────────────────────────────────────────

export async function cmdNavigate(
  { url, tabId, sessionId, newWindow, viewportWidth, viewportHeight }: NavigateParams,
  onProgress?: (data: unknown) => void
) {
  let targetTabId: number;

  if (tabId) {
    targetTabId = tabId;
  } else if (newWindow) {
    // Chrome window chrome (title bar, borders) adds ~80px height and ~0-16px width
    const windowOpts: chrome.windows.CreateData = { url: 'about:blank' };
    if (viewportWidth) windowOpts.width = viewportWidth + 16;
    if (viewportHeight) windowOpts.height = viewportHeight + 88;
    const newWin = await chrome.windows.create(windowOpts);
    if (newWin.id !== undefined) await rememberOwnedWindow(newWin.id, sessionId);
    targetTabId = newWin.tabs![0].id!;

    // Tell the server which window is ours NOW, not after the page has loaded. A slow site
    // could make navigate exceed the command timeout, and the session would never learn it
    // owned a window: close_window then answered "nothing to close" and the window leaked.
    onProgress?.({ phase: 'window-created', tabId: targetTabId, windowId: newWin.id });
  } else {
    // Use the current active tab instead of creating a new one
    targetTabId = await resolveTabId(undefined, sessionId);
  }

  const page = await getPage(targetTabId);
  attachNetworkCapture(targetTabId, page);

  // Set precise viewport dimensions if specified
  if (viewportWidth && viewportHeight) {
    await page.setViewport({ width: viewportWidth, height: viewportHeight });
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForTabLoad(targetTabId);

  const updatedTab = await chrome.tabs.get(targetTabId);
  // windowId goes back to the server so the session can claim this window as its own.
  if (sessionId) await rememberOwnedWindow(updatedTab.windowId, sessionId);
  return { tabId: targetTabId, windowId: updatedTab.windowId, url: updatedTab.url, title: updatedTab.title };
}

export async function cmdClick({ selector, tabId, sessionId, text, ref, checked }: ClickParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const page = await getPage(resolvedTabId);

  // Every path resolves coordinates from inside the page, then clicks with real mouse
  // events: that is what makes the click a genuine user gesture (so target=_blank and
  // window.open are not treated as popups) and it avoids page.evaluate(), which through
  // the extension transport can land on a stale execution context and see no document.
  const element = ref
    ? await resolveElementRef(resolvedTabId, ref)
    : await resolveElementBySelector(resolvedTabId, { selector, text });

  if (!ref && !selector && !text) throw new Error('Provide selector, text, or ref to click');

  // A click toggles a checkbox: asked for a state it is already in, leave it there.
  const wanted = wantedChecked(checked);
  const via = element.viaLabel ? { viaLabel: true, ...(element.labelFor ? { labelFor: element.labelFor } : {}) } : {};
  if (element.toggle && wanted !== undefined && element.toggle.checked === wanted) {
    return { success: true, tag: element.tag, text: element.text, checked: wanted, ...via, changes: [`already ${wanted ? 'checked' : 'unchecked'}: not clicked`] };
  }

  assertNotCovered(element, 'clicked');
  const target = await describeRefTarget(resolvedTabId, ref);
  // Before the click, which may take the element away. A box clicked through its label has
  // its own way out (viaLabel): the label's role says nothing of it.
  const accessible = element.viaLabel ? null : await accessibleAt(page, element.x, element.y);

  const effects = await armEffects(resolvedTabId);
  const openedTab = watchForNewTab(resolvedTabId);

  await page.mouse.move(element.x, element.y);
  await delay(50);
  await page.mouse.down();
  await delay(50);
  await page.mouse.up();

  const [newTab, changed] = await Promise.all([openedTab, effects.collect()]);
  const changes = changed.filter((line) => !line.startsWith('no visible change') || !newTab);
  if (newTab) {
    // A popup window opened from a session's window belongs to that session.
    const [clicked, opened] = await Promise.all([
      chrome.tabs.get(resolvedTabId).catch(() => null),
      chrome.tabs.get(newTab.tabId).catch(() => null),
    ]);
    if (clicked) await adoptOpenedWindow(clicked.windowId, newTab.windowId);
    const where = clicked && clicked.windowId !== newTab.windowId ? 'a new window' : 'a new tab';
    changes.unshift(`opened ${where} (tab ${newTab.tabId})${opened ? `: ${opened.pendingUrl || opened.url || ''}` : ''}`);
  }
  return {
    success: true,
    tag: element.tag,
    text: element.text,
    // The state the click left a checkbox, radio or switch in: what a recording replays to,
    // instead of toggling it again.
    ...(element.toggle ? { checked: element.toggle.kind === 'radio' || !element.toggle.checked } : {}),
    ...via,
    ...(accessible ? { accessible } : {}),
    ...(newTab ? { newTabId: newTab.tabId, newWindowId: newTab.windowId } : {}),
    // What the click did: so the agent does not need a screenshot to find out.
    changes,
    ...(target ? { target } : {}),
  };
}

/**
 * A click can open a tab (target=_blank, window.open). Report it, so the agent knows where
 * the flow went — a "Continue with Google" button that opens a popup used to answer
 * success with no sign that anything had been opened.
 */
function watchForNewTab(openerTabId: number, waitMs = NEW_TAB_WATCH_MS): Promise<{ tabId: number; windowId: number } | null> {
  return new Promise((resolve) => {
    const onCreated = (tab: chrome.tabs.Tab) => {
      if (tab.openerTabId !== undefined && tab.openerTabId !== openerTabId) return;
      if (tab.id === undefined) return;
      done({ tabId: tab.id, windowId: tab.windowId });
    };
    const timer = setTimeout(() => done(null), waitMs);
    function done(result: { tabId: number; windowId: number } | null) {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      resolve(result);
    }
    chrome.tabs.onCreated.addListener(onCreated);
  });
}

export async function cmdFill({ selector, value, tabId, sessionId, clear, ref, typing }: FillParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const page = await getPage(resolvedTabId);
  const shouldClear = clear ?? true;

  if (ref) {
    const element = await resolveElementRef(resolvedTabId, ref);
    // The click is what focuses the field: if it lands elsewhere, the typing goes there.
    assertNotCovered(element, 'filled');
    const target = await describeRefTarget(resolvedTabId, ref);
    if (element.picked) {
      await setPicked(resolvedTabId, { ref }, value);
      return { success: true, selector: ref, ...(target ? { target } : {}) };
    }
    await page.mouse.click(element.x, element.y);
    await clearAndType(page, value, shouldClear, typing);
    return { success: true, selector: ref, ...(target ? { target } : {}) };
  }

  if (!selector) throw new Error('Provide selector or ref to fill');

  // Same path as fill by ref: found from inside the page — iframes included — and checked
  // for anything covering it. The Puppeteer path below only sees the top frame; it stays as
  // the fallback for a field that has not appeared yet (it waits) or has no box to click.
  const located = await resolveElementBySelector(resolvedTabId, { selector }).catch(() => null);
  if (located) {
    assertNotCovered(located, 'filled');
    if (located.picked) {
      await setPicked(resolvedTabId, { selector }, value);
      return { success: true, selector };
    }
    await page.mouse.click(located.x, located.y);
    await clearAndType(page, value, shouldClear, typing);
    return { success: true, selector };
  }

  const elementHandle = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
  if (!elementHandle) throw new Error(`Element not found: ${selector}`);
  await elementHandle.dispose().catch(() => {});

  await focusViaLocator(page, 'css', selector);
  await delay(50);
  await clearAndType(page, value, shouldClear, typing);

  return { success: true, selector };
}

/** Set a date, time, colour or range input from inside the page (see dom/picked-input.ts). */
async function setPicked(tabId: number, by: { ref?: string; selector?: string }, value: string): Promise<void> {
  const result = await askFrameOf(tabId, by, { type: 'set_input_value', ...by, value });
  if (!result.success) throw new Error(result.error);
}

type PageAnswer = { success: boolean; error?: string };

/**
 * Send `message` to the frame that holds the element. A ref names its frame; a selector is
 * looked for on the page first, then in cross-origin iframes — but only when the page says
 * it is not there.
 */
async function askFrameOf<T extends PageAnswer>(tabId: number, by: { ref?: string; selector?: string }, message: Record<string, unknown>): Promise<T> {
  const ask = (frameId: number) =>
    sendToFrame<T>(tabId, frameId, message).then((r) => r ?? ({ success: false, error: 'No answer from the page' } as T));
  let result = await ask(by.ref ? await frameOfRef(tabId, by.ref) : TOP_FRAME);
  if (!by.ref && !result.success && /not found/i.test(result.error ?? '')) {
    const found = await findInFrames(tabId, ask);
    if (found) result = found.answer;
  }
  return result;
}

export async function cmdSelect({ selector, value, tabId, sessionId, ref, matchBy }: SelectParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  if (!ref && !selector) throw new Error('Provide selector or ref to select');

  // Chosen from inside the page (see selectOption): it reaches selects inside same-origin
  // iframes, which the previous page.evaluate() — top frame only — could not.
  type SelectAnswer = PageAnswer & { selectedValue?: string; selectedText?: string };
  await ensureContentScript(resolvedTabId);
  const target = await describeRefTarget(resolvedTabId, ref);
  const result = await askFrameOf<SelectAnswer>(resolvedTabId, { ref, selector },
    { type: 'select_option', ref, selector, value, matchBy: matchBy || 'text' });

  if (!result.success) throw new Error(result.error);
  return {
    success: true, selector: ref ?? selector, selectedValue: result.selectedValue, selectedText: result.selectedText,
    ...(target ? { target } : {}),
  };
}

/**
 * Give files to the file input a ref or selector stands for — itself, or the one of its
 * drop zone, label or "Upload" button (see dom/file-input.ts). `input` in the result
 * describes that input when it is another element: it is what the step records.
 */
export async function cmdUpload({ selector, ref, fileData, tabId, sessionId }: UploadParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  if (!ref && !selector) throw new Error('Provide selector or ref to upload to');
  if (!fileData?.length) throw new Error('No file to upload');

  await ensureContentScript(resolvedTabId);
  const target = await describeRefTarget(resolvedTabId, ref);
  type UploadAnswer = PageAnswer & { names?: string[]; input?: Record<string, unknown> };
  const result = await askFrameOf<UploadAnswer>(resolvedTabId, { ref, selector },
    { type: 'set_input_files', ref, selector, files: fileData });
  if (!result.success) throw new Error(result.error);
  return {
    success: true, selector: ref ?? selector, files: result.names,
    ...(result.input ? { input: result.input } : {}), ...(target ? { target } : {}),
  };
}

/**
 * Drag an element and drop it on another, at its centre or near one of its edges (see
 * drag.ts). Both are measured where they are, on screen together. `changes` says whether
 * the dragged element moved, and what else the drop showed or took away.
 */
export async function cmdDrag({ ref, selector, targetRef, target, position, tabId, sessionId }: DragParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  if (!ref && !selector) throw new Error('Provide what to drag: ref or selector');
  if (!targetRef && !target) throw new Error('Provide where to drop it: targetRef or target');
  const page = await getPage(resolvedTabId);
  const measure = (r?: string, s?: string) => () => r ? resolveElementRef(resolvedTabId, r) : resolveElementBySelector(resolvedTabId, { selector: s });
  const { from, to } = await measureBoth(measure(ref, selector), measure(targetRef, target));
  assertNotCovered(from, 'dragged');

  const [source, dropTarget] = [await describeRefTarget(resolvedTabId, ref), await describeRefTarget(resolvedTabId, targetRef)];
  const effects = await armEffects(resolvedTabId);
  const how = await dragBetween(page, from, dropPoint(to, position));
  const changed = await effects.collect();

  const after = await measure(ref, selector)().catch(() => null);
  const moved = !after ? 'the dragged element is no longer on the page, or no longer shows'
    : after.x !== from.x || after.y !== from.y ? `the dragged element moved, from (${from.x},${from.y}) to (${after.x},${after.y})`
    : 'the dragged element is where it was';
  return {
    success: true, tag: from.tag, text: from.text, drag: how,
    changes: [moved, ...changed.filter((line) => !line.startsWith('no visible change'))],
    ...(source ? { target: source } : {}), ...(dropTarget ? { dropTarget } : {}),
  };
}

/**
 * Measure two elements on screen together. Measuring one scrolls it into view when it is
 * not, which can scroll the other away: measured again until neither moves.
 */
async function measureBoth(first: () => Promise<ResolvedElement>, second: () => Promise<ResolvedElement>) {
  let from = await first();
  let to = await second();
  const same = (a: ResolvedElement, b: ResolvedElement) => a.x === b.x && a.y === b.y;
  for (let round = 0; round < 2; round++) {
    const fromAgain = await first();
    if (same(fromAgain, from)) return { from, to };
    from = fromAgain;
    const toAgain = await second();
    if (same(toAgain, to)) return { from, to };
    to = toAgain;
  }
  throw new ExpectedRefusal('Not dragged: the element and where to drop it are too far apart to be on screen together, ' +
    'and drag does not scroll while it holds the element. Drop it somewhere closer first, or make the window taller.');
}

export async function cmdKeyboard({ key, modifiers, tabId, sessionId }: KeyboardParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const page = await getPage(resolvedTabId);

  const mods = modifiers || [];
  for (const mod of mods) await page.keyboard.down(MODIFIER_MAP[mod]);
  await page.keyboard.press(key as any);
  for (const mod of [...mods].reverse()) await page.keyboard.up(MODIFIER_MAP[mod]);

  return { success: true, key };
}

export async function cmdScroll({ direction, amount, tabId, sessionId, selector, ref }: ScrollParams) {
  const resolvedTabId = await resolveTabId(tabId, sessionId);
  const page = await getPage(resolvedTabId);

  if (ref) {
    await resolveElementRef(resolvedTabId, ref);
    await delay(SCROLL_SETTLE_DELAY_MS);
    return { scrolledTo: ref };
  } else if (selector) {
    const handle = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
    if (handle) {
      await page.evaluate((el: Element) => el.scrollIntoView({ behavior: 'instant', block: 'center' }), handle);
      await handle.dispose();
    }
    return { scrolledTo: selector };
  }

  const scrollPixels = amount || 500;
  const deltaY = direction === 'up' ? -scrollPixels : scrollPixels;
  await page.mouse.wheel({ deltaY });

  return { scrolled: direction || 'down', pixels: scrollPixels };
}
