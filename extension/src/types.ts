// ─── Command Parameters ─────────────────────────────────────────────

export type KeyboardModifier = 'ctrl' | 'shift' | 'alt' | 'meta';

export interface NavigateParams {
  url: string;
  tabId?: number;
}

export interface ClickParams {
  selector?: string;
  tabId?: number;
  text?: string;
  ref?: string;
}

export interface FillParams {
  selector?: string;
  value: string;
  tabId?: number;
  clear?: boolean;
  ref?: string;
}

export interface KeyboardParams {
  key: string;
  modifiers?: KeyboardModifier[];
  tabId?: number;
}

export interface ScrollParams {
  direction?: 'up' | 'down';
  amount?: number;
  tabId?: number;
  selector?: string;
  ref?: string;
}

export interface ExtractParams {
  selector: string;
  attribute?: string;
  tabId?: number;
  multiple?: boolean;
}

export interface SnapshotParams {
  tabId?: number;
  interactiveOnly?: boolean;
  compact?: boolean;
  maxDepth?: number;
  scope?: string | null;
  format?: 'text' | 'json';
  maxTextLength?: number;
  includeHidden?: boolean;
  includeRects?: boolean;
  inlineFrames?: boolean;
}

export interface WaitParams {
  ms?: number;
  selector?: string;
  tabId?: number;
}

export interface ScreenshotParams {
  tabId?: number;
  annotate?: boolean;
}

export interface ExecuteJsParams {
  code: string;
  tabId?: number;
}

export interface GetCookiesParams {
  url?: string;
  domain?: string;
}

export interface CloseTabParams {
  tabId: number;
}

export interface PageInfoParams {
  tabId?: number;
}

// ─── Command Results ────────────────────────────────────────────────

export interface RefNodeInfo {
  role: string;
  name: string;
  level?: number;
  selector?: string;
  rect?: { x: number; y: number; w: number; h: number };
}

export interface SnapshotResult {
  url: string;
  title: string;
  timestamp: number;
  refs?: Record<string, RefNodeInfo>;
  tree: string;
}

export interface ElementCoordinates {
  x: number;
  y: number;
  tag: string;
  text: string;
}

// ─── WebSocket Messages ─────────────────────────────────────────────

export interface IncomingMessage {
  type: 'command';
  id: string;
  command: string;
  params: Record<string, unknown>;
}

export interface OutgoingResultMessage {
  type: 'result';
  id: string;
  result?: unknown;
  error?: string;
}

export interface RegisterMessage {
  type: 'register';
  profileId: string;
  userAgent: string;
}

// ─── CDP Key Definitions ────────────────────────────────────────────

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}
