// What an action acts on is known by the page it is on (the server's lib/elements.js): the
// URL of the tab when the action began goes back with its result, as `pageUrl`.

const PAGE_COMMANDS = new Set(['click', 'fill', 'select', 'upload', 'drag']);

/** Whether a command acts on an element of the page, so says where. */
export function actsOnPage(command: string): boolean {
  return PAGE_COMMANDS.has(command);
}

/** The result of an action with the URL of its page; anything else as it is. */
export function withPageUrl(result: unknown, pageUrl: string | undefined): unknown {
  if (!pageUrl || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...result, pageUrl };
}
