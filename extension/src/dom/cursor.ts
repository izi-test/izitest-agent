// The cursor of the mouse IziTest drives, drawn in the page (cursor.ts tells where it goes): a
// blue arrow gliding from point to point, a ring where it presses. In a shadow root, above
// everything, and never in the way: it takes no clicks (pointer-events: none, so
// elementFromPoint and the clicks themselves go through it), has no text, and is not a panel
// that a click's effects would report.

const HOST_ID = 'izitest-cursor-host';
const GLIDE_MS = 350;

let host: HTMLElement | null = null;
let arrow: HTMLElement | null = null;

function ensure(): { host: HTMLElement; arrow: HTMLElement } {
  if (host?.isConnected && arrow) return { host, arrow };
  document.getElementById(HOST_ID)?.remove();
  host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .arrow {
        position: fixed; left: 0; top: 0; width: 32px; height: 32px; pointer-events: none;
        transition: transform ${GLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1);
        filter: drop-shadow(0 1px 2px rgba(15, 23, 42, 0.45));
      }
      .ring {
        position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px;
        border: 3px solid #2563eb; border-radius: 50%; pointer-events: none; opacity: 0;
        /* Once the arrow is nearly there: the click itself does not wait for the picture. */
        animation: press 600ms ease-out ${Math.round(GLIDE_MS * 0.6)}ms both;
      }
      @keyframes press {
        0% { opacity: 0.9; transform: var(--at) scale(0.3); }
        100% { opacity: 0; transform: var(--at) scale(1.4); }
      }
    </style>
    <div class="arrow"><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
      <path d="M3 2 L3 19.5 L7.6 15.4 L10.6 22 L13.6 20.7 L10.7 14.2 L16.8 14.2 Z"
        fill="#2563eb" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
    </svg></div>`;
  arrow = root.querySelector('.arrow') as HTMLElement;
  // Where it last was, it shows from: no glide in from the corner.
  arrow.style.transition = 'none';
  arrow.style.visibility = 'hidden';
  document.documentElement.appendChild(host);
  return { host, arrow };
}

/** Draw the cursor at (x, y) of the viewport — the tip of the arrow there —, a ring if it presses. */
export function drawCursor({ x, y, press, hidden }: { x?: number; y?: number; press?: boolean; hidden?: boolean }): void {
  if (hidden !== undefined) {
    if (host) host.style.visibility = hidden ? 'hidden' : '';
    return;
  }
  if (typeof x !== 'number' || typeof y !== 'number') return;
  const { arrow: a } = ensure();
  const first = a.style.visibility === 'hidden';
  // The tip of the arrow is at (3, 2) of its 24-unit drawing, drawn 32 px wide: (4, 2.7).
  a.style.transform = `translate(${x - 4}px, ${y - 2.7}px)`;
  if (first) {
    a.style.visibility = '';
    requestAnimationFrame(() => { a.style.transition = ''; });
  }
  if (press) {
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.setProperty('--at', `translate(${x}px, ${y}px)`);
    a.parentNode!.appendChild(ring);
    ring.addEventListener('animationend', () => ring.remove(), { once: true });
  }
}
