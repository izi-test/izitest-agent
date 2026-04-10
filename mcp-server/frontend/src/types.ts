export interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  test_count?: number;
  tests?: Test[];
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
}
