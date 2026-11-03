// Test execution engine

import { log } from './logger.js';
import { db } from './db.js';
import { loadTest, fillStepPages } from './test-store.js';
import { computeVariables, resolveValues } from './values.js';
import { isServerStep, keptNames, runServerStep } from './server-steps.js';
import { datasetOfTest, datasetRows, rowLabel } from './datasets.js';
import { readUploadFiles, uploadPathsOf } from './upload-files.js';
import { diagnoseFailure } from './triage.js';
import { saveRepairs } from './repairs.js';
import { requirementsOfTest } from './requirements.js';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSERTION_SCREENSHOTS_DIR = join(__dirname, '..', 'data', 'assertion-screenshots');

/**
 * Assertion types supported:
 *  - element_exists:     { selector } — element must exist in DOM
 *  - element_not_exists: { selector } — element must NOT exist
 *  - element_visible:    { selector } — element must be visible
 *  - element_hidden:     { selector } — element must be hidden or absent
 *  - text_equals:        { selector, expected } — element text === expected
 *  - text_contains:      { selector, expected } — element text includes expected
 *  - attribute_equals:   { selector, attribute, expected } — element attribute === expected
 *  - url_equals:         { expected } — current URL === expected
 *  - url_contains:       { expected } — current URL includes expected
 *  - title_equals:       { expected } — page title === expected
 *  - title_contains:     { expected } — page title includes expected
 *  - element_count:      { selector, expected } — number of matching elements === expected (number)
 */

function formatAssertionActual(actual) {
  if (actual === null || actual === undefined) return 'nothing';
  if (typeof actual === 'string') {
    const normalized = actual.trim();
    return normalized ? `"${normalized}"` : 'an empty string';
  }
  return String(actual);
}

function buildAssertionFailureMessage(assertion, result) {
  const selector = assertion.selector ? ` for selector "${assertion.selector}"` : '';

  switch (assertion.type) {
    case 'element_exists':
      return `Assertion failed: expected an element matching "${assertion.selector}" to exist, but it was not found.`;
    case 'element_not_exists':
      return `Assertion failed: expected no element matching "${assertion.selector}", but one was found.`;
    case 'element_visible':
      return `Assertion failed: expected the element matching "${assertion.selector}" to be visible, but it was hidden or missing.`;
    case 'element_hidden':
      return `Assertion failed: expected the element matching "${assertion.selector}" to be hidden, but it was visible.`;
    case 'text_equals':
      return `Assertion failed: expected text${selector} to equal "${result.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'text_contains':
      return `Assertion failed: expected text${selector} to contain "${assertion.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'attribute_equals':
      return `Assertion failed: expected attribute "${assertion.attribute}"${selector} to equal "${result.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'url_equals':
      return `Assertion failed: expected the current URL to equal "${result.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'url_contains':
      return `Assertion failed: expected the current URL to contain "${assertion.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'title_equals':
      return `Assertion failed: expected the page title to equal "${result.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'title_contains':
      return `Assertion failed: expected the page title to contain "${assertion.expected}", but got ${formatAssertionActual(result.actual)}.`;
    case 'element_count':
      return `Assertion failed: expected ${result.expected} element(s) matching "${assertion.selector}", but found ${formatAssertionActual(result.actual)}.`;
    case 'no_console_errors':
      return `Assertion failed: the page logged ${assertion.expected ? `an error containing "${assertion.expected}"` : 'errors'}: ${result.actual}.`;
    case 'no_failed_requests':
      return `Assertion failed: ${assertion.expected ? `a request to "${assertion.expected}"` : 'a request'} failed: ${result.actual}.`;
    case 'link_ok':
      return `Assertion failed: the link ${assertion.selector} does not answer: ${result.actual}.`;
    case 'no_a11y_violations':
      return `Assertion failed: the page breaks ${assertion.expected ? `the accessibility rule "${assertion.expected}"` : 'accessibility rules'}: ${result.actual}.`;
    case 'visual_match':
      return `Assertion failed: Visual Regression Test failed. Expected difference ${result.expected}, but got ${result.actual}. Please check the latest state.`;
    default:
      return `Assertion failed: expected ${result.expected}, but got ${formatAssertionActual(result.actual)}.`;
  }
}

async function saveAssertionFailureScreenshot(dataUrl, executionId, stepOrder) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;

  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) {
    log(`Failed to persist assertion screenshot for execution #${executionId}, step ${stepOrder}: unsupported data URL format`);
    return null;
  }

  const [, extension, base64Payload] = match;
  const executionDir = join(ASSERTION_SCREENSHOTS_DIR, String(executionId));
  const fileName = `step-${stepOrder}-${Date.now()}.${extension === 'jpeg' ? 'jpg' : extension}`;
  const filePath = join(executionDir, fileName);

  try {
    await mkdir(executionDir, { recursive: true });
    await writeFile(filePath, Buffer.from(base64Payload, 'base64'));
    return `/assertion-screenshots/${executionId}/${fileName}`;
  } catch (err) {
    log(`Failed to persist assertion screenshot for execution #${executionId}, step ${stepOrder}: ${err.message}`);
    return null;
  }
}

async function captureAssertionFailureScreenshot(sendCommand, executionId, stepOrder, tabId) {
  try {
    const params = { annotate: false };
    if (tabId) params.tabId = tabId;
    const screenshot = await sendCommand(undefined, 'screenshot', params, 30000);
    return await saveAssertionFailureScreenshot(screenshot?.dataUrl || null, executionId, stepOrder);
  } catch (err) {
    log(`Failed to capture assertion screenshot: ${err.message}`);
    return null;
  }
}

/**
 * Execute steps one-by-one with debug controller pause gates.
 * Each step is sent as a single-element replay_sequence to the extension,
 * allowing the debug controller to pause between steps.
 */
