// A business step of a project, played as one: its phrase gives its steps, with their locators
// and the values of its parameters. An agent recording a test plays "je me connecte au portail …"
// instead of clicking through the login again — the test then holds the very steps of the
// business step, linked to it, and reads as its phrase. The dashboard inserts one the same way.

import { listStepDefinitions, getStepDefinition, updateStepDefinition } from './gherkin/step-definition-store.js';
import { compileDefinitions, stepsForPhrase } from './gherkin/parse.js';
import { isTimeWait } from './gherkin/serialize.js';
import { evaluateAssertion } from './test-execute.js';
import { waitsExtraMs } from './recorded-waits.js';

// While a test is recorded, a step of a business step waits for its element this long at most:
// the page is there, the agent is watching — a step the page does not show is told in seconds,
// not after the project's wait for an element (30 s on a slow site), which replays keep.
export const RECORDING_WAIT_MS = 8_000;

/** The business steps of a project: each phrase, how many steps it holds, its parameters. */
export function businessStepsOf(projectId) {
  if (projectId == null) return [];
  return listStepDefinitions(projectId)
    .filter((d) => Array.isArray(d.steps_template) && d.steps_template.length)
    .map((d) => ({
      id: d.id,
      keyword: d.keyword,
      pattern: d.pattern,
      steps: d.steps_template.filter((tpl) => !isTimeWait(tpl)).length,
      parameters: (d.pattern.match(/\{[a-z]*\}/g) || []),
    }));
}

/**
 * The steps of a phrase of a business step of the project — `je me connecte au portail avec
 * l'identifiant "{{secret.PORTAL_USERNAME}}" et le mot de passe "{{secret.PORTAL_PASSWORD}}"` —, the
 * first linked to it; waits of a time only left out. Or { error } when no business step reads so.
 */
export function stepsOfBusinessPhrase(projectId, phrase) {
  const business = listStepDefinitions(projectId).filter((d) => Array.isArray(d.steps_template) && d.steps_template.length);
  if (!business.length) return { error: 'This project has no business step yet (create_business_step makes one from a recorded test).' };
  const text = String(phrase ?? '').trim().replace(/^(given|when|then|and|but|soit|étant donné|quand|lorsque|alors|et|mais)\s+/i, '');
  const played = stepsForPhrase(text, null, compileDefinitions(business));
  if (!played) {
    return { error: `No business step of the project reads "${text}". Its business steps: ${business.map((d) => `"${d.pattern}"`).join('; ')}. Give each {string} its value in double quotes.` };
  }
  const definitionId = played.steps.find((s) => s.step_definition_id)?.step_definition_id ?? null;
  const steps = played.steps.filter((s) => !isTimeWait(s)).map(({ step_order: _order, ...step }, i) => ({
    ...step,
    intent: step.intent ?? null,
    step_definition_id: i === 0 ? definitionId : null,
  }));
  if (steps.length && !steps[0].intent) steps[0].intent = text;
  return { definitionId, phrase: text, steps };
}

/**
 * Plays the steps of a business step in the browser, one by one, from its step `from` (0: the
 * first): actions through the replay (their locators, the project's wait for an element), checks
 * read until they hold. An optional one the page does not show is not done (`notDone`), the
 * others go on. `live` works out the values ({{secret.…}}) as the session knows them. Resolves to
 * { tabId, notDone } or { error, failedAt } — the step that stopped it, numbered from 1.
 */
export async function playBusinessSteps(found, { sendCommand, live, tabId, elementTimeoutMs, from = 0 }) {
  let lastTabId = tabId ?? undefined;
  const notDone = [];
  for (const [i, step] of found.steps.entries()) {
    if (i < from) continue;
    try {
      if (step.command === 'assert') {
        const result = await evaluateAssertion(sendCommand, live(step.assertion), lastTabId, { timeoutMs: elementTimeoutMs });
        if (!result.passed) throw new Error(`${result.expected} — the page shows ${result.actual}`);
        continue;
      }
      // An item picked in a list by its place: the item at that place now, not the one recorded.
      const pick = step.variable?.listContext ? {
        variableResolve: {
          parentSelector: step.variable.listContext.parentSelector, itemXpath: step.variable.listContext.itemXpath,
          selectionMode: step.variable.listContext.selectionMode, value: step.variable.defaultValue,
          ...(step.variable.listContext.withinXpath ? { withinXpath: step.variable.listContext.withinXpath } : {}),
        },
      } : {};
      const played = await sendCommand(undefined, 'replay_sequence', {
        steps: [{ ...step, params: live(step.params ?? {}), ...pick }], startIndex: 0, newWindow: false,
        ...(lastTabId ? { tabId: lastTabId } : {}), elementTimeoutMs,
      }, 120000 + waitsExtraMs([step]));
      const outcome = played?.results?.[0];
      if (outcome?.status === 'failed') throw new Error(outcome.error || 'failed');
      if (outcome?.tabId) lastTabId = outcome.tabId;
    } catch (err) {
      if (step.optional) {
        notDone.push({ step: i + 1, error: err.message });
        continue;
      }
      return { error: `"${found.phrase}" stopped at its step ${i + 1} of ${found.steps.length} (${subStep(step)}): ${err.message}`, failedAt: i + 1 };
    }
  }
  return { tabId: lastTabId, notDone };
}

/** A sub-step in a few words, for the agent: its command and what it acts on. */
const subStep = (step) => {
  const target = step.command === 'assert' ? step.assertion?.selector : step.params?.selector ?? step.params?.url;
  return `${step.command}${step.intent ? `: ${step.intent}` : ''}${target ? ` on ${target}` : ''}`;
};

