import { describeBlocker, frameLevels, hitTestThroughFrames, type FrameLevel } from './hit-test';
import { toggleOf, isToggleInput, styledAwayToggleLabel, textAround, type ToggleState } from './toggle';
import { pickedInputType, setPickedValue } from './picked-input';
import { fileInputOf, putFiles, type FileData } from './file-input';
import { fieldByLabel, fieldNames } from './field-label';

export type SnapshotPurpose = 'fill' | 'click' | 'read';

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  compact?: boolean;
  maxDepth?: number;
  scope?: string | null;
  format?: 'text' | 'json';
  maxTextLength?: number;
  includeHidden?: boolean;
  includeRects?: boolean;
  inlineFrames?: boolean;
  purposeFilter?: SnapshotPurpose;
  searchText?: string;
  // Treat named cursor:pointer elements as interactive (div/li click handlers: autocomplete
  // suggestions, custom dropdown options, SPA "buttons"). Only the OUTERMOST pointer element
  // of a nested chain counts — cursor is inherited, so every descendant would match too.
  pointerInteractive?: boolean;
  // Also return a short digest of visible headings / alerts / dialogs (see SnapshotResult.digest).
  textDigest?: boolean;
  // Lowest ref number to hand out to an element that has none yet. A cross-origin iframe
  // snapshots itself in its own frame, numbering after the page's refs so every @eN stays
  // unique across the merged tree.
  refStart?: number;
  // The page frame: when this document has never been snapshotted (a new page), number from
  // @e1 again instead of from refStart.
  restartIfFresh?: boolean;
  // Forget every ref of this frame first: the page around it has changed.
  resetRefs?: boolean;
}

export interface Locator {
  type: string;
  value: string;
}

export interface RefNodeInfo {
  role: string;
  name: string;
  level?: number;
  selector?: string;
  locators?: Locator[];
  rect?: { x: number; y: number; w: number; h: number };
}

export interface SnapshotResult {
  url: string;
  title: string;
  timestamp: number;
  refs?: Record<string, RefNodeInfo>;
  tree: string;
  viewport?: { w: number; h: number; scrollY: number; pageH: number };
  /** The ref number after the last one handed out — where the next frame's numbering starts. */
  nextRef?: number;
  /** This document had no refs before this snapshot: every ref of an earlier page is void. */
  freshRefs?: boolean;
  // Visible headings, alerts, status messages and dialog titles — what the page SAYS,
  // for callers that otherwise only see interactive elements.
  digest?: string[];
}

// ─── Refs ────────────────────────────────────────────────────────────
//
// An element keeps its ref for as long as it stays on the page: a second snapshot, with
// another filter or none, names it with the same @eN. Refs used to be renumbered on every
// snapshot, so a ref read before another snapshot silently pointed at nothing — or at a
// different element. New elements get numbers above every number handed out so far, so a
// number is never reused for something else while the page lives.
declare global {
  interface Window {
    __izitestRefMap?: Map<string, Element>;
    __izitestRefOf?: WeakMap<Element, string>;
    /** Refs whose element has left the page: a click on one is told it is stale. */
    __izitestRetiredRefs?: Set<string>;
    __izitestNextRef?: number;
  }
}

/** Ready the ref registry for a snapshot. True when this document had none (a new page). */
function prepareRefRegistry(reset: boolean): boolean {
  const fresh = !window.__izitestRefMap || reset;
  if (fresh) {
    window.__izitestRefMap = new Map();
    window.__izitestRefOf = new WeakMap();
    window.__izitestRetiredRefs = new Set();
    window.__izitestNextRef = 1;
    return true;
  }
  // Holding a removed element would keep its whole detached subtree alive.
  for (const [ref, el] of window.__izitestRefMap!) {
    if (!el.isConnected) {
      window.__izitestRefMap!.delete(ref);
      window.__izitestRetiredRefs!.add(ref);
    }
  }
  return false;
}

/** Why a ref cannot be used, or null when it can. */
export function refProblem(ref: string): string | null {
  const el = window.__izitestRefMap?.get(ref);
  if (el?.isConnected) return null;
  if (el || window.__izitestRetiredRefs?.has(ref)) {
    return `Stale ref ${ref}: the element it named has been removed from the page (it re-rendered or ` +
      `changed). Take a new snapshot and use the ref it gives.`;
  }
  return `Stale ref ${ref}: it does not belong to the page now in the tab (it came from a page that ` +
    `has since navigated or reloaded, or was never handed out). Take a new snapshot.`;
}

/**
 * Locate an element by CSS selector, visible text or the label of a field, and return where
 * to click it.
 *
 * Same contract as resolveRef, and the same reason for existing: measuring from inside the
 * page is reliable, whereas page.evaluate() through the extension transport can land on a
 * stale execution context and see an empty document.
 */
const CONTROL = 'button,a[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[onclick]';

/**
 * The element a person means by its text: a leaf whose whole text it is — one that shows,
 * and in a control first. "Sign in" is the button, not the form's heading above it, which
 * came first in the page: the click, and the list detection of the click recorded, took it.
 */
export function elementByText(wanted: string, docs: Document[] = searchableDocuments()): Element | null {
  const leaves: Element[] = [];
  for (const doc of docs) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Element;
      if (node.children.length === 0 && node.textContent?.trim() === wanted) leaves.push(node);
    }
  }
  const shows = (node: Element) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return leaves.find((node) => node.closest(CONTROL) && shows(node)) ?? leaves.find(shows) ?? leaves[0] ?? null;
}

export async function locateElement(
  by: { selector?: string; text?: string; label?: string },
  options: MeasureOptions = {}
): Promise<ClickTarget | null> {
  // The page and every same-origin iframe in it, outermost first: the snapshot already
  // shows what is inside those frames, so a click by selector or text has to reach it too.
  const docs = searchableDocuments();
  let el: Element | null = null;

  if (by.selector) {
    for (const doc of docs) {
      el = doc.querySelector(by.selector);
      if (el) break;
    }
  } else if (by.text) {
    const wanted = by.text.trim();
    el = elementByText(wanted, docs);
    if (!el) {
      for (const doc of docs) {
        el = [...doc.querySelectorAll('button,a,input[type="submit"],input[type="button"],[role="button"]')]
          .find((e) => e.textContent?.trim().includes(wanted)) ?? null;
        if (el) break;
      }
    }
  } else if (by.label) {
    el = fieldByLabel(by.label, docs);
  }

  if (!el) return null;
  return measureForClick(el, options);
}

/**
 * Choose an option in a native <select>, found by snapshot ref, CSS selector or label — in
 * the page or in a same-origin iframe.
 *
 * Done here rather than through page.evaluate(), which only sees the top frame and can land
 * on a stale execution context. No click either: clicking a native <select> opens its
 * dropdown, and focus is all a framework needs to see the change as a user's.
 */