async function executeStepsInDebugMode(
  actionSteps, startIndex, newWindow, sendCommand,
  debugController, executionId, hydratedSteps,
  onProgress, streamedStepResults,
  viewportWidth, viewportHeight, server = null
) {
  const overallStartedAt = Date.now();
  const results = [];
  let failed = false;
  let lastTabId = null;

  for (let actionIndex = 0; actionIndex < actionSteps.length; actionIndex++) {
    if (actionIndex < startIndex) continue;

    const step = actionSteps[actionIndex];
    const stepNumber = step._originalStepNumber || (actionIndex + 1);

    // Pause gate: blocks until resume/step/continue signal
    try {
      await debugController.waitIfPaused(stepNumber, (pauseInfo) => {
        if (onProgress) {
          onProgress({
            type: 'step_paused',
            step: stepNumber,
            command: step.command,
            intent: step.intent || null,
            breakpoints: pauseInfo.breakpoints,
          });
        }
      });
    } catch (abortError) {
      log(`Debug execution aborted at step ${stepNumber}`);
      failed = true;
      break;
    }

    // Emit step_start
    if (onProgress) {
      onProgress({
        type: 'step_start',
        step: stepNumber,
        command: step.command,
        intent: step.intent || null,
      });
    }

    // A server step (capture, http) runs here; a browser step gets the values kept so far.
    if (server && isServerStep(step)) {
      const stepResult = await playServerStep(step, stepNumber, { sendCommand, tabId: lastTabId, server });
      results.push(stepResult);
      streamedStepResults.push(stepResult);
      try { persistStepResult(executionId, stepResult); } catch (persistErr) { log(`Failed to live-persist step ${stepNumber}: ${persistErr.message}`); }
      if (onProgress) onProgress({ type: 'step_complete', stepResult });
      if (stepResult.status === 'failed') { failed = true; break; }
      continue;
    }

    // Execute single step via replay_sequence with one element
    const singleStepParams = {
      steps: [server ? server.rehydrate(step) : step],
      startIndex: 0,
      newWindow: actionIndex === startIndex ? newWindow : false,
      ...(actionIndex === startIndex && viewportWidth && viewportHeight ? { viewportWidth, viewportHeight } : {}),
    };
    if (lastTabId) {
      singleStepParams.tabId = lastTabId;
    }

    try {
      const singleResult = await sendCommand(
        undefined, 'replay_sequence', singleStepParams, 120000
      );

      const stepResult = singleResult.results?.[0];
      if (stepResult) {
        // Remap step number to the original global step number
        stepResult.step = stepNumber;
        results.push(stepResult);
        streamedStepResults.push(stepResult);

        if (stepResult.tabId) {
          lastTabId = stepResult.tabId;
        }

        try {
          persistStepResult(executionId, stepResult);
        } catch (persistErr) {
          log(`Failed to live-persist step ${stepNumber}: ${persistErr.message}`);
        }

        if (onProgress) {
          onProgress({ type: 'step_complete', stepResult });
        }

        if (stepResult.status === 'failed') {
          failed = true;
          break;
        }
      }
    } catch (err) {
      const errorResult = {
        step: stepNumber,
        status: 'failed',
        error: err.message,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
      };
      results.push(errorResult);
      streamedStepResults.push(errorResult);

      try {
        persistStepResult(executionId, errorResult);
      } catch (persistErr) {
        log(`Failed to live-persist failed step ${stepNumber}: ${persistErr.message}`);
      }

      if (onProgress) {
        onProgress({ type: 'step_complete', stepResult: errorResult });
      }

      failed = true;
      break;
    }
  }

  return {
    results,
    startedAt: overallStartedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - overallStartedAt,
    _failed: failed,
  };
}

/** Runs a server step (lib/server-steps.js) of the run: its result, as the extension gives a step's. */
async function playServerStep(step, stepNumber, { sendCommand, tabId, server }) {
  const startedAt = Date.now();
  const done = (status, extra) => ({
    step: stepNumber, command: step.command, intent: step.intent ?? null, status,
    startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, ...(tabId ? { tabId } : {}), ...extra,
  });
  try {
    const { detail, kept } = await runServerStep(server.rehydrate(step), { sendCommand, tabId, state: server.state });
    if (kept) server.keep(kept.name, kept.value);
    log(`Server step ${stepNumber} (${step.command}): ${detail}`);
    return done('success', { detail });
  } catch (err) {
    return done('failed', { error: err.message });
  }
}

/**
 * Plays a test holding server steps: the browser's steps sent in segments, each with the
 * values kept so far, in the window the one before used; the server's steps in between.
 */
