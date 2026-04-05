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

export function saveActionToHistory(command, params, refKey) {
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
    const step = {
      command,
      params: { ...recordParams },
      ...(locators && { locators }),
    };
    // Purge null/undefined from params
    Object.keys(step.params).forEach(k => {
      if (step.params[k] === undefined || step.params[k] === null) {
        delete step.params[k];
      }
    });
    recording.steps.push(step);
    log(`Auto-recorded step: ${command} via ${id} (${recording.steps.length} steps total)`);
  }

  return id;
}
