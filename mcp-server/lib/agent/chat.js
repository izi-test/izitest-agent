// Agent chat endpoint — powers the frontend chat UI.
// Supports two modes based on agent config:
//   - API mode: calls LLM API directly (OpenRouter) with manual tool-call loop
//   - CLI mode: spawns external CLI (claude, copilot, gemini…) with -p flag
//     For Claude CLI, uses --resume <session_id> for conversation continuity.

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db, parseJson } from '../db.js';
import { log } from '../logger.js';
import { AGENT_TOOLS, getToolMap } from './tools.js';
import { listStepDefinitions } from '../gherkin/step-definition-store.js';

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3457;

// ─── System prompt builder ─────────────────────────────────────────

function buildSystemPrompt(project) {
  const definitions = listStepDefinitions(project.id);
  const tests = db.prepare(
    'SELECT name, description FROM tests WHERE project_id = ?'
  ).all(project.id);

  const defList = definitions.map(d => {
    const composite = d.steps_template ? ' [composite]' : '';
    return `  - ${d.keyword} ${d.pattern} → ${d.command}${composite}`;
  }).join('\n');

  const testList = tests.length > 0
    ? tests.map(t => `  - ${t.name}${t.description ? ': ' + t.description : ''}`).join('\n')
    : '  (aucun test créé)';

  return `Tu es un assistant spécialisé dans la création de tests BDD (Behavior-Driven Development) pour le projet "${project.name}".

## Ton rôle
- Guider l'utilisateur dans la création de tests en Gherkin
- Proposer des scénarios pertinents basés sur le contexte du projet
- Créer les tests et step definitions quand l'utilisateur valide
- Suggérer des tests manquants

## Contexte du projet
- **ID projet**: ${project.id} (utilise toujours cette valeur pour le paramètre project_id des tools)
- **Nom**: ${project.name}
- **Type**: ${project.project_type || 'non spécifié'}
- **URL de base**: ${project.base_url || 'non spécifiée'}
- **Description**: ${project.description || 'aucune'}

### Spécifications / Notes du projet
${project.context || '(aucun contexte fourni — demande à l\'utilisateur de décrire son projet)'}

## Step definitions disponibles
${defList || '  (uniquement les step definitions par défaut)'}

## Tests existants
${testList}

## Règles
1. Propose toujours le Gherkin en format \`\`\`gherkin avant de créer le test
2. Attends la validation de l'utilisateur avant d'appeler create_test_from_gherkin
3. Si un step nécessaire n'existe pas dans les step definitions, crée d'abord la step definition (simple ou composite) puis le test
4. Utilise la base_url du projet dans les steps de navigation
5. Réponds dans la langue de l'utilisateur
6. Sois concis et pratique — va droit au but
7. Quand tu appelles create_test_from_gherkin, fournis TOUJOURS le paramètre "gherkin" (le .feature complet) et "test_name".
8. Si un outil retourne une erreur, informe l'utilisateur — ne prétends JAMAIS qu'une opération a réussi si elle a échoué.`;
}

// ─── Tool definitions in OpenAI function-calling format ─────────────

function buildToolDefs() {
  return AGENT_TOOLS.map(t => {
    // Remove project_id from properties — it's auto-injected
    const props = { ...t.parameters.properties };
    delete props.project_id;
    const required = (t.parameters.required || []).filter(k => k !== 'project_id');

    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: props, required },
      },
    };
  });
}

// ─── Execute a single tool call ────────────────────────────────────

