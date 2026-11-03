// REST API routes for test & step CRUD

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { executeTest } from './tests.js';
import { sendCommand, broadcastToExtensions, getProfiles, waitForProfileReregister, getClientErrors, clearClientErrors } from './websocket.js';
import { DebugController, activeDebugControllers } from './debug-controller.js';
import {
  seedProjectStepDefinitions,
  listStepDefinitions,
  createStepDefinition,
  updateStepDefinition,
  deleteStepDefinition,
} from './gherkin/step-definition-store.js';
import { serializeTestToFeature } from './gherkin/serialize.js';
import { stepsForEditedFeature } from './gherkin/reconcile.js';
import { withElementNames, elementTargets, listElements, renameElement, deleteElement } from './element-store.js';
import { proposalsOf, startProposals, acceptProposal, dismissProposal } from './business-steps.js';
import { languageOf } from './gherkin/language.js';
import { computeVariables } from './values.js';
import { loadTest, saveTest, insertTestStep } from './test-store.js';
import { listRepairs, repairsById, getRepair, verifyRepair, applyRepair, rejectRepair, repairDiff } from './repairs.js';
import { listBugs, setBugStatus, listExplorations, getExploration, runExploration } from './bugs.js';
import { CHECKS, DEFAULT_IMPACTS } from './explore.js';
import { saveRequirement, getRequirement, listRequirements, deleteRequirement, planCases, linkTest, deleteCase, updateCase, saveDesign, requirementsOfTest } from './requirements.js';
import { designTests, planDesigned, withResolution, recordingBrief, projectBrief } from './requirement-design.js';
import { importRequirements } from './requirement-import.js';
import { jiraConfig, maskedJiraConfig, saveJiraConfig, siteOf, jiraClient, testJira, jiraProjects, importFromJira, commentOnJira } from './jira.js';
import { xrayConfig, maskedXrayConfig, saveXrayConfig, xrayClient, testXray, exportToXray } from './xray.js';
import { complete, agentName } from './agent/complete.js';
import { startCampaign, getCampaign, listCampaigns, stopCampaign, deleteCampaign, junitReport, htmlReport } from './campaigns.js';
import { generateTestCode } from './codegen/index.js';
import { listSessions } from './session.js';
import { headlessStatus, installHeadless, startHeadless, stopHeadless, ensureHeadless, inHeadless } from './headless.js';
import { handleAgentChat, listConversations, getConversation, deleteConversation } from './agent/chat.js';

// How long to wait for a reloaded extension to register again. A reload drops the socket
// and the service worker reconnects after ~1s; this leaves room for a slow restart.
const RELOAD_RECONNECT_TIMEOUT_MS = 8000;

const execFileAsync = promisify(execFile);
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3467;

// ─── Helpers ───────────────────────────────────────────────────────

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** A project's step definitions, in the order the Gherkin parser and serializer read them. */
function projectDefinitions(projectId) {
  return db
    .prepare('SELECT * FROM step_definitions WHERE project_id = ?')
    .all(projectId)
    .map((r) => ({
      ...r,
      params_template: parseJson(r.params_template) || {},
      steps_template: parseJson(r.steps_template) || null,
    }));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function matchRoute(pathname, pattern) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/** Parse JSON TEXT columns in a row object. */
function parseRow(row, ...jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const col of jsonCols) {
    if (out[col] !== undefined) out[col] = parseJson(out[col]);
  }
  return out;
}

/** Parse JSON TEXT columns in an array of rows. */
function parseRows(rows, ...jsonCols) {
  return rows.map(r => parseRow(r, ...jsonCols));
}

/** A repair with what it changes, line by line, for the dashboard. */
function withDiff(repair) {
  return repair && { ...repair, diff: repairDiff(repair) };
}

// ─── Router ────────────────────────────────────────────────────────

