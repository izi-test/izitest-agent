import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { AssertionResult, Triage } from '../../types';
import { executionsApi } from '../services/executionsApi';
import { toolCallLine, appendLine } from '../../agent-log';

// Module-level reference — non-serializable, kept outside Redux state
let activeAbortController: AbortController | null = null;

const STOPPED_BY_USER_MESSAGE = 'Stopped by user';

export interface LiveStep {
  step: number;
  command: string;
  intent: string | null;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'paused';
  locator?: string;
  error?: string;
  durationMs?: number;
  assertion_result?: AssertionResult | null;
}

interface ExecutionSummary {
  status: 'completed' | 'error';
  totalSteps: number;
  completedSteps: number;
  durationMs?: number | null;
  assertionsTotal?: number;
  assertionsPassed?: number;
  assertionsFailed?: number;
  failedStep?: number | null;
  message?: string | null;
  /** Why it failed, and the repairs proposed (see TriagePanel). */
  triage?: Triage | null;
}

interface ExecutionState {
  isExecuting: boolean;
  isLiveModalOpen: boolean;
  liveSteps: LiveStep[];
  liveStatus: 'starting' | 'running' | 'completed' | 'error' | 'stopped' | 'paused';
  liveError: string | null;
  liveSummary: ExecutionSummary | null;
  isAgentMode: boolean;
  agentOutput: string;
  /** The browser tab the run plays in, once the server has told it: shown live (LiveScreen). */
  liveTabId: number | null;
  refreshTrigger: number;
  isDebugMode: boolean;
  isPaused: boolean;
  breakpoints: number[];
  pausedAtStep: number | null;
  debugExecutionId: number | null;
}

const initialState: ExecutionState = {
  isExecuting: false,
  isLiveModalOpen: false,
  liveSteps: [],
  liveStatus: 'starting',
  liveError: null,
  liveSummary: null,
  isAgentMode: false,
  agentOutput: '',
  liveTabId: null,
  refreshTrigger: 0,
  isDebugMode: false,
  isPaused: false,
  breakpoints: [],
  pausedAtStep: null,
  debugExecutionId: null,
};

/**
 * SSE-based test execution.
 *
 * The thunk opens a streaming connection to the backend and progressively
 * dispatches handleSseEvent for each received SSE event. The backend sends:
 *   - execution_started  → liveStatus = 'running'
 *   - step_start          → add/update a live step as 'running'
 *   - step_complete       → merge the step result
 *   - assertion_result    → add/update assertion step
 *   - execution_completed → liveStatus = 'completed' + summary
 *   - execution_error     → liveStatus = 'error' + summary
 *
 * If the HTTP response itself is an error (non-200, no streaming),
 * we parse the JSON error and throw so the rejected handler catches it.
 */