async function executeInSegments(
  actionSteps, startIndex, newWindow, sendCommand, executionId,
  onProgress, streamedStepResults, viewportWidth, viewportHeight, server
) {
  const startedAt = Date.now();
  const results = [];
  let failed = false;
  let lastTabId = null;
  let first = true;
  const record = (stepResult) => {
    results.push(stepResult);
    streamedStepResults.push(stepResult);
    try { persistStepResult(executionId, stepResult); } catch (err) { log(`Failed to live-persist step ${stepResult.step}: ${err.message}`); }
  };

  for (let i = 0; i < startIndex; i++) {
    results.push({ step: actionSteps[i]._originalStepNumber, command: actionSteps[i].command, intent: actionSteps[i].intent, status: 'skipped' });
  }

  let i = startIndex;
  while (i < actionSteps.length && !failed) {
    if (isServerStep(actionSteps[i])) {
      const step = actionSteps[i++];
      if (onProgress) onProgress({ type: 'step_start', step: step._originalStepNumber, command: step.command, intent: step.intent || null });
      const stepResult = await playServerStep(step, step._originalStepNumber, { sendCommand, tabId: lastTabId, server });
      record(stepResult);
      if (onProgress) onProgress({ type: 'step_complete', stepResult });
      failed = stepResult.status === 'failed';
      continue;
    }

    const segment = [];
    while (i < actionSteps.length && !isServerStep(actionSteps[i])) segment.push(actionSteps[i++]);
    const numberOf = (n) => segment[n - 1]?._originalStepNumber ?? n;
    let steps;
    try {
      steps = segment.map((step) => server.rehydrate(step));
    } catch (err) {
      record({ step: segment[0]._originalStepNumber, command: segment[0].command, status: 'failed', error: err.message, startedAt: Date.now(), finishedAt: Date.now(), durationMs: 0 });
      failed = true;
      break;
    }
    let played;
    try {
      played = await sendCommand(undefined, 'replay_sequence', {
        steps, startIndex: 0, newWindow: first ? newWindow : false,
        ...(lastTabId ? { tabId: lastTabId } : {}),
        ...(first && viewportWidth && viewportHeight ? { viewportWidth, viewportHeight } : {}),
      }, 120000, async (raw) => {
        if (raw?.type === 'step_start') { if (onProgress) onProgress({ ...raw, step: numberOf(raw.step) }); return; }
        if (raw?.type === 'step_complete' && raw.stepResult) {
          const stepResult = { ...raw.stepResult, step: numberOf(raw.stepResult.step) };
          streamedStepResults.push(stepResult);
          try { persistStepResult(executionId, stepResult); } catch (err) { log(`Failed to live-persist step ${stepResult.step}: ${err.message}`); }
          if (onProgress) onProgress({ ...raw, stepResult });
          return;
        }
        if (onProgress) onProgress(raw);
      });
    } catch (err) {
      played = { results: err.results || [] };
      failed = true;
    }
    first = false;
    for (const result of played?.results ?? []) {
      const stepResult = { ...result, step: numberOf(result.step) };
      results.push(stepResult);
      if (stepResult.tabId) lastTabId = stepResult.tabId;
      if (stepResult.status === 'failed') failed = true;
    }
  }

  return { results, startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, _failed: failed };
}

/**
 * The steps the extension plays — every one but the assertions, checked here afterwards —
 * each with its number in the test, and where to start among them. The extension numbers
 * the steps it is given: an assertion in the middle of a test shifted every step after it,
 * and a failure was reported (and repaired) one step off.
 */
export function actionPlan(steps, startStep) {
  const actions = [];
  steps.forEach((step, i) => { if (step.command !== 'assert') actions.push({ ...step, _originalStepNumber: i + 1 }); });
  const first = startStep > 0 ? startStep - 1 : 0;
  const startIndex = actions.findIndex((step) => step._originalStepNumber - 1 >= first);
  return { actions, startIndex: startIndex < 0 ? actions.length : startIndex };
}

/**
 * Run a saved test. `options.test` runs that test instead of the saved one under `name` —
 * a repair being checked (lib/repairs.js) — and a failure is diagnosed (lib/triage.js)
 * except in such a check or in debug mode. `options.campaignId`: the run is part of that
 * campaign (lib/campaigns.js).
 */
