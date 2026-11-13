// A check made while a test is recorded: the next step of the recording, right after the
// action whose result it checks. Checks added once the test was saved were all checked on
// its last page and put at its end: on a replay, the actions ran one after the other
// without waiting for what each brought — a tab clicked 0.4 s after another stopped the
// first from loading, and the check of its content, at the end, failed. Where it belongs,
// a check holds the replay there until what it checks shows (up to the project's wait).

import { linkAssertionToVariables } from './test-variable.js';
import { withColumnsOf } from './datasets.js';
import { getRequirement } from './requirements.js';

/** Whether add_assertion on `testName` goes to the recording under way rather than to a saved test. */
export function checksRecording(recording, testName) {
  return !!recording && recording.name === testName;
}

/**
 * What a recording checks against a requirement: the one it was started for. A check of it
 * made while recording may be saved failing (non_conformity), as on the saved test.
 */
export function recordingRequirements(recording) {
  const ref = recording?.link?.requirement;
  const found = ref ? getRequirement(ref) : null;
  return found ? [{ id: found.id, key: found.key, title: found.title }] : [];
}

/**
 * Record `assertion` as the recording's next step. `{ step, after }`: its number, and the step
 * it comes right after (what the agent is told it checks the result of).
 */
export function recordCheck(session, { assertion, intent, page }) {
  const recording = session.recording;
  const before = recording.steps.at(-1) ?? null;
  recording.steps.push({ command: 'assert', params: {}, assertion, intent, ...(page && { page }) });
  const step = recording.steps.length;
  import('./websocket.js').then(({ pushOverlayState }) => {
    pushOverlayState(null, { mode: 'recording', updateOnly: true, step, stepName: intent }, session.lastTabId ?? null);
  }).catch(() => {});
  return { step, after: before ? `step ${step - 1}${before.intent ? ` (${before.intent})` : ` (${before.command})`}` : null };
}

/**
 * The checks of a recording, linked at save time to the variables it found: "Welcome Bob"
 * after typing Bob checks {{name}}, so a replay with other values checks those. Playing a
 * dataset (`row`), what its row shows is its column's too. Returns the variables with the
 * columns the checks name, and what was linked.
 */
export function linkRecordedChecks(steps, variables, row = null) {
  const fromDataset = row ? Object.fromEntries(Object.entries(row).map(([column, value]) => [column, { type: 'text', defaultValue: String(value ?? '') }])) : {};
  let all = variables;
  const linked = [];
  steps.forEach((step, i) => {
    if (step.command !== 'assert' || !step.assertion) return;
    const { assertion, linked: names } = linkAssertionToVariables(step.assertion, { ...fromDataset, ...all });
    if (!names.length) return;
    step.assertion = assertion;
    all = withColumnsOf(all, fromDataset, assertion.expected);
    linked.push({ step: i + 1, names });
  });
  return { variables: all, linked };
}
