// Does a click at (x, y) actually land on the element we mean to click?
//
// A mouse event goes to whatever is topmost at that point. When something sits on top of
// the target — a cookie banner, a sticky header, a loading overlay, an image — the page
// receives the click on that instead, and the target gets nothing. Measuring the target's
// box says nothing about this; only asking the page what is at the point does.
//
// Pure functions over a minimal node shape, so they can be tested without a browser.

interface HitNode {
  /** 11 = DOCUMENT_FRAGMENT_NODE, i.e. a ShadowRoot here. */
  nodeType?: number;
  tagName?: string;
  parentNode?: HitNode | null;
  /** On a ShadowRoot: the element hosting it. (An <a> has a `host` too — a string.) */
  host?: HitNode | string | null;
  shadowRoot?: { elementFromPoint(x: number, y: number): HitNode | null } | null;
  /** Set on a <label>: the form control it activates. */
  control?: HitNode | null;
  id?: string;
  className?: unknown;
  textContent?: string | null;
  getAttribute?(name: string): string | null;
}

/** The topmost element at (x, y), looking inside open shadow roots. */
export function deepElementFromPoint(
  root: { elementFromPoint(x: number, y: number): HitNode | null },
  x: number,
  y: number
): HitNode | null {
  let hit = root.elementFromPoint(x, y);
  // document.elementFromPoint stops at a shadow host; the real target is inside it.
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

const SHADOW_ROOT = 11;

function shadowHost(node: HitNode | null | undefined): HitNode | null {
  // Check the node type, not just `host`: an <a> carries `host` as well — its URL's
  // hostname — and would otherwise be taken for a shadow root.
  if (node?.nodeType === SHADOW_ROOT && node.host && typeof node.host === 'object') return node.host;
  return null;
}

/** Parent across shadow boundaries: a shadow root's parent is its host. */
function composedParent(node: HitNode): HitNode | null {
  if (node.parentNode) return shadowHost(node.parentNode) ?? node.parentNode;
  return shadowHost(node);
}

function isTag(node: HitNode | null | undefined, tag: string): boolean {
  return !!node?.tagName && node.tagName.toUpperCase() === tag;
}

/**
 * True when a click received by `hit` reaches `target`:
 *   - `hit` is the target or one of its descendants (an icon inside a button);
 *   - `hit` is, or is inside, a <label> for the target (custom checkboxes hide the real
 *     input under its label — clicking the label is how a person checks it);
 *   - the target is a <label> and `hit` is its own control.
 */
export function isHitOnTarget(target: HitNode, hit: HitNode | null): boolean {
  if (!hit) return false;

  for (let node: HitNode | null = hit; node; node = composedParent(node)) {
    if (node === target) return true;
    if (isTag(node, 'LABEL') && node.control === target) return true;
  }

  if (isTag(target, 'LABEL') && target.control === hit) return true;
  return false;
}

const SVG_INTERNALS = new Set(['PATH', 'G', 'USE', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'POLYGON', 'ELLIPSE', 'TEXT', 'TSPAN']);

function classesOf(node: HitNode): string[] {
  const raw = typeof node.className === 'string'
    ? node.className
    : (node.className as { baseVal?: string } | undefined)?.baseVal ?? '';
  return raw.split(/\s+/).filter(Boolean);
}

function describeOne(node: HitNode): string {
  const tag = (node.tagName ?? '?').toLowerCase();
  const id = node.id ? ` id="${node.id}"` : '';
  const classes = classesOf(node).slice(0, 2);
  const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
  const label = node.getAttribute?.('aria-label') ?? node.textContent ?? '';
  const text = label.replace(/\s+/g, ' ').trim().slice(0, 40);
  return `<${tag}${id}${cls}>${text ? ` "${text}"` : ''}`;
}

/**
 * Name what is in the way, in terms an agent can act on: the element itself, and the
 * nearest ancestor with an id — usually the banner or overlay container to dismiss.
 */
export function describeBlocker(hit: HitNode | null): string {
  if (!hit) return 'nothing at that point (it is outside the visible page, or inside a frame)';

  // A <path> says nothing useful; the <svg> it belongs to does.
  let shown: HitNode = hit;
  while (SVG_INTERNALS.has((shown.tagName ?? '').toUpperCase()) && shown.parentNode?.tagName) {
    shown = shown.parentNode;
  }

  let container: HitNode | null = composedParent(shown);
  for (let depth = 0; container && depth < 12; depth++, container = composedParent(container)) {
    if (container.id) break;
  }

  const within = container?.id && container !== shown ? ` inside #${container.id}` : '';
  return describeOne(shown) + within;
}

// ─── Same-origin iframes ─────────────────────────────────────────────
//
// An element inside an iframe measures itself relative to the iframe's viewport, not the
// page's: a button drawn at (350,169) on screen reported (50,19), and the click went to the
// top page at (50,19). A click also has to pass through every frame on the way — on the
// page it must land on the <iframe>, inside the iframe on the element — and anything on top
// at any of those levels takes it instead.

interface PointSource {
  elementFromPoint(x: number, y: number): HitNode | null;
}

interface DocLike extends PointSource {
  defaultView?: {
    frameElement?: FrameLike | null;
    getComputedStyle?(el: unknown): { paddingLeft?: string; paddingTop?: string };
  } | null;
}

interface FrameLike extends HitNode {
  getBoundingClientRect(): { left: number; top: number };
  clientLeft?: number;
  clientTop?: number;
  ownerDocument?: DocLike | null;
}

/** One document a click passes through, from the top page down to the target's own. */
export interface FrameLevel {
  doc: PointSource;
  /** Where this document's viewport starts, in top-page coordinates. */
  originX: number;
  originY: number;
  /** What the click must hit in this document: the next <iframe> on the way, or the target. */
  expect: HitNode;
}

const px = (value: string | undefined): number => {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
};

/**
 * The documents between the top page and `target`, outermost first, each with the
 * top-page position of its viewport. Null when a frame on the way cannot be read — a
 * cross-origin parent hides its <iframe> element (frameElement is null).
 */
export function frameLevels(target: HitNode & { ownerDocument?: DocLike | null }, topDoc: DocLike): FrameLevel[] | null {
  const frames: FrameLike[] = [];
  for (let doc = target.ownerDocument ?? null; doc && doc !== topDoc; ) {
    const frame = doc.defaultView?.frameElement ?? null;
    if (!frame) return null;
    frames.unshift(frame);
    doc = frame.ownerDocument ?? null;
  }

  const levels: FrameLevel[] = [];
  let originX = 0;
  let originY = 0;
  for (const frame of frames) {
    const doc = frame.ownerDocument as DocLike;
    levels.push({ doc, originX, originY, expect: frame });
    // The frame's document starts at its content box: inside the border and the padding.
    const box = frame.getBoundingClientRect();
    const style = doc.defaultView?.getComputedStyle?.(frame);
    originX += box.left + (frame.clientLeft ?? 0) + px(style?.paddingLeft);
    originY += box.top + (frame.clientTop ?? 0) + px(style?.paddingTop);
  }
  levels.push({ doc: target.ownerDocument as DocLike, originX, originY, expect: target });
  return levels;
}

/** Follow a top-page point through every level; report the first thing in the way. */
export function hitTestThroughFrames(
  levels: FrameLevel[],
  x: number,
  y: number
): { ok: boolean; blocker: HitNode | null } {
  for (const level of levels) {
    const hit = deepElementFromPoint(level.doc, x - level.originX, y - level.originY);
    if (!isHitOnTarget(level.expect, hit)) return { ok: false, blocker: hit };
  }
  return { ok: true, blocker: null };
}