export async function executeTest(name, variables, substitutions, start_step, new_window, sendCommand, trigger = 'manual', onProgress = null, debugController = null, options = {}) {
  const test = options.test ?? loadTest(name);
  if (!test) {
    throw new Error(`Test "${name}" not found.`);
  }

  // Extract viewport dimensions from test metadata
  const viewportWidth = test.viewport?.width || null;
  const viewportHeight = test.viewport?.height || null;

  // Merge default variable values with caller-supplied overrides
  const rawVariables = {};
  if (test.variables) {
    for (const [key, info] of Object.entries(test.variables)) {
      rawVariables[key] = String(info.defaultValue ?? '');
    }
  }
  // Bound to a dataset (lib/datasets.js), the test plays one of its rows — the first unless
  // told: each column is a variable of the run, over the defaults.
  const dataset = options.test ? null : datasetOfTest(name);
  const dataRow = dataset ? Number(options.row ?? 1) : null;
  if (dataset) {
    const row = dataset.rows[dataRow - 1];
    if (!row) throw new Error(`The dataset "${dataset.name}" has ${dataset.rows.length} row(s), numbered from 1: no row ${options.row}`);
    for (const [key, value] of Object.entries(row)) rawVariables[key] = String(value ?? '');
    log(`Test "${name}" plays ${rowLabel(row, dataRow)} of the dataset "${dataset.name}"`);
  }
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      rawVariables[key] = String(value ?? '');
    }
  }
  // Computed values ({{today + 3 days | dd/MM/yyyy}}, {{unique}}, {{price * 1.2}}) worked out
  // once for the run, in the language of the test's project (lib/values.js). One that does not
  // work out stops the run here, told: typed as it is, it would fail further on, unexplained.
  const projectData = datasetRows(test.project_id);
  const computed = computeVariables(rawVariables, { language: test.language, datasets: (key) => projectData[key] });
  const mergedVariables = computed.values;
  const valueProblems = [...computed.problems];
  // Values kept by steps of the run (capture): known by name now, given to the steps after.
  const kept = keptNames(test.steps);
  computed.context.lookup = (key) => mergedVariables[key];
  const waiting = () => new Set([...kept].filter((key) => !(key in mergedVariables)));
  log(`Merged variables: ${JSON.stringify(mergedVariables)}`);

  const applySubstitutions = (str) => {
    let result = str;
    // Filled into the step's JSON: escaped, or a value with a quote or a backslash (a
    // password, an expected text) made it invalid and the replay crashed.
    for (const [key, value] of Object.entries(mergedVariables)) {
      result = result.replaceAll(`{{${key}}}`, JSON.stringify(value).slice(1, -1));
    }
    if (substitutions) {
      for (const [oldVal, newVal] of Object.entries(substitutions)) {
        result = result.replaceAll(oldVal, newVal);
      }
    }
    // An expression written in the step itself, with the same values as the variables.
    const resolved = resolveValues(result, computed.context, { escape: (value) => JSON.stringify(value).slice(1, -1), waiting: waiting() });
    valueProblems.push(...resolved.problems);
    return resolved.text;
  };

  const hydratedSteps = test.steps.map(step => {
    const hydratedStep = JSON.parse(applySubstitutions(JSON.stringify(step)));

    if (hydratedStep.variable && hydratedStep.variable.listContext) {
      const varName = hydratedStep.variable.name;
      const varValue = mergedVariables[varName];

      if (varValue !== undefined) {
        hydratedStep.variableResolve = {
          parentSelector: hydratedStep.variable.listContext.parentSelector,
          itemXpath: hydratedStep.variable.listContext.itemXpath,
          selectionMode: hydratedStep.variable.listContext.selectionMode,
          value: varValue
        };
        log(`Variable "${varName}" resolved: select ${hydratedStep.variable.listContext.selectionMode} = "${varValue}" in ${hydratedStep.variable.listContext.type}`);
      }
    }
    return hydratedStep;
  });

  if (valueProblems.length) {
    throw new Error(`Computed values that do not work out — fix them in the test (Data, or its steps):\n${[...new Set(valueProblems)].join('\n')}`);
  }

  // What the server steps of the run need (lib/server-steps.js): a step given the values kept so
  // far just before it is played, and where to keep a new one.
  const server = {
    state: {},
    rehydrate(step) {
      const before = valueProblems.length;
      const fresh = JSON.parse(applySubstitutions(JSON.stringify(step)));
      if (valueProblems.length > before) throw new Error(`Computed values that do not work out:\n${valueProblems.slice(before).join('\n')}`);
      return fresh;
    },
    keep(key, value) { mergedVariables[key] = value; },
  };
  const withServerSteps = test.steps.some(isServerStep);

  // An upload sends the files' content, read here: the extension cannot read the disk.
  for (const step of hydratedSteps) {
    if (step.command === 'upload') step.params.fileData = await readUploadFiles(uploadPathsOf(step.params));
  }

  // ─── Get test ID for FK reference ──────────────────────────
  const testRow = db.prepare('SELECT id FROM tests WHERE name = ?').get(name);
  if (!testRow) throw new Error(`Test "${name}" not found in database.`);
  const testId = testRow.id;

  // Count assertion steps
  const assertionSteps = hydratedSteps.filter(s => s.command === 'assert');
  const assertionsTotal = assertionSteps.length;

  // ─── Create execution record ──────────────────────────────────
  const execResult = db.prepare(
    `INSERT INTO test_executions (test_id, test_name, status, total_steps, variables, new_window, trigger, assertions_total, campaign_id, data_row)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(testId, name, hydratedSteps.length, JSON.stringify(mergedVariables), new_window ? 1 : 0, trigger, assertionsTotal, options.campaignId ?? null, dataRow);
  const executionId = execResult.id;

  // ─── Initialize pending step rows ─────────────────────────────
  const insertStep = db.prepare(
    `INSERT INTO execution_steps (execution_id, step_order, command, intent, status)
     VALUES (?, ?, ?, ?, 'pending')`
  );
  for (let i = 0; i < hydratedSteps.length; i++) {
    const step = hydratedSteps[i];
    insertStep.run(executionId, i + 1, step.command, step.intent || null);
  }

  const isDebugMode = debugController !== null;
  log(`Execution #${executionId} created for test "${name}" (${hydratedSteps.length} steps, ${assertionsTotal} assertions, trigger: ${trigger}${isDebugMode ? ', DEBUG MODE' : ''})`);

  // Register debug controller with this execution
  if (isDebugMode) {
    debugController.register(executionId);
  }

  if (onProgress) {
    onProgress({
      type: 'execution_started',
      executionId,
      testName: name,
      totalSteps: hydratedSteps.length,
      debugMode: isDebugMode,
      breakpoints: isDebugMode ? debugController.breakpoints : [],
    });
  }

  // ─── Send to extension and process results ────────────────────
  // Filter out assertion steps — the extension only handles browser actions
  const { actions: actionSteps, startIndex } = actionPlan(hydratedSteps, start_step);
  const testOrder = (n) => actionSteps[n - 1]?._originalStepNumber ?? n;
  const numbered = (msg) => {
    if (msg?.type === 'step_start') return { ...msg, step: testOrder(msg.step) };
    if (msg?.type === 'step_complete' && msg.stepResult) return { ...msg, stepResult: { ...msg.stepResult, step: testOrder(msg.stepResult.step) } };
    return msg;
  };

  let extensionResult;
  let executionFailed = false;
  // Accumulate step results from the streaming callback because
  // when replay_sequence throws, err.results is often empty.
  const streamedStepResults = [];

  if (isDebugMode) {
    // ─── Debug mode: step-by-step execution ──────────────────────
    extensionResult = await executeStepsInDebugMode(
      actionSteps, startIndex, new_window, sendCommand,
      debugController, executionId, hydratedSteps,
      onProgress, streamedStepResults,
      viewportWidth, viewportHeight, server
    );
    executionFailed = extensionResult._failed || false;
    delete extensionResult._failed;
  } else if (withServerSteps) {
    // ─── Server steps: the browser's steps in segments, the server's in between ──
    extensionResult = await executeInSegments(
      actionSteps, startIndex, new_window, sendCommand, executionId,
      onProgress, streamedStepResults, viewportWidth, viewportHeight, server
    );
    executionFailed = extensionResult._failed || false;
    delete extensionResult._failed;
  } else {
    // ─── Normal mode: bulk replay_sequence ───────────────────────
    try {
      extensionResult = await sendCommand(undefined, 'replay_sequence', {
        steps: actionSteps, startIndex, newWindow: new_window,
        ...(viewportWidth && viewportHeight ? { viewportWidth, viewportHeight } : {})
      }, 120000, async (raw) => {
        const msg = numbered(raw);
        if (onProgress) onProgress(msg);

        if (msg.type === 'step_complete' && msg.stepResult) {
          streamedStepResults.push(msg.stepResult);
          try {
            persistStepResult(executionId, msg.stepResult);
          } catch (err) {
            log(`Failed to live-persist step ${msg.stepResult.step}: ${err.message}`);
          }
        }
      });
    } catch (err) {
      executionFailed = true;
      extensionResult = {
        results: err.results || [],
        startedAt: err.startedAt || Date.now(),
        finishedAt: err.finishedAt || Date.now(),
        durationMs: err.durationMs || 0
      };
    }
    extensionResult.results = (extensionResult.results ?? []).map((result) => ({ ...result, step: testOrder(result.step) }));
  }

  // ─── Evaluate assertion steps ─────────────────────────────────
  let assertionsPassed = 0;
  let assertionsFailed = 0;
  let firstFailedAssertion = null;
  const assertionStepResults = [];
  // Prefer extensionResult.results when available (success path),
  // fall back to streamed results captured from progress callbacks (error path).
  const stepResults = (extensionResult.results && extensionResult.results.length > 0)
    ? extensionResult.results
    : streamedStepResults;
  const assertionTabId = [...stepResults].reverse().find((stepResult) => stepResult?.tabId)?.tabId;

  if (!executionFailed) {
    for (let i = 0; i < hydratedSteps.length; i++) {
      if (hydratedSteps[i].command !== 'assert' || !hydratedSteps[i].assertion) continue;
      // With the values the run kept by then (a captured order number, say).
      let step = hydratedSteps[i];
      if (withServerSteps) {
        try { step = server.rehydrate(step); } catch (err) { log(err.message); }
      }

      const stepOrder = i + 1;
      const startedAt = Date.now();
      let assertionResult;

      try {
        assertionResult = await evaluateAssertion(sendCommand, step.assertion, assertionTabId);
      } catch (err) {
        assertionResult = { passed: false, expected: step.assertion.expected || '', actual: `Error: ${err.message}`, type: step.assertion.type };
      }

      if (assertionResult.passed) {
        assertionsPassed++;
        if (assertionResult.isVrt && assertionResult.actualDataUrl) {
          const screenshotUrl = await saveAssertionFailureScreenshot(assertionResult.actualDataUrl, executionId, stepOrder);
          assertionResult = { ...assertionResult, screenshotUrl, refScreenshotUrl: '/' + step.assertion.expected };
        }
      } else {
        assertionsFailed++;
        const failureMessage = buildAssertionFailureMessage(step.assertion, assertionResult);
        let screenshotUrl;
        if (assertionResult.isVrt && assertionResult.actualDataUrl) {
          screenshotUrl = await saveAssertionFailureScreenshot(assertionResult.actualDataUrl, executionId, stepOrder);
          assertionResult = { ...assertionResult, message: failureMessage, screenshotUrl, refScreenshotUrl: '/' + step.assertion.expected };
        } else {
          screenshotUrl = await captureAssertionFailureScreenshot(sendCommand, executionId, stepOrder, assertionTabId);
          assertionResult = { ...assertionResult, message: failureMessage, screenshotUrl };
        }
        if (!firstFailedAssertion) {
          firstFailedAssertion = { stepOrder, message: failureMessage };
        }
      }

      const finishedAt = Date.now();
      const stepError = assertionResult.passed ? null : assertionResult.message;
      assertionStepResults.push({
        step: stepOrder,
        command: 'assert',
        intent: step.intent || `Assert: ${step.assertion.type}`,
        status: assertionResult.passed ? 'success' : 'failed',
        error: stepError,
        assertionResult
      });

      // Persist assertion result
      db.prepare(
        `UPDATE execution_steps SET
          status = ?,
          started_at = ?,
          finished_at = ?,
          duration_ms = ?,
          error = ?,
          assertion_result = ?
         WHERE execution_id = ? AND step_order = ?`
      ).run(
        assertionResult.passed ? 'success' : 'failed',
        new Date(startedAt).toISOString(),
        new Date(finishedAt).toISOString(),
        finishedAt - startedAt,
        stepError,
        JSON.stringify(assertionResult),
        executionId,
        stepOrder
      );

      if (onProgress) {
        onProgress({
          type: 'assertion_result',
          stepOrder,
          intent: step.intent || `Assert: ${step.assertion.type}`,
          assertion: step.assertion,
          result: assertionResult
        });
      }
    }
  }

  // ─── Persist final step results ───────────────────────────────
  let completedCount = 0;
  let failedStepOrder = null;
  let globalError = null;

  for (const stepResult of stepResults) {
    const status = stepResult.status || 'pending';
    if (status === 'success') completedCount++;
    if (status === 'failed' && !failedStepOrder) {
      failedStepOrder = stepResult.step;
      globalError = stepResult.error;
    }
    persistStepResult(executionId, stepResult);
  }
  // The page each step ran on, and each assertion was checked on: one recorded before steps
  // kept theirs gets it now.
  try {
    const assertionPages = assertionStepResults.map((result) => ({ ...result, pageUrl: result.assertionResult?.pageUrl }));
    fillStepPages(testId, [...stepResults, ...assertionPages]);
  } catch (err) {
    log(`Could not keep the pages of the steps of "${name}": ${err.message}`);
  }

  if (!failedStepOrder && firstFailedAssertion) {
    failedStepOrder = firstFailedAssertion.stepOrder;
  }

  // ─── Cleanup debug controller ──────────────────────────────────
  if (debugController) {
    debugController.unregister();
  }

  // ─── Finalize execution record ────────────────────────────────
  const finalStatus = executionFailed ? 'failed' : (assertionsFailed > 0 ? 'failed' : 'success');
  if (assertionsFailed > 0 && !globalError) {
    globalError = firstFailedAssertion?.message || `${assertionsFailed} assertion(s) failed`;
  }
  db.prepare(
    `UPDATE test_executions SET
      status = ?,
      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      duration_ms = ?,
      completed_steps = ?,
      failed_step = ?,
      error = ?,
      assertions_passed = ?,
      assertions_failed = ?
     WHERE id = ?`
  ).run(finalStatus, extensionResult.durationMs || null, completedCount, failedStepOrder, globalError, assertionsPassed, assertionsFailed, executionId);

  log(`Execution #${executionId} finalized: ${finalStatus} (${completedCount}/${hydratedSteps.length} steps, assertions: ${assertionsPassed}/${assertionsTotal} passed, ${extensionResult.durationMs}ms)`);

  import('./websocket.js').then(({ pushOverlayState }) => {
    pushOverlayState(null, {
      mode: finalStatus === 'success' ? 'success' : 'failed',
      error: finalStatus === 'success' ? 'Sequence completed gracefully.' : (globalError || 'Assertion failed')
    }, assertionTabId);
  }).catch(() => {});

  // Why it failed, on the page it failed on, and what would repair it: kept with the run.
  let triage = null;
  // Not a repair being checked, nor a bug's test confirming the bug: those failures are expected.
  if (finalStatus === 'failed' && failedStepOrder && !isDebugMode && trigger !== 'repair' && trigger !== 'explore') {
    triage = await triageRun({
      name, test, executionId, failedStepOrder, globalError, stepResults, assertionStepResults,
      hydratedSteps, tabId: assertionTabId, sendCommand, values: mergedVariables, runOptions: { variables, substitutions },
    });
  }

  if (finalStatus === 'failed') {
    const error = new Error(globalError || 'Test execution failed');
    error.executionId = executionId;
    if (triage) error.triage = triage;
    error.status = finalStatus;
    error.durationMs = extensionResult.durationMs || null;
    error.failedStep = failedStepOrder;
    error.totalSteps = hydratedSteps.length;
    error.completedSteps = completedCount;
    error.assertionsTotal = assertionsTotal;
    error.assertionsPassed = assertionsPassed;
    error.assertionsFailed = assertionsFailed;
    error.stepResults = [
      ...stepResults.map(sr => ({
        step: sr.step,
        command: hydratedSteps[(sr.step || 1) - 1]?.command || sr.command || '?',
        intent: hydratedSteps[(sr.step || 1) - 1]?.intent || sr.intent || '',
        status: sr.status,
        error: sr.error || null
      })),
      ...assertionStepResults
    ].sort((left, right) => (left.step || 0) - (right.step || 0));
    // What this replay typed, and the tab it ended in: add_assertion links on them.
    error.values = mergedVariables;
    error.tabId = stepResults.findLast((sr) => sr.tabId != null)?.tabId;
    if (failedStepOrder) {
      const failedStepData = hydratedSteps[failedStepOrder - 1];
      error.failedStepCommand = failedStepData?.command;
      error.failedStepIntent = failedStepData?.intent;
    }
    throw error;
  }

  return { ...extensionResult, executionId, assertionsPassed, assertionsFailed, assertionsTotal, values: mergedVariables };
}

