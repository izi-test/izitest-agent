// The checkbox, radio or switch a click acts on, and whether it is checked.
//
// A click on a checkbox toggles it. Recording keeps the state the click left it in, so
// that replay and generated code set that state instead of toggling it again: a box the
// page remembers as checked would otherwise end up unchecked.

export interface ToggleState {
  kind: 'checkbox' | 'radio' | 'switch';
  checked: boolean;
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
