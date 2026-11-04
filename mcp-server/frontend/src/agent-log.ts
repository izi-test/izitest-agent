// A line of an agent's output for each tool it calls ({ type: 'tool_call', tool, input } from
// POST /api/agent/run): what it does, not only what it says. A value it types is not shown —
// it may be a password —, its intent is.

const DETAIL_KEYS = ['intent', 'url', 'name', 'description', 'text', 'selector', 'ref', 'key'];

export function toolCallLine(tool: string, input: Record<string, unknown> | null | undefined): string {
  const name = tool.split('__').pop() || tool;
  const detail = DETAIL_KEYS.map((key) => input?.[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  const short = detail && detail.length > 140 ? `${detail.slice(0, 137)}…` : detail;
  return `→ ${name}${short ? ` · ${short.replace(/\s+/g, ' ')}` : ''}\n`;
}

/** `line` after `output`, on a line of its own. */
export function appendLine(output: string, line: string): string {
  return output && !output.endsWith('\n') ? `${output}\n${line}` : output + line;
}