/** Assertions on what the page does wrong on its own, not on an element's text or state. */
export const ORACLE_ASSERTIONS = new Set(['no_console_errors', 'no_failed_requests', 'link_ok', 'no_a11y_violations']);

/**
 * Evaluate an oracle assertion on the tab: the errors it logged, the requests it failed (each
 * containing `expected` when given), a link's answer, the accessibility rule `expected`.
 */
async function evaluateOracle(sendCommand, assertion, tabId) {
  const { type, expected, selector } = assertion;
  const at = tabId ? { tabId } : {};
  const matches = (text) => !expected || String(text).includes(expected);
  const listed = (items) => items.length ? items.join(' | ') : 'none';
  switch (type) {
    case 'no_console_errors': {
      const { messages = [] } = await sendCommand(undefined, 'console_messages', at);
      const errors = messages.filter((m) => matches(m.text)).map((m) => m.text);
      return { passed: errors.length === 0, expected: expected ? `no error containing "${expected}"` : 'no console error', actual: listed(errors), type };
    }
    case 'no_failed_requests': {
      const { requests = [] } = await sendCommand(undefined, 'network_requests', { ...at, limit: 300 });
      const failed = requests.filter((r) => (r.status >= 400 || r.status === 0) && !/favicon/i.test(r.url) && matches(r.url))
        .map((r) => `${r.method} ${r.url} → ${r.status || 'no response'}`);
      return { passed: failed.length === 0, expected: expected ? `no failed request to "${expected}"` : 'no failed request', actual: listed(failed), type };
    }
    case 'link_ok': {
      const { links = [] } = await sendCommand(undefined, 'check_links', { ...at, selector });
      if (!links.length) return { passed: false, expected: 'the link answers', actual: `no link to this site's pages matches ${selector}`, type };
      const broken = links.filter((l) => l.status >= 400 || l.status === 0).map((l) => `${l.href} → ${l.status || l.error || 'no response'}`);
      return { passed: broken.length === 0, expected: 'the link answers', actual: broken.length ? listed(broken) : `${links[0].href} → ${links[0].status}`, type };
    }
    case 'no_a11y_violations': {
      const { violations = [] } = await sendCommand(undefined, 'run_axe', { ...at, ...(expected ? { rules: [expected] } : {}), ...(selector ? { selector } : {}) });
      const found = violations.map((v) => `${v.id}: ${v.count} element(s), e.g. ${v.nodes?.[0]?.target ?? '?'}`);
      return { passed: violations.length === 0, expected: expected ? `no "${expected}" violation` : 'no accessibility violation', actual: listed(found), type };
    }
  }
}

