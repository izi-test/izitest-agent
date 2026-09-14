// Test recording & replay MCP tools

import { z } from 'zod';
import { log } from '../logger.js';
import {
  getRecording, setRecording,
  getLastRefMap,
  getAction, saveActionToHistory,
  classifyWithLLM, detectListContext,
  loadTest, saveTest, deleteTest as deleteTestDb, listTests as listTestsDb, executeTest,
  updateTestStep, evaluateAssertion
} from '../tests.js';
import { DebugController, activeDebugControllers } from '../debug-controller.js';


// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Derive a meaningful variable name from step locators (label, placeholder, aria).
 * Returns null if no meaningful name can be extracted.
 */
function deriveVarNameFromLocators(step) {
  const locators = step.locators || [];
  const labelTypes = ['label', 'placeholder', 'aria'];
  for (const type of labelTypes) {
    const loc = locators.find(l => l.type === type && l.value);
    if (loc) {
      const name = loc.value
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/[^a-z0-9\s]/g, '')                      // keep alphanum + spaces
        .trim()
        .replace(/\s+/g, '_')                              // spaces → underscores
        .substring(0, 30);
      if (name && name.length >= 2) return name;
    }
  }
  return null;
}

/**
 * Ensure a variable name is unique within the used set.
 * Appends _2, _3, etc. on collision.
 */
function uniqueVarName(baseName, usedNames) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }
  let suffix = 2;
  while (usedNames.has(`${baseName}_${suffix}`)) suffix++;
  const unique = `${baseName}_${suffix}`;
  usedNames.add(unique);
  return unique;
}

/**
 * Remove recovery/parasitic steps that result from error recovery during recording.
 * Detected patterns:
 *  - navigate to same URL as a previous navigate → remove the duplicate + surrounding waits
 *  - Trailing wait steps at the very end (often artifacts)
 */
function cleanRecoverySteps(steps) {
  const cleaned = [...steps];

  // Pass 1: Remove duplicate navigate sequences (wait? → navigate(same URL) → wait?)
  const navigateUrls = new Map(); // url → first step index
  const toRemove = new Set();

  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].command === 'navigate' && cleaned[i].params.url) {
      const url = cleaned[i].params.url;
      if (navigateUrls.has(url)) {
        // Duplicate navigate — mark it and surrounding waits for removal
        toRemove.add(i);
        if (i > 0 && cleaned[i - 1].command === 'wait') toRemove.add(i - 1);
        if (i + 1 < cleaned.length && cleaned[i + 1].command === 'wait') toRemove.add(i + 1);
      } else {
        navigateUrls.set(url, i);
      }
    }
  }

  // Pass 2: Remove trailing wait steps (common recording artifact)
  let last = cleaned.length - 1;
  while (last >= 0 && cleaned[last].command === 'wait' && !toRemove.has(last)) {
    toRemove.add(last);
    last--;
  }

  if (toRemove.size === 0) return cleaned;

  const result = cleaned.filter((_, idx) => !toRemove.has(idx));
  log(`Cleaned ${toRemove.size} parasitic step(s) (${cleaned.length} → ${result.length})`);
  return result;
}

