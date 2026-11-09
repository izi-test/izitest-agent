// What a snapshot shows of the value a field holds. A password field shows that it is filled,
// never what with: the snapshot goes to an agent, and what it read stays in its conversation.

const NO_VALUE = new Set(['checkbox', 'radio', 'submit', 'reset', 'button', 'hidden', 'file']);
export const HIDDEN_VALUE = '••••••';

/** The value of an <input type="…"> as a snapshot shows it, or null when it shows none. */
export function shownInputValue(type: string | null | undefined, value: string | null | undefined): string | null {
  const kind = (type || 'text').toLowerCase();
  if (NO_VALUE.has(kind) || !value) return null;
  return kind === 'password' ? HIDDEN_VALUE : value;
}
