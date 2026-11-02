export interface Project {
  id: number;
  name: string;
  description: string | null;
  context: string;
  project_type: 'frontend' | 'backend' | 'fullstack' | null;
  base_url: string | null;
  created_at: string;
  updated_at: string;
  test_count?: number;
  tests?: Test[];
}

export interface Conversation {
  id: number;
  project_id: number;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tool_calls?: any[];
  tool_results?: any[];
  created_at: string;
}

export interface ChatResponse {
  conversation_id: number;
  message: string;
  tool_calls?: { name: string; args: any }[];
  tool_results?: { name: string; result: any }[];
}

export interface Variable {
  name: string;
  type: string;
  defaultValue: any;
}

export interface Assertion {
  type: string;
  selector?: string;
  expected?: string;
  attribute?: string;
}

export interface AssertionResult {
  passed: boolean;
  expected: string;
  actual: string;
  type: string;
  message?: string;
  screenshotUrl?: string | null;
  screenshotDataUrl?: string | null;
  refScreenshotUrl?: string | null;
}

export interface Step {
  id: string;
  test_name: string;
  step_order: number;
  command: string;
  intent: string | null;
  params: any;
  variable: Variable | null;
  locators: any | null;
  assertion: Assertion | null;
}

export interface Test {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  project_id?: number | null;
  viewport?: { width: number; height: number } | null;
  step_count?: number;
  variables?: Record<string, any>;
  steps?: Step[];
}

export interface ExecutionStep {
  id: number;
  step_order: number;
  command: string;
  intent: string | null;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  locator_used: string | null;
  error: string | null;
  assertion_result: AssertionResult | null;
}

/** Why a run failed, worked out on the page it failed on (mcp-server/lib/triage.js). */
export interface Triage {
  cause: 'test_drift' | 'timing' | 'changed_value' | 'disabled' | 'app_regression' | 'non_conformity' | 'environment' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  evidence?: {
    page?: { url: string | null; title: string | null; alerts: string[]; failedRequests: Array<{ method: string; url: string; status: number }> };
    history?: { passes: number; lastPass: string | null };
  };
  proposals: Array<{ id: number; kind: string; step_order: number; summary: string; needs_review?: boolean }>;
}

/** A change to one step proposed by the triage, and where it stands. */
export interface Repair {
  id: number;
  test_name: string;
  execution_id: number | null;
  step_order: number;
  kind: 'relocate' | 'wait' | 'expect';
  cause: Triage['cause'];
  summary: string;
  needs_review: boolean;
  status: 'proposed' | 'verified' | 'failed' | 'applied' | 'rejected' | 'superseded' | 'stale';
  verify_execution_id: number | null;
  verify_error: string | null;
  diff: string[];
}

export interface Execution {
  id: number;
  test_name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  total_steps: number;
  completed_steps: number;
  failed_step: number | null;
  error: string | null;
  new_window: boolean;
  trigger: string;
  assertions_total: number;
  assertions_passed: number;
  assertions_failed: number;
  steps?: ExecutionStep[];
  triage_cause?: Triage['cause'] | null;
  triage?: Triage | null;
  repairs?: Repair[];
}

/** A bug the explorer found (mcp-server/lib/bugs.js), with the test that reproduces it. */
export interface Bug {
  id: number;
  kind: 'console_error' | 'failed_request' | 'broken_link' | 'a11y';
  severity: 'high' | 'medium' | 'low';
  title: string;
  page_url: string;
  details: Record<string, unknown>;
  repro_test: string | null;
  reproduced: boolean | null;
  status: 'open' | 'dismissed' | 'fixed';
  occurrences: number;
  first_seen: string;
  last_seen: string;
  exploration_id: number | null;
}

/** One run of the explorer. */
export interface Exploration {
  id: number;
  start_url: string;
  status: 'running' | 'done' | 'failed';
  pages: Array<{ url: string; findings: number; clicks: number; error?: string; skipped?: string }>;
  bugs_found: number;
  bugs_new: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** A requirement: what tests are for (mcp-server/lib/requirements.js). */
export interface Criterion {
  id: number;
  position: number;
  text: string;
}

export interface RequirementCase {
  id: number;
  criterion_id: number | null;
  title: string;
  kind: 'nominal' | 'alternative' | 'error' | 'boundary';
  position: number;
  test: string | null;
  test_id: number | null;
  last_run: { id: number; status: string; started_at: string } | null;
}

export interface Requirement {
  id: number;
  key: string;
  project_id: number | null;
  title: string;
  description: string;
  source: 'prompt' | 'manual' | 'jira' | 'import';
  external_url: string | null;
  priority: 'high' | 'medium' | 'low';
  created_at: string;
  updated_at: string;
  criteria: Criterion[];
  cases: RequirementCase[];
  coverage: { status: 'passing' | 'failing' | 'not_run' | 'not_covered'; criteria: number; covered: number; tests: number; planned: number };
}

/** A requirement a test checks, with the criteria it covers there. */
export interface TestRequirement {
  id: number;
  key: string;
  title: string;
  criteria: Array<{ number: number; text: string; kind: string }>;
}
