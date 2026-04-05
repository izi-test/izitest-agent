// Workflow execution engine

import { log } from './logger.js';
import { pool } from './db.js';
import { loadWorkflow } from './workflow-store.js';

export async function executeWorkflow(name, variables, substitutions, start_step, new_window, sendCommand, trigger = 'manual', onProgress = null) {
  const workflow = await loadWorkflow(name);
  if (!workflow) {
    throw new Error(`Workflow "${name}" not found.`);
  }

  const startIndex = (start_step && start_step > 0) ? start_step - 1 : 0;

  // Merge default variable values with caller-supplied overrides
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
      executionId,
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

      if (msg.type === 'step_complete' && msg.stepResult) {
        await persistStepResult(executionId, msg.stepResult).catch(err =>
          log(`Failed to live-persist step ${msg.stepResult.step}: ${err.message}`)
        );
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

  // ─── Persist final step results ───────────────────────────────
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
    await persistStepResult(executionId, stepResult);
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

async function persistStepResult(executionId, sr) {
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
}
