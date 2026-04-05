// Workflow CRUD — PostgreSQL persistence

import { log } from './logger.js';
import { pool } from './db.js';

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
    steps: stepsResult.rows.map(row => ({
      command: row.command,
      params: row.params || {},
      ...(row.locators && { locators: row.locators }),
      ...(row.intent && { intent: row.intent }),
      ...(row.variable && { variable: row.variable }),
    }))
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