function executeTool(toolName, args, projectId, conversationMessages) {
  const toolMap = getToolMap();
  const def = toolMap[toolName];
  if (!def) return { error: `Unknown tool: ${toolName}` };

  // Auto-inject project_id
  if ('project_id' in (def.parameters.properties || {})) {
    args.project_id = projectId;
  }

  // Auto-extract gherkin from conversation when the LLM forgets to pass it
  if (toolName === 'create_test_from_gherkin' && !args.gherkin) {
    const lastAssistant = [...conversationMessages]
      .reverse()
      .find(m => m.role === 'assistant' && m.content?.includes('```'));
    if (lastAssistant) {
      const match = lastAssistant.content.match(/```(?:gherkin)?\n([\s\S]*?)```/);
      if (match) {
        args.gherkin = match[1].trim();
        log(`[Agent Chat] Auto-extracted gherkin (${args.gherkin.length} chars)`);
      }
    }
  }
  if (toolName === 'create_test_from_gherkin' && !args.test_name && args.gherkin) {
    const scenarioMatch = args.gherkin.match(/Scenario:\s*(.+)/);
    const featureMatch = args.gherkin.match(/Feature:\s*(.+)/);
    args.test_name = (scenarioMatch || featureMatch)?.[1]?.trim() || 'Untitled test';
    log(`[Agent Chat] Auto-extracted test_name: "${args.test_name}"`);
  }

  // Validate required params
  const reqKeys = (def.parameters.required || []).filter(k => k !== 'project_id');
  const missing = reqKeys.filter(k => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length > 0) {
    return { error: `Missing required parameters: ${missing.join(', ')}` };
  }

  const result = def.handler(args);
  if (result.error) return { error: result.error };
  return result.data || { success: true };
}

// ─── Call OpenRouter API directly ──────────────────────────────────

async function callOpenRouter(apiKey, modelName, messages, systemPrompt, includeTools) {
  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };

  if (includeTools) {
    body.tools = buildToolDefs();
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${text.substring(0, 300)}`);
  }

  const data = await response.json();
  if (!data.choices?.[0]?.message) {
    throw new Error(`Unexpected API response: ${JSON.stringify(data).substring(0, 300)}`);
  }

  return data.choices[0].message;
}

// ─── Conversation persistence ──────────────────────────────────────

function loadConversationMessages(conversationId) {
  return db.prepare(
    'SELECT role, content, tool_calls, tool_results FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conversationId).map(row => ({
    role: row.role,
    content: row.content,
    ...(row.tool_calls && { tool_calls: parseJson(row.tool_calls) }),
    ...(row.tool_results && { tool_results: parseJson(row.tool_results) }),
  }));
}

function saveMessage(conversationId, role, content, toolCalls, toolResults) {
  return db.prepare(
    `INSERT INTO messages (conversation_id, role, content, tool_calls, tool_results) VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).get(
    conversationId,
    role,
    typeof content === 'string' ? content : JSON.stringify(content),
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolResults ? JSON.stringify(toolResults) : null,
  );
}

// ─── CLI: spawn helper ────────────────────────────────────────────

function spawnCli(command, args) {
  return new Promise((resolve, reject) => {
    log(`[Agent Chat CLI] Spawning: ${command} ${args.map(a => a.length > 100 ? a.substring(0, 100) + '...' : a).join(' ')}`);

    const child = spawn(command, args, {
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`CLI exited with code ${code}: ${stderr.substring(0, 500)}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn CLI "${command}": ${err.message}`));
    });
  });
}

// ─── CLI mode chat handler ────────────────────────────────────────

