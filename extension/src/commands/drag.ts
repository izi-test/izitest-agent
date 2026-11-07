// Drag an element and drop it somewhere else, with the mouse, as a person does — whatever the
// page listens to.
//
// A page built on mouse or pointer events (SortableJS's fallback, dnd-kit, jQuery UI) follows
// the moves of the pressed mouse. An element with draggable="true" is another matter: once
// the mouse has moved a few pixels, Chrome starts its own drag and waits for the system to
// drop it — mouse events sent through CDP never end it, and nothing drops. That drag is
// intercepted (Input.setInterceptDrags) and carried to the drop by Input.dispatchDragEvent,
// which the page receives as Chrome's own dragenter, dragover, drop and dragend: what
// Playwright's dragTo does too.

import type { CDPSession, ElementHandle, Page } from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';
import type { Protocol } from 'devtools-protocol';

export const DROP_POSITIONS = ['center', 'top', 'bottom', 'left', 'right'] as const;
export type DropPosition = typeof DROP_POSITIONS[number];

export interface Point { x: number; y: number }
/** An element's box: its centre, and its size. */
export interface CentredBox extends Point { width: number; height: number }

// Moves from the press to the drop. Libraries move the element on each one, and some only
// start past a distance of their own (dnd-kit's activation constraint).
const MOVES = 8;
const MOVE_GAP_MS = 16;
// A first move this far: past Chrome's drag threshold (a few pixels) and most libraries'.
const FIRST_MOVE_PX = 6;
// How long a move may take to start Chrome's drag: the event comes during the move, or right after.
const INTERCEPT_WAIT_MS = 120;

/**
 * Where on the target the drop goes: its centre, or a quarter of the way in from an edge.
 * The top of an item in a vertical list puts what is dropped before it, the bottom after it.
 */
export function dropPoint(box: CentredBox, position: DropPosition = 'center'): Point {
  // A step written by hand may say anything ("I drag … to the middle of …"): the centre then.
  const [dx, dy] = { center: [0, 0], top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[position] ?? [0, 0];
  return { x: Math.round(box.x + dx * box.width / 4), y: Math.round(box.y + dy * box.height / 4) };
}

/**
 * The points the mouse goes through from `from` to `to`: a short first move toward the drop
 * (downward when the drop is where the drag starts), then `moves` steps, the last on `to`.
 */
export function dragPath(from: Point, to: Point, moves = MOVES): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const first = length > FIRST_MOVE_PX
    ? { x: Math.round(from.x + dx / length * FIRST_MOVE_PX), y: Math.round(from.y + dy / length * FIRST_MOVE_PX) }
    : { x: from.x, y: from.y + FIRST_MOVE_PX };
  const path = [first];
  for (let i = 1; i <= moves; i++) {
    path.push({ x: Math.round(first.x + (to.x - first.x) * i / moves), y: Math.round(first.y + (to.y - first.y) * i / moves) });
  }
  return path;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Press at `from`, move to `to`, release. "native" when the page started Chrome's own drag
 * (draggable="true"), carried to the drop; "mouse" when the moves were all the page needed.
 */
export async function dragBetween(page: Page, from: Point, to: Point): Promise<'native' | 'mouse'> {
  const cdp = (page as unknown as { _client(): CDPSession })._client();
  let data = null as Protocol.Input.DragData | null;
  const onIntercepted = (event: Protocol.Input.DragInterceptedEvent) => { data = event.data; };
  cdp.on('Input.dragIntercepted', onIntercepted);
  await cdp.send('Input.setInterceptDrags', { enabled: true });
  try {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    let entered = false;
    const path = dragPath(from, to);
    for (const [i, point] of path.entries()) {
      if (!data) {
        await page.mouse.move(point.x, point.y);
        if (i < 2) for (let waited = 0; !data && waited < INTERCEPT_WAIT_MS; waited += 20) await sleep(20);
      }
      if (data) {
        await cdp.send('Input.dispatchDragEvent', { type: entered ? 'dragOver' : 'dragEnter', ...point, data });
        entered = true;
      }
      await sleep(MOVE_GAP_MS);
    }
    if (data) await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...to, data });
    // Also after a drop: Puppeteer's mouse would stay pressed, and refuse the next click.
    await page.mouse.up();
    return data ? 'native' : 'mouse';
  } finally {
    cdp.off('Input.dragIntercepted', onIntercepted);
    await cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

/**
 * Replay's drag: from the element found to the target found, both on screen together —
 * each scrolled into view only when it is not.
 */
export async function dragElements(page: Page, source: ElementHandle<Element>, target: ElementHandle<Element>, position?: DropPosition) {
  const inView = (handle: ElementHandle<Element>) => handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    return x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  });
  if (!(await inView(source))) await source.scrollIntoView();
  if (!(await inView(target))) {
    await target.scrollIntoView();
    if (!(await inView(source))) throw new Error('The element and where to drop it are too far apart to be on screen together');
  }
  const centred = async (handle: ElementHandle<Element>, what: string): Promise<CentredBox> => {
    const box = await handle.boundingBox();
    if (!box) throw new Error(`The ${what} has no box to drag`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: box.width, height: box.height };
  };
  const from = await centred(source, 'element found');
  const to = dropPoint(await centred(target, 'target found'), position);
  console.log(`  ✋ Dragging from (${from.x}, ${from.y}) to (${to.x}, ${to.y})${position && position !== 'center' ? ` (${position} of the target)` : ''}`);
  return dragBetween(page, from, to);
}
