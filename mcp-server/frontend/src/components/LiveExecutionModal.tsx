import { useEffect, useRef } from "react";
import type { LiveStep } from "../store/slices/executionSlice";
import {
  Loader2, CheckCircle2, XCircle, SkipForward, X, Bot,
  ShieldCheck, Square, Play, SkipForward as StepForwardIcon,
  FastForward, Pause, Circle
} from "lucide-react";

export interface LiveExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStop?: () => void;
  testName: string;
  totalSteps: number;
  liveSteps: LiveStep[];
  executionStatus: 'starting' | 'running' | 'completed' | 'error' | 'stopped' | 'paused';
  executionError: string | null;
  agentMode?: boolean;
  agentOutput?: string;
  executionSummary?: {
    status: 'completed' | 'error';
    totalSteps: number;
    completedSteps: number;
    durationMs?: number | null;
    assertionsTotal?: number;
    assertionsPassed?: number;
    assertionsFailed?: number;
    failedStep?: number | null;
    message?: string | null;
  } | null;
  isDebugMode?: boolean;
  isPaused?: boolean;
  breakpoints?: number[];
  pausedAtStep?: number | null;
  onResume?: () => void;
  onStepOver?: () => void;
  onContinue?: () => void;
  onToggleBreakpoint?: (step: number) => void;
}

function formatDuration(ms?: number | null) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusIcon({ status, isAssertion }: { status: string; isAssertion?: boolean }) {
  if (status === 'pending') return <span className="live-icon pending">●</span>;
  if (status === 'running') return <Loader2 size={16} className="live-icon running spin" />;
  if (status === 'paused') return <Pause size={16} className="live-icon paused" />;
  if (status === 'success') return isAssertion
    ? <ShieldCheck size={16} className="live-icon success" />
    : <CheckCircle2 size={16} className="live-icon success" />;
  if (status === 'failed') return <XCircle size={16} className="live-icon failed" />;
  if (status === 'skipped') return <SkipForward size={16} className="live-icon skipped" />;
  return null;
}

