// Action history and auto-recording of test steps.
//
// State lives on the Session (see session.js), never in this module: several agents record
// different tests at the same time, and each must only ever see its own steps and refs.

import { log } from './logger.js';

// ─── Action History ────────────────────────────────────────────────

/**
 * Build a human-readable intent from available step context.
 * Uses locators (aria, label, placeholder) and params to produce
 * a concise description such as "Click 'Save'" or "Fill 'Email' field".
 */
function deriveIntent(command, params, locators) {
  const labelFromLocators = (locators || [])
    .filter(l => ['aria', 'label', 'placeholder'].includes(l.type) && l.value)
    .map(l => l.value)[0] || null;

  switch (command) {
    case 'navigate':
      return `Navigate to ${params.url || 'page'}`;

    case 'click': {
      const target = params.text || labelFromLocators;
      return target ? `Click "${target}"` : 'Click element';
    }

    case 'fill': {
      const fieldName = labelFromLocators;
      const valuePreview = params.value
        ? params.value.length > 30
          ? `"${params.value.substring(0, 30)}…"`
          : `"${params.value}"`
        : '';
      return fieldName
        ? `Fill "${fieldName}" with ${valuePreview}`
        : `Fill field with ${valuePreview}`;
    }

    case 'select': {
      const fieldName = (locators || [])
        .filter(l => ['aria', 'label', 'placeholder'].includes(l.type) && l.value)
        .map(l => l.value)[0] || null;
      return fieldName
        ? `Select "${params.value}" in "${fieldName}"`
        : `Select "${params.value}"`;
    }

    case 'keyboard': {
      const modPrefix = params.modifiers?.length
        ? params.modifiers.join('+') + '+'
        : '';
      return `Press ${modPrefix}${params.key || 'key'}`;
    }

    case 'wait':
      return params.selector
        ? `Wait for "${params.selector}"`
        : `Wait ${params.ms || 0}ms`;

    case 'execute_js':
      return 'Execute JavaScript';

    default:
      return command;
  }
}

/**
 * The params a select step is kept with: the option's value, what the form sends — an
 * assertion on it is then linked to the variable the step becomes, and a label reworded or
 * translated still replays. As asked when the page gave no value back.
 */
export function selectParams(result, value, matchBy) {
  return result?.selectedValue ? { value: result.selectedValue, matchBy: 'value' } : { value, ...(matchBy ? { matchBy } : {}) };
}

/**
 * Record one executed action in `session`'s history, and append it to that session's
 * recording when one is active. Returns the action id handed back to the agent.
 */
export function recordAction(session, command, params, refKey, screenshotBase64, agentIntent, extraLocators = []) {
  let locators = null;
  const recordParams = { ...params };

  if (refKey && session.refMap) {
    const key = String(refKey).replace('@', '');
    const refInfo = session.refMap[key];
    if (refInfo) {
      if (refInfo.selector) recordParams.selector = refInfo.selector;
      if (refInfo.locators && refInfo.locators.length > 0) {
        locators = refInfo.locators;
      }
    }
  }
  // Locators the action itself learned (the role and name Chrome gives a clicked element).
  if (extraLocators.length) locators = [...(locators ?? []), ...extraLocators];

  const id = session.putAction({ command, params: recordParams, locators });

  // Auto-record step when recording is active
  const recording = session.recording;
  if (recording) {
    const intent = agentIntent || deriveIntent(command, recordParams, locators);
    const step = {
      command,
      params: { ...recordParams },
      ...(locators && { locators }),
      ...(intent && { intent }),
      ...(screenshotBase64 && { _screenshotBase64: screenshotBase64 }),
    };
    // Purge null/undefined from params
    Object.keys(step.params).forEach(k => {
      if (step.params[k] === undefined || step.params[k] === null) {
        delete step.params[k];
      }
    });
    recording.steps.push(step);
    log(`[${session.id}] Auto-recorded step: ${command} via ${id} (${recording.steps.length} steps total)`);

    // Update overlay with new action count — on this session's tab, not whichever
    // window happens to have focus.
    import('./websocket.js').then(({ pushOverlayState }) => {
      pushOverlayState(null, {
        mode: 'recording',
        updateOnly: true,
        step: recording.steps.length,
        stepName: intent || command
      }, session.lastTabId ?? null);
    }).catch(() => {});
  }

  return id;
}
