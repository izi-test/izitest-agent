// Tool-call benchmark — measures how an MCP-connected agent performs a task, so the
// same task can be compared with and without the Jev fast path (`act`).
//
// The server cannot see the agent's LLM, but it sees every tool call. For a run
// bracketed by bench_start / bench_stop:
//   wall time   = bench_start → bench_stop
//   tool time   = time spent inside tool handlers (browser, and Jev for `act`)
//   agent time  = wall − tool  → the agent's own LLM round trips (what Jev removes)
//   chars out   = text returned to the agent ≈ tokens it must read (÷4)
//
// State is module-level on purpose: every SSE connection gets its own McpServer,
// but runs must be comparable across connections/conversations.

import { z } from 'zod';
import { log } from './logger.js';

const MAX_RUNS = 10;
const runs = [];      // finished runs, oldest first
let activeRun = null; // { label, startedAt, calls: [{ name, durationMs, chars, error }] }

function resultChars(result) {
  if (!Array.isArray(result?.content)) return 0;
  return result.content.reduce((n, part) => n + (part.text?.length || 0) + (part.data?.length || 0), 0);
}

// Wrap every tool registered AFTER this call. Must run before register*Tools().
export function instrumentTools(server) {
  const registerTool = server.tool.bind(server);
  server.tool = (...args) => {
    const name = args[0];
    const handler = args[args.length - 1];
    if (typeof handler === 'function' && !name.startsWith('bench_')) {
      args[args.length - 1] = async (...handlerArgs) => {
        const startedAt = Date.now();
        let result, error;
        try {
          result = await handler(...handlerArgs);
          return result;
        } catch (err) {
          error = err;
          throw err;
        } finally {
          const call = { name, durationMs: Date.now() - startedAt, chars: resultChars(result), error: !!error || !!result?.isError };
          log(`[Tool] ${name} ${call.durationMs}ms → ${call.chars} chars${call.error ? ' (error)' : ''}`);
          if (activeRun) activeRun.calls.push(call);
        }
      };
    }
    return registerTool(...args);
  };
}

// ─── Pure helpers (unit-tested) ────────────────────────────────────

export function summarize(run) {
  const toolMs = run.calls.reduce((n, c) => n + c.durationMs, 0);
  const wallMs = run.endedAt - run.startedAt;
  const byTool = {};
  for (const c of run.calls) byTool[c.name] = (byTool[c.name] || 0) + 1;
  return {
    label: run.label,
    wallMs,
    toolMs,
    agentMs: Math.max(0, wallMs - toolMs),
    calls: run.calls.length,
    errors: run.calls.filter((c) => c.error).length,
    chars: run.calls.reduce((n, c) => n + c.chars, 0),
    usedAct: !!byTool.act,
    byTool,
  };
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const pad = (s, n) => String(s).padEnd(n);

export function formatComparison(summaries) {
  const lines = [
    `${pad('Run', 22)}${pad('Wall', 9)}${pad('Agent LLM', 11)}${pad('Tools', 9)}${pad('Calls', 7)}${pad('Errors', 8)}Returned to agent`,
  ];
  for (const s of summaries) {
    lines.push(`${pad(s.label + (s.usedAct ? ' [act]' : ''), 22)}${pad(secs(s.wallMs), 9)}${pad(secs(s.agentMs), 11)}${pad(secs(s.toolMs), 9)}${pad(s.calls, 7)}${pad(s.errors, 8)}${s.chars} chars (~${Math.round(s.chars / 4)} tokens)`);
  }

  // Headline: latest run that used `act` vs latest run that did not.
  const withAct = [...summaries].reverse().find((s) => s.usedAct);
  const without = [...summaries].reverse().find((s) => !s.usedAct);
  if (withAct && without && withAct.wallMs > 0 && without.chars > 0) {
    const speedup = without.wallMs / withAct.wallMs;
    const tokenCut = Math.round((1 - withAct.chars / without.chars) * 100);
    lines.push('');
    lines.push(`"${withAct.label}" vs "${without.label}": ${speedup.toFixed(1)}x ${speedup >= 1 ? 'faster' : 'SLOWER'}, ${without.calls} → ${withAct.calls} tool calls, ${Math.abs(tokenCut)}% ${tokenCut >= 0 ? 'less' : 'MORE'} text returned to the agent.`);
    lines.push('Single runs are noisy (LLM latency varies): repeat each variant 2-3 times from the same starting page before concluding.');
  }
  return lines.join('\n');
}

// ─── MCP tools ─────────────────────────────────────────────────────

export function registerBenchTools(server) {
  server.tool(
    'bench_start',
    'Start a benchmark run. Call this FIRST, then perform the task, then call bench_stop. Used to compare the same task done with `act` (Jev) versus with snapshot/click/fill only.',
    { label: z.string().describe('Short name for this run, e.g. "sans-jev" or "avec-jev"') },
    async ({ label }) => {
      activeRun = { label, startedAt: Date.now(), calls: [] };
      log(`[Bench] Run "${label}" started`);
      return { content: [{ type: 'text', text: `Benchmark run "${label}" started. Perform the task now, then call bench_stop.` }] };
    }
  );

  server.tool(
    'bench_stop',
    'Stop the current benchmark run and show it side by side with the previous runs.',
    {},
    async () => {
      if (!activeRun) return { isError: true, content: [{ type: 'text', text: 'No benchmark run in progress — call bench_start first.' }] };
      const finished = { ...activeRun, endedAt: Date.now() };
      activeRun = null;
      runs.push(finished);
      if (runs.length > MAX_RUNS) runs.shift();

      const report = formatComparison(runs.map(summarize));
      log(`[Bench] Run "${finished.label}" finished\n${report}`);
      const last = summarize(finished);
      const breakdown = Object.entries(last.byTool).map(([name, n]) => `${name}×${n}`).join(', ') || 'no tool calls';
      return { content: [{ type: 'text', text: `${report}\n\nThis run ("${last.label}"): ${breakdown}` }] };
    }
  );
}