/**
 * Diagnose a failed run (lib/triage.js), keep the diagnosis with the execution and its
 * repairs as proposals (lib/repairs.js). The diagnosis, with each proposal's id.
 */
async function triageRun({ name, test, executionId, failedStepOrder, globalError, stepResults, assertionStepResults, hydratedSteps, tabId, sendCommand, values, runOptions }) {
  const assertion = assertionStepResults.find((result) => result.step === failedStepOrder && result.status === 'failed');
  const action = stepResults.find((result) => result.step === failedStepOrder);
  const hydrated = hydratedSteps[failedStepOrder - 1];
  const failed = assertion
    ? {
      step: failedStepOrder, error: assertion.error, assertionResult: assertion.assertionResult,
      hydratedExpected: hydrated?.assertion?.expected,
      recheck: () => evaluateAssertion(sendCommand, hydrated.assertion, tabId),
    }
    : { step: failedStepOrder, error: action?.error ?? globalError ?? '' };
  const testRow = db.prepare('SELECT id FROM tests WHERE name = ?').get(name);
  const passes = testRow ? db.prepare(
    `SELECT COUNT(*) AS passes, MAX(started_at) AS lastPass FROM test_executions WHERE test_id = ? AND status = 'success' AND trigger != 'repair' AND id < ?`
  ).get(testRow.id, executionId) : { passes: 0, lastPass: null };
  const failedTab = action?.tabId ?? tabId;

  const startedAt = Date.now();
  const diagnosis = await diagnoseFailure({ stored: test, failed, tabId: failedTab, sendCommand, values, history: passes, requirements: requirementsOfTest(name) });
  const ids = saveRepairs(name, executionId, diagnosis, runOptions, test);
  const triage = { ...diagnosis, proposals: diagnosis.proposals.map((proposal, i) => ({ id: ids[i], ...proposal, change: undefined })) };
  db.prepare('UPDATE test_executions SET triage = ? WHERE id = ?').run(JSON.stringify(triage), executionId);
  log(`Execution #${executionId} triaged in ${Date.now() - startedAt}ms: ${triage.cause} (${triage.confidence}), ${ids.length} repair(s) proposed`);
  return triage;
}

