// The row of its test a run played (mcp-server/lib/datasets.js), as runs and campaigns tell it.

/** The values of a row a run played, one line: "email = bob@x.dev, password = (hidden)". */
export function rowValuesText(values: Record<string, string> | null | undefined): string {
  return Object.entries(values ?? {}).map(([name, value]) => `${name} = ${value}`).join(', ');
}

/** Its first two values, after the row number: " — bob@x.dev, Bob". */
export function rowFirstValues(values: Record<string, string> | null | undefined): string {
  const first = Object.values(values ?? {}).filter((v) => v !== '').slice(0, 2).map((v) => (v.length > 24 ? `${v.slice(0, 23)}…` : v));
  return first.length ? ` — ${first.join(', ')}` : '';
}

/** How the rows of a test did, each by its last run: "row 1 of 2 failed", "2 rows passed", "1 of 3 rows run". */
export function rowsVerdict(rows: { total: number; played: number; failed: number[] } | null | undefined): string | null {
  if (!rows || rows.total < 2) return null;
  if (rows.failed.length) return `${rows.failed.length === 1 ? 'row' : 'rows'} ${rows.failed.join(', ')} of ${rows.total} failed`;
  if (rows.played < rows.total) return `${rows.played} of ${rows.total} rows run`;
  return `${rows.total} rows passed`;
}
