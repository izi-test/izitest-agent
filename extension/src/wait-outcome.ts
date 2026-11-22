// A wait in a replayed test is a step like the others: when what it waits for never comes, the
// steps after it act on a page other than the one they were recorded on.
//
// Before, the replay went on. A note the app refused to submit was waited for 10 s, and so was
// its row on the manager's page. The test then failed 7 steps later on that other page, and the
// diagnosis called it the test's own drift. The `wait` tool an agent calls still answers
// found: false: it asks, it does not check.

/** The error of a replayed wait whose element never came; null when it came, or for a pause. */
export function missedWait(command: string, result: unknown): string | null {
  const waited = result as { timeout?: boolean; selector?: string; waitedMs?: number } | null | undefined;
  if (command !== 'wait' || !waited?.timeout) return null;
  const time = waited.waitedMs ? `${Math.round(waited.waitedMs / 1000)} s` : 'its time';
  return `Waited ${time} for ${waited.selector}: not found`;
}

// How long a wait for an element waits when it says no time of its own (params.timeout), and
// its replay none either (the project's wait for an element, ReplaySequenceParams.elementTimeoutMs).
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
// The longest it waits, however its time was written (a Gherkin phrase is not checked as the
// step editor and the agents' tool are: mcp-server/lib/recorded-waits.js).
const MAX_WAIT_TIMEOUT_MS = 300_000;

/** How long a wait for an element waits: its own time (from a Gherkin phrase, a string), up to 5 min; or 10 s. */
export function waitTimeoutMs(timeout: number | string | undefined): number {
  const ms = Number(timeout);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
}
