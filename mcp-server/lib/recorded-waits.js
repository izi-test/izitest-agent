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
