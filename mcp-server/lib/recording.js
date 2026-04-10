// In-memory recording state and action history

import { log } from './logger.js';

// ─── Recording State ───────────────────────────────────────────────

let recording = null; // { name, steps: [], startedAt }
let lastRefMap = {};  // ref (@eX) → { selector, text, role, name }

export function getRecording() { return recording; }
export function setRecording(val) { recording = val; }
export function getLastRefMap() { return lastRefMap; }
export function setLastRefMap(val) { lastRefMap = val; }

// ─── Action History ────────────────────────────────────────────────

const actionHistory = new Map();
let actionCounter = 0;

export function getAction(id) { return actionHistory.get(id); }

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

export function saveActionToHistory(command, params, refKey, screenshotBase64, agentIntent) {
  const id = `act_${++actionCounter}`;
  let locators = null;
  const recordParams = { ...params };

  if (refKey && lastRefMap) {
    const key = String(refKey).replace('@', '');
    const refInfo = lastRefMap[key];
    if (refInfo) {
      if (refInfo.selector) recordParams.selector = refInfo.selector;
      if (refInfo.locators && refInfo.locators.length > 0) {
        locators = refInfo.locators;
      }
    }
  }

  actionHistory.set(id, { command, params: recordParams, locators });

  if (actionHistory.size > 100) {
    actionHistory.delete(actionHistory.keys().next().value);
  }

  // Auto-record step when recording is active
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
    log(`Auto-recorded step: ${command} via ${id} (${recording.steps.length} steps total)`);
    
    // Update overlay with new action count
    import('./websocket.js').then(({ pushOverlayState }) => {
      pushOverlayState(null, {
        mode: 'recording',
        updateOnly: true,
        step: recording.steps.length,
        stepName: intent || command
      });
    }).catch(() => {});
  }

  return id;
}

