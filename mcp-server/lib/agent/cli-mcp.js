// The MCP config a CLI agent the dashboard starts (`claude -p`: a test recorded by the agent,
// Chat with AI) connects to this server with. Its server has a name of its own: Claude Code
// remembers a server that once refused it ("needs-auth", ~/.claude/mcp-needs-auth-cache.json) by
// name, and skips it from then on — a terminal or Claude Desktop without the token, refused as
// "izitest-agent", left the dashboard's agent unable to record a test. And it always carries the
// server's token: without it, the chat's agent was the one refused.

import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const DASHBOARD_MCP_SERVER = 'izitest-dashboard';

/** The name Claude Code gives tool `name` of that server: what --allowedTools lists. */
export const dashboardToolName = (name) => `mcp__${DASHBOARD_MCP_SERVER}__${name}`;

/**
 * Write the MCP config of a CLI agent run (readable by this user only: it holds the token) and
 * return its path. `runId`: the run its tabs are followed by (lib/live.js followRun).
 */
export function writeAgentMcpConfig({ port, runId = null, prefix = 'bp-mcp' }) {
  const file = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify({
    mcpServers: {
      [DASHBOARD_MCP_SERVER]: {
        type: 'sse',
        url: `http://127.0.0.1:${port}/sse${runId ? `?run=${runId}` : ''}`,
        ...(process.env.IZITEST_TOKEN ? { headers: { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` } } : {}),
      },
    },
  }), { mode: 0o600 });
  return file;
}
