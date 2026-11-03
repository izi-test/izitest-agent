import { useEffect, useState } from 'react';
import { usePreviewValuesQuery } from './store/services/testsApi';

// Computed values in a test's variables (mcp-server/lib/values.js), as the dashboard tells them
// apart and previews them; ComputedValues.tsx shows them.

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const KEYWORDS = new Set(['today', 'tomorrow', 'yesterday', 'now', 'timestamp', 'uuid', 'unique']);

/** Whether a value holds an expression, not just the {{name}} of a variable. */
export function hasExpression(value: string | undefined): boolean {
  for (const [, inner] of String(value ?? '').matchAll(TEMPLATE)) {
    if (!/^[A-Za-z_]\w*$/.test(inner) || KEYWORDS.has(inner)) return true;
  }
  return false;
}

/** What a run would compute now for `values`, asked once typing pauses; nothing without an expression. */
export function useComputedPreview(values: Record<string, string>, language?: string, projectId?: number | null) {
  const computed = Object.values(values).some(hasExpression);
  const [asked, setAsked] = useState(values);
  const key = JSON.stringify(values);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(JSON.parse(key)), 400);
    return () => clearTimeout(timer);
  }, [key]);
  // With the project: an expression may read one of its datasets ({{users[2].email}}).
  const { data } = usePreviewValuesQuery({ values: asked, language, project_id: projectId }, { skip: !computed });
  return computed ? data : undefined;
}

export const COMPUTED_HELP = 'A value can be computed at each run: {{today + 3 days | dd/MM/yyyy}}, {{now | HH:mm}}, user-{{unique}}@example.com, {{random(1000, 9999)}}, {{round(price * 1.2, 2)}}, or read in a dataset: {{users[2].email}}.';
