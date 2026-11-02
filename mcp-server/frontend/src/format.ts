// What the pages show alike: a status's colour and label, a project's initials, a time ago,
// a date, a duration.

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'slate';

/** One colour a status, on every page: passed green, failed red, error amber, running blue, not run slate. */
export const STATUS_TONES: Record<string, [Tone, string]> = {
  success: ['green', 'Passed'], passed: ['green', 'Passed'], passing: ['green', 'Passing'], fixed: ['green', 'Fixed'], done: ['blue', 'Done'],
  failed: ['red', 'Failed'], failing: ['red', 'Failing'], regressed: ['red', 'Regressed'],
  error: ['amber', 'Error'], interrupted: ['amber', 'Interrupted'],
  running: ['blue', 'Running'], pending: ['slate', 'Pending'], new: ['blue', 'New'],
  skipped: ['slate', 'Skipped'], not_run: ['amber', 'Not run'], never: ['slate', 'Never run'], not_covered: ['slate', 'Not covered'],
  stopped: ['slate', 'Stopped'], dismissed: ['slate', 'Dismissed'], open: ['red', 'Open'],
};

export function statusTone(status: string | null | undefined): Tone {
  return STATUS_TONES[status ?? 'never']?.[0] ?? 'slate';
}

export function initialsOf(name: string) {
  const words = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[\s'’_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

// ─── Time ────────────────────────────────────────────────────────────

/** "2 min ago", "3 h ago", "yesterday", then the date. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function shortDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} s`;
}