export function selectOption(
  by: FieldBy,
  value: string,
  matchBy: 'text' | 'value' = 'text'
): { success: true; selectedValue: string; selectedText: string } | { success: false; error: string } {
  const found = elementBy(by, 'Select element');
  if ('error' in found) return { success: false, error: found.error };
  const { el } = found;
  // A ref may point at a wrapper or at an option; the control is the nearest <select>.
  const select = (el.tagName === 'SELECT' ? el : el.closest('select')) as HTMLSelectElement | null;
  if (!select) return { success: false, error: `Element is not a <select>: ${el.tagName}` };

  const options = Array.from(select.options);
  // By text, the option's value comes next, as Playwright's selectOption takes either: a
  // step is recorded by value, and a Gherkin phrase read back ("I select "pro" in …") has
  // lost which one it was.
  const exact = options.find((o) => matchBy === 'value'
    ? o.value === value
    : o.text.trim() === value || o.textContent?.trim() === value)
    ?? (matchBy === 'text' ? options.find((o) => o.value === value && value !== '') : undefined);
  const lower = value.toLowerCase();
  const partial = !exact && matchBy === 'text'
    ? options.find((o) => o.text.trim().toLowerCase().includes(lower) || o.textContent?.trim().toLowerCase().includes(lower))
    : undefined;
  const option = exact ?? partial;
  if (!option) {
    const available = options.map((o) => `"${o.text.trim()}" (value="${o.value}")`).join(', ');
    return { success: false, error: `No option matching "${value}" (by ${matchBy}). Available: ${available}` };
  }

  select.focus();
  select.value = option.value;
  // So frameworks (React, Vue, Angular) pick the change up.
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, selectedValue: option.value, selectedText: option.text.trim() };
}

/**
 * Give a date, time, colour or range input its value from inside the page (see
 * picked-input.ts): such an input is not typed into.
 */
export function setInputValue(
  by: FieldBy,
  value: string
): { success: true; value: string } | { success: false; error: string } {
  const found = elementBy(by, 'Input');
  if ('error' in found) return { success: false, error: found.error };
  const result = setPickedValue(found.el, value);
  if (!result) return { success: false, error: `Not a date, time, colour or range input: <${found.el.tagName.toLowerCase()}>` };
  return 'error' in result ? { success: false, error: result.error } : { success: true, value: result.value };
}

/**
 * Give files to the file input a ref or selector stands for (see file-input.ts): the
 * element itself, or the input of its drop zone, label or "Upload" button. That input, when
 * it is another element, is described for the step to record: the code generated from the
 * step sets files on it, not on the drop zone.
 */
export function setInputFiles(
  by: FieldBy,
  files: FileData[]
): { success: true; names: string[]; input?: RefNodeInfo } | { success: false; error: string } {
  const found = elementBy(by, 'Element');
  if ('error' in found) return { success: false, error: found.error };
  const input = fileInputOf(found.el);
  if (!input) {
    return { success: false, error: `No file input for <${found.el.tagName.toLowerCase()}>: not one, nor in it, nor its label's, ` +
      'nor a single one around it. A drop zone without any input is not handled.' };
  }
  // Before the files: the page may take the input away once it has them.
  const described = input === found.el ? undefined : describeElement(input);
  const result = putFiles(input, files);
  if ('error' in result) return { success: false, error: result.error };
  return { success: true, names: result.names, ...(described ? { input: described } : {}) };
}

/** How a command names its element: a snapshot ref, a CSS selector, or the label of a field. */
type FieldBy = { ref?: string; selector?: string; label?: string };

/**
 * The element a ref names, the first a selector matches in the page or its same-origin
 * iframes, or the field with that label (see field-label.ts).
 */
function elementBy(by: FieldBy, what: string): { el: Element } | { error: string } {
  if (by.ref) {
    const el = window.__izitestRefMap?.get(by.ref);
    return el ? { el } : { error: `Ref not found: ${by.ref} — take a new snapshot` };
  }
  if (by.label) {
    const el = fieldByLabel(by.label, searchableDocuments());
    return el ? { el } : { error: `${what} not found: ${noFieldLabelled(by.label)}` };
  }
  for (const doc of by.selector ? searchableDocuments() : []) {
    const el = doc.querySelector(by.selector!);
    if (el) return { el };
  }
  return { error: `${what} not found: ${by.selector ?? 'no ref, selector or label given'}` };
}

/** Why no field has that label, with the fields there are: the agent can correct the phrase. */
export function noFieldLabelled(label: string): string {
  const names = fieldNames(searchableDocuments());
  return `No field labelled "${label}" (by <label>, aria-label, aria-labelledby or placeholder)` +
    (names.length ? `. Fields on the page: ${names.map((n) => `"${n}"`).join(', ')}` : '. No labelled field shows on the page');
}

/** This document and the documents of its same-origin iframes, recursively. */
function searchableDocuments(): Document[] {
  const docs: Document[] = [];
  const visit = (doc: Document) => {
    docs.push(doc);
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      let inner: Document | null = null;
      try {
        inner = (frame as HTMLIFrameElement).contentDocument; // null when cross-origin
      } catch {
        inner = null;
      }
      if (inner?.body) visit(inner);
    }
  };
  visit(document);
  return docs;
}

export async function resolveRef(ref: string, options: MeasureOptions = {}): Promise<ClickTarget | null> {
  const el = window.__izitestRefMap?.get(ref);
  if (!el) return null;
  return measureForClick(el, options);
}

export interface ClickTarget {
  x: number;
  y: number;
  tag: string;
  text: string;
  /** The page scrolled: the caller should let it settle and measure again. */
  scrolled?: boolean;
  /** Set when something else is on top of the target at (x, y): what it is. */
  coveredBy?: string;
  /** The checkbox, radio or switch a click on the target acts on, as it is before the click. */
  toggle?: ToggleState;
  /** The target was a checkbox or radio styled away: its label is what was measured. */
  viaLabel?: boolean;
  /** That label is a separate <label for>: the input's id. */
  labelFor?: string;
  /** A date, time, colour or range input (its type): fill sets its value, it does not type. */
  picked?: string;
  /** Its box's size: a drop can go near an edge of it. */
  width: number;
  height: number;
}

interface MeasureOptions {
  /**
   * First measurement of a click: if the target is covered, scroll it to the centre and
   * report `scrolled` instead of a verdict — a sticky header or a fixed bar often stops
   * covering it once it is centred. The follow-up measurement passes false and decides.
   */
  uncover?: boolean;
}

