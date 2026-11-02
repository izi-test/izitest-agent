// ─── Command Parameters ─────────────────────────────────────────────

export type KeyboardModifier = 'ctrl' | 'shift' | 'alt' | 'meta';

export interface NavigateParams {
  url: string;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  newWindow?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface ClickParams {
  selector?: string;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  text?: string;
  ref?: string;
  /** A field named by the label a person reads next to it, not a selector (see dom/field-label.ts). */
  label?: string;
  /**
   * For a checkbox, radio or switch (or its label): the state wanted. The click is skipped
   * when the box is already in it. A string after a {{variable}} is replaced ("true"/"false").
   */
  checked?: boolean | string;
}

// 'keys'   — one keyDown/keyUp per character: human-like, but ~2 CDP round trips per char.
// 'insert' — the whole value in one Input.insertText call: fast, fires input events
//            but no per-character key events (less human-like; key-driven widgets may not react).
export type TypingMode = 'keys' | 'insert';

export interface FillParams {
  selector?: string;
  value: string;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  clear?: boolean;
  ref?: string;
  /** A field named by the label a person reads next to it, not a selector (see dom/field-label.ts). */
  label?: string;
  typing?: TypingMode;
}

export interface SelectParams {
  selector?: string;
  value: string;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  ref?: string;
  /** A field named by the label a person reads next to it, not a selector (see dom/field-label.ts). */
  label?: string;
  matchBy?: 'value' | 'text';
}

export interface UploadParams {
  selector?: string;
  ref?: string;
  /** The files' content, read by the server: the extension cannot read the disk. */
  fileData: Array<{ name: string; type: string; base64: string }>;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface DragParams {
  /** What is dragged: a ref, or a selector. */
  ref?: string;
  selector?: string;
  /** Where it is dropped: a ref, or a selector (what a recorded step keeps). */
  targetRef?: string;
  target?: string;
  /** Where on the target: its centre (default), or near one of its edges. */
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface ConsoleMessagesParams {
  tabId?: number;
  sessionId?: string;
  /** Only what was logged from this time on (ms since epoch). */
  since?: number;
  /** 'error' (default), or 'warning' for warnings too. */
  level?: 'error' | 'warning';
}

export interface CheckLinksParams {
  tabId?: number;
  sessionId?: string;
  /** Only the links this selector matches (default: every a[href]). */
  selector?: string;
  limit?: number;
}

export interface RunAxeParams {
  tabId?: number;
  sessionId?: string;
  /** Only these axe rule ids (default: WCAG 2.1 A/AA and best practices). */
  rules?: string[];
  /** Only this part of the page. */
  selector?: string;
}

export interface KeyboardParams {
  key: string;
  modifiers?: KeyboardModifier[];
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface ScrollParams {
  direction?: 'up' | 'down';
  amount?: number;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  selector?: string;
  ref?: string;
}

export interface ExtractParams {
  selector: string;
  attribute?: string;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  multiple?: boolean;
}

export interface SnapshotParams {
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  interactiveOnly?: boolean;
  compact?: boolean;
  maxDepth?: number;
  scope?: string | null;
  format?: 'text' | 'json';
  maxTextLength?: number;
  includeHidden?: boolean;
  includeRects?: boolean;
  inlineFrames?: boolean;
  pointerInteractive?: boolean;
  textDigest?: boolean;
}

export interface WaitParams {
  ms?: number;
  selector?: string;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface ScreenshotParams {
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  annotate?: boolean;
  // Default PNG (lossless — required by visual regression). JPEG is ~5x smaller: use it
  // when the image is only going to be looked at by a model.
  format?: 'png' | 'jpeg';
  quality?: number;
}

export interface ExecuteJsParams {
  code: string;
  tabId?: number;
  /** Run inside this iframe: the ref of its <iframe> (@e4) or a piece of its URL. */
  frame?: string;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface GetCookiesParams {
  url?: string;
  domain?: string;
}

export interface CloseTabParams {
  tabId: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface CloseWindowParams {
  /**
   * Sessions the server currently considers alive. A window owned by a session that is
   * NOT in this list is an orphan — its agent is gone — so any session may close it.
   * Without this, orphaned working windows could be closed by nobody and piled up.
   */
  liveSessions?: string[];
  tabId: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string; // any tab of the window to close
}

export interface PageInfoParams {
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
}

export interface NetworkRequestsParams {
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  textFilter?: string;
  method?: string;
  resourceType?: string;
  requestBodyFilter?: string;
  limit?: number;
}

export interface NetworkResponseParams {
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  id: string;
  jsonPath?: string;
  maxLength?: number;
}

export interface NetworkSearchParams {
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  textFilter?: string;
  method?: string;
  resourceType?: string;
  requestBodyFilter?: string;
  jsonPath?: string;
  bodyContains?: string;
  limit?: number;
  maxMatches?: number;
}

// ─── Command Results ────────────────────────────────────────────────

export interface Locator {
  type: 'text' | 'css' | 'testid' | 'placeholder' | 'label' | 'aria' | 'attribute' | 'xpath' | 'role';
  value: string;
  /** For `role`: the accessible name, as Chrome computes it (value is the role). */
  name?: string;
  /** For `role`, when that role and name is on the page more than once: the ancestor holding only this one… */
  scope?: { testid?: string; css?: string };
  /** …or, without one, its rank among them (from 0). */
  nth?: number;
}

export interface ListContext {
  type: 'list' | 'box';
  parentSelector: string;
  itemXpath: string;
  totalItems: number;
  selectedIndex: number;
  selectedText?: string;
  selectionMode: 'by_index' | 'by_text';
}

export interface VariableInfo {
  name: string;
  type: 'text' | 'select' | 'list_item' | 'box_item';
  defaultValue?: string;
  listContext?: ListContext;
}

export interface WorkflowStep {
  command: string;
  intent?: string;
  params: Record<string, any>;
  locators?: Locator[];
  variable?: VariableInfo;
}

export interface ReplaySequenceParams {
  steps: WorkflowStep[];
  startIndex: number;
  newWindow?: boolean;
  tabId?: number;
  /** IziTest Agent session this command belongs to — scopes tab resolution to its window. */
  sessionId?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface RefNodeInfo {
  role: string;
  name: string;
  level?: number;
  selector?: string;
  locators?: Locator[];
  rect?: { x: number; y: number; w: number; h: number };
}

export interface SnapshotResult {
  url: string;
  title: string;
  timestamp: number;
  refs?: Record<string, RefNodeInfo>;
  tree: string;
  /** The page had no refs before this snapshot: the refs of the page before are void. */
  freshRefs?: boolean;
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