/**
 * Sub-step `n` (from 1, waits of a time only not counted) of the business step `definitionId`
 * made optional in the library: only needed sometimes (a code asked on a new device, a banner),
 * every test using the business step does it when the page asks, and goes on when it does not.
 */
export function makeSubStepOptional(definitionId, n) {
  const definition = getStepDefinition(definitionId);
  if (!definition?.steps_template) return { error: 'No such business step' };
  const indices = definition.steps_template.map((tpl, i) => (isTimeWait(tpl) ? null : i)).filter((i) => i !== null);
  const at = indices[Number(n) - 1];
  if (at === undefined) return { error: `The business step "${definition.pattern}" has ${indices.length} step(s), numbered from 1: no step ${n}` };
  const steps_template = definition.steps_template.map((tpl, i) => (i === at ? { ...tpl, optional: true } : tpl));
  updateStepDefinition(definitionId, { ...definition, steps_template });
  return { definition: getStepDefinition(definitionId) };
}

/**
 * play_business_step: the business step `phrase` of `projectId` played, and recorded when a test
 * is — `{ text }`, or `{ error }` saying what to do. `optionalStep`: that sub-step made optional
 * in the library first. A business step stopped partway leaves done what it did: those steps are
 * recorded (the test holds what the browser did), and the agent is told how to go on — played
 * again with its failed step optional, it goes on from there, what was done not done again, and
 * the test gets the whole business step.
 */
export async function playBusinessPhrase({ projectId, phrase, optionalStep = null, session, recording, sendCommand, tabId, elementTimeoutMs }) {
  let found = stepsOfBusinessPhrase(projectId, phrase);
  if (found.error) return { error: found.error };
  let optionalText = '';
  if (optionalStep != null) {
    const made = makeSubStepOptional(found.definitionId, optionalStep);
    if (made.error) return { error: made.error };
    found = stepsOfBusinessPhrase(projectId, phrase);
    optionalText = ` Its step ${optionalStep} is optional now, in the business step: every test using it does it when the page asks for it, and goes on when it does not.`;
  }

  // Stopped partway just before (`businessPartial`: where its steps start in the recording, how
  // many are recorded, the one it stopped at): what it did stays done, it goes on from there.
  const partial = recording?.businessPartial;
  const resume = partial && partial.definitionId === found.definitionId && partial.phrase === found.phrase
    && partial.at + partial.recorded === recording.steps.length;
  let from = resume ? partial.next : 0;
  const skipped = [];
  // The step just made optional is the one the page did not show: not tried again.
  if (resume && Number(optionalStep) === partial.next + 1) {
    skipped.push({ step: partial.next + 1, error: 'not shown by the page' });
    from += 1;
  }

  const wait = recording ? Math.min(elementTimeoutMs ?? RECORDING_WAIT_MS, RECORDING_WAIT_MS) : elementTimeoutMs;
  const played = await playBusinessSteps(found, { sendCommand, live: (params) => session.live(params), tabId, elementTimeoutMs: wait, from });
  if (played.error) {
    // What it did is recorded — actions done in the browser. Checks alone changed nothing: a
    // check that does not hold ("je suis connecté", played to know) records nothing.
    const doneSteps = found.steps.slice(from, played.failedAt - 1);
    const acted = doneSteps.some((step) => step.command !== 'assert');
    const done = acted ? doneSteps.map((step) => ({ ...structuredClone(step), step_definition_id: null })) : [];
    if (recording && (done.length || resume)) {
      recording.steps.push(...done);
      recording.businessPartial = {
        definitionId: found.definitionId, phrase: found.phrase,
        at: resume ? partial.at : recording.steps.length - done.length,
        recorded: (resume ? partial.recorded : 0) + done.length,
        next: played.failedAt - 1,
      };
    }
    const before = played.failedAt - 1;
    const said = before - from <= 0 && !resume
      ? ' None of its steps was done: if the page is not where it starts (a form to open first), get there, then play it again.'
      : !acted && !resume ? ' Its steps before were checks only, which change nothing on the page: nothing was recorded.'
      : ` Its steps 1–${before} were done in the browser${recording ? ' and are recorded' : ''}.`
        + ` If the page does not need its step ${played.failedAt} this time — a code asked only on a new device, a banner shown sometimes —,`
        + ` call play_business_step again with optional_step: ${played.failedAt}: it becomes optional in the business step for every test,`
        + ` it goes on from there without doing again what was done${recording ? ', and the test gets the whole business step' : ''}.`
        + ' Otherwise do it another way, or say what blocks.';
    return { error: `${played.error.replace(/\.+$/, '')}.${said}` };
  }

  if (played.tabId) session.adoptTab(played.tabId);
  if (recording) {
    // What it did before it stopped is part of it: the test gets the whole business step, linked to it.
    if (resume) recording.steps.splice(partial.at, partial.recorded);
    recording.steps.push(...found.steps.map((step) => structuredClone(step)));
    recording.businessPartial = null;
  }
  const notDone = [...skipped, ...played.notDone];
  const notDoneText = notDone.length ? ` Not done, optional: ${notDone.map((n) => `step ${n.step} (${n.error})`).join('; ')}.` : '';
  return { text: `Played "${found.phrase}" (${found.steps.length} steps)${recording ? ': recorded as this business step' : ''}.${notDoneText}${optionalText}` };
}
