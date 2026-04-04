// Workflow recording & replay MCP tools

import { z } from 'zod';
import { log } from '../logger.js';
import {
  getRecording, setRecording,
  getLastRefMap,
  getAction, saveActionToHistory,
  classifyWithLLM, detectListContext,
  loadWorkflow, saveWorkflow, deleteWorkflow as deleteWorkflowDb, listWorkflows as listWorkflowsDb, executeWorkflow,
  updateWorkflowStep
} from '../workflows.js';


export function registerWorkflowTools(server, { sendCommand }) {

  // --- Tool: start_recording ---
  server.tool(
    'start_recording',
    'Start recording a reusable browser automation workflow. When the user asks to "record", "save", or "enregistrer" a workflow/parcours, call this tool FIRST. Then use record_step after each successful browser action (navigate, click, fill, etc.). Finally call stop_recording when done.',
    {
      name: z.string().describe('Name of the workflow (used as filename)'),
      description: z.string().optional().describe('Human-readable description of what the workflow does')
    },
    async ({ name, description }) => {
      const recording = getRecording();
      if (recording) {
        return { content: [{ type: 'text', text: `Already recording workflow "${recording.name}". Stop it first with stop_recording.` }] };
      }
      setRecording({ name, description: description || '', steps: [], startedAt: Date.now() });
      log(`Recording started: ${name}`);
      return { content: [{ type: 'text', text: `Recording started for workflow "${name}". Use record_step after each successful action.` }] };
    }
  );

  // --- Tool: record_step ---
  server.tool(
    'record_step',
    'Record a single successful browser action step into the current workflow. Call this AFTER an action succeeds by passing its action_id (e.g. "act_1"). Automatically detects if the step should be variabilized (fill values become {{variables}}, clicks on list/box items become selectable by index or text). This guarantees 100% accurate parameters recording and enables dynamic workflow replay with different data sets.',
    {
      action_id: z.string().describe('The ID of the action to record (returned when you executed the command, e.g. "act_1")'),
      intent: z.string().optional().describe('Human-readable description of what this step does (e.g. "click the login button")'),
      variable_name: z.string().optional().describe('Override the auto-detected variable name for this step (e.g. "search_query", "product")'),
      skip_variable: z.boolean().optional().describe('Set to true to skip variable detection for this step (e.g. for fixed navigation clicks)')
    },
    async ({ action_id, intent, variable_name, skip_variable }) => {
      const recording = getRecording();
      if (!recording) {
        return { content: [{ type: 'text', text: 'No recording in progress. Call start_recording first.' }] };
      }

      const action = getAction(action_id);
      if (!action) {
        return { content: [{ type: 'text', text: `Action ID "${action_id}" not found. It might have expired or never existed. You must execute an action and pass the exact action_id returned.` }] };
      }

      const step = {
        command: action.command,
        params: { ...action.params },
        ...(action.locators && { locators: action.locators }),
        ...(intent && { intent })
      };

      // Purge null/undefined from params
      Object.keys(step.params).forEach(k => {
        if (step.params[k] === undefined || step.params[k] === null) {
          delete step.params[k];
        }
      });

      let variableInfo = null;
      let variableMsg = '';
      const lastRefMap = getLastRefMap();

      if (!skip_variable) {
        // Auto-variabilize FILL steps
        if (action.command === 'fill' && step.params.value) {
          const varName = variable_name || 'input_' + (recording.steps.length + 1);
          const originalValue = step.params.value;
          step.params.value = `{{${varName}}}`;
          variableInfo = {
            name: varName,
            type: 'text',
            defaultValue: originalValue
          };
          variableMsg = `\n📝 Variable detected: "{{${varName}}}" (type: text, default: "${originalValue}")`;
          log(`Auto-variabilized fill step: {{${varName}}} = "${originalValue}"`);
        }

        // Auto-detect CLICK on list/box items
        if (action.command === 'click' && !variableInfo) {
          const cssLocator = (action.locators || []).find(l => l.type === 'css');
          const selector = step.params.selector || (cssLocator && cssLocator.value);
          const clickText = step.params.text;

          if (selector || clickText) {
            log(`Detecting list context for ${selector ? 'selector: ' + selector : 'text: ' + clickText}`);
            const listContext = await detectListContext(sendCommand, { selector, text: clickText, tabId: action.params.tabId });

            if (listContext) {
              log(`List context detected: ${JSON.stringify(listContext)}`);
              const llmResult = await classifyWithLLM(listContext, intent);

              if (llmResult.isList) {
                const varName = variable_name || llmResult.variableName;
                variableInfo = {
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
                variableMsg = `\n🔗 Variable detected: "{{${varName}}}" (type: ${variableInfo.type}, ${llmResult.selectionMode === 'by_text' ? `text: "${listContext.selectedText}"` : `index: ${listContext.selectedIndex}`}, total items: ${listContext.totalItems})`;
                log(`Auto-variabilized click step: {{${varName}}} in ${listContext.type} (${llmResult.selectionMode})`);
              } else {
                log(`LLM classified element as NOT a list — skipping variabilization`);
              }
            }
          }
        }

        // Auto-variabilize SELECT interactions
        if (action.command === 'fill' && !variableInfo) {
          const refKey = action.params.ref ? String(action.params.ref).replace('@', '') : null;
          if (refKey && lastRefMap[refKey] && lastRefMap[refKey].role === 'combobox') {
            const varName = variable_name || 'select_' + (recording.steps.length + 1);
            const originalValue = action.params.value;
            step.params.value = `{{${varName}}}`;
            variableInfo = {
              name: varName,
              type: 'select',
              defaultValue: originalValue
            };
            variableMsg = `\n📋 Variable detected: "{{${varName}}}" (type: select, default: "${originalValue}")`;
          }
        }
      }

      if (variableInfo) {
        step.variable = variableInfo;
      }

      recording.steps.push(step);
      log(`Step recorded: ${action.command} via ${action_id} (${recording.steps.length} steps total)`);
      return { content: [{ type: 'text', text: `Step ${recording.steps.length} successfully appended to workflow: ${intent || action.command}${variableMsg}` }] };
    }
  );

  // --- Tool: stop_recording ---
  server.tool(
    'stop_recording',
    'Stop the current recording and save the workflow to disk. Returns a summary including detected variables that can be customized during replay.',
    {},
    async () => {
      const recording = getRecording();
      if (!recording) {
        return { content: [{ type: 'text', text: 'No recording in progress.' }] };
      }
      if (recording.steps.length === 0) {
        setRecording(null);
        return { content: [{ type: 'text', text: 'Recording cancelled — no steps were recorded.' }] };
      }

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

      const workflow = {
        name: recording.name,
        description: recording.description,
        createdAt: new Date(recording.startedAt).toISOString(),
        variables: Object.keys(variables).length > 0 ? variables : undefined,
        steps: recording.steps
      };

      const workflowId = await saveWorkflow(workflow);
      const stepCount = recording.steps.length;
      const varCount = Object.keys(variables).length;
      log(`Recording saved: workflow id ${workflowId} (${stepCount} steps, ${varCount} variables)`);
      setRecording(null);

      let summary = `Workflow "${workflow.name}" saved with ${stepCount} steps (id: ${workflowId})`;
      if (varCount > 0) {
        summary += `\n\n📊 ${varCount} variable(s) detected for dynamic replay:\n`;
        for (const [name, info] of Object.entries(variables)) {
          summary += `  • {{${name}}} — type: ${info.type}, default: "${info.defaultValue}" (step ${info.step})\n`;
        }
        summary += `\nTo replay with different data: replay_workflow("${workflow.name}", { variables: { ${Object.keys(variables).map(k => `"${k}": "new_value"`).join(', ')} } })`;
      }
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  // --- Tool: list_workflows ---
  server.tool(
    'list_workflows',
    'List all saved workflows available for replay.',
    {},
    async () => {
      const workflows = await listWorkflowsDb();
      if (workflows.length === 0) {
        return { content: [{ type: 'text', text: 'No workflows saved yet.' }] };
      }
      const summaries = workflows.map(workflow => {
        let line = `- ${workflow.name}: ${workflow.description || '(no description)'} (${workflow.steps.length} steps)`;
        if (workflow.variables && Object.keys(workflow.variables).length > 0) {
          const vars = Object.entries(workflow.variables).map(([k, v]) => `{{${k}}} (${v.type}, default: "${v.defaultValue}")`);
          line += `\n    Variables: ${vars.join(', ')}`;
        }
        return line;
      });
      return { content: [{ type: 'text', text: `Saved workflows:\n${summaries.join('\n')}` }] };
    }
  );

  // --- Tool: replay_workflow ---
  server.tool(
    'replay_workflow',
    'REPLAY a saved workflow autonomously inside the browser extension. The extension will execute ALL steps in one incredibly fast sequence without LLM intervention. Supports dynamic variables: pass "variables" to override {{placeholders}} recorded in fill steps and list/box item selections. Use list_workflows to see available variables for each workflow. Use "substitutions" for raw find-and-replace across all params.',
    {
      name: z.string().describe('Name of the workflow to replay'),
      variables: z.record(z.string()).optional().describe('Template variables: replaces {{key}} placeholders in params. For list/box items, pass the index (e.g. "2") or text content to select.'),
      substitutions: z.record(z.string()).optional().describe('Find-and-replace in all step params. Keys are old values, values are new values. Example: { "Antony": "Marseille" } replaces all occurrences of "Antony" with "Marseille" in every step.'),
      start_step: z.number().optional().describe('Step number to start from (1-indexed). Use this to resume a workflow after fixing a prior failed step manually.'),
      new_window: z.boolean().optional().describe('If true, replays the workflow in a completely new browser window instead of a new tab.')
    },
    async ({ name, variables, substitutions, start_step, new_window }) => {
      try {
        const res = await executeWorkflow(name, variables, substitutions, start_step, new_window, sendCommand, 'mcp');
        return { content: [{ type: 'text', text: `Workflow "${name}" replayed successfully (execution #${res.executionId}).\n\n${JSON.stringify(res.results, null, 2)}` }] };
      } catch (err) {
        const msg = err.message || String(err);
        const execId = err.executionId ? ` (execution #${err.executionId})` : '';
        const failedStep = err.failedStep || '?';
        const totalSteps = err.totalSteps || '?';
        const completedSteps = err.completedSteps || 0;
        const nextStep = err.failedStep ? err.failedStep + 1 : null;
        const failedCmd = err.failedStepCommand || '?';
        const failedIntent = err.failedStepIntent || '';

        // Build explicit list of step statuses so the agent knows exactly what succeeded
        let stepsReport = '';
        if (err.stepResults) {
          for (const sr of err.stepResults) {
            const icon = sr.status === 'success' ? '✅' : sr.status === 'failed' ? '❌' : '⏭️';
            stepsReport += `  ${icon} Step ${sr.step}: [${sr.command}] ${sr.intent || ''} — ${sr.status}${sr.error ? ' — ' + sr.error : ''}\n`;
          }
        } else {
          // Fallback: reconstruct from counts
          for (let s = 1; s <= completedSteps; s++) {
            stepsReport += `  ✅ Step ${s}: SUCCEEDED (do NOT touch)\n`;
          }
          stepsReport += `  ❌ Step ${failedStep}: [${failedCmd}] ${failedIntent} — FAILED\n`;
        }

        let text = `🚨 WORKFLOW REPLAY FAILED${execId} 🚨\n\n`;
        text += `═══ STEP STATUS REPORT ═══\n`;
        text += stepsReport;
        text += `\n═══ FAILED STEP DETAILS ═══\n`;
        text += `Step number: ${failedStep}/${totalSteps}\n`;
        text += `Command: ${failedCmd}\n`;
        text += `Intent: ${failedIntent || '(none)'}\n`;
        text += `Error: ${msg}\n\n`;
        text += `═══ ACTION REQUIRED ═══\n`;
        text += `1. Use 'snapshot' to see the current page state.\n`;
        text += `2. Perform ONLY the failed step ${failedStep} manually. The failed step was a "${failedCmd}" command${failedIntent ? ' ("' + failedIntent + '")' : ''}. Use the matching browser tool.\n`;
        text += `3. Call fix_workflow_step(workflow_name="${name}", step_order=${failedStep}, action_id=<the_action_id>).\n`;
        text += `4. Call replay_workflow(name="${name}", start_step=${nextStep || failedStep}) to continue remaining steps.\n\n`;
        text += `⚠️ CRITICAL RULES:\n`;
        text += `- Steps 1–${completedSteps} already SUCCEEDED. Do NOT re-execute, re-navigate, or modify them.\n`;
        text += `- fix_workflow_step must target step_order=${failedStep} ONLY. Do NOT modify any other step.\n`;
        text += `- The page is already at the correct state after ${completedSteps} successful steps. Do NOT navigate again.\n`;
        text += `- Your manual fix should match the original command type "${failedCmd}" (e.g., if it was a click, fix it with a click, not a navigate).`;

        return { content: [{ type: 'text', text }] };
      }
    }
  );

  // --- Tool: fix_workflow_step ---
  server.tool(
    'fix_workflow_step',
    'Update a failed workflow step with the params and locators from a successful manual action. Call this AFTER you manually performed a browser action to fix a failed step. It replaces the step\'s command, params, and locators in the saved workflow so future replays will use the fixed version.',
    {
      workflow_name: z.string().describe('Name of the workflow containing the step to fix'),
      step_order: z.number().describe('The step number to update (1-indexed, as reported in the error)'),
      action_id: z.string().describe('The action_id returned by the browser tool you used to fix the step (e.g. "act_5")'),
      intent: z.string().optional().describe('Updated human-readable description for this step')
    },
    async ({ workflow_name, step_order, action_id, intent }) => {
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
        const result = await updateWorkflowStep(workflow_name, step_order, newStepData);
        if (!result) {
          return { content: [{ type: 'text', text: `Workflow "${workflow_name}" or step ${step_order} not found.` }] };
        }
        log(`Step ${step_order} of "${workflow_name}" fixed via ${action_id}: ${action.command}`);
        return { content: [{ type: 'text', text: `Step ${step_order} of "${workflow_name}" updated successfully.\n  Command: ${action.command}\n  Locators: ${action.locators ? action.locators.length + ' locator(s)' : 'none'}\nThe workflow is now permanently fixed for future replays.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to update step: ${err.message}` }] };
      }
    }
  );

  // --- Tool: delete_workflow ---
  server.tool(
    'delete_workflow',
    'Delete a saved workflow.',
    {
      name: z.string().describe('Name of the workflow to delete')
    },
    async ({ name }) => {
      if (!(await deleteWorkflowDb(name))) {
        return { content: [{ type: 'text', text: `Workflow "${name}" not found.` }] };
      }
      return { content: [{ type: 'text', text: `Workflow "${name}" deleted.` }] };
    }
  );
}
