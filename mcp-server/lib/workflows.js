// Workflow recording state, action history, and variable detection helpers
// Storage: PostgreSQL (replaces JSON file I/O)

import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './logger.js';
import { pool } from './db.js';

const execFileAsync = promisify(execFile);

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

// ─── Variable Detection Helpers ────────────────────────────────────

export async function classifyWithLLM(listContext, intent) {
  const { type, itemTexts, selectedText, totalItems } = listContext;

  const sanitize = (s) => (s || '').replace(/[\x00-\x1f]/g, ' ').substring(0, 150);

  const prompt = [
    `You are analyzing a web page element for browser automation.`,
    `An element was clicked that appears to be part of a "${type}" (detected via DOM structure analysis).`,
    `The container has ${totalItems} similar items.`,
    `The clicked item text: "${sanitize(selectedText)}"`,
    `Sample items from the container (first 5):`,
    ...(itemTexts || []).slice(0, 5).map((t, i) => `  ${i + 1}. "${sanitize(t)}"`),
    intent ? `User intent for this step: "${sanitize(intent)}"` : '',
    ``,
    `Determine:`,
    `1. Is this truly a repeated list/collection of similar items? (true/false)`,
    `2. A short snake_case variable name for this selection (e.g. "product", "category", "search_result", "menu_item")`,
    `3. Should the item be selected by_index (position) or by_text (text content match)?`,
    ``,
    `Reply ONLY with a JSON object, no markdown, no explanation:`,
    `{"is_list": true, "variable_name": "product", "selection_mode": "by_index"}`
  ].filter(Boolean).join('\n');

  try {
    const { stdout } = await execFileAsync('copilot', ['--model', 'gpt-4.1-mini', '-p', prompt], {
      timeout: 30000,
      encoding: 'utf-8'
    });

    const jsonMatch = stdout.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      log(`LLM classification result: ${JSON.stringify(parsed)}`);
      return {
        isList: parsed.is_list === true,
        variableName: parsed.variable_name || 'item',
        selectionMode: parsed.selection_mode === 'by_text' ? 'by_text' : 'by_index'
      };
    }
  } catch (err) {
    log(`LLM classification failed (falling back to heuristic): ${err.message}`);
  }

  return {
    isList: totalItems > 2,
    variableName: type === 'box' ? 'item' : 'option',
    selectionMode: 'by_index'
  };
}

export async function detectListContext(sendCommand, { selector, text, tabId }) {
  try {
    const params = {};
    if (selector) params.selector = selector;
    if (text) params.text = text;
    if (tabId) params.tabId = tabId;
    const result = await sendCommand(undefined, 'detect_list_context', params, 10000);
    return result;
  } catch (err) {
    log(`detect_list_context failed: ${err.message}`);
    return null;
  }
}

// ─── Workflow PostgreSQL I/O ──────────────────────────────────────

export async function loadWorkflow(name) {
  const wfResult = await pool.query(
    'SELECT * FROM workflows WHERE name = $1',
    [name]
  );
  if (wfResult.rows.length === 0) return null;

  const wf = wfResult.rows[0];
  const stepsResult = await pool.query(
    'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order',
    [wf.id]
  );

  return {
    name: wf.name,
    description: wf.description,
    createdAt: wf.created_at.toISOString(),
    variables: wf.variables || {},
    steps: stepsResult.rows.map(row => {
      const step = {
        command: row.command,
        params: row.params || {},
        ...(row.locators && { locators: row.locators }),
        ...(row.intent && { intent: row.intent }),
        ...(row.variable && { variable: row.variable }),
      };
      return step;
    })
  };
}