export function LiveExecutionModal({
  isOpen,
  onClose,
  onStop,
  testName,
  totalSteps,
  liveSteps,
  executionStatus,
  executionError,
  agentMode = false,
  agentOutput = '',
  executionSummary = null,
  isDebugMode = false,
  isPaused = false,
  breakpoints = [],
  pausedAtStep = null,
  onResume,
  onStepOver,
  onContinue,
  onToggleBreakpoint,
}: LiveExecutionModalProps) {
  const agentOutputRef = useRef<HTMLDivElement>(null);
  const isRunning = executionStatus === 'starting' || executionStatus === 'running' || executionStatus === 'paused';

  useEffect(() => {
    if (agentMode && agentOutputRef.current) {
      agentOutputRef.current.scrollTop = agentOutputRef.current.scrollHeight;
    }
  }, [agentOutput, agentMode]);

  if (!isOpen) return null;

  const completedCount = liveSteps.filter(s => s.status === 'success' || s.status === 'failed' || s.status === 'skipped').length;
  const progressPercent = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;
  const finalCompletedSteps = executionSummary?.completedSteps ?? completedCount;
  const finalTotalSteps = executionSummary?.totalSteps ?? totalSteps;
  const summaryDuration = formatDuration(executionSummary?.durationMs);
  const hasAssertionSummary = (executionSummary?.assertionsTotal ?? 0) > 0;
  const breakpointSet = new Set(breakpoints);

  return (
    <div className="live-exec-overlay" onClick={() => {
      if (!isRunning) onClose();
    }}>
      <div className="live-exec-drawer" onClick={e => e.stopPropagation()}>
        <div className="live-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2>
              {agentMode && <Bot size={18} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />}
              {agentMode ? `Agent: "${testName}"` : `Running "${testName}"`}
            </h2>
            <div className="live-status-badge" data-status={executionStatus}>
              {executionStatus.toUpperCase()}
            </div>
            {isDebugMode && (
              <div className="live-debug-badge">DEBUG</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isRunning && onStop && (
              <button
                className="live-stop-btn"
                onClick={onStop}
                title="Stop execution"
              >
                <Square size={14} />
                Stop
              </button>
            )}
            {!isRunning && (
              <button
                className="live-close-btn"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={24} />
              </button>
            )}
          </div>
        </div>

        {agentMode ? (
          <div className="agent-output-container" ref={agentOutputRef}>
            <pre className="agent-output-pre">
              {agentOutput || 'Waiting for agent...'}
            </pre>
          </div>
        ) : (
          <>
            <div className="live-progress-container">
              <div className="live-progress-bar" style={{ width: `${progressPercent}%` }} />
            </div>

            <div className="live-progress-text">
              {finalCompletedSteps} / {finalTotalSteps} steps completed
            </div>

            {/* Debug toolbar */}
            {isDebugMode && isRunning && (
              <div className="live-debug-toolbar">
                {isPaused && pausedAtStep !== null && (
                  <div className="live-debug-paused-info">
                    <Pause size={14} />
                    Paused at step {pausedAtStep}
                  </div>
                )}
                <div className="live-debug-actions">
                  <button
                    className="live-debug-btn"
                    onClick={onResume}
                    disabled={!isPaused}
                    title="Resume — run to next breakpoint"
                  >
                    <Play size={14} />
                    Resume
                  </button>
                  <button
                    className="live-debug-btn"
                    onClick={onStepOver}
                    disabled={!isPaused}
                    title="Step Over — execute one step"
                  >
                    <StepForwardIcon size={14} />
                    Step
                  </button>
                  <button
                    className="live-debug-btn live-debug-btn--continue"
                    onClick={onContinue}
                    disabled={!isPaused}
                    title="Continue — run all remaining"
                  >
                    <FastForward size={14} />
                    Continue
                  </button>
                </div>
              </div>
            )}

            {executionSummary && (
              <div className={`live-summary-card ${executionSummary.status}`}>
                <div className="live-summary-title">
                  {executionSummary.status === 'completed' ? 'Execution completed successfully' : 'Execution failed'}
                </div>
                <div className="live-summary-metrics">
                  <span>{finalCompletedSteps}/{finalTotalSteps} steps</span>
                  {summaryDuration && <span>{summaryDuration}</span>}
                  {hasAssertionSummary && (
                    <span>
                      {executionSummary?.assertionsPassed ?? 0}/{executionSummary?.assertionsTotal ?? 0} assertions
                    </span>
                  )}
                  {executionSummary?.failedStep ? <span>failed at step {executionSummary.failedStep}</span> : null}
                </div>
                {executionSummary.message && executionSummary.status === 'error' && (
                  <div className="live-summary-message">{executionSummary.message}</div>
                )}
              </div>
            )}

            <div className="live-steps-container">
              {liveSteps.map((step, idx) => {
                const hasBreakpoint = breakpointSet.has(step.step);
                const isStepPaused = step.status === 'paused';

                return (
                  <div key={idx} className={`live-step-row ${step.status} ${step.command === 'assert' ? 'live-step-row--assertion' : ''} ${isStepPaused ? 'paused' : ''}`}>
                    {/* Breakpoint gutter */}
                    {isDebugMode && (
                      <button
                        className={`live-breakpoint-gutter ${hasBreakpoint ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleBreakpoint?.(step.step);
                        }}
                        title={hasBreakpoint ? `Remove breakpoint at step ${step.step}` : `Set breakpoint at step ${step.step}`}
                      >
                        <Circle size={10} className="live-breakpoint-dot" />
                      </button>
                    )}
                    <div className="live-step-left">
                      <StatusIcon status={step.status} isAssertion={step.command === 'assert'} />
                      <span className="live-step-num">{step.step}</span>
                      <span className="live-step-cmd">{step.command}</span>
                      {step.intent && <span className="live-step-intent">{step.intent}</span>}
                    </div>
                    <div className="live-step-right">
                      {step.durationMs !== undefined && <span className="live-step-time">{step.durationMs}ms</span>}
                    </div>
                    {step.error && !step.assertion_result?.message && (
                      <div className="live-step-error">
                        {step.error}
                      </div>
                    )}
                    {step.assertion_result?.message && (
                      <div className="live-step-error">
                        {step.assertion_result.message}
                      </div>
                    )}
                    {(step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl) && (
                      <img
                        className="live-step-screenshot"
                        src={step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl || undefined}
                        alt={`Assertion failure screenshot for step ${step.step}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {executionError && (
          <div className="live-global-error">
            <strong>Test Error:</strong> {executionError}
          </div>
        )}
      </div>
    </div>
  );
}
