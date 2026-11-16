// Test recording & replay MCP tools

import { z } from 'zod';
import { log } from '../logger.js';
import { currentSession } from '../session.js';
import { recordAction } from '../recording.js';
import { settleActions } from './session-scope.js';
import { pageOf } from '../elements.js';
import {
  detectListContext,
  loadTest, saveTest, deleteTest as deleteTestDb, listTests as listTestsDb, executeTest, executeRows,
  updateTestStep, evaluateAssertion
} from '../tests.js';
import { setStepOptional } from '../test-store.js';
import { ORACLE_ASSERTIONS } from '../test-execute.js';
import { DebugController, activeDebugControllers } from '../debug-controller.js';
import { uniqueVarName, listVariable, variabilizeInput, typedJustBefore, variabilizeSuggestion, keepStepVariable, sameItemVariable } from '../variable-detection.js';
import { linkAssertionToVariables } from '../test-variable.js';
import { judgeListClick } from '../classify.js';
import { formatTriage } from '../triage.js';
import { getRequirement, linkRecorded, nonConformityOf } from '../requirements.js';
import { listRepairs, verifyRepair, applyRepair, rejectRepair, describeRepair, getRepair, repairUses, stepsText } from '../repairs.js';
import { usesOfStep, relocateElement } from '../element-store.js';
import { recordingDataset, recordingDatasetText, placeRecorded, datasetVariables, withColumnsOf, rowsOfTest, rowsSource, rowLabel, shownRow } from '../datasets.js';
import { redundantTimeWaits } from '../recorded-waits.js';
import { stepsOfBusinessPhrase, businessStepsOf, playBusinessSteps } from '../business-play.js';
import { elementTimeoutFor } from '../projects.js';
import { checksRecording, recordingRequirements, recordCheck, linkRecordedChecks } from '../recorded-checks.js';
import { windowSettings, closesAfterRun, closeWindowOf } from '../run-windows.js';

// What follows a value typed or picked (a search, a suggestion: a variable at save time). "chocolat"
// led Auchan to its aisle (?redirect_keywords=chocolat, a Kinder bar shown), "banane" to its
// search: a check of that product failed whatever the variable. "The second result" of "lait" was
// clicked by its name ("Ajouter AUCHAN Lait demi-écrémé … au panier"), and a total was checked
// against the line's price instead of 3 × the product's.
const ANY_VALUE_CHECKS = 'A value typed or picked (a search, a suggestion) becomes a variable, replayed with other values: '
  + 'after it, act on and check what holds for any value. Check the value itself in the title, a heading or the URL, a list of '
  + 'results shown (its container, a count) — never one particular result (a product, a row) only this value brings. Act on a '
  + 'result by its place among the others ("the second result"), not by a name only it has (a product\'s name in an '
  + 'aria-label); a name the next steps need, keep it first with capture_value and use {{name}} in their selectors. '
  + 'A computed amount (3 × a price): keep the price with capture_value, then expect "{{price * 3 | 0,00}}" (text_contains; '
  + '"6,42 €" reads as 6.42). A test that adds to a cart or creates data removes it at the end, so the next run starts the same.';

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Remove recovery/parasitic steps that result from error recovery during recording.
 * Detected patterns:
 *  - navigate to same URL as a previous navigate → remove the duplicate + surrounding waits
 *  - Trailing waits of a time only, at the very end: they check nothing. A wait for an element
 *    is kept: at the end, it is the check of what the test did (the row of the note created);
 *    dropping it lost the last step an agent recorded.
 * What it removed is told: `{ steps, removed }`.
 */

export function cleanRecoverySteps(steps) {
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

  // Pass 2: Remove trailing waits of a time only (a recording artifact)
  let last = cleaned.length - 1;
  while (last >= 0 && cleaned[last].command === 'wait' && !cleaned[last].params?.selector && !toRemove.has(last)) {
    toRemove.add(last);
    last--;
  }

  // Pass 3: Remove waits of a time only that a step after them makes useless: that step waits
  // for its element, or its check, by itself (lib/recorded-waits.js).
  const redundant = new Set(redundantTimeWaits(cleaned).filter((i) => !toRemove.has(i)));
  for (const i of redundant) toRemove.add(i);

  if (toRemove.size === 0) return { steps: cleaned, removed: [] };

  const removed = [...toRemove].sort((a, b) => a - b).map((i) => {
    const step = cleaned[i];
    return step.command === 'navigate' ? `a navigate repeated (${step.params.url})`
      : step.params?.selector ? `a wait for ${step.params.selector} around a repeated navigate`
        : `a wait of ${step.params?.ms ?? 0} ms${i > last ? ' at the end (it checks nothing)' : redundant.has(i) ? ' (the step after it waits for its element by itself)' : ''}`;
  });
  const result = cleaned.filter((_, idx) => !toRemove.has(idx));
  log(`Cleaned ${toRemove.size} parasitic step(s) (${cleaned.length} → ${result.length})`);
  return { steps: result, removed };
}

