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
  // What belongs to it (what a deletion leaves without a project), and its last campaign.
  requirement_count?: number;
  campaign_count?: number;
  open_bug_count?: number;
  last_campaign?: Pick<Campaign, 'id' | 'name' | 'version' | 'status' | 'running' | 'totals' | 'total' | 'created_at'> | null;
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
  // In the list: how it last ran, and the requirements it checks.
  last_status?: Execution['status'] | null;
  last_run_at?: string | null;
  last_duration_ms?: number | null;
  requirement_keys?: string[];
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
  /** The campaign it ran in, if it did. */
  campaign_id?: number | null;
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

export type CaseKind = 'nominal' | 'alternative' | 'error' | 'boundary';
export type Technique = 'use_case' | 'equivalence_partitioning' | 'boundary_values' | 'decision_table' | 'state_transition' | 'error_guessing';

/** How far a scenario's Gherkin resolves against the project's phrases: ready, or the steps an agent records. */
export interface ScenarioResolution {
  phrases: number;
  unresolved: string[];
  ready: boolean;
  error?: string;
}

export interface RequirementCase {
  id: number;
  criterion_id: number | null;
  title: string;
  kind: CaseKind;
  technique: Technique | null;
  priority: 'high' | 'medium' | 'low' | null;
  rationale: string | null;
  gherkin: string | null;
  resolution?: ScenarioResolution | null;
  position: number;
  test: string | null;
  test_id: number | null;
  last_run: { id: number; status: string; started_at: string } | null;
}

/** A scenario an agent proposed for a requirement (mcp-server/lib/requirement-design.js). */
export interface DesignedScenario {
  id: string;
  title: string;
  criterion: number | null;
  criterion_text: string | null;
  kind: CaseKind;
  technique: Technique | null;
  priority: 'high' | 'medium' | 'low';
  rationale: string | null;
  gherkin: string | null;
  resolution?: ScenarioResolution | null;
}

/** The last test design an agent proposed: the review of the criteria, what is missing, the scenarios. */
export interface RequirementDesign {
  review: Array<{ criterion: number; criterion_text: string; issue: string; question: string | null; suggestion: string | null }>;
  missing: string[];
  scenarios: DesignedScenario[];
  agent: string | null;
  designed_at: string;
  content_hash: string;
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
  design: RequirementDesign | null;
  design_stale: boolean;
  coverage: { status: 'passing' | 'failing' | 'not_run' | 'not_covered'; criteria: number; covered: number; tests: number; planned: number };
}

/** A requirement a test checks, with the criteria it covers there. */
export interface TestRequirement {
  id: number;
  key: string;
  title: string;
  criteria: Array<{ number: number; text: string; kind: string }>;
}

/** How a test did in a campaign (mcp-server/lib/campaigns.js). */
export type CampaignTestStatus = 'passed' | 'failed' | 'error' | 'running' | 'pending' | 'skipped';

export interface CampaignRun {
  name: string;
  status: CampaignTestStatus;
  execution_id: number | null;
  duration_ms: number | null;
  failed_step: number | null;
  total_steps: number | null;
  error: string | null;
  triage: { cause: Triage['cause']; confidence: string; summary: string } | null;
}

/** A requirement as the campaign's runs leave it, criterion by criterion. */
export interface CampaignRequirement {
  key: string;
  title: string;
  status: Requirement['coverage']['status'];
  criteria: Array<{ number: number; text: string; status: 'passing' | 'failing' | 'not_run' | 'not_covered' }>;
}

/** Tests replayed together for a version of the app: a project's, a requirement's, or a list. */
export interface Campaign {
  id: number;
  name: string;
  project_id: number | null;
  project: string | null;
  scope: { project_id?: number; requirement?: string; tests?: string[] };
  version: string | null;
  concurrency: number;
  status: 'running' | 'done' | 'stopped' | 'interrupted';
  created_at: string;
  finished_at: string | null;
  running: boolean;
  totals: Record<CampaignTestStatus, number>;
  total: number;
  duration_ms: number | null;
  changes: { since: { id: number; version: string | null; created_at: string }; regressed: string[]; fixed: string[] } | null;
  requirements: CampaignRequirement[];
  non_conformities: string[];
  runs: CampaignRun[];
  /** The Test Execution of Xray its results were sent to. */
  xray_execution_key: string | null;
  /** Run in the Chrome without windows (mcp-server/lib/headless.js). */
  headless: boolean;
}

/** A campaign's results as sent (or to be sent) to Xray (mcp-server/lib/xray.js). */
export interface XrayExport {
  sent: boolean;
  project: string;
  /** The Test Execution: updated when it was sent before. */
  execution: string | null;
  updates: boolean;
  url?: string | null;
  tests: Array<{ name: string; status: string; stories: string[] }>;
}

/** Each story's coverage as IziTest's comment on it in Jira, to post or posted (mcp-server/lib/jira.js). */
export interface JiraComments {
  sent: boolean;
  comments: Array<{ key: string; action: 'add' | 'update' | 'added' | 'updated'; status: string; text: string; url?: string; error?: string }>;
  warnings: string[];
}

/** A campaign as listed: without its runs and requirements, with what failed. */
export type CampaignSummary = Omit<Campaign, 'requirements' | 'runs'> & { failing_requirements: string[]; failed: string[] };

/** A campaign a test ran in, and how it did there. */
export type TestCampaign = Omit<Campaign, 'requirements' | 'runs' | 'changes'> & { run: CampaignRun | null };

/** What a file of requirements holds, previewed or imported (mcp-server/lib/requirement-import.js). */
export interface RequirementImport {
  format: 'csv' | 'xlsx' | 'json' | 'markdown' | 'jira';
  headers: string[] | null;
  columns: Partial<Record<'key' | 'title' | 'description' | 'criteria' | 'priority' | 'url', string>> | null;
  warnings: string[];
  saved: boolean;
  items: Array<{
    key: string | null;
    title: string;
    description: string;
    criteria: string[];
    priority: Requirement['priority'];
    url: string | null;
    source: Requirement['source'];
    status: 'new' | 'changed' | 'unchanged';
    linked_tests: number;
  }>;
  new: number;
  changed: number;
  unchanged: number;
}