function measureForClick(el: Element, { uncover = false }: MeasureOptions = {}): ClickTarget | null {
  // A checkbox or radio styled away is clicked where it shows: on its label. A separate
  // <label for> is named by the input's id: generated code goes to that label, not to a
  // label holding the input, which there is none of.
  const label = styledAwayToggleLabel(el);
  if (label) {
    const target = measureForClick(label, { uncover });
    const labelFor = !label.contains(el) && (el as HTMLInputElement).id ? (el as HTMLInputElement).id : undefined;
    return target && { ...target, viaLabel: true, ...(labelFor ? { labelFor } : {}) };
  }

  // An element inside a same-origin iframe measures itself against that iframe, so its
  // position is shifted by every frame it sits in. levels carries those offsets.
  let levels = frameLevels(el as never, document as never);
  if (!levels) {
    return { x: 0, y: 0, width: 0, height: 0, tag: el.tagName.toLowerCase(), text: el.textContent?.slice(0, 50) || '',
      coveredBy: 'a cross-origin frame around it, which this extension cannot see into' };
  }

  // Visible means visible in its own frame AND, once placed on the page, in the window —
  // avoid scrollIntoView for dropdown/overlay items that are already on screen, because
  // scrolling the page can displace absolutely-positioned overlays.
  const isInView = (lv: FrameLevel[]): boolean => {
    const r = el.getBoundingClientRect();
    const own = el.ownerDocument.defaultView ?? window;
    const inOwnFrame = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 &&
      r.bottom <= own.innerHeight && r.right <= own.innerWidth;
    const { originX, originY } = lv[lv.length - 1];
    const onPage = r.top + originY >= 0 && r.left + originX >= 0 &&
      r.bottom + originY <= window.innerHeight && r.right + originX <= window.innerWidth;
    return inOwnFrame && onPage;
  };

  const inViewport = isInView(levels);
  if (!inViewport) {
    // Also scrolls the frames around it into view.
    (el as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'center' });
    // NO timer here: this runs in the page, and Chrome clamps page timers to ~1s when the
    // window is hidden or covered — which is the normal case for a piloted window. A 50ms
    // settle wait became ~1.2s per action. The caller (service worker, not throttled)
    // waits and asks again when `scrolled` is set.
    levels = frameLevels(el as never, document as never) ?? levels;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  const { originX, originY } = levels[levels.length - 1];
  const toggle = toggleOf(el);
  const picked = pickedInputType(el);
  const target = {
    x: Math.round(originX + rect.x + rect.width / 2),
    y: Math.round(originY + rect.y + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    tag: el.tagName.toLowerCase(),
    text: el.textContent?.slice(0, 50) || '',
    ...(toggle ? { toggle } : {}),
    ...(picked ? { picked } : {}),
  };

  // Just scrolled on a first measurement: positions may still move. Let the caller settle
  // and ask again before deciding anything about what covers what. (On the follow-up the
  // instant scroll above has already been laid out, so a verdict is safe.)
  if (!inViewport && uncover) return { ...target, scrolled: true };

  // What the page will actually deliver the click to, followed through every frame on the
  // way. Without this the tool reported success with the target's name while a banner, a
  // sticky header or an image took the click — the agent believed it had clicked, and
  // nothing had happened.
  const verdict = hitTestThroughFrames(levels, target.x, target.y);
  if (verdict.ok) return { ...target, scrolled: false };

  // A link that wraps onto two lines has the centre of its box between the lines — on its
  // parent (a <th> on Wikipedia), which was then reported as covering it. Each line box of
  // the element is a place a person could click: try their centres before saying "covered".
  for (const box of Array.from(el.getClientRects())) {
    if (box.width < 1 || box.height < 1) continue;
    const x = Math.round(originX + box.x + box.width / 2);
    const y = Math.round(originY + box.y + box.height / 2);
    if (hitTestThroughFrames(levels, x, y).ok) return { ...target, x, y, scrolled: false };
  }

  if (uncover) {
    (el as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'center' });
    return { ...target, scrolled: true };
  }
  return { ...target, scrolled: false, coveredBy: describeBlocker(verdict.blocker) };
}

/**
 * Outline every ref of this frame's last snapshot, for an annotated screenshot.
 *
 * Each box is drawn in the document that holds its element. An element inside a same-origin
 * iframe measures itself against that iframe's viewport: drawn on the page, its box landed
 * at the page's top-left instead of on the iframe. Drawn in the iframe's own document it is
 * placed and clipped by the iframe itself. Cross-origin frames draw their own (cmdScreenshot
 * asks each of them); `banner` is for the top frame only, counting their refs as `extraRefs`.
 */
export function drawAnnotations(options: { banner?: boolean; extraRefs?: number } = {}): number {
  clearAnnotations();

  const refMap = window.__izitestRefMap || new Map<string, Element>();
  const byDoc = new Map<Document, [string, Element][]>();
  refMap.forEach((el, ref) => {
    if (!el.isConnected) return;
    const list = byDoc.get(el.ownerDocument) ?? [];
    list.push([ref, el]);
    byDoc.set(el.ownerDocument, list);
  });

  for (const [doc, entries] of byDoc) drawLayer(doc, entries);
  if (options.banner !== false) {
    const total = refMap.size + (options.extraRefs ?? 0);
    drawLayer(document, [], `IziTest Agent: ${total} refs`);
  }
  return refMap.size;
}

const ANNOTATION_ID = 'izitest-annotations';

function annotationLayer(doc: Document): ShadowRoot {
  const existing = doc.getElementById(ANNOTATION_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  // Use a Shadow DOM host to completely isolate annotations from the page's CSS.
  // Sites like lacentrale.fr have aggressive CSS rules (resets, flex overrides,
  // overflow:hidden) that break plain div overlays.
  const host = doc.createElement('izitest-annotations');
  host.id = ANNOTATION_ID;
  // Host styles must use !important to resist page-level CSS on custom elements
  host.style.cssText = [
    'position: fixed !important',
    'top: 0 !important',
    'left: 0 !important',
    'width: 100vw !important',
    'height: 100vh !important',
    'pointer-events: none !important',
    'z-index: 2147483647 !important',
    'display: block !important',
    'overflow: visible !important',
    'opacity: 1 !important',
    'visibility: visible !important',
    'transform: none !important',
    'margin: 0 !important',
    'padding: 0 !important',
  ].join('; ');

  const shadow = host.attachShadow({ mode: 'open' });

  // All styles scoped inside the shadow — immune to the page's CSS
  const style = doc.createElement('style');
  style.textContent = `
    :host {
      all: initial !important;
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    }
    .bp-box {
      position: absolute;
      border: 2px solid #ef4444;
      box-sizing: border-box;
      pointer-events: none;
    }
    .bp-label {
      position: absolute;
      background: #ef4444;
      color: #fff;
      padding: 1px 4px;
      font: bold 12px/1.2 monospace;
      border-radius: 3px;
      border: 1px solid #fff;
      white-space: nowrap;
      z-index: 1;
    }
    .bp-banner {
      position: absolute;
      top: 10px; left: 10px;
      padding: 5px 10px;
      background: #7c3aed;
      color: #fff;
      font: bold 12px/1.4 monospace;
      border-radius: 4px;
      z-index: 2;
    }
  `;
  shadow.appendChild(style);
  doc.documentElement.appendChild(host);
  return shadow;
}

function drawLayer(doc: Document, entries: [string, Element][], banner?: string): void {
  const view = doc.defaultView;
  if (!view) return;
  const shadow = annotationLayer(doc);

  for (const [ref, el] of entries) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > view.innerHeight || rect.right < 0 || rect.left > view.innerWidth) continue;

    const box = doc.createElement('div');
    box.className = 'bp-box';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    shadow.appendChild(box);

    const label = doc.createElement('div');
    label.className = 'bp-label';
    label.style.left = `${Math.max(0, rect.left)}px`;
    label.style.top = `${Math.max(0, rect.top)}px`;
    label.textContent = ref;
    shadow.appendChild(label);
  }

  if (banner) {
    const el = doc.createElement('div');
    el.className = 'bp-banner';
    el.textContent = banner;
    shadow.appendChild(el);
  }
}

export function clearAnnotations() {
  for (const doc of searchableDocuments()) doc.getElementById(ANNOTATION_ID)?.remove();
}

const PAGE_TEXT_MAX_CHARS = 4000;

const FILLABLE_ROLES = new Set([
  'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider',
  'spinbutton', 'searchbox', 'switch'
]);

// Checkboxes and radios are clicked too — and some menus are a checkbox in disguise.
const CLICKABLE_ROLES = new Set([
  'link', 'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'treeitem', 'switch', 'gridcell', 'checkbox', 'radio'
]);

function matchesPurposeFilter(role: string, tag: string, purpose: SnapshotPurpose | undefined): boolean {
  if (!purpose || purpose === 'read') return true;
  if (purpose === 'fill') {
    if (FILLABLE_ROLES.has(role)) return true;
    // Include <select> even though its role may resolve to 'combobox' or 'listbox'
    if (['input', 'textarea', 'select'].includes(tag)) return true;
    // Include form/region containers so there's structural context around fields
    if (['form', 'region', 'group', 'search'].includes(role)) return true;
    return false;
  }
  if (purpose === 'click') {
    if (CLICKABLE_ROLES.has(role)) return true;
    if (['a', 'button', 'summary', 'details'].includes(tag)) return true;
    return false;
  }
  return true;
}


const LOCATOR_BUDGET_MS = 400;

