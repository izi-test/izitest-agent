// Waits of a time only, recorded by an agent, that the replay does not need.
//
// An agent recording a test often waits "3000 ms" for a page to load. The replay already waits
// for what each step acts on — its element, up to the project's wait (lib/projects.js), and a
// check reads the page again until it holds —: a fixed time before such a step only slows every
// replay, and is too short on a slow day anyway. So a wait of a time only, followed (after any
// other waits of a time only) by a step that waits by itself, is not kept.

/** Whether a recorded step waits by itself for what it needs: an element, or what it checks. */
export function waitsByItself(step) {
  if (!step) return false;
  if (step.command === 'wait') return !!step.params?.selector;
  if (step.command === 'assert' || step.assertion) return true;
  return Array.isArray(step.locators) && step.locators.length > 0;
}

/** The indexes of the waits of a time only that a step after them makes useless. */
export function redundantTimeWaits(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].command !== 'wait' || steps[i].params?.selector) continue;
    let next = i + 1;
    while (next < steps.length && steps[next].command === 'wait' && !steps[next].params?.selector) next += 1;
    if (waitsByItself(steps[next])) out.push(i);
  }
  return out;
}

/** What an agent is told when it waits a time while recording. */
export const TIME_WAIT_NOTE = '\n\nA wait of a time only is kept as a step only if no step after it waits by itself: the replay already waits for the element each step acts on (up to the project\'s wait for an element, 10 s by default), and for what a check expects. Prefer wait(selector) on what the page shows once ready, or nothing.';

// ─── How long a wait for an element waits ───────────────────────────
//
// A wait for an element waits as long as its project says each step waits for its element
// (lib/projects.js, 10 s by default), unless it says its own time: what it waits for may take
// longer than any other step's element — an export built, a batch done, a report computed.
// Its own time is kept with the step (params.timeout, in ms, whole seconds), read as Gherkin as
// `I wait for "…" up to 30 seconds`, and replayed as it was recorded.

export const MIN_WAIT_TIMEOUT_MS = 1_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;

/**
 * A wait's own time, in ms, rounded up to whole seconds (a Gherkin phrase says seconds); null
 * when it gives none. Throws, saying what it takes, for a time out of 1 s to 5 min.
 */
export function waitTimeoutOf(value) {
  if (value == null || value === '') return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`timeout is a time in milliseconds, from ${MIN_WAIT_TIMEOUT_MS} (1 s) to ${MAX_WAIT_TIMEOUT_MS} (5 min): ${JSON.stringify(value)} is not one.`);
  const rounded = Math.ceil(ms / 1000) * 1000;
  if (rounded < MIN_WAIT_TIMEOUT_MS || rounded > MAX_WAIT_TIMEOUT_MS) {
    throw new Error(`timeout is from ${MIN_WAIT_TIMEOUT_MS} ms (1 s) to ${MAX_WAIT_TIMEOUT_MS} ms (5 min): ${ms} ms is not.`);
  }
  return rounded;
}

/**
 * How much longer than its other steps a run of `steps` may take for its waits: the time of
 * each pause, and that of each wait for an element given its own. A replay is given its usual
 * time plus this, or a long wait would make it time out before the wait does.
 */
export function waitsExtraMs(steps) {
  let extra = 0;
  for (const step of steps ?? []) {
    if (step?.command !== 'wait') continue;
    const ms = Number(step.params?.ms);
    const timeout = Number(step.params?.timeout);
    if (Number.isFinite(ms) && ms > 0) extra += ms;
    // As long as the browser waits at most (extension/src/commands/queries.ts waitTimeoutMs).
    else if (step.params?.selector && Number.isFinite(timeout) && timeout > 0) extra += Math.min(timeout, MAX_WAIT_TIMEOUT_MS);
  }
  return extra;
}

/**
 * A wait an agent asks for now (the `wait` tool): what is sent to the browser, what the step
 * recording it keeps — its own time only, the project's may change —, and how long the command
 * may take; or why it is refused. `elementTimeoutMs`: the project's wait for an element.
 */
export function waitNow({ ms, selector, timeout, elementTimeoutMs = null }) {
  let own = null;
  if (selector) {
    try { own = waitTimeoutOf(timeout); } catch (err) { return { error: `${err.message} Nothing was waited for, nor recorded.` }; }
  }
  const waitMs = selector ? own ?? elementTimeoutMs ?? null : null;
  const longest = Number(ms) > 0 ? Number(ms) : waitMs ?? 0;
  return {
    sent: { ms, selector, ...(waitMs ? { timeout: waitMs } : {}) },
    kept: { ms, selector, ...(own ? { timeout: own } : {}) },
    commandMs: Math.max(30_000, longest + 15_000),
  };
}

/**
 * A wait step's params as kept, written in the step editor: its own time rounded up to whole
 * seconds (the Gherkin phrase says seconds), or none — none for a pause either. Throws for a
 * time out of 1 s to 5 min.
 */
export function keptWaitParams(params) {
  if (!params || typeof params !== 'object' || !('timeout' in params)) return params;
  const { timeout, ...rest } = params;
  const own = rest.selector ? waitTimeoutOf(timeout) : null;
  return own ? { ...rest, timeout: own } : rest;
}