export async function apiRouter(req, res, url) {
  const method = req.method;
  const path = url.pathname;

  try {
    // ── GET|DELETE /api/dev/extension-errors ──
    // What the extension's service worker reported since the last clear. A test run clears
    // it first, then asserts it is still empty at the end — the extension's console is not
    // otherwise reachable from outside Chrome.
    if (path === '/api/dev/extension-errors') {
      if (method === 'GET') return json(res, 200, { errors: getClientErrors() });
      if (method === 'DELETE') return json(res, 200, { cleared: clearClientErrors() });
      return json(res, 405, { error: 'Use GET or DELETE' });
    }

    // ── POST /api/dev/reload-extension ──
    // Lets `npm run build` in extension/ reload the unpacked extension in Chrome instead
    // of the user clicking Reload in chrome://extensions. The extension reloads itself
    // (chrome.runtime.reload), so nothing here needs CDP or a relaunched browser.
    if (method === 'POST' && path === '/api/dev/reload-extension') {
      if (getProfiles().size === 0) {
        log('Extension reload requested, but no extension is connected');
        return json(res, 200, { notified: 0, reloaded: false });
      }
      // Listener first: the extension can be back before this request finishes.
      const reconnected = waitForProfileReregister(RELOAD_RECONNECT_TIMEOUT_MS);
      const notified = broadcastToExtensions({ type: 'reload_extension' });
      const reloaded = await reconnected;
      log(reloaded
        ? `Extension reload confirmed (${notified} profile(s) notified, extension re-registered)`
        : `Extension reload pushed to ${notified} profile(s) but none came back — it is probably running a build from before auto-reload`);
      return json(res, 200, { notified, reloaded });
    }

    // ── GET /api/tests ──
    if (method === 'GET' && path === '/api/tests') {
      const projectId = url.searchParams.get('project_id');
      // Each test with how it last ran and the requirements it checks: what the list filters on.
      let query = `
        SELECT t.id, t.name, t.description, t.variables, t.viewport, t.project_id, t.created_at, t.updated_at,
               (SELECT COUNT(*) FROM test_steps ts WHERE ts.test_id = t.id) AS step_count,
               last.status AS last_status, last.started_at AS last_run_at, last.duration_ms AS last_duration_ms,
               (SELECT json_group_array(key) FROM (
                  SELECT DISTINCT r.key FROM requirement_cases c JOIN requirements r ON r.id = c.requirement_id
                  WHERE c.test_id = t.id ORDER BY r.key)) AS requirement_keys
        FROM tests t
        LEFT JOIN test_executions last ON last.id = (
          SELECT e.id FROM test_executions e WHERE e.test_id = t.id ORDER BY e.started_at DESC, e.id DESC LIMIT 1)
      `;
      const params = [];
      if (projectId !== null) {
        query += ' WHERE t.project_id = ?';
        params.push(projectId === 'null' ? null : projectId);
      }
      query += ' ORDER BY t.updated_at DESC';
      const rows = db.prepare(query).all(...params);
      return json(res, 200, { tests: parseRows(rows, 'variables', 'viewport', 'requirement_keys') });
    }

    // ── GET /api/tests/:name ──
    let params = matchRoute(path, '/api/tests/:name');
    if (method === 'GET' && params) {
      const test = db.prepare('SELECT * FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      const steps = db.prepare(
        'SELECT * FROM test_steps WHERE test_id = ? ORDER BY step_order'
      ).all(test.id);
      // Each step with the element it acts on (`element`, its name), when it is known.
      const { steps: named } = withElementNames({ project_id: test.project_id, steps: parseRows(steps, 'params', 'locators', 'variable', 'assertion') });
      return json(res, 200, {
        test: {
          ...parseRow(test, 'variables', 'viewport'),
          steps: named
        }
      });
    }

    // ── POST /api/tests ──
    if (method === 'POST' && path === '/api/tests') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });

      const result = db.prepare(
        `INSERT INTO tests (name, description) VALUES (?, ?) RETURNING id, name`
      ).get(body.name, body.description || '');
      return json(res, 201, result);
    }

    // ── PUT /api/tests/:name ──
    params = matchRoute(path, '/api/tests/:name');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const sets = [];
      const vals = [];

      if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
      if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description); }
      if (body.variables !== undefined) { sets.push('variables = ?'); vals.push(JSON.stringify(body.variables)); }
      if (body.viewport !== undefined) { sets.push('viewport = ?'); vals.push(body.viewport ? JSON.stringify(body.viewport) : null); }
      if (sets.length === 0) return json(res, 400, { error: 'Nothing to update' });

      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      vals.push(params.name);

      const result = db.prepare(
        `UPDATE tests SET ${sets.join(', ')} WHERE name = ? RETURNING *`
      ).get(...vals);
      if (!result) return json(res, 404, { error: 'Test not found' });
      return json(res, 200, parseRow(result, 'variables', 'viewport'));
    }

    // ── GET /api/tests/:name/feature — serialize test_steps as Gherkin ──
    params = matchRoute(path, '/api/tests/:name/feature');
    if (method === 'GET' && params) {
      const test = loadTest(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });
      const projectId = test.project_id;
      if (!projectId) return json(res, 400, { error: 'Test is not assigned to a project; assign it first to use Gherkin' });
      // Its elements by their names, not their selectors: When I click on "Save profile".
      const feature = serializeTestToFeature(withElementNames(test), projectId);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(feature);
    }

    // ── PUT /api/tests/:name/feature — parse Gherkin and replace test_steps ──
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const featureText = body.feature;
      if (typeof featureText !== 'string') return json(res, 400, { error: 'feature (string) is required' });

      const existing = loadTest(params.name);
      if (!existing) return json(res, 404, { error: 'Test not found' });
      const projectId = existing.project_id;
      if (!projectId) return json(res, 400, { error: 'Test is not assigned to a project; assign it first to use Gherkin' });

      let steps;
      try {
        // Unchanged phrases keep their steps whole: list variables, intents, locators.
        // A name of an element reads back as that element.
        steps = stepsForEditedFeature(featureText, projectDefinitions(projectId), withElementNames(existing), { targets: elementTargets(projectId) });
      } catch (err) {
        if (err.code === 'GHERKIN_UNRESOLVED') {
          return json(res, 422, { error: err.message, errors: err.errors });
        }
        return json(res, 400, { error: err.message });
      }

      saveTest({ ...existing, steps });
      return json(res, 200, { success: true, step_count: steps.length });
    }

    // ── POST /api/values/preview — { values: { name: "{{today | dd/MM/yyyy}}" }, language }: what
    // a run would compute now (lib/values.js), and what does not work out ──
    if (method === 'POST' && path === '/api/values/preview') {
      const body = await readBody(req);
      const raw = Object.fromEntries(Object.entries(body.values ?? {}).map(([name, value]) => [name, String(value ?? '')]));
      const { values, problems } = computeVariables(raw, { language: languageOf(body.language) });
      return json(res, 200, { values, problems });
    }

    // ── Business steps the agent proposes for a test (lib/business-steps.js) ──
    // GET: the proposals kept, or whether they are being worked out. DELETE: all dismissed.
    params = matchRoute(path, '/api/tests/:name/business-steps');
    if (method === 'GET' && params) return json(res, 200, proposalsOf(params.name));
    if (method === 'DELETE' && params) {
      const result = dismissProposal(params.name);
      return result.error ? json(res, result.status, { error: result.error }) : json(res, 200, result);
    }
    // POST …/propose: asked of the agent set in Settings, in the background (a few minutes at most).
    params = matchRoute(path, '/api/tests/:name/business-steps/propose');
    if (method === 'POST' && params) {
      const result = startProposals(params.name, { complete, agent: agentName() });
      return result.error ? json(res, result.status, { error: result.error }) : json(res, 202, result);
    }
    // POST …/:id/accept — { pattern?, keyword? }: the phrase as the user left it becomes a business step.
    params = matchRoute(path, '/api/tests/:name/business-steps/:id/accept');
    if (method === 'POST' && params) {
      const body = await readBody(req);
      const result = acceptProposal(params.name, params.id, { pattern: body.pattern, keyword: body.keyword });
      return result.error ? json(res, result.status, { error: result.error }) : json(res, 200, result);
    }
    params = matchRoute(path, '/api/tests/:name/business-steps/:id');
    if (method === 'DELETE' && params) {
      const result = dismissProposal(params.name, params.id);
      return result.error ? json(res, result.status, { error: result.error }) : json(res, 200, result);
    }

    // ── GET /api/tests/:name/codegen?framework=... ──
    params = matchRoute(path, '/api/tests/:name/codegen');
    if (method === 'GET' && params) {
      const framework = url.searchParams.get('framework') || 'playwright-plain';
      const test = loadTest(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      try {
        const result = generateTestCode({ ...test, requirements: requirementsOfTest(test.name) }, framework, projectDefinitions);
        if (result.error) return json(res, result.status, { error: result.error });
        return json(res, 200, { framework, files: result.files });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // ── DELETE /api/tests/:name ──
    params = matchRoute(path, '/api/tests/:name');
    if (method === 'DELETE' && params) {
      const result = db.prepare('DELETE FROM tests WHERE name = ?').run(params.name);
      if (result.changes === 0) return json(res, 404, { error: 'Test not found' });
      return json(res, 200, { success: true });
    }

    // ── POST /api/tests/:name/execute (Streaming SSE) ──
    params = matchRoute(path, '/api/tests/:name/execute');
    if (method === 'POST' && params) {
      const body = await readBody(req);

      // Setup SSE headers for chunked transfer
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Create debug controller if debug mode requested
      let debugController = null;
      if (body.debug) {
        const breakpoints = Array.isArray(body.breakpoints) ? body.breakpoints : [];
        debugController = new DebugController(breakpoints, 'step');
      }

      // Abort debug session if client disconnects
      req.on('close', () => {
        if (debugController && !debugController.isAborted) {
          debugController.abort();
        }
      });

      // Out of sight, in the Chrome without windows (lib/headless.js) — started if it is not —,
      // and its window closed after: nobody looks at it. Not in debug: that one is watched.
      const headless = body.headless === true && !body.debug;
      const run = headless ? inHeadless(sendCommand) : sendCommand;
      let tabId = null;
      try {
        if (headless) await ensureHeadless();
        const newWindow = headless || (body.new_window !== undefined ? body.new_window : true);
        const resObj = await executeTest(params.name, body.variables, body.substitutions, body.start_step, newWindow, run, 'manual', onProgress, debugController);
        tabId = resObj?.results?.findLast?.((r) => r.tabId != null)?.tabId ?? null;
        res.write(`data: ${JSON.stringify({ type: 'execution_completed', result: resObj })}\n\n`);
      } catch (err) {
        tabId = err.tabId ?? null;
        res.write(`data: ${JSON.stringify({
          type: 'execution_error',
          error: err.message,
          executionId: err.executionId,
          status: err.status || 'failed',
          durationMs: err.durationMs ?? null,
          totalSteps: err.totalSteps ?? null,
          completedSteps: err.completedSteps ?? null,
          failedStep: err.failedStep ?? null,
          assertionsTotal: err.assertionsTotal ?? null,
          assertionsPassed: err.assertionsPassed ?? null,
          assertionsFailed: err.assertionsFailed ?? null,
          triage: err.triage ?? null,
        })}\n\n`);
      } finally {
        res.end();
        if (headless && tabId) run(undefined, 'close_window', { tabId, liveSessions: listSessions().map((s) => s.id) }).catch(() => {});
      }
      return;
    }

    // ── POST /api/debug/:executionId/:action ──
    params = matchRoute(path, '/api/debug/:executionId/:action');
    if (method === 'POST' && params) {
      const executionId = parseInt(params.executionId);
      const action = params.action;
      const controller = activeDebugControllers.get(executionId);

      if (!controller) {
        return json(res, 404, { error: `No active debug session for execution #${executionId}` });
      }

      switch (action) {
        case 'resume':
          controller.resume();
          return json(res, 200, { success: true, action: 'resume' });

        case 'step':
          controller.stepOver();
          return json(res, 200, { success: true, action: 'step' });

        case 'continue':
          controller.continueAll();
          return json(res, 200, { success: true, action: 'continue' });

        case 'toggle-breakpoint': {
          const body = await readBody(req);
          if (!body.step || typeof body.step !== 'number') {
            return json(res, 400, { error: 'step (number) is required' });
          }
          const isSet = controller.toggleBreakpoint(body.step);
          return json(res, 200, { success: true, step: body.step, isSet, breakpoints: controller.breakpoints });
        }

        case 'abort':
          controller.abort();
          return json(res, 200, { success: true, action: 'abort' });

        default:
          return json(res, 400, { error: `Unknown debug action: ${action}. Valid: resume, step, continue, toggle-breakpoint, abort` });
      }
    }

    // ── GET /api/tests/:name/executions ──
    params = matchRoute(path, '/api/tests/:name/executions');
    if (method === 'GET' && params) {
      const page = parseInt(url.searchParams.get('page') || '0');
      const pageSize = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
      const offset = page * pageSize;

      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      const rows = db.prepare(
        `SELECT id, status, started_at, finished_at, duration_ms, total_steps, completed_steps,
                failed_step, error, new_window, trigger, assertions_total, assertions_passed, assertions_failed,
                json_extract(triage, '$.cause') AS triage_cause, campaign_id
         FROM test_executions
         WHERE test_id = ?
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`
      ).all(test.id, pageSize, offset);

      const countRow = db.prepare(
        'SELECT COUNT(*) AS total FROM test_executions WHERE test_id = ?'
      ).get(test.id);

      return json(res, 200, { executions: rows, total: countRow.total, page, pageSize });
    }

    // ── GET /api/tests/:name/campaigns — the campaigns it ran in, newest first, with how it did in each ──
    params = matchRoute(path, '/api/tests/:name/campaigns');
    if (method === 'GET' && params) {
      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });
      const ids = db.prepare(
        `SELECT DISTINCT campaign_id AS id FROM test_executions
         WHERE test_id = ? AND campaign_id IS NOT NULL ORDER BY campaign_id DESC LIMIT 20`
      ).all(test.id);
      const campaigns = ids.map(({ id }) => getCampaign(id)).filter(Boolean).map(({ requirements, runs, changes, ...c }) => ({
        ...c, run: runs.find((r) => r.name === params.name) ?? null,
      }));
      return json(res, 200, { campaigns });
    }

    // ── GET /api/executions/:id ──
    params = matchRoute(path, '/api/executions/:id');
    if (method === 'GET' && params) {
      const execId = parseInt(params.id);
      const exec = db.prepare('SELECT * FROM test_executions WHERE id = ?').get(execId);
      if (!exec) return json(res, 404, { error: 'Execution not found' });

      const steps = db.prepare(
        'SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY step_order'
      ).all(execId);

      const execution = parseRow(exec, 'variables', 'triage');
      // The repairs its diagnosis proposed: one may have been proposed by an earlier run first.
      const repairIds = (execution.triage?.proposals ?? []).map((proposal) => proposal.id).filter(Boolean);
      return json(res, 200, {
        execution: { ...execution, steps: parseRows(steps, 'assertion_result'), repairs: repairsById(repairIds).map(withDiff) }
      });
    }

    // ── Requirements (lib/requirements.js): what tests are for, and their coverage ──

    // GET /api/requirements?project_id= — newest first, each with its coverage
    if (method === 'GET' && path === '/api/requirements') {
      const projectId = url.searchParams.get('project_id');
      return json(res, 200, { requirements: listRequirements({ projectId: projectId ? Number(projectId) : undefined }) });
    }

    // POST /api/requirements — { title, description, criteria, source, key, url, project_id, priority }
    if (method === 'POST' && path === '/api/requirements') {
      const body = await readBody(req);
      try {
        const { requirement } = saveRequirement({
          key: body.key || undefined, title: body.title, description: body.description ?? '', criteria: body.criteria ?? [],
          source: body.source ?? 'manual', url: body.url ?? null, projectId: body.project_id ?? null, priority: body.priority ?? 'medium',
        });
        return json(res, 201, { requirement });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/requirements/import — { filename, content | content_base64, format, sheet, columns, project_id, dry_run }:
    // what the file holds, new, changed or unchanged — saved unless dry_run (lib/requirement-import.js)
    if (method === 'POST' && path === '/api/requirements/import') {
      const body = await readBody(req);
      try {
        const content = body.content_base64 != null ? Buffer.from(body.content_base64, 'base64') : body.content;
        const result = importRequirements({
          content, filename: body.filename ?? '', format: body.format || null, sheet: body.sheet || null, columns: body.columns ?? {},
          projectId: body.project_id ?? null, dryRun: body.dry_run !== false,
        });
        return json(res, 200, { import: result });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // ── Jira (lib/jira.js): the site to read stories from, and the stories read ──

    // GET | PUT /api/settings/jira — { baseUrl, email, apiToken }: the token masked when read, kept when given masked
    if (path === '/api/settings/jira' && (method === 'GET' || method === 'PUT')) {
      if (method === 'GET') return json(res, 200, { jira: maskedJiraConfig() });
      const body = await readBody(req);
      try {
        return json(res, 200, { jira: saveJiraConfig(body) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/settings/jira/test — { baseUrl, email, apiToken } (a token given masked: the one saved): who it reads as
    if (method === 'POST' && path === '/api/settings/jira/test') {
      const body = await readBody(req);
      try {
        const saved = jiraConfig();
        const config = body.baseUrl ? {
          baseUrl: siteOf(body.baseUrl), email: body.email, apiToken: body.apiToken?.includes('•') ? saved?.apiToken : body.apiToken,
        } : saved;
        return json(res, 200, { success: true, ...(await testJira(jiraClient(config))) });
      } catch (err) {
        return json(res, 200, { success: false, error: err.message });
      }
    }

    // GET /api/jira/projects — the site's projects, for a query to start from
    if (method === 'GET' && path === '/api/jira/projects') {
      try {
        return json(res, 200, { projects: await jiraProjects(jiraClient()) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/jira/import — { jql | keys | sync, project_id, dry_run }: stories read as requirements, saved unless dry_run
    if (method === 'POST' && path === '/api/jira/import') {
      const body = await readBody(req);
      try {
        const result = await importFromJira({
          jql: body.jql, keys: Array.isArray(body.keys) ? body.keys : undefined, sync: !!body.sync,
          projectId: body.project_id ?? null, dryRun: body.dry_run !== false,
        });
        return json(res, 200, { import: result });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/jira/comments — { keys | campaign_id, dry_run }: each story's coverage as IziTest's comment on it, posted unless dry_run
    if (method === 'POST' && path === '/api/jira/comments') {
      const body = await readBody(req);
      try {
        const result = await commentOnJira({
          keys: Array.isArray(body.keys) ? body.keys : [], campaignId: body.campaign_id ?? null, dryRun: body.dry_run !== false,
        });
        return json(res, 200, { comments: result });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // ── Xray (lib/xray.js): the API key, and a campaign's results sent as a Test Execution ──

    // GET | PUT /api/settings/xray — { clientId, clientSecret }: the secret masked when read, kept when given masked
    if (path === '/api/settings/xray' && (method === 'GET' || method === 'PUT')) {
      if (method === 'GET') return json(res, 200, { xray: maskedXrayConfig() });
      const body = await readBody(req);
      try {
        return json(res, 200, { xray: saveXrayConfig(body) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/settings/xray/test — { clientId, clientSecret } (a secret given masked: the one saved): whether Xray takes it
    if (method === 'POST' && path === '/api/settings/xray/test') {
      const body = await readBody(req);
      try {
        const config = body.clientId
          ? { clientId: body.clientId.trim(), clientSecret: body.clientSecret?.includes('•') ? xrayConfig()?.clientSecret : body.clientSecret }
          : xrayConfig();
        return json(res, 200, { success: true, ...(await testXray(xrayClient(config))) });
      } catch (err) {
        return json(res, 200, { success: false, error: err.message });
      }
    }

    // GET /api/tests/:name/requirements — what the test checks
    params = matchRoute(path, '/api/tests/:name/requirements');
    if (method === 'GET' && params) {
      return json(res, 200, { requirements: requirementsOfTest(params.name) });
    }

    // GET | PUT | DELETE /api/requirements/:ref (key or id)
    params = matchRoute(path, '/api/requirements/:ref');
    if (params && ['GET', 'PUT', 'DELETE'].includes(method)) {
      const existing = getRequirement(params.ref);
      if (!existing) return json(res, 404, { error: 'Requirement not found' });
      if (method === 'GET') return json(res, 200, { requirement: withResolution(existing) });
      if (method === 'DELETE') {
        deleteRequirement(existing.id);
        return json(res, 200, { success: true });
      }
      const body = await readBody(req);
      try {
        // What the body does not give stays as it is; criteria given with their id keep their cases.
        const { requirement } = saveRequirement({
          key: existing.key, title: body.title ?? existing.title, description: body.description ?? existing.description,
          criteria: body.criteria ?? existing.criteria.map((c) => ({ id: c.id, text: c.text })),
          source: body.source ?? existing.source, url: body.url ?? existing.external_url,
          projectId: body.project_id ?? existing.project_id, priority: body.priority ?? existing.priority,
        });
        return json(res, 200, { requirement });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/requirements/:ref/cases — { test_name, case_id, criterion, kind, title, technique, priority, rationale, gherkin }:
    // a test linked (to a planned case), or a case planned
    params = matchRoute(path, '/api/requirements/:ref/cases');
    if (method === 'POST' && params) {
      const body = await readBody(req);
      try {
        const requirement = body.test_name
          ? linkTest(params.ref, body.test_name, { caseId: body.case_id ?? null, criterion: body.criterion ?? null, kind: body.kind ?? 'nominal', title: body.title ?? null })
          : planCases(params.ref, [{
            title: body.title, criterion: body.criterion ?? null, kind: body.kind ?? 'nominal',
            technique: body.technique ?? null, priority: body.priority ?? null, rationale: body.rationale ?? null, gherkin: body.gherkin ?? null,
          }]);
        return json(res, 200, { requirement: withResolution(requirement) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // PUT | DELETE /api/requirements/:ref/cases/:caseId — a case changed (its title, kind, scenario…); a planned case gone, or a test unlinked
    params = matchRoute(path, '/api/requirements/:ref/cases/:caseId');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const changes = Object.fromEntries(['title', 'kind', 'technique', 'priority', 'rationale', 'gherkin'].filter((k) => k in body).map((k) => [k, body[k]]));
      try {
        return json(res, 200, { requirement: withResolution(updateCase(parseInt(params.caseId), changes)) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (method === 'DELETE' && params) {
      try {
        return json(res, 200, { requirement: withResolution(deleteCase(parseInt(params.caseId))) });
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }

    // POST /api/requirements/:ref/design — the agent set in Settings reviews the criteria and proposes scenarios
    // (lib/requirement-design.js); kept on the requirement. One answer, no tools: it takes up to a few minutes.
    params = matchRoute(path, '/api/requirements/:ref/design');
    if (method === 'POST' && params) {
      if (!getRequirement(params.ref)) return json(res, 404, { error: 'Requirement not found' });
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      try {
        const requirement = await designTests(params.ref, { complete, agent: agentName(), signal: abort.signal });
        return json(res, 200, { requirement });
      } catch (err) {
        log(`Test design failed for ${params.ref}: ${err.message}`);
        if (abort.signal.aborted) return;
        return json(res, 502, { error: err.message });
      }
    }
    // DELETE /api/requirements/:ref/design — the proposals dismissed
    if (method === 'DELETE' && params) {
      try {
        return json(res, 200, { requirement: withResolution(saveDesign(params.ref, null)) });
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }

    // POST /api/requirements/:ref/design/plan — { scenarios: ["s1", "s3"] }: the chosen proposals become planned cases
    params = matchRoute(path, '/api/requirements/:ref/design/plan');
    if (method === 'POST' && params) {
      const body = await readBody(req);
      try {
        return json(res, 200, { requirement: planDesigned(params.ref, Array.isArray(body.scenarios) ? body.scenarios : []) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // ── Campaigns (lib/campaigns.js): tests replayed together for a version of the app ──

    // GET /api/campaigns?project_id= — newest first
    if (method === 'GET' && path === '/api/campaigns') {
      const projectId = url.searchParams.get('project_id');
      return json(res, 200, { campaigns: listCampaigns({ projectId: projectId ? Number(projectId) : undefined }) });
    }

    // POST /api/campaigns — { project_id | requirement | tests, version, name, concurrency }: started, runs on its own
    if (method === 'POST' && path === '/api/campaigns') {
      const body = await readBody(req);
      try {
        const { campaign } = startCampaign({
          name: body.name, tests: Array.isArray(body.tests) ? body.tests : undefined, requirement: body.requirement || undefined,
          projectId: body.project_id ?? null, version: body.version ?? null, concurrency: body.concurrency ?? 3,
          headless: body.headless === true,
        }, { sendCommand });
        return json(res, 201, { campaign });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // GET | DELETE /api/campaigns/:id — its report; gone (its runs stay, as runs of their tests)
    params = matchRoute(path, '/api/campaigns/:id');
    if (params && (method === 'GET' || method === 'DELETE')) {
      if (method === 'GET') {
        const campaign = getCampaign(params.id);
        return campaign ? json(res, 200, { campaign }) : json(res, 404, { error: 'Campaign not found' });
      }
      try {
        deleteCampaign(params.id);
        return json(res, 200, { success: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/campaigns/:id/stop — the tests running finish, the others are not started
    params = matchRoute(path, '/api/campaigns/:id/stop');
    if (method === 'POST' && params) {
      try {
        return json(res, 200, { campaign: stopCampaign(params.id) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // POST /api/campaigns/:id/xray — { project_key, test_plan_key, dry_run }: its results as a Test Execution of Xray, sent unless dry_run
    params = matchRoute(path, '/api/campaigns/:id/xray');
    if (method === 'POST' && params) {
      const body = await readBody(req);
      try {
        const result = await exportToXray(params.id, {
          projectKey: body.project_key || null, testPlanKey: body.test_plan_key || null, dryRun: body.dry_run !== false,
        });
        return json(res, 200, { xray: result });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // GET /api/campaigns/:id/junit.xml | report.html — the report for a CI, and to share
    params = matchRoute(path, '/api/campaigns/:id/:file');
    if (method === 'GET' && params && ['junit.xml', 'report.html'].includes(params.file)) {
      const campaign = getCampaign(params.id);
      if (!campaign) return json(res, 404, { error: 'Campaign not found' });
      const isXml = params.file === 'junit.xml';
      res.writeHead(200, {
        'Content-Type': isXml ? 'application/xml; charset=utf-8' : 'text/html; charset=utf-8',
        ...(isXml ? { 'Content-Disposition': `attachment; filename="campaign-${campaign.id}-junit.xml"` } : {}),
      });
      res.end(isXml ? junitReport(campaign) : htmlReport(campaign));
      return;
    }

    // ── Bugs the explorer found (lib/bugs.js), and its explorations ──

    // GET /api/bugs?status=open|dismissed|fixed|all&project_id=
    if (method === 'GET' && path === '/api/bugs') {
      const projectId = url.searchParams.get('project_id');
      return json(res, 200, { bugs: listBugs({ status: url.searchParams.get('status') || 'open', projectId: projectId ? Number(projectId) : undefined }) });
    }

    // PUT /api/bugs/:id — { status: open | dismissed | fixed }
    params = matchRoute(path, '/api/bugs/:id');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      try {
        return json(res, 200, { bug: setBugStatus(parseInt(params.id), body.status) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // GET /api/explorations — the latest
    if (method === 'GET' && path === '/api/explorations') {
      return json(res, 200, { explorations: listExplorations(10) });
    }

    // GET /api/explorations/:id — one, with its bugs
    params = matchRoute(path, '/api/explorations/:id');
    if (method === 'GET' && params) {
      const exploration = getExploration(parseInt(params.id));
      if (!exploration) return json(res, 404, { error: 'Exploration not found' });
      return json(res, 200, { exploration, bugs: listBugs({ status: 'all', explorationId: exploration.id }) });
    }

    // POST /api/explorations — { url, max_pages, interact, project_id }: starts one, answers at once
    if (method === 'POST' && path === '/api/explorations') {
      const body = await readBody(req);
      if (!body.url || !/^https?:\/\//.test(body.url)) return json(res, 400, { error: 'An http(s) URL is needed' });
      const started = new Promise((resolve) => {
        runExploration({
          url: body.url, sendCommand, projectId: body.project_id ?? null,
          maxPages: Math.min(Number(body.max_pages) || 8, 50), interact: body.interact ?? true,
          checks: CHECKS, impacts: DEFAULT_IMPACTS, budgetMs: 120000, onStart: resolve,
        }).catch((err) => {
          log(`Exploration of ${body.url} failed: ${err.message}`);
          resolve(null);
        });
      });
      const id = await started;
      return id ? json(res, 202, { id }) : json(res, 500, { error: 'The exploration could not start' });
    }

    // ── Repairs: proposed when a run fails (lib/triage.js), accepted or not by the user ──

    // GET /api/tests/:name/repairs — the test's repairs, newest first (?open=1: not decided yet)
    params = matchRoute(path, '/api/tests/:name/repairs');
    if (method === 'GET' && params) {
      return json(res, 200, { repairs: listRepairs({ testName: params.name, open: url.searchParams.get('open') === '1' }).map(withDiff) });
    }

    // POST /api/repairs/:id/verify | apply | reject
    params = matchRoute(path, '/api/repairs/:id/:action');
    if (method === 'POST' && params && ['verify', 'apply', 'reject'].includes(params.action)) {
      const id = parseInt(params.id);
      if (!getRepair(id)) return json(res, 404, { error: 'Repair not found' });
      try {
        if (params.action === 'verify') {
          const { repair, passed, error } = await verifyRepair(id, sendCommand);
          return json(res, 200, { repair: withDiff(repair), passed, error: error ?? null });
        }
        const repair = params.action === 'apply' ? applyRepair(id) : rejectRepair(id);
        return json(res, 200, { repair: withDiff(repair) });
      } catch (err) {
        return json(res, 409, { error: err.message, repair: withDiff(getRepair(id)) });
      }
    }

    // ── Steps routes: /api/tests/:name/steps ──

    // POST /api/tests/:name/steps — add step
    params = matchRoute(path, '/api/tests/:name/steps');
    if (method === 'POST' && params) {
      const body = await readBody(req);
      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      const testId = test.id;

      // Get max step_order
      const maxRes = db.prepare(
        'SELECT COALESCE(MAX(step_order), 0) AS max_order FROM test_steps WHERE test_id = ?'
      ).get(testId);
      const nextOrder = Math.min(body.step_order || (maxRes.max_order + 1), maxRes.max_order + 1);

      // Inserted in the middle, the steps after it move down (see insertTestStep).
      const result = insertTestStep(testId, nextOrder, body);
      return json(res, 201, result);
    }

    // PUT /api/tests/:name/steps/:stepOrder — update step
    params = matchRoute(path, '/api/tests/:name/steps/:stepOrder');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      const result = db.prepare(
        `UPDATE test_steps SET
           command = COALESCE(?, command),
           params = COALESCE(?, params),
           locators = COALESCE(?, locators),
           intent = COALESCE(?, intent),
           variable = COALESCE(?, variable),
           assertion = COALESCE(?, assertion)
         WHERE test_id = ? AND step_order = ?
         RETURNING *`
      ).get(
        body.command || null,
        body.params ? JSON.stringify(body.params) : null,
        body.locators ? JSON.stringify(body.locators) : null,
        body.intent !== undefined ? body.intent : null,
        body.variable ? JSON.stringify(body.variable) : null,
        body.assertion ? JSON.stringify(body.assertion) : null,
        test.id,
        parseInt(params.stepOrder)
      );

      if (!result) return json(res, 404, { error: 'Step not found' });
      db.prepare("UPDATE tests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(test.id);
      return json(res, 200, parseRow(result, 'params', 'locators', 'variable', 'assertion'));
    }

    // DELETE /api/tests/:name/steps/:stepOrder — delete step & renumber
    params = matchRoute(path, '/api/tests/:name/steps/:stepOrder');
    if (method === 'DELETE' && params) {
      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      const testId = test.id;
      const stepOrder = parseInt(params.stepOrder);

      const deleteAndReorder = db.transaction(() => {
        const del = db.prepare(
          'DELETE FROM test_steps WHERE test_id = ? AND step_order = ?'
        ).run(testId, stepOrder);
        if (del.changes === 0) return false;

        db.prepare(
          'UPDATE test_steps SET step_order = step_order - 1 WHERE test_id = ? AND step_order > ?'
        ).run(testId, stepOrder);
        db.prepare("UPDATE tests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(testId);
        return true;
      });

      const deleted = deleteAndReorder();
      if (!deleted) return json(res, 404, { error: 'Step not found' });
      return json(res, 200, { success: true });
    }

    // ── PUT /api/tests/:name/steps-reorder — reorder all steps ──
    params = matchRoute(path, '/api/tests/:name/steps-reorder');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      if (!Array.isArray(body.orders)) return json(res, 400, { error: 'orders array required' });

      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      const reorderTransaction = db.transaction(() => {
        const setNeg = db.prepare(
          'UPDATE test_steps SET step_order = ? WHERE id = ? AND test_id = ?'
        );
        // Set all to negative to avoid unique constraint conflicts
        for (const { id, step_order } of body.orders) {
          setNeg.run(-step_order, id, test.id);
        }
        // Flip back to positive
        db.prepare(
          'UPDATE test_steps SET step_order = -step_order WHERE test_id = ? AND step_order < 0'
        ).run(test.id);
        db.prepare("UPDATE tests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(test.id);
      });

      reorderTransaction();
      return json(res, 200, { success: true });
    }

    // ── PROJECTS ──

    // GET /api/projects — each project with what belongs to it (what a deletion leaves without a
    // project) and its last campaign
    if (method === 'GET' && path === '/api/projects') {
      const rows = db.prepare(`
        SELECT p.id, p.name, p.description, p.context, p.project_type, p.base_url, p.language, p.created_at, p.updated_at,
               (SELECT COUNT(*) FROM tests t WHERE t.project_id = p.id) AS test_count,
               (SELECT COUNT(*) FROM requirements r WHERE r.project_id = p.id) AS requirement_count,
               (SELECT COUNT(*) FROM campaigns c WHERE c.project_id = p.id) AS campaign_count,
               (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id AND b.status = 'open') AS open_bug_count
        FROM projects p
        ORDER BY p.updated_at DESC
      `).all();
      const projects = rows.map((p) => {
        const last = p.campaign_count ? listCampaigns({ projectId: p.id, limit: 1 })[0] : null;
        return {
          ...p,
          last_campaign: last && { id: last.id, name: last.name, version: last.version, status: last.status, running: last.running, totals: last.totals, total: last.total, created_at: last.created_at },
        };
      });
      return json(res, 200, { projects });
    }

    // GET /api/projects/:id — get project with its tests
    params = matchRoute(path, '/api/projects/:id');
    if (method === 'GET' && params) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id);
      if (!project) return json(res, 404, { error: 'Project not found' });

      const tests = db.prepare(`
        SELECT t.id, t.name, t.description, t.variables, t.viewport, t.created_at, t.updated_at,
               COUNT(ts.id) AS step_count
        FROM tests t
        LEFT JOIN test_steps ts ON ts.test_id = t.id
        WHERE t.project_id = ?
        GROUP BY t.id
        ORDER BY t.updated_at DESC
      `).all(project.id);

      return json(res, 200, {
        project: {
          ...project,
          tests: parseRows(tests, 'variables', 'viewport')
        }
      });
    }

    // POST /api/projects — create new project
    if (method === 'POST' && path === '/api/projects') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });

      try {
        // The language its tests are written in: its built-in phrases are seeded in it.
        const result = db.prepare(
          `INSERT INTO projects (name, description, context, project_type, base_url, language)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
        ).get(
          body.name,
          body.description || '',
          body.context || '',
          body.project_type || null,
          body.base_url || null,
          languageOf(body.language)
        );
        seedProjectStepDefinitions(result.id);
        return json(res, 201, result);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return json(res, 409, { error: 'Project name already exists' });
        }
        throw err;
      }
    }

    // PUT /api/projects/:id — update project
    params = matchRoute(path, '/api/projects/:id');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const sets = [];
      const vals = [];

      if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
      if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description); }
      if (body.context !== undefined) { sets.push('context = ?'); vals.push(body.context); }
      if (body.project_type !== undefined) { sets.push('project_type = ?'); vals.push(body.project_type); }
      if (body.base_url !== undefined) { sets.push('base_url = ?'); vals.push(body.base_url); }
      if (body.language !== undefined) { sets.push('language = ?'); vals.push(languageOf(body.language)); }
      if (sets.length === 0) return json(res, 400, { error: 'Nothing to update' });

      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      vals.push(params.id);

      try {
        const result = db.prepare(
          `UPDATE projects SET ${sets.join(', ')} WHERE id = ? RETURNING *`
        ).get(...vals);
        if (!result) return json(res, 404, { error: 'Project not found' });
        // Written in another language from now on: its phrases in that one too. Those of the
        // language before stay, so its tests still read and parse.
        if (body.language !== undefined) seedProjectStepDefinitions(result.id);
        return json(res, 200, result);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return json(res, 409, { error: 'Project name already exists' });
        }
        throw err;
      }
    }

    // DELETE /api/projects/:id — delete project (tests will have project_id set to NULL)
    params = matchRoute(path, '/api/projects/:id');
    if (method === 'DELETE' && params) {
      const result = db.prepare('DELETE FROM projects WHERE id = ?').run(params.id);
      if (result.changes === 0) return json(res, 404, { error: 'Project not found' });
      return json(res, 200, { success: true });
    }

    // ── GET /api/projects/:id/elements — what its steps act on, page by page, with their uses ──
    params = matchRoute(path, '/api/projects/:id/elements');
    if (method === 'GET' && params) {
      const projectId = parseInt(params.id, 10);
      if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) return json(res, 404, { error: 'Project not found' });
      return json(res, 200, { elements: listElements(projectId) });
    }

    // ── PATCH /api/elements/:id — rename; DELETE — one no step acts on any more ──
    params = matchRoute(path, '/api/elements/:id');
    if (method === 'PATCH' && params) {
      const body = await readBody(req);
      const result = renameElement(parseInt(params.id, 10), body.name);
      return result.error ? json(res, result.status, { error: result.error }) : json(res, 200, result);
    }
    if (method === 'DELETE' && params) {
      const result = deleteElement(parseInt(params.id, 10));
      return result.error ? json(res, result.status, { error: result.error }) : json(res, 200, result);
    }

    // ── GET /api/projects/:id/step-definitions ──
    params = matchRoute(path, '/api/projects/:id/step-definitions');
    if (method === 'GET' && params) {
      const definitions = listStepDefinitions(parseInt(params.id, 10));
      return json(res, 200, { definitions });
    }

    // ── POST /api/projects/:id/step-definitions ──
    if (method === 'POST' && params) {
      const body = await readBody(req);
      const isComposite = Array.isArray(body.steps_template) && body.steps_template.length > 0;
      if (!body.keyword || !body.pattern || (!body.command && !isComposite)) {
        return json(res, 400, { error: 'keyword, pattern and command (or steps_template) are required' });
      }
      if (!['Given', 'When', 'Then'].includes(body.keyword)) {
        return json(res, 400, { error: 'keyword must be Given, When or Then' });
      }
      try {
        const def = createStepDefinition(parseInt(params.id, 10), {
          keyword: body.keyword,
          pattern: body.pattern,
          command: isComposite ? 'composite' : body.command,
          params_template: body.params_template || {},
          steps_template: isComposite ? body.steps_template : null,
        });
        return json(res, 201, def);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return json(res, 409, { error: 'A step definition with this pattern already exists in the project' });
        }
        throw err;
      }
    }

    // ── PATCH /api/step-definitions/:id ──
    params = matchRoute(path, '/api/step-definitions/:id');
    if (method === 'PATCH' && params) {
      const body = await readBody(req);
      const isComposite = Array.isArray(body.steps_template) && body.steps_template.length > 0;
      if (!body.keyword || !body.pattern || (!body.command && !isComposite)) {
        return json(res, 400, { error: 'keyword, pattern and command (or steps_template) are required' });
      }
      if (!['Given', 'When', 'Then'].includes(body.keyword)) {
        return json(res, 400, { error: 'keyword must be Given, When or Then' });
      }
      try {
        const def = updateStepDefinition(parseInt(params.id, 10), {
          keyword: body.keyword,
          pattern: body.pattern,
          command: isComposite ? 'composite' : body.command,
          params_template: body.params_template || {},
          steps_template: isComposite ? body.steps_template : null,
        });
        if (!def) return json(res, 404, { error: 'Step definition not found or is built-in' });
        return json(res, 200, def);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return json(res, 409, { error: 'A step definition with this pattern already exists in the project' });
        }
        throw err;
      }
    }

    // ── DELETE /api/step-definitions/:id ──
    if (method === 'DELETE' && params) {
      const ok = deleteStepDefinition(parseInt(params.id, 10));
      if (!ok) return json(res, 404, { error: 'Step definition not found or is built-in' });
      return json(res, 200, { success: true });
    }

    // PUT /api/tests/:name/project — assign test to project
    params = matchRoute(path, '/api/tests/:name/project');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const projectId = body.project_id;

      const test = db.prepare('SELECT id FROM tests WHERE name = ?').get(params.name);
      if (!test) return json(res, 404, { error: 'Test not found' });

      if (projectId !== null && projectId !== undefined) {
        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
        if (!project) return json(res, 404, { error: 'Project not found' });
      }

      db.prepare(
        'UPDATE tests SET project_id = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?'
      ).run(projectId || null, test.id);

      return json(res, 200, { success: true });
    }

    // ── The Chrome without windows tests can run in (lib/headless.js) ──

    // GET /api/headless — installed (which version), being installed, running, connected
    if (method === 'GET' && path === '/api/headless') {
      return json(res, 200, { headless: await headlessStatus() });
    }

    // POST /api/headless/install — downloads Chrome for Testing (~150 MB): answers at once,
    // GET /api/headless says how far it is
    if (method === 'POST' && path === '/api/headless/install') {
      installHeadless().catch(() => {});
      return json(res, 202, { headless: await headlessStatus() });
    }

    // POST /api/headless/start | stop
    params = matchRoute(path, '/api/headless/:action');
    if (method === 'POST' && params && (params.action === 'start' || params.action === 'stop')) {
      try {
        if (params.action === 'start') await startHeadless();
        else await stopHeadless();
      } catch (err) {
        return json(res, 409, { error: err.message, headless: await headlessStatus() });
      }
      return json(res, 200, { headless: await headlessStatus() });
    }

    // ── GET /api/settings/agent ──
    if (method === 'GET' && path === '/api/settings/agent') {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
      // The agent the server falls back on when none is set (lib/agent/complete.js): shown as it is.
      const defaults = {
        mode: 'cli',
        cli: { provider: 'claude', command: 'claude' },
        api: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' }
      };
      const value = row ? { ...defaults, ...parseJson(row.value) } : defaults;
      // Never send the full API key to the frontend — mask it
      if (value.api?.apiKey) {
        const key = value.api.apiKey;
        value.api.apiKey = key.length > 8 ? key.slice(0, 4) + '•'.repeat(key.length - 8) + key.slice(-4) : '••••••••';
      }
      return json(res, 200, { agent: value });
    }

    // ── PUT /api/settings/agent ──
    if (method === 'PUT' && path === '/api/settings/agent') {
      const body = await readBody(req);
      if (!body.agent) return json(res, 400, { error: 'agent config is required' });

      const incoming = body.agent;

      // If the API key contains mask characters (•), keep the existing key from the DB
      if (incoming.api?.apiKey && incoming.api.apiKey.includes('•')) {
        const existingRow = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
        if (existingRow) {
          const existing = parseJson(existingRow.value);
          incoming.api.apiKey = existing.api?.apiKey || '';
        }
      }

      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('agent', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(JSON.stringify(incoming));
      log(`Agent config updated: mode=${incoming.mode}, api.provider=${incoming.api?.provider}, api.model=${incoming.api?.model}`);
      return json(res, 200, { success: true, agent: incoming });
    }

    // ── POST /api/settings/agent/test ──
    if (method === 'POST' && path === '/api/settings/agent/test') {
      const body = await readBody(req);
      const command = body.command;
      if (!command) return json(res, 400, { error: 'command is required' });

      try {
        const baseCmd = command.trim().split(/\s+/)[0];
        const { stdout, stderr } = await execFileAsync(baseCmd, ['--version'], {
          timeout: 10000,
          encoding: 'utf-8',
          env: { ...process.env, PATH: process.env.PATH }
        });
        const output = (stdout || stderr || '').trim().substring(0, 200);
        log(`Agent test "${baseCmd} --version" => ${output}`);
        return json(res, 200, { success: true, output });
      } catch (err) {
        try {
          const baseCmd = command.trim().split(/\s+/)[0];
          const { stdout, stderr } = await execFileAsync(baseCmd, ['--help'], {
            timeout: 10000,
            encoding: 'utf-8',
            env: { ...process.env, PATH: process.env.PATH }
          });
          const output = (stdout || stderr || '').trim().substring(0, 200);
          log(`Agent test "${baseCmd} --help" => ${output}`);
          return json(res, 200, { success: true, output });
        } catch (err2) {
          const baseCmd = command.trim().split(/\s+/)[0];
          log(`Agent test failed for "${baseCmd}": ${err2.message}`);
          return json(res, 200, { success: false, error: `Command "${baseCmd}" not found or not executable` });
        }
      }
    }

    // ── GET /api/models — list OpenRouter models that support tool use ──
    if (method === 'GET' && path === '/api/models') {
      try {
        const { OpenRouter } = await import('@openrouter/sdk');
        const client = new OpenRouter();
        const result = await client.models.list();
        const models = result.data
          .filter(m => m.supportedParameters?.includes('tools'))
          .map(m => ({ id: m.id, name: m.name, context: m.contextLength, pricing: m.pricing }));
        return json(res, 200, { models });
      } catch (err) {
        log(`Models list error: ${err.message}`);
        return json(res, 500, { error: err.message });
      }
    }

    // ── POST /api/settings/agent/test-api — validate an OpenRouter API key ──
    if (method === 'POST' && path === '/api/settings/agent/test-api') {
      const body = await readBody(req);
      const { apiKey, model } = body;
      if (!apiKey || !model) return json(res, 400, { error: 'apiKey and model are required' });

      // Resolve actual API key: if masked, read from DB
      let realKey = apiKey;
      if (apiKey.includes('•')) {
        const existingRow = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
        if (existingRow) {
          const existing = parseJson(existingRow.value);
          realKey = existing.api?.apiKey || '';
        }
      }
      if (!realKey) return json(res, 200, { success: false, error: 'No API key configured' });

      try {
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${realKey}`
          },
          body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(15000)
        });
        const data = await resp.json();

        if (resp.ok) {
          log(`API key test OK for ${model}`);
          return json(res, 200, { success: true, output: `${model} — connected successfully` });
        } else {
          const errMsg = data.error?.message || data.error?.type || JSON.stringify(data).substring(0, 200);
          log(`API key test FAILED for ${model}: ${errMsg}`);
          return json(res, 200, { success: false, error: errMsg });
        }
      } catch (err) {
        log(`API key test error: ${err.message}`);
        return json(res, 200, { success: false, error: err.message });
      }
    }

    // ── POST /api/agent/run — stream agent execution via SSE ──
    if (method === 'POST' && path === '/api/agent/run') {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: 'prompt is required' });
      // The requirement the test is for (the dashboard saves the request as one): linked when recorded.
      const requirementLink = body.requirement ? { requirement: String(body.requirement), caseId: body.case_id ?? null, criterion: null } : null;

      // Load agent config
      const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
      const agentConfig = settingsRow ? parseJson(settingsRow.value) : {
        mode: 'cli',
        cli: { provider: 'claude', command: 'claude' },
        api: { model: 'anthropic/claude-haiku-4-5-20251001', apiKey: '' }
      };

      // The agent is told what the requirement expects: the expected results come from it. A CLI agent
      // records through the MCP tools, and is told to link there; the internal one links by itself.
      const linkedRequirement = requirementLink && getRequirement(requirementLink.requirement);
      if (linkedRequirement) {
        body.prompt += `\n\n${recordingBrief(linkedRequirement, requirementLink.caseId, { viaMcp: agentConfig.mode !== 'api' })}`;
      }
      // The app the test is for: where it is and what to know of it, as the project says.
      const project = body.project_id ? db.prepare('SELECT name, base_url, context, language FROM projects WHERE id = ?').get(body.project_id) : null;
      body.prompt += `\n\n${projectBrief(project)}`;

      // ── API mode: internal agent via Vercel AI SDK ──
      if (agentConfig.mode === 'api') {
        const apiConfig = agentConfig.api;
        if (!apiConfig?.apiKey) return json(res, 400, { error: 'No API key configured. Go to Settings to add one.' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        log(`Agent run (API mode): ${apiConfig.model}`);
        log(`Agent prompt:\n--- AGENT PROMPT START ---\n${body.prompt}\n--- AGENT PROMPT END ---`);

        const abortController = new AbortController();
        req.on('close', () => abortController.abort());

        const { runAgent } = await import('./agent-executor.js');
        await runAgent(
          apiConfig,
          body.prompt,
          sendCommand,
          (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); },
          abortController.signal,
          { requirementLink }
        );

        if (!res.writableEnded) res.end();
        return;
      }

      // ── CLI mode: spawn external agent process ──
      const command = agentConfig.cli?.command || 'claude';
      const baseCmd = command.trim().split(/\s+/)[0];

      // Build args based on provider
      const args = [];
      if (agentConfig.cli?.provider === 'claude') {
        const mcpToolNames = [
          'list_profiles', 'navigate', 'click', 'fill', 'extract', 'screenshot',
          'get_tabs', 'get_page_info', 'scroll', 'wait', 'execute_js', 'keyboard',
          'get_cookies', 'snapshot', 'start_recording', 'record_step', 'stop_recording',
          'list_tests', 'run_test', 'fix_test_step', 'delete_test', 'add_assertion', 'close_window'
        ].map(t => `mcp__izitest-agent__${t}`).join(',');
        args.push('-p', body.prompt, '--allowedTools', mcpToolNames, '--allow-dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose');
      } else if (agentConfig.cli?.provider === 'copilot') {
        args.push('-p', body.prompt, '--allow-all', '--allow-all-tools');
      } else if (agentConfig.cli?.provider === 'gemini') {
        args.push('-p', body.prompt, '-y');
      } else if (agentConfig.cli?.provider === 'opencode') {
        args.push('run', body.prompt);
      } else {
        args.push('-p', body.prompt);
      }

      // Create a temp MCP config that connects to the ALREADY-RUNNING server via SSE
      let tmpMcpConfig = null;
      if (agentConfig.cli?.provider === 'claude') {
        tmpMcpConfig = join(tmpdir(), `bp-mcp-${Date.now()}.json`);
        writeFileSync(tmpMcpConfig, JSON.stringify({
          mcpServers: {
            'izitest-agent': {
              type: 'sse',
              url: `http://127.0.0.1:${MCP_PORT}/sse`,
              // The server refuses unauthenticated clients when a token is set.
              ...(process.env.IZITEST_TOKEN
                ? { headers: { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` } }
                : {})
            }
          }
        }), { mode: 0o600 }); // it may hold the token: readable by this user only
        args.push('--mcp-config', tmpMcpConfig, '--strict-mcp-config');
      }

      // Setup SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      log(`Agent run: spawning ${baseCmd} with args: ${JSON.stringify(args.map(a => a.length > 200 ? a.substring(0, 200) + '...' : a))}`);
      log(`Agent prompt:\n--- AGENT PROMPT START ---\n${body.prompt}\n--- AGENT PROMPT END ---`);

      const child = spawn(baseCmd, args, {
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });

      let outputBuffer = '';
      let lineBuffer = '';
      const isClaudeProvider = agentConfig.cli?.provider === 'claude';

      // Parse Claude stream-json and emit only human-readable SSE events
      const processStreamJson = (raw) => {
        lineBuffer += raw;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch { continue; }

          // Assistant text message
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                res.write(`data: ${JSON.stringify({ type: 'chunk', text: block.text })}\n\n`);
              }
              if (block.type === 'tool_use') {
                res.write(`data: ${JSON.stringify({ type: 'tool_call', tool: block.name, input: block.input })}\n\n`);
                log(`Agent tool call: ${block.name}(${JSON.stringify(block.input || {}).substring(0, 500)})`);
              }
            }
            continue;
          }

          // Tool result
          if (parsed.type === 'result' && parsed.result) {
            res.write(`data: ${JSON.stringify({ type: 'chunk', text: parsed.result })}\n\n`);
            continue;
          }
        }
      };

      child.stdout.on('data', (data) => {
        const text = data.toString();
        outputBuffer += text;
        if (isClaudeProvider) {
          processStreamJson(text);
        } else {
          res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
        }
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        log(`Agent stderr: ${text.substring(0, 500)}`);
      });

      child.on('error', (err) => {
        log(`Agent spawn error: ${err.message}`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: `Failed to start agent: ${err.message}` })}\n\n`);
        res.end();
      });

      const cleanupTmpConfig = () => {
        if (tmpMcpConfig) {
          try { unlinkSync(tmpMcpConfig); } catch {}
          tmpMcpConfig = null;
        }
      };

      child.on('close', (code) => {
        cleanupTmpConfig();
        log(`Agent process exited with code ${code} (output: ${outputBuffer.length} chars)`);
        const fixCalls = outputBuffer.match(/fix_test_step/g);
        const runCalls = outputBuffer.match(/run_test/g);
        const navigateCalls = outputBuffer.match(/\bnavigate\b/g);
        log(`Agent summary: fix_test_step calls: ${fixCalls?.length || 0}, run_test calls: ${runCalls?.length || 0}, navigate mentions: ${navigateCalls?.length || 0}`);
        res.write(`data: ${JSON.stringify({ type: 'done', exitCode: code, output: outputBuffer })}\n\n`);
        res.end();
      });

      // If client disconnects, kill the agent process group
      req.on('close', () => {
        if (!child.killed) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          log('Agent process group killed (client disconnected)');
        }
        cleanupTmpConfig();
      });

      return;
    }

    // ── POST /api/agent/chat — conversational agent for test creation ──
    if (method === 'POST' && path === '/api/agent/chat') {
      const body = await readBody(req);
      const result = await handleAgentChat(req, res, body);
      return json(res, result.status, result.body);
    }

    // ── GET /api/projects/:id/conversations — list conversations ──
    params = matchRoute(path, '/api/projects/:id/conversations');
    if (method === 'GET' && params) {
      const conversations = listConversations(parseInt(params.id, 10));
      return json(res, 200, { conversations });
    }

    // ── GET /api/conversations/:id — get conversation with messages ──
    params = matchRoute(path, '/api/conversations/:id');
    if (method === 'GET' && params) {
      const conversation = getConversation(parseInt(params.id, 10));
      if (!conversation) return json(res, 404, { error: 'Conversation not found' });
      return json(res, 200, conversation);
    }

    // ── DELETE /api/conversations/:id — delete conversation ──
    if (method === 'DELETE' && params) {
      const ok = deleteConversation(parseInt(params.id, 10));
      if (!ok) return json(res, 404, { error: 'Conversation not found' });
      return json(res, 200, { success: true });
    }

    // ── GET /api/stats — aggregated dashboard statistics ──
    if (method === 'GET' && path === '/api/stats') {
      const projectId = url.searchParams.get('project_id');
      // The period the runs are counted over: 7, 30 (by default) or 90 days.
      const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
      const since = `DATE('now', '-${days} days')`;

      // Build WHERE clause for project filtering
      let testWhere = '';
      let execWhere = '';
      const queryParams = [];
      if (projectId && projectId !== 'null') {
        testWhere = ' WHERE t.project_id = ?';
        execWhere = ' WHERE e.test_id IN (SELECT id FROM tests WHERE project_id = ?)';
        queryParams.push(projectId);
      }
      const periodWhere = `${execWhere ? `${execWhere} AND` : ' WHERE'} e.started_at >= ${since}`;

      // Test counts: all of them, and those never run
      const testCount = db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM test_executions x WHERE x.test_id = t.id) THEN 1 ELSE 0 END) AS never_run
         FROM tests t${testWhere}`
      ).get(...queryParams);

      // Execution summary, over the period
      const execSummary = db.prepare(
        `SELECT
           COUNT(*) AS total_executions,
           SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN e.status = 'running' THEN 1 ELSE 0 END) AS running,
           ROUND(AVG(e.duration_ms)) AS avg_duration_ms,
           SUM(e.assertions_total) AS assertions_total,
           SUM(e.assertions_passed) AS assertions_passed,
           SUM(e.assertions_failed) AS assertions_failed
         FROM test_executions e${periodWhere}`
      ).get(...queryParams);

      // Recent tests (last 10)
      const recentTests = db.prepare(
        `SELECT t.name, t.description, t.project_id, t.updated_at, COUNT(ts.id) AS step_count
         FROM tests t
         LEFT JOIN test_steps ts ON ts.test_id = t.id
         ${testWhere}
         GROUP BY t.id
         ORDER BY t.updated_at DESC
         LIMIT 10`
      ).all(...queryParams);

      // Recent executions (last 20)
      const recentExecutions = db.prepare(
        `SELECT e.id, e.test_name, e.status, e.started_at, e.finished_at, e.duration_ms,
                e.total_steps, e.completed_steps, e.error,
                e.assertions_total, e.assertions_passed, e.assertions_failed
         FROM test_executions e${periodWhere}
         ORDER BY e.started_at DESC
         LIMIT 20`
      ).all(...queryParams);

      // Execution trend — daily counts over the period
      const execTrend = db.prepare(
        `SELECT
           DATE(e.started_at) AS date,
           COUNT(*) AS total,
           SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM test_executions e${periodWhere}
         GROUP BY DATE(e.started_at)
         ORDER BY date ASC`
      ).all(...queryParams);

      // Top flaky tests (tests with both pass and fail over the period)
      const flakyTests = db.prepare(
        `SELECT e.test_name,
                COUNT(*) AS total_runs,
                SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS pass_count,
                SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS fail_count
         FROM test_executions e${periodWhere}
         GROUP BY e.test_name
         HAVING fail_count > 0 AND pass_count > 0
         ORDER BY fail_count DESC
         LIMIT 5`
      ).all(...queryParams);

      return json(res, 200, {
        days,
        tests: {
          total: testCount.total,
          never_run: testCount.never_run || 0,
          recent: recentTests,
        },
        executions: {
          total: execSummary.total_executions || 0,
          passed: execSummary.passed || 0,
          failed: execSummary.failed || 0,
          running: execSummary.running || 0,
          avg_duration_ms: execSummary.avg_duration_ms || 0,
          assertions_total: execSummary.assertions_total || 0,
          assertions_passed: execSummary.assertions_passed || 0,
          assertions_failed: execSummary.assertions_failed || 0,
          recent: recentExecutions,
          trend: execTrend,
          flaky: flakyTests,
        },
      });
    }

    return json(res, 404, { error: 'API route not found' });
  } catch (err) {
    log(`API error: ${err.message}`);
    if (!res.headersSent) {
      const status = err.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500;
      json(res, status, { error: err.message });
    }
  }
}