/**
 * What an action on `ref` should record: the element's role, name and locators, computed
 * for that one element. Asked before the action, while the element is surely still there.
 */
export function describeRef(ref: string): RefNodeInfo | null {
  const el = window.__izitestRefMap?.get(ref);
  if (!el?.isConnected) return null;
  return describeElement(el);
}

function describeElement(el: Element): RefNodeInfo {
  const { getRole, getAccessibleName, buildSelector, buildLocators } = pageTools();
  const role = getRole(el);
  const name = getAccessibleName(el);
  return {
    role,
    name: name.replace(/\s+/g, ' ').trim().slice(0, 80),
    selector: buildSelector(el),
    locators: buildLocators(el, name, role),
  };
}

/**
 * Roles, names, visibility and locators of page elements — shared by the snapshot and by
 * describeRef, which computes one element's locators when an action uses its ref.
 */
function pageTools() {
  const isCustomElement = (tag: string): boolean => tag.includes('-');

  // Returns true when the element AND all descendants are truly not rendered.
  // Only display:none guarantees that children cannot be visible.
  const isSubtreeHidden = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    return style.display === 'none';
  };

  // Returns true when the element itself appears visible.
  // When false, the element node is skipped but children are still traversed
  // because wrappers with aria-hidden, opacity:0, visibility:hidden, or zero
  // dimensions can still contain visually-visible children (drawers, modals,
  // CSS transitions, overflow:visible containers).
  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if (rect.width === 0 || rect.height === 0) {
      if (style.display === 'contents') {
        // Elements with display: contents have a 0x0 rect, but render children normally.
      } else if (isCustomElement(tag) || el.shadowRoot) {
        // Custom elements (Angular, Web Components) may have 0x0 host dimensions
        // but render visible children — treat as visible to traverse them.
      } else if (el.tagName !== 'A' && el.tagName !== 'SPAN' && el.tagName !== 'SVG') {
        return false;
      }
    }
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) {
      return false;
    }
    return true;
  };

  const getRole = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': return 'button';
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['text', 'email', 'search', 'tel', 'url', 'password', 'number'].includes(type)) return 'textbox';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (['submit', 'reset', 'button'].includes(type)) return 'button';
        return type;
      }
      case 'select': return (el as HTMLSelectElement).size <= 1 ? 'combobox' : 'listbox';
      case 'textarea': return 'textbox';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': // Simplified: usually banner if top level
        return 'banner';
      case 'footer': 
        return 'contentinfo';
      case 'aside': return 'complementary';
      case 'section':
      case 'form': 
        if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return tag === 'form' ? 'form' : 'region';
        return 'generic';
      case 'p': return 'paragraph';
      case 'table': return 'table';
      case 'img': return el.hasAttribute('alt') ? 'img' : 'presentation';
      case 'dialog': return 'dialog';
      case 'details': return 'group';
      case 'summary': return 'button';
      default:
        // An editing host (contenteditable) is a text field, as Chrome has it: listed with
        // the fields to fill, not as a "generic" only found among things to click.
        if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return 'textbox';
        return 'generic';
    }
  };

  const getAccessibleName = (el: Element): string => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '');
      const str = parts.filter(Boolean).join(' ');
      if (str) return str;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    // Explicit label: <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
    }

    // Implicit label: <label><input ...> text</label>
    // W3C spec: an input nested inside a label inherits the label's text as its accessible name
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const parentLabel = el.closest('label');
      if (parentLabel) {
        // Collect text from the label excluding the input element itself
        let labelText = '';
        for (const child of parentLabel.childNodes) {
          if (child === el) continue;
          if (child.nodeType === Node.TEXT_NODE) {
            labelText += child.textContent || '';
          } else if (child.nodeType === Node.ELEMENT_NODE && child !== el) {
            labelText += (child as Element).textContent || '';
          }
        }
        labelText = labelText.replace(/\s+/g, ' ').trim();
        if (labelText) return labelText;
      }
    }

    // The attribute, not the property: on a <form>, `.title` is whatever control is named
    // "title" — Wikipedia's search form has one, and the snapshot crashed on the element it
    // got back instead of a string.
    const title = el.getAttribute('title') ?? '';
    if (el.tagName === 'IMG') return el.getAttribute('alt') || title;
    if (title) return title;

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder;
      // Only a button's value is its name, as Chrome has it. Any other input's value is what
      // it holds — "on" for a checkbox, "#6c5ce7" for a colour, "60" for a slider — and goes
      // the moment the input is filled: the locator recorded from it found nothing on replay.
      const val = (el as HTMLInputElement).value;
      const type = (el as HTMLInputElement).type;
      if (val && ['submit', 'reset', 'button'].includes(type)) return val;
    }

    // What an editing host holds is its value (shown as such), not its name: the name went
    // with the first edit, like an input's value did.
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && getRole(el) === 'textbox') return '';

    // Check direct text nodes first (to avoid grabbing massive child text globally)
    let directText = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        directText += child.textContent.trim() + ' ';
      }
    }
    
    if (directText.trim()) return directText.trim();

    // Check if it's specifically an interactive role where we deeply want the text
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const isActivable = ['a', 'button'].includes(tag) || ['button', 'link', 'menuitem', 'tab', 'option', 'switch', 'checkbox', 'radio', 'treeitem'].includes(role) || el.hasAttribute('onclick');

    if (isActivable) {
      const fullText = el.textContent?.trim() || '';
      if (fullText) return fullText.replace(/\s+/g, ' ');

      // If no text, check for images or SVGs inside that might serve as the icon name
      const img = el.querySelector('img[alt]');
      if (img) return img.getAttribute('alt')?.trim() || '';
      
      const svg = el.querySelector('svg title');
      if (svg) return svg.textContent?.trim() || '';
    }
    
    return '';
  };

  const isInteractiveRole = (role: string, tag: string) => {
    const interactiveRoles = ['link', 'button', 'textbox', 'checkbox', 'radio', 'slider', 'combobox', 'listbox', 'search', 'menuitem', 'tab', 'option', 'treeitem', 'switch', 'gridcell'];
    if (interactiveRoles.includes(role)) return true;
    if (['select', 'textarea', 'input', 'button', 'a'].includes(tag)) return true;
    return false;
  };

  const isDynamicId = (id: string): boolean => {
    if (/react-aria|radix-|ember|ng-|_r_|rc-|headlessui-/i.test(id)) return true;
    if (/\d{4,}/.test(id)) return true;
    if (/^[a-f0-9-]{8,}$/i.test(id)) return true;
    if (/^:.*:$/.test(id)) return true;
    return false;
  };

  // ── Dynamic class detection ──────────────────────────────────────────
  const isDynamicClass = (cls: string): boolean => {
    // Tailwind/utility — these are fine, but single-char or hash-based are not
    if (/^[a-z]{1,2}\d+$/i.test(cls)) return true;           // e.g. "a0", "b12"
    if (/^_/.test(cls)) return true;                          // CSS modules: _1a2b3c
    if (/^css-/.test(cls)) return true;                       // Emotion: css-1a2b3c
    if (/^sc-/.test(cls)) return true;                        // styled-components
    if (/^styles?_/.test(cls)) return true;                   // CSS modules variant
    if (/[A-Za-z0-9]{6,}$/.test(cls) && /[_-]/.test(cls) && /\d/.test(cls)) return true; // hash suffix
    if (/^[a-f0-9]{5,}$/i.test(cls)) return true;            // pure hex hashes
    if (/^jsx-\d+$/.test(cls)) return true;                   // styled-jsx
    if (/^go\d+$/.test(cls)) return true;                     // Goober
    return false;
  };

  // ── Uniqueness helpers ───────────────────────────────────────────────
  const isUniqueCSS = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch { return false; }
  };

  const isUniqueXPath = (xpath: string): boolean => {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return result.snapshotLength === 1;
    } catch { return false; }
  };

  // ── Robust CSS selector builder ──────────────────────────────────────
  // Strategy order:
  //   1. #stableId
  //   2. [data-testid="..."]
  //   3. tag[semantic-attr="value"] (name, placeholder, aria-label, alt, for, title, type+name)
  //   4. tag.stableClass (single or pair of non-dynamic classes)
  //   5. Shortest unique ancestor path (walk up, at each level try to anchor)
  //   6. Structural fallback (full child-combinator path)
  const buildSelector = (el: Element): string => {
    const tag = el.tagName.toLowerCase();

    // 1. Stable ID
    if (el.id && !isDynamicId(el.id)) return `#${CSS.escape(el.id)}`;

    // 2. data-testid / data-test-id / data-cy
    for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${CSS.escape(val)}"]`;
        if (isUniqueCSS(sel)) return sel;
      }
    }

    // 3. Semantic attribute selectors
    const semanticAttrs: Array<[string, string | null]> = [
      ['name', el.getAttribute('name')],
      ['placeholder', el.getAttribute('placeholder')],
      ['aria-label', el.getAttribute('aria-label')],
      ['alt', el.getAttribute('alt')],
      ['for', el.getAttribute('for')],
      ['title', el.getAttribute('title')],
      ['role', el.getAttribute('role')],
      ['href', tag === 'a' ? el.getAttribute('href') : null],
      ['type', tag === 'input' ? el.getAttribute('type') : null],
      // The items of a list told apart by what each stands for (data-value="cost"), where
      // only their position was left: a sorted list changes it.
      ['data-id', el.getAttribute('data-id')],
      ['data-value', el.getAttribute('data-value')],
      ['data-key', el.getAttribute('data-key')],
    ];

    for (const [attr, val] of semanticAttrs) {
      if (!val) continue;
      if (attr.startsWith('data-') && isDynamicId(val)) continue;
      // For href, use startsWith match to handle long URLs
      if (attr === 'href' && val.length > 60) {
        const shortHref = CSS.escape(val.slice(0, 50));
        const sel = `${tag}[href^="${shortHref}"]`;
        if (isUniqueCSS(sel)) return sel;
        continue;
      }
      const sel = `${tag}[${attr}="${CSS.escape(val)}"]`;
      if (isUniqueCSS(sel)) return sel;
    }

    // For inputs: combine type + name for uniqueness
    if (tag === 'input') {
      const type = el.getAttribute('type');
      const nameA = el.getAttribute('name');
      if (type && nameA) {
        const sel = `input[type="${CSS.escape(type)}"][name="${CSS.escape(nameA)}"]`;
        if (isUniqueCSS(sel)) return sel;
      }
    }

    // 4. Stable class-based selectors
    const classes = Array.from(el.classList).filter(c => !isDynamicClass(c));
    if (classes.length > 0) {
      // Try single class first
      for (const cls of classes) {
        const sel = `${tag}.${CSS.escape(cls)}`;
        if (isUniqueCSS(sel)) return sel;
      }
      // Try pairs of classes
      if (classes.length >= 2) {
        for (let i = 0; i < Math.min(classes.length, 4); i++) {
          for (let j = i + 1; j < Math.min(classes.length, 5); j++) {
            const sel = `${tag}.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
            if (isUniqueCSS(sel)) return sel;
          }
        }
      }
    }

    // 5. Shortest unique path: walk up the tree, at each ancestor try to build
    //    a short selector that uniquely identifies the target
    {
      let target = el;
      let childPart = tag;
      // Disambiguate at target level with class or nth-of-type
      const targetClasses = classes.length > 0 ? `.${CSS.escape(classes[0])}` : '';
      if (targetClasses) {
        const withClass = `${tag}${targetClasses}`;
        if (isUniqueCSS(withClass)) return withClass;
        childPart = withClass;
      }

      let current: Element | null = el.parentElement;
      let depth = 0;
      const MAX_CLIMB = 5;

      while (current && current !== document.body && current !== document.documentElement && depth < MAX_CLIMB) {
        depth++;
        let anchorParts: string[] = [];
        const pTag = current.tagName.toLowerCase();

        // Try to anchor on ancestor's ID
        if (current.id && !isDynamicId(current.id)) {
          const sel = `#${CSS.escape(current.id)} ${childPart}`;
          if (isUniqueCSS(sel)) return sel;
          // Try with direct child combinator
          if (depth === 1) {
            const directSel = `#${CSS.escape(current.id)} > ${childPart}`;
            if (isUniqueCSS(directSel)) return directSel;
          }
        }

        // Try ancestor's data-testid
        for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
          const aVal = current.getAttribute(attr);
          if (aVal) {
            const sel = `[${attr}="${CSS.escape(aVal)}"] ${childPart}`;
            if (isUniqueCSS(sel)) return sel;
          }
        }

        // Try ancestor's semantic attributes
        const anchorAttrs: Array<[string, string | null]> = [
          ['aria-label', current.getAttribute('aria-label')],
          ['name', current.getAttribute('name')],
          ['role', current.getAttribute('role')],
        ];
        for (const [attr, val] of anchorAttrs) {
          if (!val) continue;
          const sel = `${pTag}[${attr}="${CSS.escape(val)}"] ${childPart}`;
          if (isUniqueCSS(sel)) return sel;
        }

        // Try ancestor's stable classes
        const pClasses = Array.from(current.classList).filter(c => !isDynamicClass(c));
        for (const cls of pClasses.slice(0, 3)) {
          const sel = `${pTag}.${CSS.escape(cls)} ${childPart}`;
          if (isUniqueCSS(sel)) return sel;
        }

        // Build childPart for next iteration (prepend this ancestor's tag)
        const siblings = Array.from(current.parentElement?.children || []).filter(e => e.tagName === current!.tagName);
        let anchorTag = pTag;
        if (pClasses.length > 0) {
          anchorTag = `${pTag}.${CSS.escape(pClasses[0])}`;
        } else if (siblings.length > 1) {
          anchorTag = `${pTag}:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        childPart = `${anchorTag} > ${childPart}`;

        current = current.parentElement;
      }
    }

    // 6. Structural fallback (last resort — full path with nth-of-type)
    let current = el;
    const path: string[] = [];
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id && !isDynamicId(current.id)) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(e => e.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      path.unshift(part);
      current = current.parentElement!;
    }
    return path.join(' > ');
  };

  // ── Robust XPath builder ─────────────────────────────────────────────
  // Strategy order:
  //   1. //*[@id="stableId"]
  //   2. //tag[@data-testid="..."]
  //   3. //tag[@semantic-attr="value"]
  //   4. //tag[normalize-space()="short text"] (for buttons, links, labels)
  //   5. Relative from nearest identifiable ancestor
  //   6. Positional fallback
  const buildXPath = (el: Element): string => {
    const tag = el.tagName.toLowerCase();

    // 1. Stable ID
    if (el.id && !isDynamicId(el.id) && !el.id.includes('"') && !el.id.includes("'")) {
      return `//*[@id="${el.id}"]`;
    }

    if (tag === 'html') return '/html';
    if (tag === 'body') return '/html/body';

    // 2. data-testid
    for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
      const val = el.getAttribute(attr);
      if (val && !val.includes('"')) {
        const xp = `//${tag}[@${attr}="${val}"]`;
        if (isUniqueXPath(xp)) return xp;
      }
    }

    // 3. Semantic attribute XPath
    const semanticAttrs: Array<[string, string | null]> = [
      ['name', el.getAttribute('name')],
      ['placeholder', el.getAttribute('placeholder')],
      ['aria-label', el.getAttribute('aria-label')],
      ['alt', el.getAttribute('alt')],
      ['title', el.getAttribute('title')],
      ['for', el.getAttribute('for')],
    ];

    for (const [attr, val] of semanticAttrs) {
      if (!val || val.includes('"')) continue;
      const xp = `//${tag}[@${attr}="${val}"]`;
      if (isUniqueXPath(xp)) return xp;
    }

    // For inputs: combine type + name
    if (tag === 'input') {
      const type = el.getAttribute('type');
      const nameA = el.getAttribute('name');
      if (type && nameA && !type.includes('"') && !nameA.includes('"')) {
        const xp = `//input[@type="${type}"][@name="${nameA}"]`;
        if (isUniqueXPath(xp)) return xp;
      }
    }

    // 4. Text-based XPath (only for short, stable text on interactive elements)
    const interactiveTags = ['button', 'a', 'label', 'th', 'summary', 'legend'];
    if (interactiveTags.includes(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
      const text = el.textContent?.trim().replace(/\s+/g, ' ');
      if (text && text.length > 0 && text.length < 60 && !text.includes('"')) {
        // Exact text match
        const xp = `//${tag}[normalize-space()="${text}"]`;
        if (isUniqueXPath(xp)) return xp;
        // Contains match for slightly longer text
        if (text.length > 20) {
          const shortText = text.slice(0, 25);
          if (!shortText.includes('"')) {
            const xpContains = `//${tag}[contains(normalize-space(),"${shortText}")]`;
            if (isUniqueXPath(xpContains)) return xpContains;
          }
        }
      }
    }

    // 5. Relative from nearest identifiable ancestor
    let ancestor: Element | null = el.parentElement;
    let relDepth = 0;
    const MAX_ANCESTOR_CLIMB = 5;

    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && relDepth < MAX_ANCESTOR_CLIMB) {
      relDepth++;
      let anchorXPath = '';
      const aTag = ancestor.tagName.toLowerCase();

      // Anchor on ID
      if (ancestor.id && !isDynamicId(ancestor.id) && !ancestor.id.includes('"')) {
        anchorXPath = `//*[@id="${ancestor.id}"]`;
      }
      // Anchor on data-testid
      if (!anchorXPath) {
        for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
          const aVal = ancestor.getAttribute(attr);
          if (aVal && !aVal.includes('"')) {
            anchorXPath = `//${aTag}[@${attr}="${aVal}"]`;
            break;
          }
        }
      }
      // Anchor on aria-label
      if (!anchorXPath) {
        const ariaL = ancestor.getAttribute('aria-label');
        if (ariaL && !ariaL.includes('"')) {
          anchorXPath = `//${aTag}[@aria-label="${ariaL}"]`;
        }
      }

      if (anchorXPath && isUniqueXPath(anchorXPath)) {
        // Try descendant axis with just the tag
        let relXp = `${anchorXPath}//${tag}`;
        if (isUniqueXPath(relXp)) return relXp;

        // Try with an attribute on the target
        for (const [attr, val] of semanticAttrs) {
          if (!val || val.includes('"')) continue;
          relXp = `${anchorXPath}//${tag}[@${attr}="${val}"]`;
          if (isUniqueXPath(relXp)) return relXp;
        }

        // Try with position among same-tag descendants
        const descendants = document.evaluate(
          `${anchorXPath}//${tag}`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        for (let i = 0; i < descendants.snapshotLength; i++) {
          if (descendants.snapshotItem(i) === el) {
            relXp = `(${anchorXPath}//${tag})[${i + 1}]`;
            if (isUniqueXPath(relXp)) return relXp;
            break;
          }
        }
      }

      ancestor = ancestor.parentElement;
    }

    // 6. Positional fallback (full path)
    let current: Element | null = el;
    const path: string[] = [];

    while (current && current !== document.body && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }

      const hasSameTagSiblings = index > 1 || Array.from(current.parentElement?.children || []).some(
        e => e !== current && e.tagName === current!.tagName
      );

      if (hasSameTagSiblings) {
        part += `[${index}]`;
      }
      path.unshift(part);
      current = current.parentElement;
    }
    return `/html/body/${path.join('/')}`;
  };

  // ── Locator builder ──────────────────────────────────────────────────
  const buildLocators = (el: Element, name: string, role: string): Array<{type: string, value: string}> => {
    const locators: Array<{type: string, value: string}> = [];
    const tag = el.tagName.toLowerCase();
    const seen = new Set<string>();

    const addLocator = (type: string, value: string) => {
      const key = `${type}::${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        locators.push({ type, value });
      }
    };

    // 1. data-testid (most stable — developer-intentional)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
    if (testId) {
      addLocator('testid', `[data-testid="${CSS.escape(testId)}"]`);
    }

    // 2. Stable ID
    if (el.id && !isDynamicId(el.id)) {
      addLocator('css', `#${CSS.escape(el.id)}`);
    }

    // 3. ARIA / accessible name
    if (name && name.length > 0 && name.length < 100) {
      addLocator('aria', name);
    }

    // 4. Semantic attributes
    const nameAttr = el.getAttribute('name');
    if (nameAttr) {
      addLocator('attribute', `${tag}[name="${CSS.escape(nameAttr)}"]`);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      addLocator('placeholder', placeholder);
      addLocator('attribute', `${tag}[placeholder="${CSS.escape(placeholder)}"]`);
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      addLocator('attribute', `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`);
    }

    const altAttr = el.getAttribute('alt');
    if (altAttr) {
      addLocator('attribute', `${tag}[alt="${CSS.escape(altAttr)}"]`);
    }

    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.length < 100) {
      addLocator('attribute', `${tag}[title="${CSS.escape(titleAttr)}"]`);
    }

    // 5. Text content
    const textContent = el.textContent?.trim().replace(/\s+/g, ' ');
    if (textContent && textContent.length > 0 && textContent.length < 100) {
      addLocator('text', textContent);
    }

    // 6. CSS selector (robust algorithm)
    const cssSelector = buildSelector(el);
    addLocator('css', cssSelector);

    // 7. XPath (robust algorithm)
    const xpath = buildXPath(el);
    addLocator('xpath', xpath);

    return locators;
  };
  return { isCustomElement, isSubtreeHidden, isVisible, getRole, getAccessibleName, isInteractiveRole, isDynamicId, isDynamicClass, isUniqueCSS, isUniqueXPath, buildSelector, buildXPath, buildLocators };
}

