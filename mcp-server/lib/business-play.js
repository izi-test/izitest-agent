// A business step of a project, played as one: its phrase gives its steps, with their locators
// and the values of its parameters. An agent recording a test plays "je me connecte au portail …"
// instead of clicking through the login again — the test then holds the very steps of the
// business step, linked to it, and reads as its phrase. The dashboard inserts one the same way.

import { listStepDefinitions } from './gherkin/step-definition-store.js';
import { compileDefinitions, stepsForPhrase } from './gherkin/parse.js';
import { isTimeWait } from './gherkin/serialize.js';
import { evaluateAssertion } from './test-execute.js';

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
 * Plays the steps of a business step in the browser, one by one: actions through the replay
 * (their locators, the project's wait for an element), checks read until they hold. `live`
 * works out the values ({{secret.…}}) as the session knows them. Resolves to { tabId } or
 * { error } naming the step that stopped it.
 */
export async function playBusinessSteps(found, { sendCommand, live, tabId, elementTimeoutMs }) {
  let lastTabId = tabId ?? undefined;
  for (const [i, step] of found.steps.entries()) {
    try {
      if (step.command === 'assert') {
        const result = await evaluateAssertion(sendCommand, live(step.assertion), lastTabId, { timeoutMs: elementTimeoutMs });
        if (!result.passed) throw new Error(`${result.expected} — the page shows ${result.actual}`);
        continue;
      }
      const played = await sendCommand(undefined, 'replay_sequence', {
        steps: [{ ...step, params: live(step.params ?? {}) }], startIndex: 0, newWindow: false,
        ...(lastTabId ? { tabId: lastTabId } : {}), elementTimeoutMs,
      }, 120000);
      const outcome = played?.results?.[0];
      if (outcome?.status === 'failed') throw new Error(outcome.error || 'failed');
      if (outcome?.tabId) lastTabId = outcome.tabId;
    } catch (err) {
      return { error: `"${found.phrase}" stopped at its step ${i + 1} of ${found.steps.length} (${step.command}${step.intent ? `: ${step.intent}` : ''}): ${err.message}. Nothing of it was recorded.` };
    }
  }
  return { tabId: lastTabId };
}
