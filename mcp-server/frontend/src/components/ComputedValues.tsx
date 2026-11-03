import { hasExpression } from '../values';

// Computed values in a test's variables (mcp-server/lib/values.js): {{today + 3 days | dd/MM/yyyy}},
// user-{{unique}}@example.com, {{round(price * 1.2, 2)}}, worked out at each run. The Data tab
// shows what a run would compute now, or what does not work out.

/** Under a value with an expression: what it gives now, or why it does not work out. */
export function ComputedHint({ name, value, preview }: {
  name: string; value: string; preview?: { values: Record<string, string>; problems: string[] };
}) {
  if (!hasExpression(value) || !preview) return null;
  const problem = preview.problems.find((p) => p.startsWith(`{{${name}}}`));
  if (problem) return <span className="computed-hint computed-hint--error">{problem.replace(`{{${name}}} — `, '')}</span>;
  return <span className="computed-hint">Computed at each run · now <span className="mono">{preview.values[name]}</span></span>;
}
