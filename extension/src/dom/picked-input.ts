// Inputs whose value a person picks — in a calendar, a colour picker, on a slider — rather
// than types. Typing does not work on them: a date input takes keys segment by segment, in
// the order of the browser's locale (mm/dd/yyyy here, dd/mm/yyyy elsewhere), so the value
// stayed empty; a click on a colour input opens the system picker; a click on a range moves
// its thumb to where the click lands (50 for a click in its middle, whatever was asked).
// Their value is set from inside the page instead, which is also what Playwright's fill()
// does with them — so recording, replay and generated code agree.

const PICKED_TYPES = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'];

/** The type of `el` when it is such an input; undefined otherwise. */
export function pickedInputType(el: Element): string | undefined {
  if (el.tagName !== 'INPUT') return undefined;
  const type = (el as HTMLInputElement).type;
  return PICKED_TYPES.includes(type) ? type : undefined;
}

/**
 * Give such an input `value`, and tell the page as a person's change would (input, then
 * change). Null when `el` is not one of them: it is typed into as usual.
 *
 * A value the input cannot take — a date not written yyyy-mm-dd, a range off its steps —
 * is refused, and the input keeps the value it had: the browser would have emptied the date,
 * or moved the thumb to the nearest step, and the test gone on with another value than the
 * one written in it.
 *
 * Self-contained, its own copy of the types included: replay runs it in the page with
 * handle.evaluate(), which sends its source and nothing around it.
 */
export function setPickedValue(el: Element, value: string): { value: string } | { error: string } | null {
  const input = el as HTMLInputElement;
  const formats: Record<string, string> = {
    date: 'yyyy-mm-dd', time: 'hh:mm', 'datetime-local': 'yyyy-mm-ddThh:mm', month: 'yyyy-mm', week: 'yyyy-Www', color: '#rrggbb',
    range: `a number from ${input.min || 0} to ${input.max || 100}, in steps of ${input.step || 1}`,
  };
  if (el.tagName !== 'INPUT' || !(input.type in formats)) return null;

  // The setter of the prototype, not the input's own: React puts its own on the input to
  // remember what it set itself, and a value set through it is not seen as a change.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  const set = (v: string) => (setter ? setter.call(input, v) : (input.value = v));
  const before = input.value;
  set(value);
  const taken = input.value === value
    || (input.type === 'color' && input.value === value.toLowerCase())
    || (input.type === 'range' && value.trim() !== '' && Number(input.value) === Number(value));
  if (!taken) {
    const got = input.value;
    set(before);
    return { error: `The ${input.type} input does not take "${value}" (it would hold "${got}"): give ${formats[input.type]}` };
  }

  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: input.value };
}