async function handleAgentChatCli(project, convId, message, cliConfig, isNewConversation) {
  const provider = cliConfig.provider || 'claude';
  const command = (cliConfig.command || provider).trim().split(/\s+/)[0];

  // Load existing session_id for conversation resumption
  const conv = db.prepare('SELECT cli_session_id FROM conversations WHERE id = ?').get(convId);
  const existingSessionId = conv?.cli_session_id;

  // Build prompt
  const systemPrompt = buildSystemPrompt(project);
  let prompt;

  if (provider === 'claude' && existingSessionId) {
    // Claude with existing session: context is retained — just send new message
    prompt = message;
  } else {
    // First message or non-session provider: include history
    const history = loadConversationMessages(convId);
    const pastMessages = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1); // exclude the message we just saved

    if (pastMessages.length === 0) {
      prompt = `${systemPrompt}\n\n---\n\nUser:\n${message}`;
    } else {
      // Rebuild conversation for providers without session support
      const historyStr = pastMessages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      prompt = `${systemPrompt}\n\n---\n\nConversation history:\n${historyStr}\n\nUser:\n${message}`;
    }
  }

  // Build CLI args based on provider
  const args = [];
  let tmpMcpConfig = null;

  if (provider === 'claude') {
    const agentToolNames = AGENT_TOOLS
      .map(t => `mcp__izitest-agent__${t.name}`)
      .join(',');

    args.push('-p', prompt, '--output-format', 'json',
      '--allowedTools', agentToolNames,
      '--allow-dangerously-skip-permissions');

    if (existingSessionId) {
      args.push('--resume', existingSessionId);
    }

    // Create temp MCP config pointing to the already-running server
    tmpMcpConfig = join(tmpdir(), `bp-chat-mcp-${Date.now()}.json`);
    writeFileSync(tmpMcpConfig, JSON.stringify({
      mcpServers: {
        'izitest-agent': { type: 'sse', url: `http://127.0.0.1:${MCP_PORT}/sse` }
      }
    }));
    args.push('--mcp-config', tmpMcpConfig, '--strict-mcp-config');

  } else if (provider === 'copilot') {
    args.push('-p', prompt, '--allow-all', '--allow-all-tools');
  } else if (provider === 'gemini') {
    args.push('-p', prompt, '-y');
  } else if (provider === 'opencode') {
    args.push('run', prompt);
  } else {
    args.push('-p', prompt);
  }

  try {
    const { stdout } = await spawnCli(command, args);

    let text = '';
    let newSessionId = null;

    if (provider === 'claude') {
      // Claude --output-format json returns { result, session_id, ... }
      try {
        const result = JSON.parse(stdout);
        text = result.result || '';
        newSessionId = result.session_id || null;
      } catch {
        text = stdout.trim();
      }
    } else {
      text = stdout.trim();
    }

    if (!text) {
      text = 'Désolé, je n\'ai pas pu générer de réponse. Veuillez réessayer.';
    }

    // Store session_id for future resumption (Claude only)
    if (newSessionId) {
      db.prepare('UPDATE conversations SET cli_session_id = ? WHERE id = ?')
        .run(newSessionId, convId);
      log(`[Agent Chat CLI] Stored session_id: ${newSessionId} for conversation ${convId}`);
    }

    return text;

  } finally {
    if (tmpMcpConfig) {
      try { unlinkSync(tmpMcpConfig); } catch {}
    }
  }
}

// ─── API mode chat handler ────────────────────────────────────────

async function handleAgentChatApi(project, convId, message, apiConfig, isNewConversation) {
  const history = loadConversationMessages(convId);
  const llmMessages = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const systemPrompt = buildSystemPrompt(project);

  const MAX_ROUNDS = 5;
  const messages = [...llmMessages];
  let assistantText = '';
  let allToolCalls = [];
  let allToolResults = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const useTools = round < MAX_ROUNDS - 1;

    log(`[Agent Chat API] Round ${round}: ${messages.length} messages, tools=${useTools}`);

    const llmResponse = await callOpenRouter(
      apiConfig.apiKey, apiConfig.model, messages, systemPrompt, useTools
    );

    const hasToolCalls = llmResponse.tool_calls && llmResponse.tool_calls.length > 0;
    log(`[Agent Chat API] Round ${round}: content=${(llmResponse.content || '').length}ch, tool_calls=${llmResponse.tool_calls?.length || 0}`);

    if (!hasToolCalls) {
      assistantText += llmResponse.content || '';
      break;
    }

    if (llmResponse.content) {
      assistantText += llmResponse.content + '\n\n';
    }

    messages.push({
      role: 'assistant',
      content: llmResponse.content || null,
      tool_calls: llmResponse.tool_calls,
    });

    for (const tc of llmResponse.tool_calls) {
      const toolName = tc.function.name;
      let args;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }

      log(`[Agent Chat API] Tool: ${toolName}(${JSON.stringify(args).substring(0, 300)})`);

      const result = executeTool(toolName, args, project.id, messages);
      const resultStr = JSON.stringify(result);

      log(`[Agent Chat API] Result: ${toolName} => ${resultStr.substring(0, 300)}`);

      allToolCalls.push({ name: toolName, args });
      allToolResults.push({ name: toolName, result });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultStr,
      });
    }
  }

  if (!assistantText.trim()) {
    assistantText = 'Désolé, je n\'ai pas pu générer de réponse. Veuillez réessayer.';
  }

  return { text: assistantText.trim(), allToolCalls, allToolResults };
}

