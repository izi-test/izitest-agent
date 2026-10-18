// Unit tests for the tool-call benchmark (fake MCP server — no network, no DB).
// Run with: node --test test/bench.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentTools, registerBenchTools, summarize, formatComparison } from '../lib/bench.js';

// Minimal stand-in for McpServer: remembers the handler registered for each tool.
function fakeServer() {
  const handlers = {};
  return { handlers, tool: (...args) => { handlers[args[0]] = args[args.length - 1]; } };
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('summarize splits wall time into tool time and agent time', () => {
  const s = summarize({
    label: 'sans-jev', startedAt: 1000, endedAt: 11000,
    calls: [
      { name: 'snapshot', durationMs: 300, chars: 8000, error: false },
      { name: 'click', durationMs: 200, chars: 120, error: false },
      { name: 'snapshot', durationMs: 500, chars: 6000, error: true },
    ],
  });
  assert.deepEqual(
    { wallMs: s.wallMs, toolMs: s.toolMs, agentMs: s.agentMs, calls: s.calls, errors: s.errors, chars: s.chars, usedAct: s.usedAct },
    { wallMs: 10000, toolMs: 1000, agentMs: 9000, calls: 3, errors: 1, chars: 14120, usedAct: false },
  );
  assert.deepEqual(s.byTool, { snapshot: 2, click: 1 });
});

test('formatComparison headlines the act run against the manual run', () => {
  const out = formatComparison([
    { label: 'sans-jev', wallMs: 24000, toolMs: 4000, agentMs: 20000, calls: 9, errors: 0, chars: 18000, usedAct: false, byTool: {} },
    { label: 'avec-jev', wallMs: 6000, toolMs: 2000, agentMs: 4000, calls: 2, errors: 0, chars: 900, usedAct: true, byTool: {} },
  ]);
  assert.match(out, /sans-jev\s+24\.0s\s+20\.0s\s+4\.0s\s+9/);
  assert.match(out, /avec-jev \[act\]\s+6\.0s/);
  assert.match(out, /"avec-jev" vs "sans-jev": 4\.0x faster, 9 → 2 tool calls, 95% less text/);
});

test('formatComparison says so when act is slower', () => {
  const out = formatComparison([
    { label: 'manual', wallMs: 5000, toolMs: 1000, agentMs: 4000, calls: 3, errors: 0, chars: 1000, usedAct: false, byTool: {} },
    { label: 'jev', wallMs: 10000, toolMs: 9000, agentMs: 1000, calls: 1, errors: 0, chars: 2000, usedAct: true, byTool: {} },
  ]);
  assert.match(out, /0\.5x SLOWER/);
  assert.match(out, / 100% MORE text/);
});

test('instrumented tools are recorded only inside a bench run, and results pass through', async () => {
  const server = fakeServer();
  instrumentTools(server);
  server.tool('click', 'desc', {}, async () => { await wait(20); return text('clicked!'); });
  server.tool('act', 'desc', {}, async () => text('act: DONE'));
  server.tool('boom', 'desc', {}, async () => { throw new Error('nope'); });
  registerBenchTools(server);

  // Outside a run: works, not recorded.
  assert.deepEqual(await server.handlers.click({}), text('clicked!'));

  await server.handlers.bench_start({ label: 'avec-jev' });
  await server.handlers.click({});
  await server.handlers.act({});
  await assert.rejects(() => server.handlers.boom({}), /nope/); // errors still propagate
  const stop = await server.handlers.bench_stop({});

  const out = stop.content[0].text;
  assert.match(out, /avec-jev \[act\]/);
  assert.match(out, /click×1, act×1, boom×1/);
  // 3 calls, 1 error, and the click's ≥20ms is counted as tool time.
  assert.match(out, /avec-jev \[act\]\s+\S+\s+\S+\s+\S+\s+3\s+1\s/);
});

test('bench_stop without bench_start is an error, not a crash', async () => {
  const server = fakeServer();
  registerBenchTools(server);
  const res = await server.handlers.bench_stop({});
  assert.equal(res.isError, true);
});