export const executeTest = createAsyncThunk(
  'execution/executeTest',
  async (
    { testName, newWindow, variables, debug, breakpoints, headless, row }: { testName: string; newWindow: boolean; variables: Record<string, string>; debug?: boolean; breakpoints?: number[]; headless?: boolean; row?: number },
    { dispatch }
  ) => {
    const controller = new AbortController();
    activeAbortController = controller;

    const response = await fetch(`/api/tests/${encodeURIComponent(testName)}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_window: newWindow, variables, debug: debug || false, breakpoints: breakpoints || [], headless: headless || false, ...(row ? { row } : {}) }),
      signal: controller.signal,
    });

    // The execute endpoint always returns 200 with SSE even on errors,
    // but guard against unexpected HTTP errors.
    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        errorMessage = data.error || errorMessage;
      } catch {
        // Could not parse JSON body
      }
      throw new Error(errorMessage);
    }

    if (!response.body) throw new Error('ReadableStream not supported in this browser.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);

        if (chunk.startsWith('data: ')) {
          try {
            const data = JSON.parse(chunk.slice(6));
            dispatch(handleSseEvent(data));
          } catch {
            // Ignore malformed SSE chunks
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    // Invalidate execution cache after execution completes
    dispatch(executionsApi.util.invalidateTags([{ type: 'ExecutionList', id: testName }]));
    activeAbortController = null;
  }
);

export const executeAgent = createAsyncThunk(
  'execution/executeAgent',
  async (
    { prompt }: { prompt: string },
    { dispatch }
  ) => {
    const controller = new AbortController();
    activeAbortController = controller;

    dispatch(setLiveStatus('running'));

    const response = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        errorMessage = data.error || errorMessage;
      } catch {
        // Could not parse JSON body
      }
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response stream');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'chunk') {
            dispatch(appendAgentOutput(event.text));
          } else if (event.type === 'tool_call') {
            dispatch(appendAgentLine(toolCallLine(event.tool, event.input)));
          } else if (event.type === 'live') {
            dispatch(handleSseEvent(event));
          } else if (event.type === 'error') {
            dispatch(setLiveError(event.error));
            dispatch(setLiveStatus('error'));
          } else if (event.type === 'done') {
            dispatch(setLiveStatus(event.exitCode === 0 ? 'completed' : 'error'));
            if (event.exitCode !== 0) {
              dispatch(setLiveError(`Agent exited with code ${event.exitCode}`));
            }
            dispatch(incrementRefreshTrigger());
          }
        } catch {
          // Ignore malformed SSE lines
        }
      }
    }
    activeAbortController = null;
  }
);

/**
 * Abort the current execution (test replay or agent run).
 * Closing the SSE connection triggers the server-side `req.on('close')` handler
 * which kills the child process group automatically.
 */
export const stopExecution = createAsyncThunk(
  'execution/stopExecution',
  async (_, { dispatch }) => {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    dispatch(markAsStopped());
  }
);

const executionSlice = createSlice({
  name: 'execution',
  initialState,
  reducers: {
    closeLiveModal(state) {
      state.isLiveModalOpen = false;
    },
    setLiveStatus(state, action: PayloadAction<'starting' | 'running' | 'completed' | 'error' | 'stopped'>) {
      state.liveStatus = action.payload;
    },
    setLiveError(state, action: PayloadAction<string>) {
      state.liveError = action.payload;
    },
    appendAgentOutput(state, action: PayloadAction<string>) {
      state.agentOutput += action.payload;
    },
    appendAgentLine(state, action: PayloadAction<string>) {
      state.agentOutput = appendLine(state.agentOutput, action.payload);
    },
    incrementRefreshTrigger(state) {
      state.refreshTrigger += 1;
    },
    toggleBreakpoint(state, action: PayloadAction<number>) {
      const step = action.payload;
      const index = state.breakpoints.indexOf(step);
      if (index >= 0) {
        state.breakpoints.splice(index, 1);
      } else {
        state.breakpoints.push(step);
        state.breakpoints.sort((a, b) => a - b);
      }
    },
    handleSseEvent(state, action: PayloadAction<any>) {
      const data = action.payload;
      switch (data.type) {
        case 'live':
          state.liveTabId = typeof data.tabId === 'number' ? data.tabId : null;
          break;
        case 'execution_started':
          state.liveStatus = 'running';
          if (data.debugMode) {
            state.isDebugMode = true;
            state.breakpoints = data.breakpoints || [];
            state.debugExecutionId = data.executionId || null;
          }
          break;
        case 'step_paused': {
          state.liveStatus = 'paused';
          state.isPaused = true;
          state.pausedAtStep = data.step;
          if (data.breakpoints) {
            state.breakpoints = data.breakpoints;
          }
          // Mark the paused step in liveSteps
          const pausedIdx = state.liveSteps.findIndex(s => s.step === data.step);
          if (pausedIdx >= 0) {
            state.liveSteps[pausedIdx].status = 'paused';
          } else {
            state.liveSteps.push({
              step: data.step,
              command: data.command || '?',
              intent: data.intent || null,
              status: 'paused',
            });
            state.liveSteps.sort((a, b) => a.step - b.step);
          }
          break;
        }
        case 'step_start': {
          state.liveStatus = 'running';
          state.isPaused = false;
          state.pausedAtStep = null;
          const existingIdx = state.liveSteps.findIndex(s => s.step === data.step);
          if (existingIdx >= 0) {
            state.liveSteps[existingIdx].status = 'running';
          } else {
            state.liveSteps.push({
              step: data.step,
              command: data.command,
              intent: data.intent,
              status: 'running',
            });
            state.liveSteps.sort((a, b) => a.step - b.step);
          }
          break;
        }
        case 'step_complete': {
          const stepResult = data.stepResult;
          if (!stepResult) break;
          const idx = state.liveSteps.findIndex(s => s.step === stepResult.step);
          if (idx >= 0) {
            state.liveSteps[idx] = { ...state.liveSteps[idx], ...stepResult };
          } else {
            state.liveSteps.push(stepResult);
            state.liveSteps.sort((a, b) => a.step - b.step);
          }
          break;
        }
        case 'assertion_result': {
          const assertStep: LiveStep = {
            step: data.stepOrder,
            command: 'assert',
            intent: data.intent || `Assert: ${data.assertion?.type || 'unknown'}`,
            status: data.result?.passed ? 'success' : 'failed',
            assertion_result: data.result,
            error: data.result?.message || undefined,
          };
          const assertIdx = state.liveSteps.findIndex(s => s.step === data.stepOrder);
          if (assertIdx >= 0) {
            state.liveSteps[assertIdx] = { ...state.liveSteps[assertIdx], ...assertStep };
          } else {
            state.liveSteps.push(assertStep);
            state.liveSteps.sort((a, b) => a.step - b.step);
          }
          break;
        }
        case 'execution_completed':
          state.liveStatus = 'completed';
          state.isExecuting = false;
          state.liveSummary = {
            status: 'completed',
            totalSteps: data.result?.results?.length || state.liveSteps.length,
            completedSteps: data.result?.results?.filter((r: any) => r.status === 'success' || r.status === 'failed' || r.status === 'skipped').length || state.liveSteps.length,
            durationMs: data.result?.durationMs ?? null,
            assertionsTotal: data.result?.assertionsTotal ?? 0,
            assertionsPassed: data.result?.assertionsPassed ?? 0,
            assertionsFailed: data.result?.assertionsFailed ?? 0,
            message: null,
          };
          state.refreshTrigger += 1;
          break;
        case 'execution_error':
          state.liveStatus = 'error';
          state.isExecuting = false;
          state.liveError = data.error;
          state.liveSummary = {
            status: 'error',
            totalSteps: data.totalSteps ?? state.liveSteps.length,
            completedSteps: data.completedSteps ?? state.liveSteps.filter(
              s => s.status === 'success' || s.status === 'failed' || s.status === 'skipped'
            ).length,
            durationMs: data.durationMs ?? null,
            assertionsTotal: data.assertionsTotal ?? undefined,
            assertionsPassed: data.assertionsPassed ?? undefined,
            assertionsFailed: data.assertionsFailed ?? undefined,
            failedStep: data.failedStep ?? null,
            message: data.error,
            triage: data.triage ?? null,
          };
          state.refreshTrigger += 1;
          break;
      }
    },
    markAsStopped(state) {
      state.liveStatus = 'stopped';
      state.isExecuting = false;
      state.isPaused = false;
      state.liveError = STOPPED_BY_USER_MESSAGE;
    },
    resetExecution() {
      activeAbortController = null;
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(executeTest.pending, (state, action) => {
        state.isExecuting = true;
        state.isLiveModalOpen = true;
        state.liveSteps = [];
        state.liveStatus = 'starting';
        state.liveError = null;
        state.liveSummary = null;
        state.agentOutput = '';
        state.liveTabId = null;
        state.isAgentMode = false;
        state.isDebugMode = action.meta.arg.debug || false;
        state.breakpoints = action.meta.arg.breakpoints || [];
        state.isPaused = false;
        state.pausedAtStep = null;
        state.debugExecutionId = null;
      })
      .addCase(executeTest.rejected, (state, action) => {
        // Abort errors are handled by markAsStopped, skip the generic error path
        if (action.error.name === 'AbortError' || state.liveStatus === 'stopped') return;
        state.liveStatus = 'error';
        state.liveError = action.error.message || 'Execution failed';
        state.isExecuting = false;
      })
      .addCase(executeTest.fulfilled, (state) => {
        // Stream ended — if we never got execution_completed/error events, mark as done
        if (state.liveStatus === 'running' || state.liveStatus === 'starting') {
          state.liveStatus = 'completed';
        }
        state.isExecuting = false;
      })
      .addCase(executeAgent.pending, (state) => {
        state.isExecuting = true;
        state.isLiveModalOpen = true;
        state.liveSteps = [];
        state.liveStatus = 'starting';
        state.liveError = null;
        state.liveSummary = null;
        state.agentOutput = '';
        state.liveTabId = null;
        state.isAgentMode = true;
      })
      .addCase(executeAgent.rejected, (state, action) => {
        if (action.error.name === 'AbortError' || state.liveStatus === 'stopped') return;
        state.liveStatus = 'error';
        state.liveError = action.error.message || 'Agent execution failed';
        state.isExecuting = false;
      })
      .addCase(executeAgent.fulfilled, (state) => {
        if (state.liveStatus === 'running' || state.liveStatus === 'starting') {
          state.liveStatus = 'completed';
        }
        state.isExecuting = false;
      });
  },
});

export const {
  closeLiveModal,
  setLiveStatus,
  setLiveError,
  appendAgentOutput,
  appendAgentLine,
  incrementRefreshTrigger,
  toggleBreakpoint,
  handleSseEvent,
  markAsStopped,
  resetExecution,
} = executionSlice.actions;

// --- Debug action thunk ---
export const sendDebugAction = createAsyncThunk(
  'execution/sendDebugAction',
  async (
    { executionId, action, step }: { executionId: number; action: string; step?: number },
  ) => {
    const body: Record<string, unknown> = {};
    if (step !== undefined) body.step = step;

    const response = await fetch(`/api/debug/${executionId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Debug action failed: HTTP ${response.status}`);
    }

    const result = await response.json();

    // If toggling breakpoint, update local state with server's breakpoints
    if (action === 'toggle-breakpoint' && result.breakpoints) {
      // Breakpoints are synced via SSE step_paused events
    }

    return result;
  }
);

export default executionSlice.reducer;