export function registerTestTools(server, { sendCommand }) {

  // --- Tool: start_recording ---
  server.tool(
    'start_recording',
    'Start recording a reusable browser automation test. When the user asks to "record", "save", or "enregistrer" a test/parcours, call this tool FIRST. Every browser action (navigate, click, fill, etc.) is automatically recorded — no need to call record_step. IMPORTANT: Always pass the "intent" parameter on each browser action call (click, fill, navigate, etc.) to describe the FUNCTIONAL purpose of the step (e.g. intent: "Submit the login form"). When done, call stop_recording to save (variable detection runs automatically at save time).',
    {
      name: z.string().describe('Name of the test (used as identifier)'),
      description: z.string().optional().describe('Human-readable description of what the test does'),
      use_vrt: z.boolean().optional().describe('Enable Visual Regression Testing (VRT). If true, a background screenshot will be captured automatically at every interaction step to allow retroactive visual assertions.'),
      viewport_width: z.number().optional().describe('Viewport width in pixels (e.g. 1280, 1920). Only applies when a new window is opened.'),
      viewport_height: z.number().optional().describe('Viewport height in pixels (e.g. 720, 1080). Only applies when a new window is opened.'),
    },
    async ({ name, description, use_vrt, viewport_width, viewport_height }) => {
      const recording = getRecording();
      if (recording) {
        // Idempotent: if already recording the same test, return success
        if (recording.name === name) {
          log(`start_recording called again for "${name}" — already recording, returning success`);
          return { content: [{ type: 'text', text: `Recording is already in progress for test "${name}". Continue executing browser actions, then call stop_recording when done.` }] };
        }
        return { content: [{ type: 'text', text: `Already recording test "${recording.name}". Stop it first with stop_recording.` }] };
      }

      const viewport = (viewport_width && viewport_height) ? { width: viewport_width, height: viewport_height } : null;
      setRecording({ name, description: description || '', steps: [], startedAt: Date.now(), use_vrt: use_vrt || false, viewport });
      log(`Recording started: ${name} (VRT: ${use_vrt ? 'enabled' : 'disabled'}, viewport: ${viewport ? `${viewport.width}x${viewport.height}` : 'default'})`);
      
      let newTabId = null;
      try {
        const navParams = { url: 'about:blank', newWindow: true };
        if (viewport) {
          navParams.viewportWidth = viewport.width;
          navParams.viewportHeight = viewport.height;
        }
        const navResult = await sendCommand(undefined, 'navigate', navParams);
        newTabId = navResult?.tabId || null;
      } catch (err) {
        log(`Failed to open new window for recording: ${err.message}`);
      }
      
      import('../websocket.js').then(({ pushOverlayState }) => {
        pushOverlayState(null, { mode: 'recording', step: 0, stepName: 'Waiting for action...' }, newTabId);
      }).catch(() => {});

      const viewportMsg = viewport ? ` with viewport ${viewport.width}x${viewport.height}` : '';
      return { content: [{ type: 'text', text: `Recording started for test "${name}"${use_vrt ? ' (VRT enabled)' : ''}${viewportMsg}. A new window has been opened. Use the 'navigate' tool to go to your target URL.` }] };
    }
  );

  // --- Tool: record_step (deprecated — steps are now auto-recorded) ---
  server.tool(
    'record_step',
    '[DEPRECATED] Steps are now automatically recorded when a recording is active. You do NOT need to call this tool. Just execute browser actions and call stop_recording when done. If called, it will add an intent/variable_name override to the last recorded step.',
    {
      action_id: z.string().describe('The ID of the action (ignored — steps are auto-recorded)'),
      intent: z.string().optional().describe('Human-readable description of what this step does'),
      variable_name: z.string().optional().describe('Override the auto-detected variable name for this step'),
      skip_variable: z.boolean().optional().describe('Set to true to skip variable detection for this step')
    },
    async ({ action_id, intent, variable_name, skip_variable }) => {
      const recording = getRecording();
      if (!recording) {
        return { content: [{ type: 'text', text: 'No recording in progress. Call start_recording first.' }] };
      }

      if (recording.steps.length === 0) {
        return { content: [{ type: 'text', text: 'No steps recorded yet. Steps are now auto-recorded — just execute browser actions.' }] };
      }

      // Apply optional overrides to the last auto-recorded step
      const lastStep = recording.steps[recording.steps.length - 1];
      if (intent) lastStep.intent = intent;
      if (variable_name) lastStep._variableNameOverride = variable_name;
      if (skip_variable) lastStep._skipVariable = true;

      log(`record_step called (deprecated) — applied overrides to step ${recording.steps.length}`);
      
      import('../websocket.js').then(({ pushOverlayState }) => {
        pushOverlayState(null, {
          mode: 'recording',
          updateOnly: true,
          step: recording.steps.length,
          stepName: intent || lastStep.command
        });
      }).catch(() => {});

      return { content: [{ type: 'text', text: `Step ${recording.steps.length} (${lastStep.command}) updated with overrides. Note: record_step is deprecated — steps are auto-recorded. Just call stop_recording when done.` }] };
    }
  );

  // --- Tool: stop_recording ---
  server.tool(
    'stop_recording',
    'Stop the current recording and save the test. Automatically detects variables (fill values become {{variables}}, clicks on list/box items become selectable by index or text). All variable detection runs in batch at save time for faster recording.',
    {},
    async () => {
      const recording = getRecording();
      if (!recording) {
        return { content: [{ type: 'text', text: 'No recording in progress.' }] };
      }
      
      import('../websocket.js').then(({ pushOverlayState }) => {
        pushOverlayState(null, null); // null state hides the overlay
      }).catch(() => {});

      if (recording.steps.length === 0) {
        setRecording(null);
        return { content: [{ type: 'text', text: 'Recording cancelled — no steps were recorded.' }] };
      }

      // ─── Step cleanup: remove parasitic recovery steps ────────────
      recording.steps = cleanRecoverySteps(recording.steps);

      log(`Batch variable detection for ${recording.steps.length} steps...`);
      const lastRefMap = getLastRefMap();
      const usedVarNames = new Set();

      // ─── Batch variable detection ─────────────────────────────────
      for (let i = 0; i < recording.steps.length; i++) {
        const step = recording.steps[i];
        if (step.variable) {
          usedVarNames.add(step.variable.name);
          continue; // already variabilized
        }

        // Auto-variabilize FILL steps (smart naming from locators)
        if (step.command === 'fill' && step.params.value) {
          const baseName = deriveVarNameFromLocators(step) || ('input_' + (i + 1));
          const varName = uniqueVarName(baseName, usedVarNames);
          const originalValue = step.params.value;
          step.params.value = `{{${varName}}}`;
          step.variable = { name: varName, type: 'text', defaultValue: originalValue };
          log(`Auto-variabilized fill step ${i + 1}: {{${varName}}} = "${originalValue}"`);
          continue;
        }

        // Auto-detect CLICK on list/box items (with deduplication)
        if (step.command === 'click') {
          const cssLocator = (step.locators || []).find(l => l.type === 'css');
          const selector = step.params.selector || (cssLocator && cssLocator.value);
          const clickText = step.params.text;

          if (selector || clickText) {
            try {
              const listContext = await detectListContext(sendCommand, { selector, text: clickText, tabId: step.params.tabId });
              if (listContext) {
                const llmResult = await classifyWithLLM(listContext, step.intent);
                if (llmResult.isList) {
                  const varName = uniqueVarName(llmResult.variableName, usedVarNames);
                  step.variable = {
                    name: varName,
                    type: listContext.type === 'box' ? 'box_item' : 'list_item',
                    defaultValue: llmResult.selectionMode === 'by_text'
                      ? listContext.selectedText
                      : String(listContext.selectedIndex),
                    listContext: {
                      type: listContext.type,
                      parentSelector: listContext.parentSelector,
                      itemXpath: listContext.itemXpath,
                      totalItems: listContext.totalItems,
                      selectedIndex: listContext.selectedIndex,
                      selectedText: listContext.selectedText,
                      selectionMode: llmResult.selectionMode
                    }
                  };
                  log(`Auto-variabilized click step ${i + 1}: {{${varName}}} in ${listContext.type}`);
                }
              }
            } catch (err) {
              log(`Variable detection failed for step ${i + 1}: ${err.message}`);
            }
          }
          continue;
        }

        // Auto-variabilize SELECT interactions
        if (step.command === 'fill' && !step.variable) {
          const refKey = step.params.ref ? String(step.params.ref).replace('@', '') : null;
          if (refKey && lastRefMap[refKey] && lastRefMap[refKey].role === 'combobox') {
            const baseName = 'select_' + (i + 1);
            const varName = uniqueVarName(baseName, usedVarNames);
            const originalValue = step.params.value;
            step.params.value = `{{${varName}}}`;
            step.variable = { name: varName, type: 'select', defaultValue: originalValue };
          }
        }
      }

      // ─── Build variables summary ──────────────────────────────────
      const variables = {};
      recording.steps.forEach((step, i) => {
        if (step.variable) {
          variables[step.variable.name] = {
            type: step.variable.type,
            defaultValue: step.variable.defaultValue || '',
            step: i + 1,
            description: step.intent || `${step.command} in step ${i + 1}`
          };
        }
      });

      const test = {
        name: recording.name,
        description: recording.description,
        createdAt: new Date(recording.startedAt).toISOString(),
        variables: Object.keys(variables).length > 0 ? variables : undefined,
        viewport: recording.viewport || null,
        steps: recording.steps
      };

      const testId = await saveTest(test);
      const stepCount = recording.steps.length;
      const varCount = Object.keys(variables).length;
      log(`Recording saved: test id ${testId} (${stepCount} steps, ${varCount} variables)`);
      setRecording(null);

      let summary = `Test "${test.name}" saved with ${stepCount} steps (id: ${testId})`;
      if (varCount > 0) {
        summary += `\n\n${varCount} variable(s) detected for dynamic replay:\n`;
        for (const [name, info] of Object.entries(variables)) {
          summary += `  - {{${name}}} — type: ${info.type}, default: "${info.defaultValue}" (step ${info.step})\n`;
        }
        summary += `\nTo run with different data: run_test("${test.name}", { variables: { ${Object.keys(variables).map(k => `"${k}": "new_value"`).join(', ')} } })`;
      }
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  // --- Tool: list_tests ---
  server.tool(
    'list_tests',
    'List all saved tests available for execution.',
    {},
    async () => {
      const tests = await listTestsDb();
      if (tests.length === 0) {
        return { content: [{ type: 'text', text: 'No tests saved yet.' }] };
      }
      const summaries = tests.map(test => {
        let line = `- ${test.name}: ${test.description || '(no description)'} (${test.steps.length} steps)`;
        if (test.variables && Object.keys(test.variables).length > 0) {
          const vars = Object.entries(test.variables).map(([k, v]) => `{{${k}}} (${v.type}, default: "${v.defaultValue}")`);
          line += `\n    Variables: ${vars.join(', ')}`;
        }
        return line;
      });
      return { content: [{ type: 'text', text: `Saved tests:\n${summaries.join('\n')}` }] };
    }
  );

  server.tool(
    'run_test',
    'RUN a saved test autonomously inside the browser extension. The extension will execute ALL steps in one incredibly fast sequence without LLM intervention. Supports dynamic variables: pass "variables" to override {{placeholders}} recorded in fill steps and list/box item selections. Use list_tests to see available variables for each test. Use "substitutions" for raw find-and-replace across all params. After execution, assertions are evaluated and reported. Set debug=true to enable step-by-step debug mode with breakpoints — use debug_action to control the paused execution.',
    {
      name: z.string().describe('Name of the test to run'),
      variables: z.record(z.string()).optional().describe('Template variables: replaces {{key}} placeholders in params. For list/box items, pass the index (e.g. "2") or text content to select.'),
      substitutions: z.record(z.string()).optional().describe('Find-and-replace in all step params. Keys are old values, values are new values. Example: { "Antony": "Marseille" } replaces all occurrences of "Antony" with "Marseille" in every step.'),
      start_step: z.number().optional().describe('Step number to start from (1-indexed). Use this to resume a test after fixing a prior failed step manually.'),
      new_window: z.boolean().optional().default(true).describe('Runs the test in a new browser window. Defaults to true. Set to false to reuse the current tab.'),
      debug: z.boolean().optional().describe('Enable debug mode: execution pauses before each step (or at breakpoints). Use debug_action tool to resume/step/continue.'),
      breakpoints: z.array(z.number()).optional().describe('Step numbers (1-indexed) to pause at. Only used when debug=true. If empty, pauses at every step.')
    },
    async ({ name, variables, substitutions, start_step, new_window, debug, breakpoints }) => {
      // Debug mode: run asynchronously and return immediately with execution ID
      if (debug) {
        const debugController = new DebugController(breakpoints || [], 'step');

        // Run execution in background — do not await.
        // Wrap in a settled promise to prevent unhandled rejection crashes.
        // debug_action reads _executionResult / _executionError later.
        const executionPromise = executeTest(
          name, variables, substitutions, start_step, new_window,
          sendCommand, 'mcp', null, debugController
        ).then(
          (result) => { debugController._executionResult = result; },
          (err) => { debugController._executionError = err; }
        );

        // Wait briefly for execution to start so we get the executionId from the controller
        await new Promise(resolve => setTimeout(resolve, 200));

        const executionId = debugController.executionId;
        if (!executionId) {
          // Execution failed to start — await to get the error
          try {
            await executionPromise;
          } catch (err) {
            return { content: [{ type: 'text', text: `Failed to start debug execution: ${err.message}` }] };
          }
        }

        // Store the promise so we can return final results later
        debugController._executionPromise = executionPromise;

        let text = `Debug execution #${executionId} started for test "${name}".\n`;
        text += `Mode: step-by-step (pauses before each step)\n`;
        if (breakpoints && breakpoints.length > 0) {
          text += `Breakpoints set at steps: ${breakpoints.join(', ')}\n`;
        }
        text += `\nThe execution is now PAUSED at step 1.\n`;
        text += `Use these tools to control the debug session:\n`;
        text += `  - debug_action(execution_id: ${executionId}, action: "step") — execute one step, pause again\n`;
        text += `  - debug_action(execution_id: ${executionId}, action: "resume") — run until next breakpoint\n`;
        text += `  - debug_action(execution_id: ${executionId}, action: "continue") — run all remaining steps\n`;
        text += `  - debug_action(execution_id: ${executionId}, action: "toggle_breakpoint", step: N) — toggle breakpoint\n`;
        text += `  - snapshot() — inspect the current page state while paused\n`;

        return { content: [{ type: 'text', text }] };
      }

      // Normal (non-debug) execution
      try {
        const res = await executeTest(name, variables, substitutions, start_step, new_window, sendCommand, 'mcp');
        let resultText = `Test "${name}" executed successfully (execution #${res.executionId}).`;
        if (res.assertionsTotal > 0) {
          resultText += `\n\nAssertions: ${res.assertionsPassed}/${res.assertionsTotal} passed`;
          if (res.assertionsFailed > 0) {
            resultText += ` (${res.assertionsFailed} failed)`;
          }
        }
        resultText += `\n\n${JSON.stringify(res.results, null, 2)}`;
        return { content: [{ type: 'text', text: resultText }] };
      } catch (err) {
        const msg = err.message || String(err);
        const execId = err.executionId ? ` (execution #${err.executionId})` : '';
        const failedStep = err.failedStep || '?';
        const totalSteps = err.totalSteps || '?';
        const completedSteps = err.completedSteps || 0;
        const nextStep = err.failedStep ? err.failedStep + 1 : null;
        const failedCmd = err.failedStepCommand || '?';
        const failedIntent = err.failedStepIntent || '';

        let stepsReport = '';
        if (err.stepResults) {
          for (const sr of err.stepResults) {
            const icon = sr.status === 'success' ? '✅' : sr.status === 'failed' ? '❌' : '⏭️';
            stepsReport += `  ${icon} Step ${sr.step}: [${sr.command}] ${sr.intent || ''} — ${sr.status}${sr.error ? ' — ' + sr.error : ''}\n`;
          }
        } else {
          for (let s = 1; s <= completedSteps; s++) {
            stepsReport += `  ✅ Step ${s}: SUCCEEDED (do NOT touch)\n`;
          }
          stepsReport += `  ❌ Step ${failedStep}: [${failedCmd}] ${failedIntent} — FAILED\n`;
        }

        let text = `TEST EXECUTION FAILED${execId}\n\n`;
        text += `=== STEP STATUS REPORT ===\n`;
        text += stepsReport;
        text += `\n=== FAILED STEP DETAILS ===\n`;
        text += `Step number: ${failedStep}/${totalSteps}\n`;
        text += `Command: ${failedCmd}\n`;
        text += `Intent: ${failedIntent || '(none)'}\n`;
        text += `Error: ${msg}\n\n`;

        if (err.assertionsFailed > 0) {
          text += `=== ASSERTIONS ===\n`;
          text += `Passed: ${err.assertionsPassed}, Failed: ${err.assertionsFailed}\n\n`;
        }

        text += `=== ACTION REQUIRED ===\n`;
        text += `1. Use 'snapshot' to see the current page state.\n`;
        text += `2. Perform ONLY the failed step ${failedStep} manually. The failed step was a "${failedCmd}" command${failedIntent ? ' ("' + failedIntent + '")' : ''}. Use the matching browser tool.\n`;
        text += `3. Call fix_test_step(test_name="${name}", step_order=${failedStep}, action_id=<the_action_id>).\n`;
        text += `4. Call run_test(name="${name}", start_step=${nextStep || failedStep}) to continue remaining steps.\n\n`;
        text += `CRITICAL RULES:\n`;
        text += `- Steps 1–${completedSteps} already SUCCEEDED. Do NOT re-execute, re-navigate, or modify them.\n`;
        text += `- fix_test_step must target step_order=${failedStep} ONLY. Do NOT modify any other step.\n`;
        text += `- The page is already at the correct state after ${completedSteps} successful steps. Do NOT navigate again.\n`;
        text += `- Your manual fix should match the original command type "${failedCmd}" (e.g., if it was a click, fix it with a click, not a navigate).`;

        return { content: [{ type: 'text', text }] };
      }
    }
  );

  // --- Tool: debug_action ---
  server.tool(
    'debug_action',
    'Control a paused debug execution. Use after calling run_test with debug=true. Allows stepping through test execution, resuming to breakpoints, or continuing all remaining steps. Call snapshot() between debug actions to inspect the page state.',
    {
      execution_id: z.number().describe('The execution ID returned by run_test in debug mode'),
      action: z.enum(['resume', 'step', 'continue', 'toggle_breakpoint', 'abort']).describe(
        'resume: run until next breakpoint. step: execute one step then pause. continue: run all remaining. toggle_breakpoint: add/remove breakpoint. abort: cancel execution.'
      ),
      step: z.number().optional().describe('Step number for toggle_breakpoint action')
    },
    async ({ execution_id, action, step }) => {
      const controller = activeDebugControllers.get(execution_id);
      if (!controller) {
        return { content: [{ type: 'text', text: `No active debug session found for execution #${execution_id}. It may have already completed or been aborted.` }] };
      }

      const wasPausedAt = controller.pausedAtStep;

      switch (action) {
        case 'resume':
          controller.resume();
          break;
        case 'step':
          controller.stepOver();
          break;
        case 'continue':
          controller.continueAll();
          break;
        case 'toggle_breakpoint': {
          if (!step) {
            return { content: [{ type: 'text', text: 'step parameter is required for toggle_breakpoint action' }] };
          }
          const isSet = controller.toggleBreakpoint(step);
          return { content: [{ type: 'text', text: `Breakpoint ${isSet ? 'set' : 'removed'} at step ${step}. Current breakpoints: [${controller.breakpoints.join(', ')}]` }] };
        }
        case 'abort':
          controller.abort();
          // Wait for the execution promise to settle (already caught internally)
          if (controller._executionPromise) {
            await controller._executionPromise;
          }
          return { content: [{ type: 'text', text: `Debug execution #${execution_id} aborted.` }] };
      }

      // Wait for the controller to pause again or for execution to complete
      const waitForNextState = () => new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (controller.isPaused) {
            clearInterval(checkInterval);
            resolve({ paused: true, step: controller.pausedAtStep });
          }
          if (controller.isAborted || !activeDebugControllers.has(execution_id)) {
            clearInterval(checkInterval);
            resolve({ completed: true });
          }
        }, 100);
        // Safety timeout: don't wait forever
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve({ completed: !activeDebugControllers.has(execution_id), paused: controller.isPaused, step: controller.pausedAtStep });
        }, 30000);
      });

      const nextState = await waitForNextState();

      if (nextState.paused) {
        let text = `Execution #${execution_id}: stepped from ${wasPausedAt || '?'} → now paused at step ${nextState.step}.\n`;
        text += `Breakpoints: [${controller.breakpoints.join(', ')}]\n`;
        text += `\nUse snapshot() to inspect the page, then debug_action to continue.`;
        return { content: [{ type: 'text', text }] };
      }

      // Execution completed — get final results.
      // Wait for the background promise to settle so _executionResult/_executionError are populated.
      if (controller._executionPromise) {
        await controller._executionPromise;
      }
      let finalText = `Debug execution #${execution_id} completed.\n`;
      if (controller._executionError) {
        const err = controller._executionError;
        finalText += `Status: failed\nError: ${err.message}\n`;
        if (err.stepResults) {
          finalText += `\nStep results:\n`;
          for (const sr of err.stepResults) {
            finalText += `  Step ${sr.step} (${sr.command}${sr.intent ? ': ' + sr.intent : ''}): ${sr.status}${sr.error ? ' — ' + sr.error : ''}\n`;
          }
        }
      } else if (controller._executionResult) {
        const result = controller._executionResult;
        finalText += `Status: success\n`;
        if (result.assertionsTotal > 0) {
          finalText += `Assertions: ${result.assertionsPassed}/${result.assertionsTotal} passed\n`;
        }
      }
      return { content: [{ type: 'text', text: finalText }] };
    }
  );

  // --- Tool: add_assertion ---
  server.tool(
    'add_assertion',
    'Add an assertion step to a saved test. The assertion is first evaluated live against the current browser page to verify it passes. If it fails, the assertion is NOT added and the failure details are returned so you can fix the selector or expected value. Only passing assertions are saved to the test.',
    {
      test_name: z.string().describe('Name of the test to add the assertion to'),
      assertion_type: z.enum([
        'element_exists', 'element_not_exists', 'element_visible', 'element_hidden',
        'text_equals', 'text_contains', 'attribute_equals',
        'url_equals', 'url_contains', 'title_equals', 'title_contains',
        'element_count'
      ]).describe('Type of assertion'),
      selector: z.string().optional().describe('CSS selector for element assertions'),
      expected: z.string().optional().describe('Expected value for comparison assertions'),
      attribute: z.string().optional().describe('Attribute name for attribute_equals assertion'),
      description: z.string().optional().describe('Human-readable description of what this assertion verifies'),
      step_order: z.number().optional().describe('Position to insert (1-indexed). If omitted, appends at the end.')
    },
    async ({ test_name, assertion_type, selector, expected, attribute, description, step_order }) => {
      const assertion = { type: assertion_type };
      if (selector) assertion.selector = selector;
      if (expected !== undefined) assertion.expected = expected;
      if (attribute) assertion.attribute = attribute;

      // Validate required fields
      const needsSelector = ['element_exists', 'element_not_exists', 'element_visible', 'element_hidden', 'text_equals', 'text_contains', 'attribute_equals', 'element_count'];
      if (needsSelector.includes(assertion_type) && !selector) {
        return { content: [{ type: 'text', text: `Assertion type "${assertion_type}" requires a CSS selector.` }] };
      }
      const needsExpected = ['text_equals', 'text_contains', 'attribute_equals', 'url_equals', 'url_contains', 'title_equals', 'title_contains', 'element_count'];
      if (needsExpected.includes(assertion_type) && expected === undefined) {
        return { content: [{ type: 'text', text: `Assertion type "${assertion_type}" requires an expected value.` }] };
      }
      if (assertion_type === 'attribute_equals' && !attribute) {
        return { content: [{ type: 'text', text: 'Assertion type "attribute_equals" requires an attribute name.' }] };
      }

      const test = loadTest(test_name);
      if (!test) {
        return { content: [{ type: 'text', text: `Test "${test_name}" not found.` }] };
      }

      // ─── Evaluate assertion live against the current browser page ───
      let result;
      try {
        result = await evaluateAssertion(sendCommand, assertion);
      } catch (err) {
        return { content: [{ type: 'text', text: `Assertion evaluation error: ${err.message}\nThe assertion was NOT added. Fix the issue and try again.` }] };
      }

      if (!result.passed) {
        let msg = `Assertion FAILED — not added to test "${test_name}".\n`;
        msg += `  Type: ${assertion_type}\n`;
        if (selector) msg += `  Selector: ${selector}\n`;
        msg += `  Expected: ${result.expected}\n`;
        msg += `  Actual:   ${result.actual}\n\n`;
        msg += `Fix the selector or expected value and try again. Use 'snapshot' to inspect the current page.`;
        return { content: [{ type: 'text', text: msg }] };
      }

      // ─── Assertion passed — save it to the test ───
      const intentText = description || `Assert: ${assertion_type}${selector ? ` on ${selector}` : ''}${expected ? ` = "${expected}"` : ''}`;
      const newStep = {
        command: 'assert',
        params: {},
        intent: intentText,
        assertion
      };

      if (step_order && step_order > 0 && step_order <= test.steps.length + 1) {
        test.steps.splice(step_order - 1, 0, newStep);
      } else {
        test.steps.push(newStep);
      }

      saveTest(test);
      const pos = step_order || test.steps.length;
      let summary = `Assertion PASSED and added to test "${test_name}" at step ${pos}.\n`;
      summary += `  Type: ${assertion_type}\n`;
      if (selector) summary += `  Selector: ${selector}\n`;
      summary += `  Expected: ${result.expected}\n`;
      summary += `  Actual:   ${result.actual}`;
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  // --- Tool: fix_test_step ---
  server.tool(
    'fix_test_step',
    'Update a failed test step with the params and locators from a successful manual action. Call this AFTER you manually performed a browser action to fix a failed step. It replaces the step\'s command, params, and locators in the saved test so future runs will use the fixed version.',
    {
      test_name: z.string().describe('Name of the test containing the step to fix'),
      step_order: z.number().describe('The step number to update (1-indexed, as reported in the error)'),
      action_id: z.string().describe('The action_id returned by the browser tool you used to fix the step (e.g. "act_5")'),
      intent: z.string().optional().describe('Updated human-readable description for this step')
    },
    async ({ test_name, step_order, action_id, intent }) => {
      const action = getAction(action_id);
      if (!action) {
        return { content: [{ type: 'text', text: `Action ID "${action_id}" not found. Make sure you pass the action_id returned by the browser tool you just used.` }] };
      }

      const newStepData = {
        command: action.command,
        params: { ...action.params },
        locators: action.locators || null,
        intent: intent || null
      };

      // Purge null/undefined from params
      Object.keys(newStepData.params).forEach(k => {
        if (newStepData.params[k] === undefined || newStepData.params[k] === null) {
          delete newStepData.params[k];
        }
      });

      try {
        const result = await updateTestStep(test_name, step_order, newStepData);
        if (!result) {
          return { content: [{ type: 'text', text: `Test "${test_name}" or step ${step_order} not found.` }] };
        }
        log(`Step ${step_order} of "${test_name}" fixed via ${action_id}: ${action.command}`);
        return { content: [{ type: 'text', text: `Step ${step_order} of "${test_name}" updated successfully.\n  Command: ${action.command}\n  Locators: ${action.locators ? action.locators.length + ' locator(s)' : 'none'}\nThe test is now permanently fixed for future runs.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to update step: ${err.message}` }] };
      }
    }
  );

  // --- Tool: delete_test ---
  server.tool(
    'delete_test',
    'Delete a saved test.',
    {
      name: z.string().describe('Name of the test to delete')
    },
    async ({ name }) => {
      if (!(await deleteTestDb(name))) {
        return { content: [{ type: 'text', text: `Test "${name}" not found.` }] };
      }
      return { content: [{ type: 'text', text: `Test "${name}" deleted.` }] };
    }
  );

  // --- Tool: add_retroactive_vrt ---
  server.tool(
    'add_retroactive_vrt',
    'Add a visual regression test (VRT) assertion retroactively to a saved test. Uses the screenshot captured during recording for that step as the baseline. The original recording must have been done with use_vrt=true.',
    {
      test_name: z.string().describe('Name of the test'),
      step_order: z.number().describe('The position of the step to use as the visual reference (1-indexed). The assertion will be added immediately AFTER this step.'),
      selector: z.string().optional().describe('Optional CSS selector. If provided, the visual match will only compare this specific element within the viewport.')
    },
    async ({ test_name, step_order, selector }) => {
      const test = loadTest(test_name);
      if (!test) return { content: [{ type: 'text', text: `Test "${test_name}" not found.` }] };
      
      const referenceStep = test.steps[step_order - 1];
      if (!referenceStep || !referenceStep.params || !referenceStep.params.baselinePath) {
        return { content: [{ type: 'text', text: `Step ${step_order} does not have a saved baseline screenshot. Ensure the test was recorded with use_vrt=true.` }] };
      }

      const assertion = {
        type: 'visual_match',
        expected: referenceStep.params.baselinePath,
      };
      
      if (selector) {
        assertion.selector = selector;
      }

      const newStep = {
        command: 'assert',
        params: {},
        intent: `Retroactive Visual Regression Test (VRT) based on step ${step_order}${selector ? ` [${selector}]` : ''}`,
        assertion
      };

      test.steps.splice(step_order, 0, newStep);
      saveTest(test);
      
      return { content: [{ type: 'text', text: `Retroactive VRT assertion added successfully after step ${step_order} in test "${test_name}". It will compare against the baseline image captured during recording.` }] };
    }
  );
}
