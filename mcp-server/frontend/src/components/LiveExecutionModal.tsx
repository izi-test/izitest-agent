import { useEffect, useRef } from "react";
import type { ExecutionStep } from "../types";
import { Loader2, CheckCircle2, XCircle, SkipForward, X, Bot } from "lucide-react";

export interface LiveStep extends Partial<ExecutionStep> {
  step: number;
  command: string;
  intent: string | null;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  locator?: string;
  error?: string;
  durationMs?: number;
}

export interface LiveExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowName: string;
  totalSteps: number;
  liveSteps: LiveStep[];
  executionStatus: 'starting' | 'running' | 'completed' | 'error';
  executionError: string | null;
  agentMode?: boolean;
  agentOutput?: string;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'pending') return <span className="live-icon pending">●</span>;
  if (status === 'running') return <Loader2 size={16} className="live-icon running spin" />;
  if (status === 'success') return <CheckCircle2 size={16} className="live-icon success" />;
  if (status === 'failed') return <XCircle size={16} className="live-icon failed" />;
  if (status === 'skipped') return <SkipForward size={16} className="live-icon skipped" />;
  return null;
}

export function LiveExecutionModal({
  isOpen,
  onClose,
  workflowName,
  totalSteps,
  liveSteps,
  executionStatus,
  executionError,
  agentMode = false,
  agentOutput = ''
}: LiveExecutionModalProps) {
  const agentOutputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll agent output
  useEffect(() => {
    if (agentMode && agentOutputRef.current) {
      agentOutputRef.current.scrollTop = agentOutputRef.current.scrollHeight;
    }
  }, [agentOutput, agentMode]);

  if (!isOpen) return null;

  const completedCount = liveSteps.filter(s => s.status === 'success' || s.status === 'failed' || s.status === 'skipped').length;
  const progressPercent = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;

  return (
    <div className="live-exec-overlay" onClick={() => {
      onClose();
    }}>
      <div className="live-exec-drawer" onClick={e => e.stopPropagation()}>
        <div className="live-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2>
              {agentMode && <Bot size={18} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />}
              {agentMode ? `Agent: "${workflowName}"` : `Executing "${workflowName}"`}
            </h2>
            <div className="live-status-badge" data-status={executionStatus}>
              {executionStatus.toUpperCase()}
            </div>
          </div>
          <button
            className="live-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={24} />
          </button>
        </div>

        {agentMode ? (
          /* ─── Agent streaming output ─── */
          <div className="agent-output-container" ref={agentOutputRef}>
            <pre className="agent-output-pre">
              {agentOutput || 'Waiting for agent...'}
            </pre>
          </div>
        ) : (
          /* ─── Normal step-by-step execution ─── */
          <>
            <div className="live-progress-container">
              <div className="live-progress-bar" style={{ width: `${progressPercent}%` }} />
            </div>

            <div className="live-progress-text">
              {completedCount} / {totalSteps} steps completed
            </div>

            <div className="live-steps-container">
              {liveSteps.map((step, idx) => (
                <div key={idx} className={`live-step-row ${step.status}`}>
                  <div className="live-step-left">
                    <StatusIcon status={step.status} />
                    <span className="live-step-num">{step.step}</span>
                    <span className="live-step-cmd">{step.command}</span>
                    {step.intent && <span className="live-step-intent">{step.intent}</span>}
                  </div>
                  <div className="live-step-right">
                    {step.durationMs !== undefined && <span className="live-step-time">{step.durationMs}ms</span>}
                  </div>
                  {step.error && (
                    <div className="live-step-error">
                      {step.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {executionError && (
          <div className="live-global-error">
            <strong>Execution Error:</strong> {executionError}
          </div>
        )}
      </div>
    </div>
  );
}
