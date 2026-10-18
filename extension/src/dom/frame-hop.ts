// Placing a cross-origin iframe on the page, one parent at a time.
//
// A cross-origin frame does not know where it sits on the page — its parent does. So the
// frame posts a message to its parent, and the parent's content script recognises which
// of its <iframe> elements sent it (the message's `source` is that iframe's window). From
// there it knows the iframe's position, which ref the snapshot gave it, and whether a click
// at a given point would actually reach it. It reports that to the service worker, which
// repeats the hop with the parent until it reaches the page.

import { deepElementFromPoint, isHitOnTarget, describeBlocker, frameLevels } from './hit-test';

const HOP_KEY = '__browserPilotHop';

interface HopRequest {
  [HOP_KEY]: string; // token
  x?: number;
  y?: number;
  uncover?: boolean;
}

/** Child side: ask the parent to place this frame, optionally with a point inside it. */
export function announceToParent(token: string, point?: { x: number; y: number }, uncover = false): boolean {
  if (window.parent === window) return false;
  const message: HopRequest = { [HOP_KEY]: token, ...(point ?? {}), uncover };
  window.parent.postMessage(message, '*');
  return true;
}

function findSendingIframe(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null;
  for (const frame of document.querySelectorAll('iframe, frame')) {
    if ((frame as HTMLIFrameElement).contentWindow === source) return frame as HTMLIFrameElement;
  }
  return null;
}

function refOf(el: Element): string | null {
  const ref = window.__browserPilotRefOf?.get(el);
  if (ref && window.__browserPilotRefMap?.get(ref) === el) return ref;
  return null;
}

/** Parent side: answer hop requests from this document's own iframes. */
export function listenForHops(): void {
  window.addEventListener('message', (event) => {
    const data = event.data as HopRequest | undefined;
    const token = data && typeof data === 'object' ? data[HOP_KEY] : undefined;
    if (typeof token !== 'string') return;

    const frame = findSendingIframe(event.source);
    if (!frame) return; // not one of ours (or a page script posting to itself)

    let inlined = false;
    try { inlined = !!frame.contentDocument; } catch { inlined = false; }

    const box = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const visible = box.width > 1 && box.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';

    const report: Record<string, unknown> = {
      type: 'frame_hop_report', token,
      ref: refOf(frame), inlined, visible,
      src: frame.src || frame.getAttribute('src') || '',
    };

    if (typeof data!.x === 'number' && typeof data!.y === 'number') {
      // The frame's document starts at its content box, inside border and padding.
      const levels = frameLevels(frame as never, document as never);
      const origin = levels ? levels[levels.length - 1] : { originX: 0, originY: 0 };
      const ox = origin.originX + box.left + frame.clientLeft + parseFloat(style.paddingLeft || '0');
      const oy = origin.originY + box.top + frame.clientTop + parseFloat(style.paddingTop || '0');
      const x = Math.round(ox + data!.x);
      const y = Math.round(oy + data!.y);

      const inView = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const hit = inView ? deepElementFromPoint(document as never, x, y) : null;
      const ok = inView && isHitOnTarget(frame as never, hit as never);

      if (!ok && data!.uncover) {
        frame.scrollIntoView({ behavior: 'instant', block: 'center' });
        Object.assign(report, { x, y, ok: false, scrolled: true });
      } else {
        Object.assign(report, {
          x, y, ok,
          ...(ok ? {} : { coveredBy: inView ? describeBlocker(hit as never) : 'nothing at that point (its frame is outside the visible page)' }),
        });
      }
    }

    chrome.runtime.sendMessage(report).catch(() => {});
  });
}
