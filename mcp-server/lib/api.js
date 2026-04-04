// REST API routes for workflow & step CRUD

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { pool } from './db.js';
import { log } from './logger.js';
import { executeWorkflow } from './workflows.js';
import { sendCommand } from './websocket.js';

const execFileAsync = promisify(execFile);

// ─── Helpers ───────────────────────────────────────────────────────

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function matchRoute(pathname, pattern) {
  // pattern like /api/workflows/:name/steps/:stepOrder
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

// ─── Router ────────────────────────────────────────────────────────

export async function apiRouter(req, res, url) {
  const method = req.method;
  const path = url.pathname;

  try {
    // ── GET /api/workflows ──
    if (method === 'GET' && path === '/api/workflows') {
      const result = await pool.query(`
        SELECT w.id, w.name, w.description, w.variables, w.created_at, w.updated_at,
               COUNT(ws.id)::int AS step_count
        FROM workflows w
        LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
        GROUP BY w.id
        ORDER BY w.updated_at DESC
      `);
      return json(res, 200, { workflows: result.rows });
    }

    // ── GET /api/workflows/:name ──
    let params = matchRoute(path, '/api/workflows/:name');
    if (method === 'GET' && params) {
      const wf = await pool.query('SELECT * FROM workflows WHERE name = $1', [params.name]);
      if (wf.rows.length === 0) return json(res, 404, { error: 'Workflow not found' });

      const steps = await pool.query(
        'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order',
        [wf.rows[0].id]
      );
      return json(res, 200, {
        workflow: { ...wf.rows[0], steps: steps.rows }
      });
    }

    // ── POST /api/workflows ──
    if (method === 'POST' && path === '/api/workflows') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });

      const result = await pool.query(
        `INSERT INTO workflows (name, description) VALUES ($1, $2) RETURNING id, name`,
        [body.name, body.description || '']
      );
      return json(res, 201, result.rows[0]);
    }

    // ── PUT /api/workflows/:name ──
    params = matchRoute(path, '/api/workflows/:name');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const sets = [];
      const vals = [];
      let idx = 1;

      if (body.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(body.name); }
      if (body.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(body.description); }
      if (body.variables !== undefined) { sets.push(`variables = $${idx++}`); vals.push(JSON.stringify(body.variables)); }
      if (sets.length === 0) return json(res, 400, { error: 'Nothing to update' });

      sets.push(`updated_at = NOW()`);
      vals.push(params.name);

      const result = await pool.query(
        `UPDATE workflows SET ${sets.join(', ')} WHERE name = $${idx} RETURNING *`,
        vals
      );
      if (result.rowCount === 0) return json(res, 404, { error: 'Workflow not found' });
      return json(res, 200, result.rows[0]);
    }

    // ── DELETE /api/workflows/:name ──
    params = matchRoute(path, '/api/workflows/:name');
    if (method === 'DELETE' && params) {
      const result = await pool.query('DELETE FROM workflows WHERE name = $1 RETURNING id', [params.name]);
      if (result.rowCount === 0) return json(res, 404, { error: 'Workflow not found' });
      return json(res, 200, { success: true });
    }

    // ── POST /api/workflows/:name/execute (Streaming SSE) ──
    params = matchRoute(path, '/api/workflows/:name/execute');
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

      try {
        const resObj = await executeWorkflow(params.name, body.variables, body.substitutions, body.start_step, body.new_window, sendCommand, 'manual', onProgress);
        res.write(`data: ${JSON.stringify({ type: 'execution_completed', result: resObj })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'execution_error', error: err.message, executionId: err.executionId })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    // ── GET /api/workflows/:name/executions ──
    params = matchRoute(path, '/api/workflows/:name/executions');
    if (method === 'GET' && params) {
      const page = parseInt(url.searchParams.get('page') || '0');
      const pageSize = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
      const offset = page * pageSize;

      const wf = await pool.query('SELECT id FROM workflows WHERE name = $1', [params.name]);
      if (wf.rows.length === 0) return json(res, 404, { error: 'Workflow not found' });

      const result = await pool.query(
        `SELECT id, status, started_at, finished_at, duration_ms, total_steps, completed_steps,
                failed_step, error, new_window, trigger
         FROM workflow_executions
         WHERE workflow_id = $1
         ORDER BY started_at DESC
         LIMIT $2 OFFSET $3`,
        [wf.rows[0].id, pageSize, offset]
      );

      const countResult = await pool.query(
        'SELECT COUNT(*)::int AS total FROM workflow_executions WHERE workflow_id = $1',
        [wf.rows[0].id]
      );

      return json(res, 200, { executions: result.rows, total: countResult.rows[0].total, page, pageSize });
    }

    // ── GET /api/executions/:id ──
    params = matchRoute(path, '/api/executions/:id');
    if (method === 'GET' && params) {
      const execId = parseInt(params.id);
      const exec = await pool.query('SELECT * FROM workflow_executions WHERE id = $1', [execId]);
      if (exec.rows.length === 0) return json(res, 404, { error: 'Execution not found' });

      const steps = await pool.query(
        'SELECT * FROM execution_steps WHERE execution_id = $1 ORDER BY step_order',
        [execId]
      );

      return json(res, 200, { execution: { ...exec.rows[0], steps: steps.rows } });
    }

    // ── Steps routes: /api/workflows/:name/steps ──

    // POST /api/workflows/:name/steps — add step
    params = matchRoute(path, '/api/workflows/:name/steps');
    if (method === 'POST' && params) {
      const body = await readBody(req);
      const wf = await pool.query('SELECT id FROM workflows WHERE name = $1', [params.name]);
      if (wf.rows.length === 0) return json(res, 404, { error: 'Workflow not found' });

      const workflowId = wf.rows[0].id;

      // Get max step_order
      const maxRes = await pool.query(
        'SELECT COALESCE(MAX(step_order), 0) AS max_order FROM workflow_steps WHERE workflow_id = $1',
        [workflowId]
      );
      const nextOrder = body.step_order || (maxRes.rows[0].max_order + 1);

      // Shift existing steps if inserting in the middle
      await pool.query(
        'UPDATE workflow_steps SET step_order = step_order + 1 WHERE workflow_id = $1 AND step_order >= $2',
        [workflowId, nextOrder]
      );

      const result = await pool.query(
        `INSERT INTO workflow_steps (workflow_id, step_order, command, params, locators, intent, variable)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, step_order`,
        [
          workflowId, nextOrder,
          body.command || '',
          JSON.stringify(body.params || {}),
          body.locators ? JSON.stringify(body.locators) : null,
          body.intent || null,
          body.variable ? JSON.stringify(body.variable) : null
        ]
      );

      await pool.query('UPDATE workflows SET updated_at = NOW() WHERE id = $1', [workflowId]);
      return json(res, 201, result.rows[0]);
    }

    // PUT /api/workflows/:name/steps/:stepOrder — update step
    params = matchRoute(path, '/api/workflows/:name/steps/:stepOrder');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      const wf = await pool.query('SELECT id FROM workflows WHERE name = $1', [params.name]);
      if (wf.rows.length === 0) return json(res, 404, { error: 'Workflow not found' });

      const result = await pool.query(
        `UPDATE workflow_steps SET
           command = COALESCE($1, command),
           params = COALESCE($2, params),
           locators = COALESCE($3, locators),
           intent = COALESCE($4, intent),
           variable = COALESCE($5, variable)
         WHERE workflow_id = $6 AND step_order = $7
         RETURNING *`,
        [
          body.command || null,
          body.params ? JSON.stringify(body.params) : null,
          body.locators ? JSON.stringify(body.locators) : null,
          body.intent !== undefined ? body.intent : null,
          body.variable ? JSON.stringify(body.variable) : null,
          wf.rows[0].id,
          parseInt(params.stepOrder)
        ]
      );

      if (result.rowCount === 0) return json(res, 404, { error: 'Step not found' });
      await pool.query('UPDATE workflows SET updated_at = NOW() WHERE id = $1', [wf.rows[0].id]);
      return json(res, 200, result.rows[0]);
    }

    // DELETE /api/workflows/:name/steps/:stepOrder — delete step & renumber
    params = matchRoute(path, '/api/workflows/:name/steps/:stepOrder');
    if (method === 'DELETE' && params) {
      const wf = await pool.query('SELECT id FROM workflows WHERE name = $1', [params.name]);
      if (wf.rows.length === 0) return json(res, 404, { error: 'Workflow not found' });

      const workflowId = wf.rows[0].id;
      const stepOrder = parseInt(params.stepOrder);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const del = await client.query(
          'DELETE FROM workflow_steps WHERE workflow_id = $1 AND step_order = $2',
          [workflowId, stepOrder]
        );
        if (del.rowCount === 0) {
          await client.query('ROLLBACK');
          return json(res, 404, { error: 'Step not found' });
        }
        await client.query(
          'UPDATE workflow_steps SET step_order = step_order - 1 WHERE workflow_id = $1 AND step_order > $2',
          [workflowId, stepOrder]
        );
        await client.query('UPDATE workflows SET updated_at = NOW() WHERE id = $1', [workflowId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return json(res, 200, { success: true });
    }

    // ── PUT /api/workflows/:name/steps-reorder — reorder all steps ──
    params = matchRoute(path, '/api/workflows/:name/steps-reorder');
    if (method === 'PUT' && params) {
      const body = await readBody(req);
      if (!Array.isArray(body.orders)) return json(res, 400, { error: 'orders array required' });

      const wf = await pool.query('SELECT id FROM workflows WHERE name = $1', [params.name]);
      if (wf.rows.length === 0) return json(res, 404, { error: 'Workflow not found' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Set all to negative to avoid unique constraint conflicts
        for (const { id, step_order } of body.orders) {
          await client.query(
            'UPDATE workflow_steps SET step_order = $1 WHERE id = $2 AND workflow_id = $3',
            [-step_order, id, wf.rows[0].id]
          );
        }
        // Flip back to positive
        await client.query(
          'UPDATE workflow_steps SET step_order = -step_order WHERE workflow_id = $1 AND step_order < 0',
          [wf.rows[0].id]
        );
        await client.query('UPDATE workflows SET updated_at = NOW() WHERE id = $1', [wf.rows[0].id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return json(res, 200, { success: true });
    }

    // ── GET /api/settings/agent ──
    if (method === 'GET' && path === '/api/settings/agent') {
      const result = await pool.query("SELECT value FROM settings WHERE key = 'agent'");
      const value = result.rows.length > 0 ? result.rows[0].value : {
        mode: 'cli',
        cli: { provider: 'copilot', command: 'copilot' }
      };
      return json(res, 200, { agent: value });
    }

    // ── PUT /api/settings/agent ──
    if (method === 'PUT' && path === '/api/settings/agent') {
      const body = await readBody(req);
      if (!body.agent) return json(res, 400, { error: 'agent config is required' });

      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('agent', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [JSON.stringify(body.agent)]
      );
      log(`Agent config updated: ${JSON.stringify(body.agent)}`);
      return json(res, 200, { success: true, agent: body.agent });
    }

    // ── POST /api/settings/agent/test ──
    if (method === 'POST' && path === '/api/settings/agent/test') {
      const body = await readBody(req);
      const command = body.command;
      if (!command) return json(res, 400, { error: 'command is required' });

      try {
        // Extract just the base command (first word) for version test
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
        // Try --help as fallback (some CLIs don't have --version)
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

    // ── POST /api/agent/run — stream agent CLI execution via SSE ──
    if (method === 'POST' && path === '/api/agent/run') {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: 'prompt is required' });

      // Load agent config
      const settingsResult = await pool.query("SELECT value FROM settings WHERE key = 'agent'");
      const agentConfig = settingsResult.rows.length > 0 ? settingsResult.rows[0].value : {
        mode: 'cli',
        cli: { provider: 'claude', command: 'claude' }
      };

      const command = agentConfig.cli?.command || 'claude';
      const baseCmd = command.trim().split(/\s+/)[0];

      // Build args based on provider
      const args = [];
      if (agentConfig.cli?.provider === 'claude') {
        args.push('-p', body.prompt, '--output-format', 'stream-json', '-y');
      } else if (agentConfig.cli?.provider === 'copilot') {
        args.push('-p', body.prompt, '--allow-all', '--allow-all-tools', '-s', '--no-ask-user');
      } else if (agentConfig.cli?.provider === 'gemini') {
        args.push('-p', body.prompt, '-y');
      } else {
        args.push('-p', body.prompt);
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
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let outputBuffer = '';
      let toolCallBuffer = '';

      // Parse agent output for tool calls (works for Claude stream-json and copilot formats)
      const extractToolCalls = (text) => {
        toolCallBuffer += text;
        // Claude stream-json: look for tool_use events
        const lines = toolCallBuffer.split('\n');
        toolCallBuffer = lines.pop() || ''; // keep incomplete last line
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            // Claude stream-json format
            if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
              log(`Agent tool call: ${parsed.content_block.name}(${JSON.stringify(parsed.content_block.input || {}).substring(0, 500)})`);
            }
            if (parsed.type === 'result' && parsed.subtype === 'tool_use') {
              log(`Agent tool call: ${parsed.tool_name || 'unknown'}(${JSON.stringify(parsed.input || {}).substring(0, 500)})`);
            }
            // Generic: look for tool_name/tool fields
            if (parsed.tool_name || parsed.tool) {
              log(`Agent tool call detected: ${parsed.tool_name || parsed.tool}(${JSON.stringify(parsed.input || parsed.args || {}).substring(0, 500)})`);
            }
          } catch {
            // Not JSON, check for common patterns in text output
            const toolMatch = line.match(/(?:calling|using|tool[_\s]?(?:use|call))[:\s]+(\w+)/i);
            if (toolMatch) {
              log(`Agent tool mention: ${toolMatch[1]} — ${line.substring(0, 300)}`);
            }
          }
        }
      };

      child.stdout.on('data', (data) => {
        const text = data.toString();
        outputBuffer += text;
        extractToolCalls(text);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        log(`Agent stderr: ${text.substring(0, 500)}`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
      });

      child.on('error', (err) => {
        log(`Agent spawn error: ${err.message}`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: `Failed to start agent: ${err.message}` })}\n\n`);
        res.end();
      });

      child.on('close', (code) => {
        log(`Agent process exited with code ${code} (output: ${outputBuffer.length} chars)`);
        // Log a summary of agent actions for debugging
        const fixCalls = outputBuffer.match(/fix_workflow_step/g);
        const replayCalls = outputBuffer.match(/replay_workflow/g);
        const navigateCalls = outputBuffer.match(/\bnavigate\b/g);
        log(`Agent summary: fix_workflow_step calls: ${fixCalls?.length || 0}, replay_workflow calls: ${replayCalls?.length || 0}, navigate mentions: ${navigateCalls?.length || 0}`);
        res.write(`data: ${JSON.stringify({ type: 'done', exitCode: code, output: outputBuffer })}\n\n`);
        res.end();
      });

      // If client disconnects, kill the agent process
      req.on('close', () => {
        if (!child.killed) {
          child.kill('SIGTERM');
          log('Agent process killed (client disconnected)');
        }
      });

      return;
    }

    return json(res, 404, { error: 'API route not found' });
  } catch (err) {
    log(`API error: ${err.message}`);
    if (!res.headersSent) {
      const status = err.code === '23505' ? 409 : 500;
      json(res, status, { error: err.message });
    }
  }
}