export function registerTestTools(server, { sendCommand: dispatch }) {

  // Recording state is per session (see tools/session-scope.js): two agents can record two
  // different tests at the same time without their steps interleaving.
  const sess = () => currentSession();

  // The values a replay typed, by the tab it ended in: an assertion added on that tab
  // (add_assertion's tabId) is linked to the variables through them, not the defaults.
  const rememberReplay = (name, values, tabId) => {
    if (!values || tabId == null) return;
    const session = sess();
    session.replays ??= new Map();
    session.replays.set(tabId, { test: name, values });
  };
  // The browser the session works in (named once, e.g. "headless"), when a call names none:
  // add_assertion checks the page of the window the test was recorded in.
  const sendCommand = (profile, command, params, ...rest) => dispatch(profile ?? sess().profile, command, sess().scope(params), ...rest);
  const getRecording = () => sess().recording;
  const setRecording = (value) => { sess().recording = value; };
  const getAction = (id) => sess().getAction(id);
  const saveActionToHistory = (...args) => recordAction(sess(), ...args);

  // The window a test was recorded in, closed once the test is saved when the user chose so
  // (Settings → Browser windows, lib/run-windows.js) — the agent told: its next navigate opens a new one.
  const closeRecordingWindow = async () => {
    const tabId = sess().lastTabId;
    if (tabId === undefined || !windowSettings().after_recording) return '';
    return (await closeWindowOf(sendCommand, tabId))
      ? '\nIts window was closed, as the user chose (Settings → Browser windows): the next navigate opens a new one.'
      : '';
  };

  // --- Tool: start_recording ---
  server.tool(
    'start_recording',
    'Start recording a reusable browser automation test. When the user asks to "record", "save", or "enregistrer" a test/parcours, call this tool FIRST. Every browser action (navigate, click, fill, etc.) is automatically recorded — no need to call record_step. IMPORTANT: Always pass the "intent" parameter on each browser action call (click, fill, navigate, etc.) to describe the FUNCTIONAL purpose of the step (e.g. intent: "Submit the login form"). Check each outcome as you go: right after an action whose result matters (a page or a tab opened, a form sent, a list loaded), call add_assertion with this test\'s name, before the next action — the check is recorded as the next step, and on a replay it holds the test there until what it checks shows. Checks left for the end are all made on the last page, and the replay then runs the actions without waiting for what each brings. When done, call stop_recording to save (variable detection runs automatically at save time).',
    {
      name: z.string().describe('Name of the test (used as identifier)'),
      description: z.string().optional().describe('Human-readable description of what the test does'),
      use_vrt: z.boolean().optional().describe('Enable Visual Regression Testing (VRT). If true, a background screenshot will be captured automatically at every interaction step to allow retroactive visual assertions.'),
      viewport_width: z.number().optional().describe('Viewport width in pixels (e.g. 1280, 1920). Only applies when a new window is opened.'),
      viewport_height: z.number().optional().describe('Viewport height in pixels (e.g. 720, 1080). Only applies when a new window is opened.'),
      requirement: z.string().optional().describe('The requirement this test checks (key, e.g. "REQ-12"): the saved test is linked to it'),
      case_id: z.number().int().optional().describe('The planned case it records (from plan_tests)'),
      criterion: z.number().int().optional().describe('Without a case: the criterion it checks, by its number'),
      project_id: z.number().int().optional().describe('The project the test is for: saved in it; while recording, a value of one of its datasets is {{users[1].email}} (rows numbered from 1)'),
      dataset: z.string().optional().describe('With project_id: a dataset of the project the test plays every row of. Type {{email}} (its columns): while recording, the value of its first row; the saved test is bound to it and runs once per row'),
    },
    async ({ name, description, use_vrt, viewport_width, viewport_height, requirement, case_id, criterion, project_id, dataset }) => {
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
      // Checked now, not at the end of the recording: a wrong key would lose the link then.
      if (requirement) {
        const found = getRequirement(requirement);
        if (!found) return { isError: true, content: [{ type: 'text', text: `No requirement ${requirement}: save_requirement first, or drop the parameter.` }] };
        if (case_id != null && !found.cases.some((c) => c.id === case_id)) return { isError: true, content: [{ type: 'text', text: `${found.key} has no case #${case_id}.` }] };
      }
      const link = requirement ? { requirement, caseId: case_id ?? null, criterion: criterion ?? null } : null;
      const played = recordingDataset(project_id, dataset);
      if (played.error) return { isError: true, content: [{ type: 'text', text: played.error }] };
      setRecording({ name, description: description || '', steps: [], startedAt: Date.now(), use_vrt: use_vrt || false, viewport, link, projectId: project_id ?? null, dataset: played.dataset });
      // A recording keeps its own values (capture_value, call_api), with those of the project's datasets.
      sess().resetValues({ projectId: project_id, row: played.dataset?.row });
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
        sess().adoptTab(navResult?.tabId, navResult?.windowId);
      } catch (err) {
        log(`Failed to open new window for recording: ${err.message}`);
      }
      
      import('../websocket.js').then(({ pushOverlayState }) => {
        pushOverlayState(null, { mode: 'recording', step: 0, stepName: 'Waiting for action...' }, newTabId);
      }).catch(() => {});

      const viewportMsg = viewport ? ` with viewport ${viewport.width}x${viewport.height}` : '';
      // The project's business steps: played as one (play_business_step), the test reads as them.
      const business = businessStepsOf(project_id ?? null);
      const businessText = business.length
        ? `\n\nThe project's business steps — play one with play_business_step instead of doing its steps again:\n${business.map((b) => `- ${b.keyword} ${b.pattern} (${b.steps} steps)`).join('\n')}`
        : '';
      const checksText = `\n\nCheck each outcome right after the action that brings it, before the next action: add_assertion(test_name: "${name}", …) records the check as the next step.`
        + ` ${ANY_VALUE_CHECKS}`;
      return { content: [{ type: 'text', text: `Recording started for test "${name}"${use_vrt ? ' (VRT enabled)' : ''}${viewportMsg}. A new window has been opened. Use the 'navigate' tool to go to your target URL.${recordingDatasetText(project_id, played.dataset)}${businessText}${checksText}` }] };
    }
  );

  // --- Tool: record_step (deprecated — steps are now auto-recorded) ---
  server.tool(
    'record_step',
    'Steps are recorded on their own while a recording is active: no need to call this to record one. Call it to name the variable of a step (what a fill typed becomes {{variable_name}} at stop_recording, instead of a name taken from its field), to keep its value fixed (skip_variable), to change its intent, to remove it (remove: an execute_js that only looked at the page), to say how a click the page found in a list is meant (pick: none, by_place, by_text — its result says what it was taken as), or to make it optional: a step the app may not need (a cookie banner, a popup only shown sometimes) — when it fails on a replay, the test goes on and passes.',
    {
      action_id: z.string().describe('The action_id a browser tool answered (e.g. "act_12"): the step it recorded'),
      intent: z.string().optional().describe('Human-readable description of what this step does'),
      variable_name: z.string().optional().describe('The name of the variable of this step (letters, digits, _), e.g. "email"'),
      skip_variable: z.boolean().optional().describe('Set to true to keep this step\'s value fixed: no variable'),
      optional: z.boolean().optional().describe('True: the step may not be done on a replay (an element only shown sometimes) — its failure is told, and the test goes on'),
      remove: z.boolean().optional().describe('True: the step is not part of the test — an execute_js that only looked at the page, an action done by mistake. Removed from the recording.'),
      pick: z.enum(['none', 'by_place', 'by_text']).optional().describe('A click the page found in a list (its result says "List: taken as item N of M"): "none" — not an item of a list, a click on this element; "by_place" — the item at its place ("the second result"); "by_text" — the item with its label ("the category Garden"). Goes before what is decided at stop_recording.'),
    },
    async ({ action_id, intent, variable_name, skip_variable, optional, remove, pick }) => {
      const recording = getRecording();
      if (!recording) {
        return { content: [{ type: 'text', text: 'No recording in progress. Call start_recording first.' }] };
      }

      if (recording.steps.length === 0) {
        return { content: [{ type: 'text', text: 'No steps recorded yet. Steps are now auto-recorded — just execute browser actions.' }] };
      }

      // The step of that action; the last one when the action is not known.
      let at = recording.steps.findLastIndex((step) => step._actionId === action_id);
      if (at < 0) at = recording.steps.length - 1;
      const lastStep = recording.steps[at];
      // Not part of the test: a look at the page through execute_js, which a replay would run
      // again — kept as optional "technical lookup" steps, they cluttered it.
      if (remove) {
        if (!recording.steps.some((step) => step._actionId === action_id)) {
          return { content: [{ type: 'text', text: `No step recorded for ${action_id}: nothing removed.` }] };
        }
        recording.steps.splice(at, 1);
        log(`record_step — removed step ${at + 1} (${lastStep.command})`);
        return { content: [{ type: 'text', text: `Step ${at + 1} (${lastStep.command}) removed: the test now has ${recording.steps.length} steps.` }] };
      }
      const name = variable_name ? variable_name.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') : '';
      if (intent) lastStep.intent = intent;
      if (name) lastStep._variableNameOverride = name;
      if (skip_variable) lastStep._skipVariable = true;
      if (typeof optional === 'boolean') lastStep.optional = optional;
      // The agent's word on a click in a list: it knows what it meant.
      if (pick === 'none') { lastStep._pick = pick; lastStep._skipVariable = true; }
      else if (pick) { lastStep._pick = pick; delete lastStep._skipVariable; }

      log(`record_step — applied overrides to step ${at + 1}`);
      
      import('../websocket.js').then(({ pushOverlayState }) => {
        pushOverlayState(null, {
          mode: 'recording',
          updateOnly: true,
          step: recording.steps.length,
          stepName: intent || lastStep.command
        }, sess().lastTabId ?? null);
      }).catch(() => {});

      const noList = pick && pick !== 'none' && lastStep.command === 'click' && lastStep._listContext === null;
      const told = [name && `its variable will be {{${name}}}`, skip_variable && 'its value stays fixed', intent && 'its intent changed',
        pick === 'none' && 'not an item of a list: a click on this element',
        pick === 'by_place' && 'the item at its place in the list', pick === 'by_text' && 'the item with its label in the list',
        noList && 'but no list was found around it when it was clicked: it stays a click on this element',
        optional === true && 'it is optional: on a replay, its failure does not fail the test', optional === false && 'it is required again'].filter(Boolean).join(', ');
      return { content: [{ type: 'text', text: `Step ${at + 1} (${lastStep.command})${told ? `: ${told}` : ' unchanged'}. Steps are recorded on their own: call stop_recording when done.` }] };
    }
  );

  // --- Tool: play_business_step ---
  server.tool(
    'play_business_step',
    [
      'Play a business step of the project — a phrase that stands for several steps, e.g. "je me connecte au portail avec',
      'l\'identifiant "{{secret.PORTAL_USERNAME}}" et le mot de passe "{{secret.PORTAL_PASSWORD}}"" — in the browser, as one action.',
      'While recording, its steps are recorded, linked to it: the test reads as the phrase. Use it instead of doing again what',
      'a business step does (logging in, logging out…): start_recording and get_project_context list the project\'s business steps.',
      'Give each {string} its value in double quotes; a secret as {{secret.NAME}}, a variable as {{name}}.',
    ].join(' '),
    {
      phrase: z.string().describe('The phrase, with its values: je me déconnecte du portail'),
      project_id: z.number().optional().describe('The project of the business step. Default: the one being recorded'),
      tabId: z.number().optional(),
    },
    async ({ phrase, project_id, tabId }) => {
      const recording = getRecording();
      const projectId = project_id ?? recording?.projectId ?? null;
      if (projectId == null) {
        return { content: [{ type: 'text', text: 'Which project? Pass project_id, or start_recording with project_id.' }], isError: true };
      }
      const found = stepsOfBusinessPhrase(projectId, phrase);
      if (found.error) return { content: [{ type: 'text', text: found.error }], isError: true };

      const session = sess();
      // Its values ({{secret.…}}, a value kept) worked out as the session knows them; the steps
      // recorded keep them as written.
      const played = await playBusinessSteps(found, {
        sendCommand, live: (params) => session.live(params), tabId: tabId ?? session.lastTabId, elementTimeoutMs: elementTimeoutFor(projectId),
      });
      if (played.error) return { content: [{ type: 'text', text: played.error }], isError: true };
      if (played.tabId) session.adoptTab(played.tabId);
      if (recording) {
        for (const step of found.steps) recording.steps.push(structuredClone(step));
        log(`[${session.id}] Business step played and recorded: "${found.phrase}" (${found.steps.length} steps)`);
      }
      return { content: [{ type: 'text', text: `Played "${found.phrase}" (${found.steps.length} steps)${recording ? ': recorded as this business step' : ''}.` }] };
    }
  );

  // --- Tool: stop_recording ---
  server.tool(
    'stop_recording',
    'Stop the current recording and save the test. Actions still under way are recorded first. Automatically detects variables (fill values become {{variables}} — named as record_step said —, clicks on list/box items become selectable by index or text). A last wait for an element is kept (it checks the outcome); a last wait of a time only is not. All variable detection runs in batch at save time for faster recording.',
    {},
    async () => {
      // An action sent with it, in the same message, is recorded first: before, it was lost.
      await settleActions(sess());
      const recording = getRecording();
      if (!recording) {
        return { content: [{ type: 'text', text: 'No recording in progress.' }] };
      }
      
      import('../websocket.js').then(({ pushOverlayState }) => {
        pushOverlayState(null, null, sess().lastTabId ?? null); // null state hides the overlay
      }).catch(() => {});

      if (recording.steps.length === 0) {
        setRecording(null);
        return { content: [{ type: 'text', text: 'Recording cancelled — no steps were recorded.' }] };
      }

      // ─── Step cleanup: remove parasitic recovery steps ────────────
      const cleanup = cleanRecoverySteps(recording.steps);
      recording.steps = cleanup.steps;

      log(`Batch variable detection for ${recording.steps.length} steps...`);
      // Playing a dataset, its columns are the variables of what came from it, and only those.
      const row = recording.dataset?.row ?? null;
      const usedVarNames = new Set(row ? Object.keys(row) : []);

      // ─── Batch variable detection ─────────────────────────────────
      for (let i = 0; i < recording.steps.length; i++) {
        const step = recording.steps[i];
        if (step.variable) {
          usedVarNames.add(step.variable.name);
          continue; // already variabilized
        }

        // What was typed (fill) or picked in a <select>: a variable named after the field.
        if (variabilizeInput(step, i, usedVarNames, row)) {
          log(`Auto-variabilized ${step.command} step ${i + 1}: {{${step.variable.name}}} = "${step.variable.defaultValue}"`);
          continue;
        }

        // Auto-detect CLICK on list/box items (with deduplication)
        if (step.command === 'click' && !step._skipVariable) {
          // A suggestion picked right after typing: a variable of its own, found without its list (gone by now).
          if (variabilizeSuggestion(recording.steps, i, usedVarNames)) {
            log(`Auto-variabilized click step ${i + 1}: {{${step.variable.name}}} picked among the suggestions of {{${step.variable.suggestionOf ?? '?'}}}`);
            continue;
          }
          const cssLocator = (step.locators || []).find(l => l.type === 'css');
          const selector = step.params.selector || (cssLocator && cssLocator.value);
          const clickText = step.params.text;

          if (selector || clickText) {
            try {
              // Read when it was clicked, on its page (the click tool); else now, on the page left open.
              const listContext = step._listContext !== undefined ? step._listContext
                : await detectListContext(sendCommand, { selector, text: clickText, tabId: step.params.tabId });
              // The item an earlier step picked — the second product's card, its "Add" then its "+" —:
              // the same variable, its own element in the card.
              const sameItem = listContext && sameItemVariable(recording.steps, i, listContext);
              if (sameItem) {
                step.variable = sameItem;
                log(`Auto-variabilized click step ${i + 1}: {{${sameItem.name}}}, the item an earlier step picked`);
              } else {
                // What the agent said (record_step pick) before what the classifier says.
                const judged = await judgeListClick(listContext, step, { afterTyping: typedJustBefore(recording.steps, i) });
                if (judged) {
                  const varName = uniqueVarName(step._variableNameOverride || judged.variableName, usedVarNames);
                  step.variable = listVariable(varName, listContext, judged);
                  log(`Auto-variabilized click step ${i + 1}: {{${varName}}} in ${listContext.type}${listContext.withinXpath ? ' (an element of the item)' : ''}${step._pick ? ` (${step._pick}, as the agent said)` : ''}`);
                }
              }
            } catch (err) {
              log(`Variable detection failed for step ${i + 1}: ${err.message}`);
            }
          }
          continue;
        }
      }

      // ─── Build variables summary ──────────────────────────────────
      const variables = {};
      recording.steps.forEach((step, i) => {
        // A variable several steps share (one card picked): told by the first of them.
        if (step.variable && !variables[step.variable.name]) {
          variables[step.variable.name] = {
            type: step.variable.type,
            defaultValue: step.variable.defaultValue || '',
            step: i + 1,
            description: step.intent || `${step.command} in step ${i + 1}`
          };
        }
      });
      // The checks made while recording, linked to what was typed: a replay with other values checks those.
      const checks = linkRecordedChecks(recording.steps, variables, row);

      const test = {
        name: recording.name,
        description: recording.description,
        createdAt: new Date(recording.startedAt).toISOString(),
        variables: Object.keys(checks.variables).length > 0 ? checks.variables : undefined,
        viewport: recording.viewport || null,
        steps: recording.steps
      };

      const testId = await saveTest(test);
      const stepCount = recording.steps.length;
      const varCount = Object.keys(variables).length;
      log(`Recording saved: test id ${testId} (${stepCount} steps, ${varCount} variables)`);
      setRecording(null);

      let summary = `Test "${test.name}" saved with ${stepCount} steps (id: ${testId})`;
      if (cleanup.removed.length) summary += `\nNot kept: ${cleanup.removed.join('; ')}.`;
      for (const { step, names } of checks.linked) summary += `\nThe check of step ${step} is linked to ${names.map((n) => `{{${n}}}`).join(', ')}.`;
      summary += linkRecorded(recording);
      summary += placeRecorded(recording);
      if (varCount > 0) {
        summary += `\n\n${varCount} variable(s) detected for dynamic replay:\n`;
        for (const [name, info] of Object.entries(variables)) {
          summary += `  - {{${name}}} — type: ${info.type}, default: "${info.defaultValue}" (step ${info.step})\n`;
        }
        summary += `\nTo run with different data: run_test("${test.name}", { variables: { ${Object.keys(variables).map(k => `"${k}": "new_value"`).join(', ')} } })`;
      }
      summary += await closeRecordingWindow();
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
        const played = rowsOfTest(test.name);
        if (played) line += `\n    Rows: ${played.row_count} of ${rowsSource(played)} — run_test plays every row, a run each`;
        return line;
      });
      return { content: [{ type: 'text', text: `Saved tests:\n${summaries.join('\n')}` }] };
    }
  );

  server.tool(
    'run_test',
    'RUN a saved test autonomously inside the browser extension. The extension will execute ALL steps in one incredibly fast sequence without LLM intervention. Supports dynamic variables: pass "variables" to override {{placeholders}} recorded in fill steps and list/box item selections. Use list_tests to see available variables for each test. A test with rows (typed in its Data tab, or those of the dataset it is bound to) plays every row, a run each, its values over the defaults; "row" plays one. Use "substitutions" for raw find-and-replace across all params. Each assertion is checked where it is in the test, on the page the steps before it led to (one that fails there stops the run), and reported. Set debug=true to enable step-by-step debug mode with breakpoints — use debug_action to control the paused execution.',
    {
      name: z.string().describe('Name of the test to run'),
      variables: z.record(z.string()).optional().describe('Template variables: replaces {{key}} placeholders in params. For list/box items, pass the index (e.g. "2") or text content to select.'),
      substitutions: z.record(z.string()).optional().describe('Find-and-replace in all step params. Keys are old values, values are new values. Example: { "Antony": "Marseille" } replaces all occurrences of "Antony" with "Marseille" in every step.'),
      start_step: z.number().optional().describe('Step number to start from (1-indexed). Use this to resume a test after fixing a prior failed step manually.'),
      new_window: z.boolean().optional().default(true).describe('Runs the test in a new browser window. Defaults to true. Set to false to reuse the current tab.'),
      debug: z.boolean().optional().describe('Enable debug mode: execution pauses before each step (or at breakpoints). Use debug_action tool to resume/step/continue.'),
      breakpoints: z.array(z.number()).optional().describe('Step numbers (1-indexed) to pause at. Only used when debug=true. If empty, pauses at every step.'),
      row: z.number().optional().describe('For a test with rows (its own, or those of the dataset it is bound to): the one row to play, numbered from 1. Without it, every row is played, a run each — one row only (the first) with debug or start_step.'),
      record_video: z.boolean().optional().describe('Keep the video of the run even if it passes (a failed run keeps its video anyway): watched in the dashboard, the run\'s steps beside it'),
      close_window: z.boolean().optional().describe('Close the window of a run that passed. Default: as the user chose in Settings → Browser windows. false keeps it open — to add_assertion on the page it ended on. A failed run\'s window always stays open: repair the step there.'),
    },
    async ({ name, variables, substitutions, start_step, new_window, debug, breakpoints, row, record_video, close_window }) => {
      // Debug mode: run asynchronously and return immediately with execution ID
      if (debug) {
        const debugController = new DebugController(breakpoints || [], 'step');

        // Run execution in background — do not await.
        // Wrap in a settled promise to prevent unhandled rejection crashes.
        // debug_action reads _executionResult / _executionError later.
        const executionPromise = executeTest(
          name, variables, substitutions, start_step, new_window,
          sendCommand, 'mcp', null, debugController, { row }
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

      // Normal (non-debug) execution. With rows (lib/datasets.js), every row, a run each — or
      // the one asked, or the first when resumed at a step.
      const played = rowsOfTest(name);
      const rowText = (n) => (n && played?.rows[n - 1] ? `${rowLabel(shownRow(played.rows[n - 1]), n)} of ${rowsSource(played)}` : n ? `row ${n}` : '');
      const succeeded = (res, n) => {
        let resultText = `Test "${name}" executed successfully (execution #${res.executionId})${n ? `, ${rowText(n)}` : ''}.`;
        if (res.assertionsTotal > 0) {
          resultText += `\n\nAssertions: ${res.assertionsPassed}/${res.assertionsTotal} passed`;
          if (res.assertionsFailed > 0) {
            resultText += ` (${res.assertionsFailed} failed)`;
          }
        }
        if (res.video) resultText += `\n\nVideo kept (${res.video.frames} images): in the dashboard, the run's Video button.`;
        if (res.optionalNotDone?.length) resultText += `\n\nOptional step(s) not done, the test went on: ${res.optionalNotDone.map((o) => `step ${o.step} (${o.error})`).join('; ')}.`;
        // The bugs this test met, fixed now that it passes (lib/bugs.js).
        if (res.bugs?.fixed?.length) resultText += `\n\nBug(s) ${res.bugs.fixed.map((id) => `#${id}`).join(', ')} marked fixed in the Bugs page: this test met them, and passes again.`;
        if (res.bugs?.changed?.length) resultText += `\n\nBug(s) ${res.bugs.changed.map((id) => `#${id}`).join(', ')} left open: this test passes, but was changed since it met them — it may no longer check what failed. Tell the user.`;
        return resultText;
      };
      // `inPlace`: the page is still where it failed (the last run played), repaired there.
      const failed = (err, n, { inPlace = true } = {}) => {
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

        let text = `TEST EXECUTION FAILED${execId}${n ? `, ${rowText(n)}` : ''}\n\n`;
        if (!inPlace) {
          return `${text}Step ${failedStep}/${totalSteps} [${failedCmd}] ${failedIntent || ''}: ${msg}\n${err.triage ? `${formatTriage(err.triage)}\n` : ''}` +
            `${err.bug ? `Bug #${err.bug.id} in the Bugs page: ${err.bug.title}\n` : ''}` +
            `The rows after it were played, the page is no longer where it failed: to repair it, run_test(name="${name}", row=${n}) plays that row alone and stops there, with what to do.\n`;
        }
        if (err.video) text += `Video of the run kept (${err.video.frames} images): in the dashboard, the run's Video button.\n\n`;
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

        // Why it failed, worked out on the page it failed on (lib/triage.js).
        const triage = err.triage;
        const repair = triage?.proposals?.[0];
        if (triage) text += `=== TRIAGE ===\n${formatTriage(triage)}\n\n`;
        // Put on the app: kept as a bug (lib/bugs.js), closed when the test passes again.
        if (err.bug) {
          const b = err.bug;
          text += `=== BUG ===\nBug #${b.id} ${b.isNew ? 'opened' : b.reopened ? 'open again (it was fixed)' : `seen again (${b.occurrences} times${b.status !== 'open' ? `, ${b.status}` : ''})`} in the Bugs page: ${b.title}. It is marked fixed when this test passes again, unchanged.\n\n`;
        } else if (err.bugToReport) {
          text += `=== BUG ===\nNo bug opened: this project's bugs are reported by a person. The diagnosis puts the failure on the app — tell the user; if they agree, it is reported from this run's report in the dashboard (Report a bug).\n\n`;
        }

        text += `=== ACTION REQUIRED ===\n`;
        if (repair) {
          text += `A repair is proposed (#${repair.id}). Check it: verify_repair(repair_id=${repair.id}) replays the test with it, without saving it. `;
          text += repair.needs_review
            ? `It accepts what the page shows now: ask the user whether that change is intended before resolve_repair(repair_id=${repair.id}, decision="apply").\n`
            : `If the test passes, tell the user what it changes, and on their word save it: resolve_repair(repair_id=${repair.id}, decision="apply").\n`;
          // The element it relocates, acted on by other tests: one fix for all of them.
          const shared = repairUses(getRepair(repair.id));
          if (shared) {
            text += `Its element "${shared.element.name}" is also acted on by ${shared.uses.length} other step(s) in ${shared.tests} test(s) (${stepsText(shared.uses)}): ` +
              `ask the user whether to fix them too — resolve_repair(repair_id=${repair.id}, decision="apply", all_uses=true).\n`;
          }
          text += `If it does not fix the test, fix the step by hand:\n`;
        } else if (triage?.cause === 'test_outdated') {
          text += `The app does what its requirement says now; the test still expects the old value. Update the test to what the requirement says, then tell the user which test changed and why.\n`;
        } else if (triage?.cause === 'session_state') {
          text += `The test is not broken: it started in a browser already logged in. Make it start logged out (a first step to the app's logout URL), then run it again — do NOT change its login steps.\n`;
        } else if (['app_regression', 'environment', 'changed_value', 'disabled', 'non_conformity'].includes(triage?.cause)) {
          text += `This does not look like a broken test (${triage.cause}): do NOT change the test to make it pass — report it to the user first. To fix the step by hand once they agree:\n`;
        }
        text += `1. Use 'snapshot' to see the current page state.\n`;
        text += `2. Perform ONLY the failed step ${failedStep} manually. The failed step was a "${failedCmd}" command${failedIntent ? ' ("' + failedIntent + '")' : ''}. Use the matching browser tool.\n`;
        text += `3. Call fix_test_step(test_name="${name}", step_order=${failedStep}, action_id=<the_action_id>).\n`;
        text += `4. Call run_test(name="${name}", start_step=${nextStep || failedStep}${n ? `, row=${n}` : ''}) to continue remaining steps.\n\n`;
        text += `CRITICAL RULES:\n`;
        text += `- Steps 1–${completedSteps} already SUCCEEDED. Do NOT re-execute, re-navigate, or modify them.\n`;
        text += `- fix_test_step must target step_order=${failedStep} ONLY. Do NOT modify any other step.\n`;
        text += `- The page is already at the correct state after ${completedSteps} successful steps. Do NOT navigate again.\n`;
        text += `- Your manual fix should match the original command type "${failedCmd}" (e.g., if it was a click, fix it with a click, not a navigate).`;
        return text;
      };

      const play = (n) => executeTest(name, variables, substitutions, start_step, new_window, sendCommand, 'mcp', null, null, { ...(n ? { row: n } : {}), recordVideo: record_video === true });
      const { rows, outcomes } = await executeRows(name, { row, one: !!start_step }, play);
      for (const { result, error } of outcomes) {
        const done = result ?? error;
        rememberReplay(name, done.values, result ? result.results?.findLast?.((r) => r.tabId != null)?.tabId : error.tabId);
      }
      // The window of a run that passed, closed as the user chose (Settings → Browser windows,
      // lib/run-windows.js) or as close_window says; a failed run's stays open: repaired there.
      let closedNote = '';
      if (new_window && (close_window ?? closesAfterRun(true))) {
        let closed = 0;
        for (const { result } of outcomes) {
          if (result && await closeWindowOf(sendCommand, result.results?.findLast?.((r) => r.tabId != null)?.tabId)) closed++;
        }
        if (closed) {
          closedNote = `\n\n${closed > 1 ? `The windows of the ${closed} runs that passed were` : 'Its window was'} closed (${close_window ? 'close_window' : 'as the user chose: Settings → Browser windows'}). ` +
            'To add an assertion on the page it ended on, run it again with close_window: false.';
        }
      }
      if (rows.length === 1) {
        const [{ row: n, result, error }] = outcomes;
        return { content: [{ type: 'text', text: result ? `${succeeded(result, n)}${closedNote}\n\n${JSON.stringify(result.results, null, 2)}` : failed(error, n) }] };
      }
      // Every row: each told; a failed one in full — repaired in place when it is the last played.
      const failures = outcomes.filter((o) => o.error);
      const lines = [`Test "${name}" played ${rows.length} rows of ${rowsSource(played)}, a run each: ${outcomes.length - failures.length} passed, ${failures.length} failed.`];
      for (const o of outcomes) {
        lines.push(o.result
          ? `- ${rowText(o.row)}: passed (execution #${o.result.executionId}${o.result.assertionsTotal ? `, assertions ${o.result.assertionsPassed}/${o.result.assertionsTotal}` : ''})`
          : `- ${rowText(o.row)}: FAILED${o.error.executionId ? ` (execution #${o.error.executionId})` : ''} — ${String(o.error.message ?? o.error).split('\n')[0]}`);
      }
      // What a passed run has to say besides (a video kept, an optional step not done, a bug fixed).
      for (const o of outcomes.filter((x) => x.result)) {
        const notes = succeeded(o.result, o.row).split('\n\n').slice(1).filter((p) => !p.startsWith('Assertions:'));
        if (notes.length) lines.push('', `Row ${o.row}: ${notes.join(' ')}`);
      }
      const lastPlayed = outcomes.at(-1);
      for (const o of failures) lines.push('', failed(o.error, o.row, { inPlace: o === lastPlayed }));
      if (closedNote) lines.push(closedNote);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
    'Add an assertion step to a test. While the test is recorded (test_name: the one being recorded), call it right after the action whose result it checks, before the next action: it is recorded as the next step, and on a replay it holds the test there until what it checks shows (up to the project\'s wait). On a saved test it is appended at the end, or put at step_order — but it is checked on the page as it is now: give a step_order only when the page now is what that step sees. The assertion is first evaluated live against the current browser page to verify it passes. If it fails, the assertion is NOT added and the failure details are returned so you can fix the selector or expected value. Only passing assertions are saved to the test — except the checks of what the page does wrong on its own (no_console_errors, no_failed_requests, link_ok, no_a11y_violations): failing, such a check makes the test reproduce the bug (it passes once the bug is fixed); passing, it guards against it. And except, on a test linked to a requirement, the expected result the requirement states, when the element is there but shows something else and you pass non_conformity: true: the test then reports that non-conformity — give the expected value from the requirement, never what the page shows.',
    {
      test_name: z.string().describe('Name of the test to add the assertion to'),
      assertion_type: z.enum([
        'element_exists', 'element_not_exists', 'element_visible', 'element_hidden',
        'text_equals', 'text_contains', 'text_not_contains', 'attribute_equals',
        'url_equals', 'url_contains', 'title_equals', 'title_contains',
        'element_count', 'no_console_errors', 'no_failed_requests', 'link_ok', 'no_a11y_violations'
      ]).describe('Type of assertion'),
      selector: z.string().optional().describe('CSS selector for element assertions; for link_ok, the link (a[href="/pricing"]); for no_a11y_violations, the part of the page to check'),
      expected: z.string().optional().describe('Expected value for comparison assertions; for no_console_errors, a fragment of the error message; for no_failed_requests, a fragment of the request URL; for no_a11y_violations, the axe rule id (e.g. "image-alt")'),
      attribute: z.string().optional().describe('Attribute name for attribute_equals assertion'),
      description: z.string().optional().describe('Human-readable description of what this assertion verifies'),
      step_order: z.number().optional().describe('On a saved test: position to insert (1-indexed). If omitted, appends at the end. Not used while recording: the check goes right after the last action.'),
      tabId: z.number().optional().describe('Tab to check the assertion in: e.g. the tabId run_test reports, to assert on the page a replay ended on. Default: this session\'s window.'),
      non_conformity: z.boolean().optional().describe('On a test linked to a requirement: the expected value is the requirement\'s, the page does not show it, and you checked the steps before did what they should. The assertion is saved failing: the test reports the non-conformity.')
    },
    async ({ test_name, assertion_type, selector, expected, attribute, description, step_order, tabId, non_conformity }) => {
      const assertion = { type: assertion_type };
      if (selector) assertion.selector = selector;
      if (expected !== undefined) assertion.expected = expected;
      if (attribute) assertion.attribute = attribute;

      // Validate required fields
      const needsSelector = ['element_exists', 'element_not_exists', 'element_visible', 'element_hidden', 'text_equals', 'text_contains', 'text_not_contains', 'attribute_equals', 'element_count', 'link_ok'];
      if (needsSelector.includes(assertion_type) && !selector) {
        return { content: [{ type: 'text', text: `Assertion type "${assertion_type}" requires a CSS selector.` }] };
      }
      const needsExpected = ['text_equals', 'text_contains', 'text_not_contains', 'attribute_equals', 'url_equals', 'url_contains', 'title_equals', 'title_contains', 'element_count'];
      if (needsExpected.includes(assertion_type) && expected === undefined) {
        return { content: [{ type: 'text', text: `Assertion type "${assertion_type}" requires an expected value.` }] };
      }
      if (assertion_type === 'attribute_equals' && !attribute) {
        return { content: [{ type: 'text', text: 'Assertion type "attribute_equals" requires an attribute name.' }] };
      }

      // While its test is recorded, a check is the recording's next step (lib/recorded-checks.js).
      const recording = getRecording();
      const recorded = checksRecording(recording, test_name);
      const test = recorded ? null : loadTest(test_name);
      if (!recorded && !test) {
        const hint = recording ? ` The test being recorded is "${recording.name}": pass that name to check the result of its last action.` : '';
        return { content: [{ type: 'text', text: `Test "${test_name}" not found.${hint}` }] };
      }

      // ─── Evaluate assertion live against the current browser page ───
      // A value kept by the session ({{order}}) or computed ({{today}}) is checked as it is now;
      // the step keeps the assertion as written.
      let result;
      try {
        result = await evaluateAssertion(sendCommand, sess().live(assertion), tabId);
      } catch (err) {
        return { content: [{ type: 'text', text: `Assertion evaluation error: ${err.message}\nThe assertion was NOT added. Fix the issue and try again.` }] };
      }

      // A check of what the page does wrong is added failing too: the test then reproduces the bug.
      const isOracle = ORACLE_ASSERTIONS.has(assertion_type);
      // So is the expected result of a requirement the test checks, when the page shows something
      // else — once the agent says so (non_conformity), having checked the steps before did what
      // they should. Never when the element is not found: a wrong selector.
      const { requirements, elementFound, nonConformity } = nonConformityOf(test_name, result, non_conformity, recorded ? recordingRequirements(recording) : undefined);
      if (!result.passed && !isOracle && !nonConformity) {
        let msg = `Assertion FAILED — not added to test "${test_name}".\n`;
        msg += `  Type: ${assertion_type}\n`;
        if (selector) msg += `  Selector: ${selector}\n`;
        msg += `  Expected: ${result.expected}\n`;
        msg += `  Actual:   ${result.actual}\n\n`;
        msg += `Fix the selector or expected value and try again. Use 'snapshot' to inspect the current page.`;
        if (requirements.length && elementFound) {
          msg += `\n\nThis test checks ${requirements.map((r) => r.key).join(', ')}. If the expected value is the requirement's and the page really does not meet it — `
            + `check first that the steps before did what they should (snapshot, screenshot) — call again with non_conformity: true: it is saved failing, and the test reports the non-conformity.`;
        }
        return { content: [{ type: 'text', text: msg }] };
      }

      const verdict = (where) => (result.passed ? `Assertion PASSED and ${where}.\n`
        : isOracle ? `Assertion FAILS now and was ${where}: the test reproduces this bug, and will pass once it is fixed.\n`
          : `Assertion FAILS now and was ${where}: the app does not meet ${requirements.map((r) => r.key).join(', ')} — the test reports this non-conformity until the app is fixed. Tell the user.\n`);
      const shown = () => `  Type: ${assertion_type}\n${selector ? `  Selector: ${selector}\n` : ''}  Expected: ${result.expected}\n  Actual:   ${result.actual}`;

      if (recorded) {
        // Kept as written: what it names that was typed is linked to the variables at stop_recording.
        const page = pageOf(result.pageUrl);
        const intentText = description || `Assert: ${assertion_type}${selector ? ` on ${selector}` : ''}${expected ? ` = "${expected}"` : ''}`;
        const { step, after } = recordCheck(sess(), { assertion, intent: intentText, page });
        let summary = verdict(`recorded as step ${step} of "${test_name}"${after ? `, right after ${after}` : ''}`);
        summary += shown();
        summary += '\n  On a replay it holds the test there until it holds (up to the project\'s wait), before the next action.';
        if (step_order) summary += '\n  step_order is not used while recording: a check goes right after the last action.';
        return { content: [{ type: 'text', text: summary }] };
      }

      // ─── Assertion passed — save it to the test ───
      // Checked against what the test typed: replayed with other values, it checks those.
      // On the window of a replay of this test, what the page shows is what that replay typed.
      const replay = tabId != null ? sess().replays?.get(tabId) : undefined;
      // Bound to a dataset, what its row shows is its column's too: "Welcome Bob" checks {{name}}.
      const fromDataset = datasetVariables(test_name);
      const { assertion: saved, linked, ambiguous } = linkAssertionToVariables(
        assertion, { ...fromDataset, ...test.variables }, replay?.test === test_name ? replay.values : undefined);
      test.variables = withColumnsOf(test.variables, fromDataset, saved.expected);
      const intentText = description || `Assert: ${assertion_type}${selector ? ` on ${selector}` : ''}${expected ? ` = "${expected}"` : ''}`;
      // The page it was checked on: what it checks is an element of that page (lib/elements.js).
      const page = pageOf(result.pageUrl);
      const newStep = {
        command: 'assert',
        params: {},
        intent: intentText,
        assertion: saved,
        ...(page && { page }),
      };

      if (step_order && step_order > 0 && step_order <= test.steps.length + 1) {
        test.steps.splice(step_order - 1, 0, newStep);
      } else {
        test.steps.push(newStep);
      }

      saveTest(test);
      const pos = step_order || test.steps.length;
      let summary = verdict(`added to test "${test_name}" at step ${pos}`) + shown();
      if (linked.length) {
        summary += `\n  Linked to ${linked.map(n => `{{${n}}}`).join(', ')}: saved as "${saved.expected}", ` +
          'so a replay with other values checks those values.';
      }
      for (const { name, value, found } of ambiguous) {
        summary += `\n  Not linked to {{${name}}}: "${value}" is found ${found} times in the expected text, ` +
          'so which one it is cannot be told. Give an expected text where it is found once to link it.';
      }
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  // --- Tool: fix_test_step ---
  server.tool(
    'fix_test_step',
    'Update a failed test step with the params and locators from a successful manual action. Call this AFTER you manually performed a browser action to fix a failed step. It replaces the step\'s command, params, and locators in the saved test so future runs will use the fixed version. Its answer says how many other steps of the project act on the same element: with all_uses=true (on the user\'s word) they are given the new locators too.',
    {
      test_name: z.string().describe('Name of the test containing the step to fix'),
      step_order: z.number().describe('The step number to update (1-indexed, as reported in the error)'),
      action_id: z.string().describe('The action_id returned by the browser tool you used to fix the step (e.g. "act_5")'),
      intent: z.string().optional().describe('Updated human-readable description for this step'),
      all_uses: z.boolean().optional().describe('Also give the new locators to the other steps of the project acting on the same element — the same element found another way, not another one. Default false.')
    },
    async ({ test_name, step_order, action_id, intent, all_uses }) => {
      const action = getAction(action_id);
      if (!action) {
        return { content: [{ type: 'text', text: `Action ID "${action_id}" not found. Make sure you pass the action_id returned by the browser tool you just used.` }] };
      }

      const newStepData = {
        command: action.command,
        params: { ...action.params },
        locators: action.locators || null,
        intent: intent || null,
        ...(action.page && { page: action.page }),
      };

      // Purge null/undefined from params
      Object.keys(newStepData.params).forEach(k => {
        if (newStepData.params[k] === undefined || newStepData.params[k] === null) {
          delete newStepData.params[k];
        }
      });

      try {
        const test = loadTest(test_name);
        const before = test?.steps?.[step_order - 1];
        // Redone by hand, the step keeps its variable: what it typed, the suggestion it picks.
        Object.assign(newStepData, keepStepVariable(before, newStepData));
        const result = await updateTestStep(test_name, step_order, newStepData);
        if (!result) {
          return { content: [{ type: 'text', text: `Test "${test_name}" or step ${step_order} not found.` }] };
        }
        log(`Step ${step_order} of "${test_name}" fixed via ${action_id}: ${action.command}`);
        let text = `Step ${step_order} of "${test_name}" updated successfully.\n  Command: ${action.command}\n  Locators: ${action.locators ? action.locators.length + ' locator(s)' : 'none'}\nThe test is now permanently fixed for future runs.`;
        // The other steps acting on the element it found the old way.
        const after = { ...newStepData, page: newStepData.page ?? before?.page };
        if (test?.project_id && before && before.command === after.command) {
          // The fixed step acts on the element it acted on: it keeps its name.
          const self = { test: test_name, order: step_order };
          const { element, relocated } = relocateElement(test.project_id, { ...self, before, after, allUses: !!all_uses, join: true });
          if (relocated.length) text += `\n${relocated.length} other step(s) acting on "${element.name}" were given the new locators too: ${stepsText(relocated)}.`;
          const { element: same, uses, tests } = usesOfStep(test.project_id, after, self, after);
          if (uses.length) text += `\nIts element "${same.name}" is also acted on by ${uses.length} other step(s) in ${tests} test(s) (${stepsText(uses)}), which still find it the old way: ask the user whether to fix them too — fix_test_step again with all_uses=true.`;
        }
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to update step: ${err.message}` }] };
      }
    }
  );

  // --- Tool: set_step_optional ---
  server.tool(
    'set_step_optional',
    [
      'Make a step of a saved test optional — a step the app may not need on every run: a cookie banner or a popup only shown',
      'sometimes, a tour to dismiss. On a replay, when it fails, its failure is told (the step reads "skipped") and the test goes',
      'on; the test passes if the rest does. It still waits for its element as any step does. Never for a step the test is',
      'about: a check that fails there must fail the test. optional: false makes it required again.',
    ].join(' '),
    {
      test_name: z.string(),
      step_order: z.number().int().describe('The step (1-indexed)'),
      optional: z.boolean().optional().describe('Default true'),
    },
    async ({ test_name, step_order, optional = true }) => {
      const step = setStepOptional(test_name, step_order, optional);
      if (!step) return { isError: true, content: [{ type: 'text', text: `No step ${step_order} in test "${test_name}".` }] };
      return { content: [{ type: 'text', text: `Step ${step_order} of "${test_name}" (${step.command}${step.intent ? `: ${step.intent}` : ''}) is ${optional ? 'optional: on a replay, its failure is told and the test goes on' : 'required again'}.` }] };
    }
  );

  // --- Tool: list_repairs ---
  server.tool(
    'list_repairs',
    'List the repairs proposed when runs of a test failed (run_test diagnoses every failure): what each changes, why, and where it stands — proposed, verified (the test passes with it), failed (it does not), applied, rejected, stale (the step was edited since).',
    {
      test_name: z.string().optional().describe('Only this test\'s repairs. Default: every test.'),
      open_only: z.boolean().optional().describe('Only the repairs not applied or rejected yet (default true)')
    },
    async ({ test_name, open_only }) => {
      const repairs = listRepairs({ testName: test_name, open: open_only ?? true });
      if (!repairs.length) return { content: [{ type: 'text', text: `No ${open_only === false ? '' : 'open '}repair${test_name ? ` for "${test_name}"` : ''}.` }] };
      return { content: [{ type: 'text', text: repairs.map(describeRepair).join('\n\n') }] };
    }
  );

  // --- Tool: verify_repair ---
  server.tool(
    'verify_repair',
    'Replay a test with a proposed repair made, without saving it, as the failed run was played (same variables and substitutions). Verified when the whole test passes — assertions included. The window it ran in stays open.',
    {
      repair_id: z.number().describe('Id of the repair, from run_test\'s TRIAGE section or list_repairs')
    },
    async ({ repair_id }) => {
      try {
        const { repair, passed, error, tabId } = await verifyRepair(repair_id, sendCommand);
        const verdict = passed
          ? `Verified: the test passes with repair #${repair_id}. Nothing is saved yet: resolve_repair(repair_id=${repair_id}, decision="apply") once the user agrees.`
          : `Not verified: the test still fails with repair #${repair_id}.\n${error}`;
        return { content: [{ type: 'text', text: `${verdict}${tabId ? `\n(tab ${tabId})` : ''}\n\n${describeRepair(repair)}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
  );

  // --- Tool: resolve_repair ---
  server.tool(
    'resolve_repair',
    'Apply a proposed repair to the saved test, or reject it. Apply only on the user\'s word: a repair of kind "expect" makes the test accept what the page shows now, which may be the very regression the test exists to catch. A repair that finds an element another way says how many other steps of the project act on that element (list_repairs, verify_repair, run_test): with all_uses=true they are given the new locators too — ask the user. Called again with all_uses=true on an applied repair, it fixes those other steps.',
    {
      repair_id: z.number().describe('Id of the repair'),
      decision: z.enum(['apply', 'reject']),
      all_uses: z.boolean().optional().describe('With "apply": also give the new locators to the other steps of the project that act on the same element, each keeping what it does (its value, what it checks). Default false: only this step.')
    },
    async ({ repair_id, decision, all_uses }) => {
      try {
        const repair = decision === 'apply' ? applyRepair(repair_id, { allUses: !!all_uses }) : rejectRepair(repair_id);
        const others = repair.relocated?.length ? ` ${repair.relocated.length} other step(s) acting on the same element were given the new locators too: ${stepsText(repair.relocated)}.` : '';
        const done = decision === 'apply' ? `Applied: step ${repair.step_order} of "${repair.test_name}" is repaired.${others}` : `Rejected: repair #${repair_id} will not be applied.`;
        return { content: [{ type: 'text', text: `${done}\n\n${describeRepair(repair)}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
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