export function buildSnapshot(providedOptions: SnapshotOptions = {}): SnapshotResult {
  const options = {
    interactiveOnly: false,
    compact: false,
    maxDepth: 50,
    scope: null,
    format: 'text',
    maxTextLength: 80,
    includeHidden: false,
    includeRects: false,
    inlineFrames: true,
    ...providedOptions
  };

  const freshRefs = prepareRefRegistry(options.resetRefs === true);
  const refMap = window.__izitestRefMap!;
  const refOf = window.__izitestRefOf!;
  let refCounter = freshRefs && options.restartIfFresh
    ? 1
    : Math.max(options.refStart ?? 1, window.__izitestNextRef ?? 1);
  const refFor = (el: Element): string => {
    const known = refOf.get(el);
    if (known && refMap.get(known) === el) return known;
    const ref = `@e${refCounter++}`;
    refMap.set(ref, el);
    refOf.set(el, ref);
    return ref;
  };
  const jsonRefs: Record<string, RefNodeInfo> = {};
  const locatorDeadline = performance.now() + LOCATOR_BUDGET_MS;

  const truncate = (text: string) => {
    if (!text) return '';
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (clean.length > options.maxTextLength!) {
      return clean.slice(0, options.maxTextLength! - 3) + '...';
    }
    return clean;
  };

  const { isCustomElement, isSubtreeHidden, isVisible, getRole, getAccessibleName, isInteractiveRole, isDynamicId, isDynamicClass, isUniqueCSS, isUniqueXPath, buildSelector, buildXPath, buildLocators } = pageTools();
  const treeLines: string[] = [];
  /** Interactive elements and iframes listed: none, and the page's text is shown instead. */
  let actionable = 0;
  const digest: string[] = [];
  const DIGEST_MAX_ITEMS = 15;
  const DIGEST_MAX_CHARS = 120;

  const traverse = (el: Element, depth: number) => {
    if (depth > options.maxDepth!) return;

    if (!options.includeHidden) {
      // display:none truly hides the entire subtree — skip completely. Except a checkbox or
      // radio hidden that way behind a label that shows: it has no subtree, and it is used
      // through that label — the stars of a rating are <input display:none> + <label for>.
      if (isSubtreeHidden(el) && !styledAwayToggleLabel(el)) return;
    }

    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);
    // What the snapshot shows the element as. Locators keep the accessible name: `aria/`
    // would not find a <div> by its text.
    let label = name;
    let interactive = isInteractiveRole(role, tag) || el.hasAttribute('onclick');
    if (!interactive && el.hasAttribute('tabindex')) {
      const ti = parseInt(el.getAttribute('tabindex') || '', 10);
      if (!isNaN(ti) && ti >= 0) interactive = true;
    }

    // pointerInteractive, and always under purposeFilter "click": an element whose cursor is
    // 'pointer' while its parent's is not — the outermost element of a clickable region built
    // without semantic markup. The parent check also drops the inside of links/styled buttons
    // (inherited cursor). Such a region often has no name of its own — Bien'ici's "Afficher
    // tous les critères" is a <div class="btn"> whose text sits in a child <span>, and the
    // click filter hid it — so its text names it.
    // Known limit: when the pointer cursor is set on a whole list container rather than on
    // its items, only the container is reported.
    let pointerOnly = false;
    if (!interactive && (options.pointerInteractive || options.purposeFilter === 'click') && tag !== 'body' && tag !== 'html') {
      if (window.getComputedStyle(el).cursor === 'pointer') {
        const parent = el.parentElement;
        if (!parent || window.getComputedStyle(parent).cursor !== 'pointer') {
          label = name || (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (label) {
            interactive = true;
            pointerOnly = true;
          }
        }
      }
    }

    // Something to drag: draggable="true", or the outermost element under a grab or move
    // cursor (a list sorted with mouse events). Listed, named by its text when it has no name
    // — a sortable item is a <div> of <span>s — so that drag can take its ref.
    let dragHint = '';
    if (tag !== 'body' && tag !== 'html') {
      const grabs = (node: Element | null) => !!node && /grab|move/.test(window.getComputedStyle(node).cursor);
      if (el.getAttribute('draggable') === 'true') dragHint = ' [draggable]';
      else if (!interactive && grabs(el) && !grabs(el.parentElement)) dragHint = ' [cursor=grab]';
      if (dragHint && !interactive) {
        label = name || ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
        interactive = !!label;
        if (!interactive) dragHint = '';
      }
    }

    // A checkbox or radio styled away (opacity 0, no size) behind a label that shows: it is
    // operated through that label, so it is listed (a click goes to the label, see
    // measureForClick). Without a name of its own — the text sits next to the label, not in
    // it — the text around it names it, where its value ("on") used to.
    const styledToggle = styledAwayToggleLabel(el);
    if ((styledToggle || isToggleInput(el)) && !label) label = textAround(el);

    if (options.textDigest && digest.length < DIGEST_MAX_ITEMS) {
      const isHeading = role === 'heading' && ['h1', 'h2', 'h3'].includes(tag);
      const isAnnouncement = ['alert', 'status', 'dialog', 'alertdialog'].includes(role);
      if ((isHeading || isAnnouncement) && isVisible(el)) {
        const text = (name || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, DIGEST_MAX_CHARS);
        if (text) digest.push(`${isHeading ? tag : role}: ${text}`);
      }
    }

    let skipNodeRender = false;

    // Element-level visibility: don't render this node but still traverse children.
    // Handles aria-hidden, opacity:0, visibility:hidden on wrapper elements
    // whose children may still be visually visible (drawers, modals, transitions).
    if (!options.includeHidden && !isVisible(el) && !styledToggle) {
      skipNodeRender = true;
    }

    // Check if we should skip rendering this specific node (but still traverse children)
    if (options.interactiveOnly && !interactive) {
      skipNodeRender = true;
    } else if (options.compact && role === 'generic' && !name && !interactive) {
      skipNodeRender = true;
    }

    // Purpose-based filtering: skip elements that don't match the intended action.
    // A search looks through every interactive element whatever the filter: a menu built on
    // a checkbox ("Mon idealo" on idealo.fr) is clicked, but it is no button, and
    // purposeFilter "click" + searchText hid the very element the agent was looking for.
    const searchedAnyway = !!providedOptions.searchText && interactive;
    if (!skipNodeRender && !searchedAnyway && providedOptions.purposeFilter && providedOptions.purposeFilter !== 'read') {
      const clickableRegion = (pointerOnly || !!dragHint) && providedOptions.purposeFilter === 'click';
      if (!clickableRegion && !matchesPurposeFilter(role, tag, providedOptions.purposeFilter)) {
        skipNodeRender = true;
      }
    }

    // Process iframes
    if (tag === 'iframe' && options.inlineFrames) {
      const iframe = el as HTMLIFrameElement;
      let crossOrigin = false;
      let iframeDoc: Document | null = null;
      try {
        iframeDoc = iframe.contentDocument;
        if (!iframeDoc) crossOrigin = true;
      } catch (e) {
        crossOrigin = true;
      }

      const ref = refFor(el);
      actionable++;
      const indent = '  '.repeat(depth);
      const frameName = name || iframe.getAttribute('name') || iframe.getAttribute('title') || 'iframe';
      
      // Its address: what execute_js's `frame` can name it by, and a hint of what it holds.
      const src = iframe.src && !iframe.src.startsWith('about:') ? ` src="${truncate(iframe.src)}"` : '';
      treeLines.push(`${indent}${ref} [iframe] "${truncate(frameName)}"${crossOrigin ? ' [cross-origin]' : ''}${src}`);
      
      if (!crossOrigin && iframeDoc && iframeDoc.body) {
        traverse(iframeDoc.body, depth + 1);
      }
      return; 
    }

    if (!skipNodeRender && tag !== 'body') {
      const ref = refFor(el);
      if (interactive) actionable++;

      const indent = '  '.repeat(depth);
      let line = `${indent}${ref} [${role}]`;
      if (label) line += ` "${truncate(label)}"`;

      // Active/focus state
      if (document.activeElement === el) line += ` [active]`;

      // Specific attributes mapping
      if (role === 'heading') {
        const level = tag.replace('h', '');
        if (['1','2','3','4','5','6'].includes(level)) line += ` [level=${level}]`;
      }
      
      const htmlEl = el as HTMLInputElement;
      if (tag === 'a' && el.hasAttribute('href')) {
        let href = el.getAttribute('href')!;
        if (href.length > 30) href = href.slice(0, 27) + '...';
        line += ` href="${href}"`;
      }
      if (tag === 'input') {
        if (htmlEl.type) line += ` type="${htmlEl.type}"`;
        if (htmlEl.placeholder) line += ` placeholder="${truncate(htmlEl.placeholder)}"`;
        // Show current value for text-like inputs and sliders
        const inputType = (htmlEl.type || 'text').toLowerCase();
        if (!['checkbox', 'radio', 'submit', 'reset', 'button', 'hidden', 'file'].includes(inputType) && htmlEl.value) {
          line += ` value="${truncate(htmlEl.value)}"`;
        }
        if (htmlEl.required) line += ` [required]`;
        if (htmlEl.disabled) line += ` [disabled]`;
        if (htmlEl.readOnly) line += ` [readonly]`;
      }
      if (tag === 'textarea') {
        if (htmlEl.placeholder) line += ` placeholder="${truncate(htmlEl.placeholder)}"`;
        if (htmlEl.value) line += ` value="${truncate(htmlEl.value)}"`;
      } else if (role === 'textbox' && tag !== 'input') {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) line += ` value="${truncate(text)}"`;
      }
      
      if (role === 'checkbox' || role === 'radio') {
        // Its value, when its name does not say it: five stars all named "★" are told
        // apart by value="1" … value="5". Not "on" (the default), not "high" under "High".
        const value = tag === 'input' ? htmlEl.value : '';
        if (value && value !== 'on' && !label.toLowerCase().includes(value.toLowerCase())) line += ` value="${truncate(value)}"`;
        line += htmlEl.checked ? ` [checked]` : ` [unchecked]`;
      }
      
      if (tag === 'select') {
        const selectedOpt = el.querySelector('option:checked');
        if (selectedOpt) line += ` value="${truncate(selectedOpt.textContent || '')}"`;
      }
      
      if (role === 'button' && (el as HTMLButtonElement).disabled) {
        line += ` [disabled]`;
      }
      
      if (tag === 'img' && el.hasAttribute('alt')) {
        line += ` alt="${truncate(el.getAttribute('alt')!)}"`;
      }
      
      if (tag === 'details') {
        line += el.hasAttribute('open') ? ` [open]` : ` [closed]`;
      }

      // cursor=pointer indicates clickable non-semantic elements (divs, spans with click handlers)
      if (pointerOnly) {
        line += ` [cursor=pointer]`;
      } else if (dragHint) {
        line += dragHint;
      } else if (!interactive) {
        const cursor = window.getComputedStyle(el).cursor;
        if (cursor === 'pointer') line += ` [cursor=pointer]`;
      }

      if (el.hasAttribute('aria-expanded')) {
        line += ` [expanded=${el.getAttribute('aria-expanded')}]`;
      }
      if (el.hasAttribute('aria-selected')) {
        line += ` [selected=${el.getAttribute('aria-selected')}]`;
      }
      if (el.hasAttribute('aria-disabled')) {
        line += ` [disabled=${el.getAttribute('aria-disabled')}]`;
      }
      
      // Show data-testid in tree for easy identification
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
      if (testId) line += ` [testid="${testId}"]`;

      if (options.includeRects) {
        const rect = el.getBoundingClientRect();
        line += ` [${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}]`;
      }

      treeLines.push(line);

      // Render <option> children for select/combobox/listbox so the AI knows available values
      if (tag === 'select') {
        const optIndent = '  '.repeat(skipNodeRender ? depth : depth + 1);
        for (const opt of Array.from(el.querySelectorAll('option'))) {
          const optText = truncate(opt.textContent || '');
          let optLine = `${optIndent}[option] "${optText}"`;
          if ((opt as HTMLOptionElement).selected) optLine += ` [selected]`;
          if ((opt as HTMLOptionElement).disabled) optLine += ` [disabled]`;
          treeLines.push(optLine);
        }
      }

      // Always build ref mapping (needed for workflow recording). Locators check their
      // uniqueness against the whole document, so their cost grows with the square of the
      // page: Wikipedia's "France" article (6,000+ links) took over 30 s. Past the budget they
      // are left out; an action on a ref computes its own element's (describeRef).
      const withLocators = performance.now() < locatorDeadline;
      const refInfo: RefNodeInfo = {
        role,
        name: truncate(label),
        ...(withLocators ? { selector: buildSelector(el), locators: buildLocators(el, name, role) } : {}),
      };
      if (role === 'heading') {
         const level = parseInt(tag.replace('h', ''), 10);
         if (!isNaN(level)) refInfo.level = level;
      }
      if (options.includeRects) {
        const rect = el.getBoundingClientRect();
        refInfo.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      }
      jsonRefs[ref.substring(1)] = refInfo; // removing the '@' for json keys
    }

    // Recurse into Shadow DOM if present
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT' || child.tagName === 'LINK' || child.tagName === 'META') {
          continue;
        }
        traverse(child, skipNodeRender ? depth : depth + 1);
      }
    }

    // Recurse light DOM children
    for (const child of el.children) {
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT' || child.tagName === 'LINK' || child.tagName === 'META') {
        continue;
      }
      traverse(child, skipNodeRender ? depth : depth + 1);
    }
  };

  const root = options.scope ? document.querySelector(options.scope) || document.body : document.body;

  if (root) {
    traverse(root, 0);
  }

  // Traverse Angular CDK overlay container (dropdowns, modals, tooltips)
  // and other portal containers that render outside the main DOM tree.
  if (!options.scope) {
    const overlayContainers = document.querySelectorAll(
      '.cdk-overlay-container, [id="portal-root"], [id="modal-root"], [class*="overlay-container"]'
    );
    overlayContainers.forEach(container => {
      if (container !== root && container.children.length > 0) {
        traverse(container, 0);
      }
    });
  }

  // A page with nothing to act on — raw JSON, a plain-text file, an error page — still says
  // something. "No elements found" left the agent believing the page was empty, and a JSON
  // body showed as one [generic] line cut at 80 characters.
  if (actionable === 0 && !options.scope && !providedOptions.searchText) {
    const text = (document.body?.innerText ?? '').trim();
    if (text) {
      treeLines.push(`[page text] (no elements to act on; ${text.length} chars${text.length > PAGE_TEXT_MAX_CHARS ? `, first ${PAGE_TEXT_MAX_CHARS} shown — use extract for the rest` : ''})`);
      treeLines.push(text.slice(0, PAGE_TEXT_MAX_CHARS));
    }
  }

  // ─── Post-filter: searchText ──────────────────────────────────────
  let filteredTreeLines = treeLines;
  let filteredRefs = jsonRefs;

  if (providedOptions.searchText) {
    const needle = providedOptions.searchText.toLowerCase();

    // Keep only tree lines whose text content matches the search
    filteredTreeLines = treeLines.filter(line => line.toLowerCase().includes(needle));

    // Extract ref IDs from the matching lines (pattern: @eNN at start of trimmed line)
    const matchedRefIds = new Set<string>();
    for (const line of filteredTreeLines) {
      const match = line.trimStart().match(/^@(e\d+)/);
      if (match) matchedRefIds.add(match[1]);
    }

    // Only the matched refs are returned; the others stay valid (refs outlive a snapshot).
    filteredRefs = {};
    for (const [key, value] of Object.entries(jsonRefs)) {
      if (matchedRefIds.has(key)) filteredRefs[key] = value;
    }
  }

  const result: SnapshotResult = {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    refs: filteredRefs,
    tree: filteredTreeLines.join('\n'),
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      pageH: document.documentElement.scrollHeight
    },
    ...(options.textDigest ? { digest } : {}),
    nextRef: refCounter,
    freshRefs,
  };
  window.__izitestNextRef = refCounter;

  return result;
}
