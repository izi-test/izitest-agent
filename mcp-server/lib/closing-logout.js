// The logout a test ends with, played even when the test failed before it. The app keeps the
// session a failed run opened on its side — clearing the browser's cookies does not close it —
// and an app that limits the sessions of an account (PORTAL: "Concurrent Sessions Exceeded")
// refused the next runs until someone closed them by hand.

// What a step says when it logs out: "je me déconnecte du portail", "Se déconnecter", "Log Out".
const LOGS_OUT = /d[ée]conne(?:ct|x)|disconnect|log ?out|log ?off|sign ?out/i;
// A click right before it that opens the menu the logout is in ("Ouvrir le menu du compte").
const OPENS_ITS_MENU = /menu|compte|account|profil|avatar/i;

/**
 * The steps a test ends with to log out, as indexes of `steps`: from the last step that says it
 * logs out — by its intent, or by the business step it belongs to (`patternOf(id)`, its
 * phrase) — to the end, with the steps of that business step after it (they carry no intent of
 * their own) and a click just before it that opens its menu. Only actions: a check of the
 * logged-out page proves nothing on a run that failed. None when the test does not end so.
 */
export function closingLogout(steps = [], patternOf = () => null) {
  const saysLogout = (step) => LOGS_OUT.test(step.intent ?? '')
    || (step.step_definition_id != null && LOGS_OUT.test(patternOf(step.step_definition_id) ?? ''));
  let start = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (saysLogout(step)) { start = i; continue; }
    // Steps of a business step after its first (no intent of their own), or a check of the
    // page after the logout: they belong to the block if a step saying it logs out comes before.
    if (!step.intent?.trim() || (start === null && step.command === 'assert')) continue;
    break;
  }
  if (start === null) return [];
  const before = steps[start - 1];
  if (before && before.command === 'click' && OPENS_ITS_MENU.test(before.intent ?? '') && !saysLogout(before)) start -= 1;
  const block = [];
  for (let i = start; i < steps.length; i++) if (steps[i].command !== 'assert') block.push(i);
  return block;
}

/**
 * The steps of that logout still to play after a run stopped at step `ranUpTo` (numbered from
 * 1): those after it. None when the run failed in the logout itself — it was played.
 */
export function logoutToPlay(steps, ranUpTo, patternOf) {
  const block = closingLogout(steps, patternOf);
  if (!block.length || ranUpTo == null || ranUpTo > block[0]) return [];
  return block;
}
