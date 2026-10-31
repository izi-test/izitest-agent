// The checkbox, radio or switch a click acts on, and whether it is checked.
//
// A click on a checkbox toggles it. Recording keeps the state the click left it in, so
// that replay and generated code set that state instead of toggling it again: a box the
// page remembers as checked would otherwise end up unchecked.

export interface ToggleState {
  kind: 'checkbox' | 'radio' | 'switch';
  checked: boolean;
}

export function isToggleInput(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return type === 'checkbox' || type === 'radio';
}

/**
 * The <label> a checkbox or radio is operated through when the box itself is styled away
 * (opacity 0, no size: a custom toggle draws its own track and thumb) and the label shows.
 * Null otherwise. Clicks go to that label; Playwright's check() on such an input times out.
 */
export function styledAwayToggleLabel(el: Element): Element | null {
  if (!isToggleInput(el)) return null;
  const view = el.ownerDocument.defaultView ?? window;
  const style = view.getComputedStyle(el);
  const box = el.getBoundingClientRect();
  if (style.opacity !== '0' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0) return null;

  const label = (el as HTMLInputElement).labels?.[0] ?? el.closest('label');
  if (!label) return null;
  const labelBox = label.getBoundingClientRect();
  const labelStyle = view.getComputedStyle(label);
  const shows = labelBox.width > 0 && labelBox.height > 0 && labelStyle.visibility !== 'hidden' && labelStyle.opacity !== '0';
  return shows ? label : null;
}

/**
 * The text next to a control that has no name of its own: own text of the closest of its
 * three nearest ancestors that has any. <div><label><input>…</label> Dark mode</div> → "Dark mode".
 */
export function textAround(el: Element): string {
  let node = el.parentElement;
  for (let level = 0; node && level < 3; level++, node = node.parentElement) {
    const own = Array.from(node.childNodes)
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (own) return own.slice(0, 80);
  }
  return '';
}

/**
 * The checkbox, radio or switch a click on `el` acts on: the element itself, the custom
 * control it sits in (role="checkbox"), or the control of the <label> it is or sits in —
 * styled checkboxes hide the real <input> and show its label. Undefined for anything else.
 * Duck-typed: an element from a same-origin iframe is no instance of this window's classes.
 * (Replay asks the same in page-helpers.ts toggleStateOf, inlined for page.evaluate.)
 */
export function toggleOf(el: Element): ToggleState | undefined {
  const label = el.closest('label') as HTMLLabelElement | null;
  const candidates = [el, el.closest('[role="checkbox"], [role="radio"], [role="switch"]'), label?.control ?? null];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const type = candidate.tagName === 'INPUT' ? (candidate as HTMLInputElement).type : '';
    if (type === 'checkbox' || type === 'radio') {
      return { kind: type, checked: (candidate as HTMLInputElement).checked };
    }
    const role = candidate.getAttribute('role');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      return { kind: role, checked: candidate.getAttribute('aria-checked') === 'true' };
    }
  }
  return undefined;
}