export async function saveWorkflow(workflow) {
  // Safety net: auto-variabilize any fill step that has a raw value (not already a {{variable}})
  const usedVarNames = new Set();
  if (workflow.variables) {
    for (const name of Object.keys(workflow.variables)) usedVarNames.add(name);
  }

  workflow.steps.forEach((step, i) => {
    if (step.command === 'fill' && step.params.value && !step.variable) {
      const value = step.params.value;
      if (/^\{\{.+\}\}$/.test(value)) return; // already a variable placeholder

      let varName = 'input_' + (i + 1);
      while (usedVarNames.has(varName)) varName = 'input_' + (i + 1) + '_' + Math.random().toString(36).slice(2, 5);
      usedVarNames.add(varName);

      step.params.value = `{{${varName}}}`;
      step.variable = { name: varName, type: 'text', defaultValue: value };

      if (!workflow.variables) workflow.variables = {};
      workflow.variables[varName] = {
        type: 'text',
        defaultValue: value,
        step: i + 1,
        description: step.intent || `${step.command} in step ${i + 1}`
      };
      log(`Auto-variabilized fill step ${i + 1}: {{${varName}}} = "${value}"`);
    }
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert workflow
    const wfResult = await client.query(
      `INSERT INTO workflows (name, description, variables, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         variables = EXCLUDED.variables,
         updated_at = NOW()
       RETURNING id`,
      [
        workflow.name,
        workflow.description || '',
        JSON.stringify(workflow.variables || {}),
        workflow.createdAt || new Date().toISOString()
      ]
    );
    const workflowId = wfResult.rows[0].id;

    // Delete old steps then insert new ones
    await client.query('DELETE FROM workflow_steps WHERE workflow_id = $1', [workflowId]);

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      await client.query(
        `INSERT INTO workflow_steps (workflow_id, step_order, command, params, locators, intent, variable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          workflowId,
          i + 1,
          step.command,
          JSON.stringify(step.params || {}),
          step.locators ? JSON.stringify(step.locators) : null,
          step.intent || null,
          step.variable ? JSON.stringify(step.variable) : null
        ]
      );
    }

    await client.query('COMMIT');
    log(`Workflow "${workflow.name}" saved to PostgreSQL (${workflow.steps.length} steps)`);
    return workflowId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateWorkflowStep(workflowName, stepOrder, stepData) {
  const wf = await pool.query('SELECT id FROM workflows WHERE name = $1', [workflowName]);
  if (wf.rows.length === 0) return null;

  const workflowId = wf.rows[0].id;

  // Preserve existing variable metadata if the new step doesn't provide it
  const existing = await pool.query(
    'SELECT variable FROM workflow_steps WHERE workflow_id = $1 AND step_order = $2',
    [workflowId, stepOrder]
  );
  if (existing.rows.length === 0) return null;

  const result = await pool.query(
    `UPDATE workflow_steps SET
       command = $1,
       params = $2,
       locators = $3,
       intent = COALESCE($4, intent)
     WHERE workflow_id = $5 AND step_order = $6
     RETURNING *`,
    [
      stepData.command,
      JSON.stringify(stepData.params || {}),
      stepData.locators ? JSON.stringify(stepData.locators) : null,
      stepData.intent || null,
      workflowId,
      stepOrder
    ]
  );

  if (result.rowCount === 0) return null;

  await pool.query('UPDATE workflows SET updated_at = NOW() WHERE id = $1', [workflowId]);
  log(`Step ${stepOrder} of workflow "${workflowName}" updated: ${stepData.command}`);
  return result.rows[0];
}

export async function deleteWorkflow(name) {
  const result = await pool.query('DELETE FROM workflows WHERE name = $1 RETURNING id', [name]);
  return result.rowCount > 0;
}

export async function listWorkflows() {
  const result = await pool.query(
    `SELECT w.*, s.step_order, s.command, s.params, s.locators, s.intent, s.variable
     FROM workflows w
     LEFT JOIN workflow_steps s ON s.workflow_id = w.id
     ORDER BY w.updated_at DESC, s.step_order ASC`
  );

  const workflowMap = new Map();
  for (const row of result.rows) {
    if (!workflowMap.has(row.id)) {
      workflowMap.set(row.id, {
        name: row.name,
        description: row.description,
        createdAt: row.created_at.toISOString(),
        variables: row.variables || {},
        steps: []
      });
    }
    if (row.step_order != null) {
      workflowMap.get(row.id).steps.push({
        command: row.command,
        params: row.params || {},
        ...(row.locators && { locators: row.locators }),
        ...(row.intent && { intent: row.intent }),
        ...(row.variable && { variable: row.variable }),
      });
    }
  }

  return [...workflowMap.values()];
}

export async function executeWorkflow(name, variables, substitutions, start_step, new_window, sendCommand, trigger = 'manual', onProgress = null) {
  const workflow = await loadWorkflow(name);
  if (!workflow) {
    throw new Error(`Workflow "${name}" not found.`);
  }

  const startIndex = (start_step && start_step > 0) ? start_step - 1 : 0;

  const mergedVariables = {};
  if (workflow.variables) {
    for (const [key, info] of Object.entries(workflow.variables)) {
      mergedVariables[key] = String(info.defaultValue ?? '');
    }
  }
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      mergedVariables[key] = String(value ?? '');
    }
  }
  log(`Merged variables: ${JSON.stringify(mergedVariables)}`);

  const applySubstitutions = (str) => {
    let result = str;
    for (const [key, value] of Object.entries(mergedVariables)) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
    if (substitutions) {
      for (const [oldVal, newVal] of Object.entries(substitutions)) {
        result = result.replaceAll(oldVal, newVal);
      }
    }
    return result;
  };

  const hydratedSteps = workflow.steps.map(step => {
    const stepStr = applySubstitutions(JSON.stringify(step));
    const hydratedStep = JSON.parse(stepStr);

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

  // ─── Get workflow ID for FK reference ──────────────────────────
  const wfRow = await pool.query('SELECT id FROM workflows WHERE name = $1', [name]);
  const workflowId = wfRow.rows[0]?.id;
  if (!workflowId) throw new Error(`Workflow "${name}" not found in database.`);

  // ─── Create execution record ──────────────────────────────────
  const execResult = await pool.query(
    `INSERT INTO workflow_executions (workflow_id, workflow_name, status, total_steps, variables, new_window, trigger)
     VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id`,
    [workflowId, name, hydratedSteps.length, JSON.stringify(mergedVariables), !!new_window, trigger]
  );
  const executionId = execResult.rows[0].id;

  // ─── Initialize pending step rows ─────────────────────────────
  for (let i = 0; i < hydratedSteps.length; i++) {
    const step = hydratedSteps[i];
    await pool.query(
      `INSERT INTO execution_steps (execution_id, step_order, command, intent, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [executionId, i + 1, step.command, step.intent || null]
    );
  }

  log(`Execution #${executionId} created for workflow "${name}" (${hydratedSteps.length} steps, trigger: ${trigger})`);
  
  if (onProgress) {
    onProgress({
      type: 'execution_started',
      executionId: executionId,
      workflowName: name,
      totalSteps: hydratedSteps.length
    });
  }

  // ─── Send to extension and process results ────────────────────
  let extensionResult;
  let executionFailed = false;

  try {
    extensionResult = await sendCommand(undefined, 'replay_sequence', { steps: hydratedSteps, startIndex, newWindow: new_window }, 120000, async (msg) => {
      if (onProgress) onProgress(msg);
      
      // Live DB persistence for step completion
      if (msg.type === 'step_complete' && msg.stepResult) {
        const sr = msg.stepResult;
        try {
          await pool.query(
            `UPDATE execution_steps SET
              status = $1,
              started_at = $2,
              finished_at = $3,
              duration_ms = $4,
              locator_used = $5,
              error = $6
             WHERE execution_id = $7 AND step_order = $8`,
            [
              sr.status || 'pending',
              sr.startedAt ? new Date(sr.startedAt) : null,
              sr.finishedAt ? new Date(sr.finishedAt) : null,
              sr.durationMs || null,
              sr.locator || sr.resolvedVia || null,
              sr.error || null,
              executionId,
              sr.step
            ]
          );
        } catch (dbErr) {
          log(`Failed to live-persist step ${sr.step}: ${dbErr.message}`);
        }
      }
    });
  } catch (err) {
    executionFailed = true;
    // The extension throws enriched errors with results attached
    extensionResult = {
      results: err.results || [],
      startedAt: err.startedAt || Date.now(),
      finishedAt: err.finishedAt || Date.now(),
      durationMs: err.durationMs || 0
    };
  }

  // ─── Persist step results ─────────────────────────────────────
  const stepResults = extensionResult.results || [];
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

    await pool.query(
      `UPDATE execution_steps SET
        status = $1,
        started_at = $2,
        finished_at = $3,
        duration_ms = $4,
        locator_used = $5,
        error = $6
       WHERE execution_id = $7 AND step_order = $8`,
      [
        status,
        stepResult.startedAt ? new Date(stepResult.startedAt) : null,
        stepResult.finishedAt ? new Date(stepResult.finishedAt) : null,
        stepResult.durationMs || null,
        stepResult.locator || stepResult.resolvedVia || null,
        stepResult.error || null,
        executionId,
        stepResult.step
      ]
    );
  }

  // ─── Finalize execution record ────────────────────────────────
  const finalStatus = executionFailed ? 'failed' : 'success';
  await pool.query(
    `UPDATE workflow_executions SET
      status = $1,
      finished_at = NOW(),
      duration_ms = $2,
      completed_steps = $3,
      failed_step = $4,
      error = $5
     WHERE id = $6`,
    [finalStatus, extensionResult.durationMs || null, completedCount, failedStepOrder, globalError, executionId]
  );

  log(`Execution #${executionId} finalized: ${finalStatus} (${completedCount}/${hydratedSteps.length} steps, ${extensionResult.durationMs}ms)`);

  if (executionFailed) {
    const error = new Error(globalError || 'Workflow execution failed');
    error.executionId = executionId;
    error.failedStep = failedStepOrder;
    error.totalSteps = hydratedSteps.length;
    error.completedSteps = completedCount;
    error.stepResults = stepResults.map(sr => ({
      step: sr.step,
      command: hydratedSteps[(sr.step || 1) - 1]?.command || sr.command || '?',
      intent: hydratedSteps[(sr.step || 1) - 1]?.intent || sr.intent || '',
      status: sr.status,
      error: sr.error || null
    }));
    if (failedStepOrder) {
      const failedStepData = hydratedSteps[failedStepOrder - 1];
      error.failedStepCommand = failedStepData?.command;
      error.failedStepIntent = failedStepData?.intent;
    }
    throw error;
  }

  return { ...extensionResult, executionId };
}

