export interface Variable {
  name: string;
  type: string;
  defaultValue: any;
}

export interface Step {
  id: string;
  workflow_name: string;
  step_order: number;
  command: string;
  intent: string | null;
  params: any;
  variable: Variable | null;
  locators: any | null;
}

export interface Workflow {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
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
}

export interface Execution {
  id: number;
  workflow_name: string;
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
  steps?: ExecutionStep[];
}