/**
 * What a whole page shows, for a check of a phrase in it: where the phrase is, when it is
 * there; otherwise the page's text, cut short.
 */
function pageExcerpt(text, expected) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = expected ? flat.indexOf(expected) : -1;
  if (at >= 0) return `the page: …${flat.slice(Math.max(0, at - 60), at + expected.length + 60)}…`;
  return `the page: ${flat.length > 240 ? `${flat.slice(0, 240)}…` : flat}`;
}

/**
 * Evaluate a single assertion by querying the browser.
 * Returns { passed, expected, actual, type }
 */
export async function evaluateAssertion(sendCommand, assertion, tabId) {
  const type = assertion.type;
  const selector = assertion.selector;
  const expected = assertion.expected;

  if (type === 'visual_match') {
    const params = { annotate: false };
    if (tabId) params.tabId = tabId;
    const snap = await sendCommand(undefined, 'screenshot', params, 30000);
    const actualDataUrl = snap?.dataUrl;
    
    let result;
    if (!actualDataUrl) {
      result = { passed: false, expected: expected, actual: 'Failed to capture screenshot', type };
    } else {
      const match = actualDataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
      if (!match || match[1] !== 'png') {
        result = { passed: false, expected: expected, actual: 'Screenshot is not a valid PNG format', type };
      } else {
        try {
          const { readFile, writeFile } = await import('fs/promises');
          const { default: pixelmatch } = await import('pixelmatch');
          const { PNG } = await import('pngjs');
          const path = await import('path');
          
          const actualBuffer = Buffer.from(match[2], 'base64');
          const expectedPath = path.isAbsolute(expected) ? expected : path.join(process.cwd(), expected);
          
          let baselineBuffer;
          try {
            baselineBuffer = await readFile(expectedPath);
          } catch (e) {
            // First run! Save it as baseline!
            await writeFile(expectedPath, actualBuffer);
            result = { passed: true, expected: expected, actual: 'Baseline created successfully', type };
          }

          if (!result) {
            const img1 = PNG.sync.read(baselineBuffer);
            const img2 = PNG.sync.read(actualBuffer);
            
            const { width, height } = img1;
            
            if (img1.width !== img2.width || img1.height !== img2.height) {
              result = { passed: false, expected: `${width}x${height}`, actual: `${img2.width}x${img2.height}`, type, message: "Screenshot dimensions do not match baseline. Run with fixed viewport." };
            } else {
              const diff = new PNG({ width, height });
              const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });
              const diffRatio = numDiffPixels / (width * height);
              
              const vrtConfigThreshold = process.env.VRT_THRESHOLD ? parseFloat(process.env.VRT_THRESHOLD) : 0.001; // 0.1%

              if (diffRatio > vrtConfigThreshold) {
                 result = { passed: false, expected: `<${(vrtConfigThreshold*100).toFixed(2)}% diff`, actual: `${(diffRatio*100).toFixed(2)}% diff`, type };
              } else {
                 result = { passed: true, expected: `<${(vrtConfigThreshold*100).toFixed(2)}% diff`, actual: `${(diffRatio*100).toFixed(2)}% diff`, type };
              }
            }
          }
        } catch (e) {
           result = { passed: false, expected: expected, actual: `VRT Error: ${e.message}`, type };
        }
      }
    }
    
    return { ...result, isVrt: true, actualDataUrl };
  }

  // What the page does wrong on its own (extension/src/commands/checks.ts): a bug's test
  // checks it is gone.
  if (ORACLE_ASSERTIONS.has(type)) return evaluateOracle(sendCommand, assertion, tabId);

  let js;
  switch (type) {
    case 'element_exists':
      js = `!!document.querySelector(${JSON.stringify(selector)})`;
      break;
    case 'element_not_exists':
      js = `!document.querySelector(${JSON.stringify(selector)})`;
      break;
    case 'element_visible': {
      js = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const style = getComputedStyle(el); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0; })()`;
      break;
    }
    case 'element_hidden': {
      js = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return true; const style = getComputedStyle(el); return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || el.offsetWidth === 0; })()`;
      break;
    }
    case 'text_equals':
      js = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent.trim() : null; })()`;
      break;
    // With no selector ("I should see …"), the whole page: as the exported code checks it, in body.
    case 'text_contains':
    case 'text_not_contains':
      js = `(() => { const el = document.querySelector(${JSON.stringify(selector || 'body')}); return el ? el.textContent.trim() : null; })()`;
      break;
    case 'attribute_equals':
      // A field's "value" is what it holds now, as Playwright's toHaveValue reads it: the
      // attribute is only the value it started with (null for a field the test filled).
      js = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const attr = ${JSON.stringify(assertion.attribute || '')}; return attr === 'value' && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.value : el.getAttribute(attr); })()`;
      break;
    case 'url_equals':
    case 'url_contains':
      js = `window.location.href`;
      break;
    case 'title_equals':
    case 'title_contains':
      js = `document.title`;
      break;
    case 'element_count':
      js = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
      break;
    default:
      return { passed: false, expected: '', actual: `Unknown assertion type: ${type}`, type };
  }

  // With the URL of the page it is checked on: the assertion keeps its page (lib/elements.js).
  const params = { code: `({ value: ${js}, pageUrl: location.href })` };
  if (tabId) params.tabId = tabId;
  const result = await sendCommand(undefined, 'execute_js', params);
  const answer = result?.result !== undefined ? result.result : result;
  const checked = judgeAssertion(assertion, answer?.value);
  return typeof answer?.pageUrl === 'string' ? { ...checked, pageUrl: answer.pageUrl } : checked;
}