// ─── Main chat handler (dispatcher) ───────────────────────────────

export async function handleAgentChat(req, res, body) {
  const { project_id, conversation_id, message } = body;

  if (!project_id || !message) {
    return { status: 400, body: { error: 'project_id and message are required' } };
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
  if (!project) return { status: 404, body: { error: 'Project not found' } };

  // Load agent config
  const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
  const agentConfig = settingsRow ? parseJson(settingsRow.value) : {
    mode: 'cli',
    cli: { provider: 'claude', command: 'claude' },
    api: { model: 'anthropic/claude-haiku-4-5-20251001', apiKey: '' }
  };

  const isCli = agentConfig.mode === 'cli';

  // Validate config for the selected mode
  if (!isCli && !agentConfig.api?.apiKey) {
    return { status: 400, body: { error: 'No API key configured. Go to Settings to add one.' } };
  }

  // Get or create conversation
  const isNewConversation = !conversation_id;
  let convId = conversation_id;
  if (!convId) {
    const conv = db.prepare(
      `INSERT INTO conversations (project_id, title) VALUES (?, ?) RETURNING id`
    ).get(project_id, message.substring(0, 100));
    convId = conv.id;
  }

  // Save user message
  saveMessage(convId, 'user', message);

  try {
    let assistantText;
    let allToolCalls = null;
    let allToolResults = null;

    if (isCli) {
      // ── CLI mode ──
      log(`[Agent Chat] CLI mode — provider=${agentConfig.cli?.provider}, command=${agentConfig.cli?.command}`);
      assistantText = await handleAgentChatCli(
        project, convId, message, agentConfig.cli, isNewConversation
      );
    } else {
      // ── API mode ──
      log(`[Agent Chat] API mode — model=${agentConfig.api?.model}`);
      const result = await handleAgentChatApi(
        project, convId, message, agentConfig.api, isNewConversation
      );
      assistantText = result.text;
      allToolCalls = result.allToolCalls.length > 0 ? result.allToolCalls : null;
      allToolResults = result.allToolResults.length > 0 ? result.allToolResults : null;
    }

    // Save assistant response
    saveMessage(convId, 'assistant', assistantText, allToolCalls, allToolResults);

    // Update conversation title if first exchange
    if (isNewConversation) {
      db.prepare(
        "UPDATE conversations SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      ).run(message.substring(0, 100), convId);
    }

    return {
      status: 200,
      body: {
        conversation_id: convId,
        message: assistantText,
        tool_calls: allToolCalls || undefined,
        tool_results: allToolResults || undefined,
      },
    };
  } catch (err) {
    log(`[Agent Chat] Error: ${err.message}`);
    return { status: 500, body: { error: err.message } };
  }
}

// ─── Conversation CRUD ─────────────────────────────────────────────

export function listConversations(projectId) {
  return db.prepare(
    `SELECT c.*, COUNT(m.id) as message_count
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.project_id = ?
     GROUP BY c.id
     ORDER BY c.updated_at DESC`
  ).all(projectId);
}

export function getConversation(conversationId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return null;

  const messages = db.prepare(
    'SELECT id, role, content, tool_calls, tool_results, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conversationId).map(row => ({
    ...row,
    tool_calls: parseJson(row.tool_calls),
    tool_results: parseJson(row.tool_results),
  }));

  return { ...conv, messages };
}

export function deleteConversation(conversationId) {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  return result.changes > 0;
}
