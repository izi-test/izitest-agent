// Test CRUD — SQLite persistence

import { log } from './logger.js';
import { db, parseJson } from './db.js';
import fs from 'fs';
import path from 'path';

export function loadTest(name) {
  const test = db.prepare('SELECT * FROM tests WHERE name = ?').get(name);
  if (!test) return null;

  const steps = db.prepare(
    'SELECT * FROM test_steps WHERE test_id = ? ORDER BY step_order'
  ).all(test.id);

  return {
    name: test.name,
    description: test.description,
    createdAt: test.created_at,
    project_id: test.project_id,
    viewport: parseJson(test.viewport) || null,
    variables: parseJson(test.variables) || {},
    steps: steps.map(row => ({
      command: row.command,
      params: parseJson(row.params) || {},
      ...(row.locators && { locators: parseJson(row.locators) }),
      ...(row.intent && { intent: row.intent }),
      ...(row.variable && { variable: parseJson(row.variable) }),
      ...(row.assertion && { assertion: parseJson(row.assertion) }),
    }))
  };
}

export function saveTest(test) {
  // Safety net: auto-variabilize any fill step that has a raw value (not already a {{variable}})
  const usedVarNames = new Set();
  if (test.variables) {
    for (const name of Object.keys(test.variables)) usedVarNames.add(name);
  }

  test.steps.forEach((step, i) => {
    if (step.command === 'fill' && step.params.value && !step.variable) {
      const value = step.params.value;
      if (/^\{\{.+\}\}$/.test(value)) return; // already a variable placeholder

      let varName = 'input_' + (i + 1);
      while (usedVarNames.has(varName)) varName = 'input_' + (i + 1) + '_' + Math.random().toString(36).slice(2, 5);
      usedVarNames.add(varName);

      step.params.value = `{{${varName}}}`;
      step.variable = { name: varName, type: 'text', defaultValue: value };

      if (!test.variables) test.variables = {};
      test.variables[varName] = {
        type: 'text',
        defaultValue: value,
        step: i + 1,
        description: step.intent || `${step.command} in step ${i + 1}`
      };
      log(`Auto-variabilized fill step ${i + 1}: {{${varName}}} = "${value}"`);
    }
  });

  const saveTransaction = db.transaction(() => {
    const testResult = db.prepare(
      `INSERT INTO tests (name, description, variables, viewport, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (name) DO UPDATE SET
         description = excluded.description,
         variables = excluded.variables,
         viewport = excluded.viewport,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING id`
    ).get(
      test.name,
      test.description || '',
      JSON.stringify(test.variables || {}),
      test.viewport ? JSON.stringify(test.viewport) : null,
      test.createdAt || new Date().toISOString()
    );
    const testId = testResult.id;

    db.prepare('DELETE FROM test_steps WHERE test_id = ?').run(testId);

    const insertStep = db.prepare(
      `INSERT INTO test_steps (test_id, step_order, command, params, locators, intent, variable, assertion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i];
      
      let stepScreenshotPath = null;
      if (step._screenshotBase64) {
        const p = path.join(process.cwd(), 'data', 'baselines', `baseline-${testId}-${i + 1}.png`);
        fs.writeFileSync(p, Buffer.from(step._screenshotBase64, 'base64'));
        stepScreenshotPath = `data/baselines/baseline-${testId}-${i + 1}.png`;
        if (!step.params) step.params = {};
        step.params.baselinePath = stepScreenshotPath;
        delete step._screenshotBase64;
      }
      
      insertStep.run(
        testId,
        i + 1,
        step.command,
        JSON.stringify(step.params || {}),
        step.locators ? JSON.stringify(step.locators) : null,
        step.intent || null,
        step.variable ? JSON.stringify(step.variable) : null,
        step.assertion ? JSON.stringify(step.assertion) : null
      );
    }

    return testId;
  });

  const testId = saveTransaction();
  log(`Test "${test.name}" saved to SQLite (${test.steps.length} steps)`);
  return testId;
}

export function updateTestStep(testName, stepOrder, stepData) {
  const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(testName);
  if (!test) return null;

  const existing = db.prepare(
    'SELECT variable FROM test_steps WHERE test_id = ? AND step_order = ?'
  ).get(test.id, stepOrder);
  if (!existing) return null;

  const result = db.prepare(
    `UPDATE test_steps SET
       command = ?,
       params = ?,
       locators = ?,
       intent = COALESCE(?, intent),
       assertion = ?
     WHERE test_id = ? AND step_order = ?
     RETURNING *`
  ).get(
    stepData.command,
    JSON.stringify(stepData.params || {}),
    stepData.locators ? JSON.stringify(stepData.locators) : null,
    stepData.intent || null,
    stepData.assertion ? JSON.stringify(stepData.assertion) : null,
    test.id,
    stepOrder
  );

  if (!result) return null;

  db.prepare("UPDATE tests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(test.id);
  log(`Step ${stepOrder} of test "${testName}" updated: ${stepData.command}`);
  return result;
}

export function deleteTest(name) {
  const result = db.prepare('DELETE FROM tests WHERE name = ?').run(name);
  return result.changes > 0;
}

export function listTests() {
  const rows = db.prepare(
    `SELECT t.*, s.step_order, s.command, s.params, s.locators, s.intent, s.variable, s.assertion
     FROM tests t
     LEFT JOIN test_steps s ON s.test_id = t.id
     ORDER BY t.updated_at DESC, s.step_order ASC`
  ).all();

  const testMap = new Map();
  for (const row of rows) {
    if (!testMap.has(row.id)) {
      testMap.set(row.id, {
        name: row.name,
        description: row.description,
        createdAt: row.created_at,
        project_id: row.project_id,
        viewport: parseJson(row.viewport) || null,
        variables: parseJson(row.variables) || {},
        steps: []
      });
    }
    if (row.step_order != null) {
      testMap.get(row.id).steps.push({
        command: row.command,
        params: parseJson(row.params) || {},
        ...(row.locators && { locators: parseJson(row.locators) }),
        ...(row.intent && { intent: row.intent }),
        ...(row.variable && { variable: parseJson(row.variable) }),
        ...(row.assertion && { assertion: parseJson(row.assertion) }),
      });
    }
  }

  return [...testMap.values()];
}