/** Whether `value`, read from the page, is what `assertion` expects. */
function judgeAssertion({ type, selector, expected }, value) {
  // The whole page's text, checked for a phrase: told in a line, not page after page.
  const wholePage = !selector && (type === 'text_contains' || type === 'text_not_contains') && typeof value === 'string';
  const actual = wholePage ? pageExcerpt(value, expected) : value;

  switch (type) {
    case 'element_exists':
    case 'element_not_exists':
    case 'element_visible':
    case 'element_hidden':
      return { passed: actual === true, expected: 'true', actual: String(actual), type };
    case 'text_equals':
      return { passed: actual === expected, expected, actual: actual ?? '(element not found)', type };
    case 'text_contains':
      if (wholePage) return { passed: value.includes(expected), expected: `contains "${expected}"`, actual, type };
      return { passed: typeof actual === 'string' && actual.includes(expected), expected: `contains "${expected}"`, actual: actual ?? '(element not found)', type };
    // The element has to be there: a result panel that never showed up contains nothing,
    // and passing on it would hide the failure.
    case 'text_not_contains':
      if (wholePage) return { passed: !value.includes(expected), expected: `does not contain "${expected}"`, actual, type };
      return { passed: typeof actual === 'string' && !actual.includes(expected), expected: `does not contain "${expected}"`, actual: actual ?? '(element not found)', type };
    case 'attribute_equals':
      return { passed: actual === expected, expected, actual: actual ?? '(element/attribute not found)', type };
    case 'url_equals':
      return { passed: actual === expected, expected, actual: actual ?? '', type };
    case 'url_contains':
      return { passed: typeof actual === 'string' && actual.includes(expected), expected: `contains "${expected}"`, actual: actual ?? '', type };
    case 'title_equals':
      return { passed: actual === expected, expected, actual: actual ?? '', type };
    case 'title_contains':
      return { passed: typeof actual === 'string' && actual.includes(expected), expected: `contains "${expected}"`, actual: actual ?? '', type };
    case 'element_count': {
      const expectedNum = parseInt(expected, 10);
      return { passed: actual === expectedNum, expected: String(expectedNum), actual: String(actual), type };
    }
    default:
      return { passed: false, expected: '', actual: `Unknown assertion type: ${type}`, type };
  }
}

function persistStepResult(executionId, sr) {
  db.prepare(
    `UPDATE execution_steps SET
      status = ?,
      started_at = ?,
      finished_at = ?,
      duration_ms = ?,
      locator_used = ?,
      error = ?
     WHERE execution_id = ? AND step_order = ?`
  ).run(
    sr.status || 'pending',
    sr.startedAt ? new Date(sr.startedAt).toISOString() : null,
    sr.finishedAt ? new Date(sr.finishedAt).toISOString() : null,
    sr.durationMs || null,
    sr.locator || sr.resolvedVia || null,
    sr.error || null,
    executionId,
    sr.step
  );
}
