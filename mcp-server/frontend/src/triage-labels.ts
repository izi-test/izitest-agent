import type { Triage } from './types';

/** What each cause of a failed run means, as the dashboard names it (mcp-server/lib/triage.js). */
export const CAUSE_LABELS: Record<Triage['cause'], string> = {
  test_drift: 'Test broke — the page changed',
  timing: 'Timing — the element was late',
  changed_value: 'Value changed — regression or intended?',
  disabled: 'Element disabled',
  app_regression: 'Suspected app regression',
  environment: 'Environment — the page did not load',
  unknown: 'Cause unknown',
};
