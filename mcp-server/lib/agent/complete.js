// One answer from the dashboard's agent, with no tools: a prompt in, its text out. It is the
// agent set in Settings — a model reached through OpenRouter, or a CLI (claude, copilot,
// gemini, opencode) run once with -p — asked to think, not to act. The dashboard uses it
// for what it asks an agent to reason about, a requirement's test design, and reads the text.

import { db, parseJson } from '../db.js';
import { log } from '../logger.js';
import { callOpenRouter, spawnCli } from './chat.js';

// The agent the chat and the recording agent fall back on when none is set.
const DEFAULT_AGENT = {
  mode: 'cli',
  cli: { provider: 'claude', command: 'claude' },
  api: { model: 'anthropic/claude-haiku-4-5-20251001', apiKey: '' },
};

export function agentConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
  return row ? { ...DEFAULT_AGENT, ...parseJson(row.value) } : DEFAULT_AGENT;
}

/** Who answers, as the dashboard shows it: "claude", "anthropic/claude-haiku-4-5". */
export function agentName(config = agentConfig()) {
  return config.mode === 'api' ? config.api?.model : (config.cli?.provider || 'claude');
}

/**
 * The command line of a CLI for one answer: no tools, no MCP server, no session kept. The
 * system prompt goes apart where the CLI takes one (claude), before the prompt otherwise.
 */
export function cliInvocation(cli, system, prompt) {
  const provider = cli?.provider || 'claude';
  const command = (cli?.command || provider).trim().split(/\s+/)[0];
  if (provider === 'claude') {
    return {
      command, provider,
      args: ['-p', prompt, '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'],
    };
  }
  const whole = `${system}\n\n---\n\n${prompt}`;
  return { command, provider, args: provider === 'opencode' ? ['run', whole] : ['-p', whole] };
}

/** The agent's answer to `prompt`, as text. Stopped when `signal` aborts, or after `timeoutMs`. */
export async function complete({ system, prompt, signal, timeoutMs = 300_000 }) {
  const config = agentConfig();
  if (config.mode === 'api') {
    if (!config.api?.apiKey) throw new Error('No API key configured. Go to Settings to add one.');
    log(`[Agent] One answer from ${config.api.model} (${prompt.length} chars asked)`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const message = await callOpenRouter(config.api.apiKey, config.api.model, [{ role: 'user', content: prompt }], system, false,
      signal ? AbortSignal.any([signal, timeout]) : timeout);
    return message.content ?? '';
  }
  const { command, provider, args } = cliInvocation(config.cli, system, prompt);
  const { stdout } = await spawnCli(command, args, { signal, timeoutMs });
  if (signal?.aborted) throw new Error('Stopped');
  if (provider !== 'claude') return stdout.trim();
  // claude --output-format json: { result, is_error, … }
  let answer;
  try { answer = JSON.parse(stdout); } catch { return stdout.trim(); }
  if (answer.is_error) throw new Error(`${command} failed: ${String(answer.result ?? answer.subtype ?? 'no answer').slice(0, 300)}`);
  return answer.result ?? '';
}
