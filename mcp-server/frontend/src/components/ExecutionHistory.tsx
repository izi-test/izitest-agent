import { useState } from 'react';
import { useGetExecutionsQuery, useLazyGetExecutionQuery } from '../store/services/executionsApi';
import type { ExecutionStep } from '../types';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  RotateCcw,
  ShieldCheck
} from 'lucide-react';

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  success: { label: 'Passed', className: 'exec-status-success' },
  failed:  { label: 'Failed',  className: 'exec-status-failed' },
  running: { label: 'Running', className: 'exec-status-running' },
  pending: { label: 'Pending', className: 'exec-status-pending' },
  skipped: { label: 'Skipped', className: 'exec-status-skipped' },
};

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const info = STATUS_LABELS[status] || { label: status, className: '' };

  let Icon = Clock;
  if (status === 'success') Icon = CheckCircle2;
  if (status === 'failed') Icon = XCircle;
  if (status === 'running') Icon = Play;
  if (status === 'pending') Icon = Clock;
  if (status === 'skipped') Icon = RotateCcw;

  return (
    <span className={`exec-badge ${info.className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <Icon size={12} />
      {info.label}
    </span>
  );
}

interface ExecutionHistoryProps {
  testName: string;
  refreshTrigger: number;
}

export function ExecutionHistory({ testName, refreshTrigger }: ExecutionHistoryProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<ExecutionStep[]>([]);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const { data: executions = [], isLoading } = useGetExecutionsQuery(
    { testName, limit: 20 },
    { refetchOnMountOrArgChange: refreshTrigger }
  );

  const [triggerGetExecution] = useLazyGetExecutionQuery();

  const toggleExpand = async (executionId: number) => {
    if (expandedId === executionId) {
      setExpandedId(null);
      setExpandedSteps([]);
      return;
    }
    try {
      const execution = await triggerGetExecution(executionId).unwrap();
      setExpandedSteps(execution?.steps || []);
      setExpandedId(executionId);
    } catch {
      setExpandedSteps([]);
      setExpandedId(executionId);
    }
  };

  if (isLoading) return <p className="empty-state">Loading execution history...</p>;
  if (executions.length === 0) return <p className="empty-state">No executions yet. Click Run Test to execute.</p>;

  return (
    <div className="exec-history">
      {executions.map(exec => (
        <div key={exec.id} className={`exec-card ${expandedId === exec.id ? 'expanded' : ''}`}>
          <div className="exec-row" onClick={() => toggleExpand(exec.id)}>
            <StatusBadge status={exec.status} />
            <div className="exec-info">
              <span className="exec-date">{formatTime(exec.started_at)}</span>
              <span className="exec-metrics">
                {exec.completed_steps}/{exec.total_steps} steps · {formatDuration(exec.duration_ms)}
              </span>
              {exec.assertions_total > 0 && (
                <span className="exec-metrics" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <ShieldCheck size={12} />
                  {exec.assertions_passed}/{exec.assertions_total} assertions
                </span>
              )}
            </div>
            <div className="exec-meta">
              {exec.trigger !== 'manual' && <span className="exec-trigger">{exec.trigger}</span>}
              {exec.new_window && <span className="exec-trigger">new window</span>}
              <span className="exec-expand-icon">
                {expandedId === exec.id ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </span>
            </div>
          </div>

          {exec.error && (
            <div className="exec-error">{exec.error}</div>
          )}

          {expandedId === exec.id && (
            <div className="exec-steps">
              {expandedSteps.map(step => (
                <div key={step.id} className={`exec-step ${step.status}`}>
                  <span className="exec-step-order">{step.step_order}</span>
                  <StatusBadge status={step.status} />
                  <span className="exec-step-command">
                    {step.command === 'assert' && <ShieldCheck size={12} style={{ marginRight: 4 }} />}
                    {step.command}
                  </span>
                  {step.intent && <span className="exec-step-intent">{step.intent}</span>}
                  <span className="exec-step-duration">{formatDuration(step.duration_ms)}</span>
                  {step.locator_used && <span className="exec-step-locator">via {step.locator_used}</span>}
                  {step.error && !step.assertion_result?.message && <div className="exec-step-error">{step.error}</div>}
                  {step.assertion_result && (
                    <div className={`exec-step-assertion ${step.assertion_result.passed ? 'passed' : 'failed'}`}>
                      {step.assertion_result.message && (
                        <div className="exec-step-assertion-message">{step.assertion_result.message}</div>
                      )}
                      <span>Expected: {step.assertion_result.expected}</span>
                      <span>Actual: {step.assertion_result.actual}</span>
                      {step.assertion_result.type === 'visual_match' ? (
                        <div className="vrt-screenshots" style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                          {step.assertion_result?.refScreenshotUrl && (
                            <div className="vrt-screenshot-box" style={{ flex: 1, cursor: 'pointer' }} onClick={() => setSelectedImage(step.assertion_result?.refScreenshotUrl!)}>
                              <div className="vrt-screenshot-title" style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>Reference (Expected)</div>
                              <img className="exec-step-screenshot" src={step.assertion_result.refScreenshotUrl} alt="Reference" style={{ width: '100%', border: '1px solid #444', borderRadius: '4px' }} />
                            </div>
                          )}
                          {(step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl) && (
                            <div className="vrt-screenshot-box" style={{ flex: 1, cursor: 'pointer' }} onClick={() => setSelectedImage(step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl || null)}>
                              <div className="vrt-screenshot-title" style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>Current (Actual)</div>
                              <img className="exec-step-screenshot" src={step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl || undefined} alt="Current" style={{ width: '100%', border: '1px solid #444', borderRadius: '4px' }} />
                            </div>
                          )}
                        </div>
                      ) : (
                        (step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl) && (
                          <img
                            className="exec-step-screenshot"
                            src={step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl || undefined}
                            alt={`Assertion failure screenshot for step ${step.step_order}`}
                            style={{ cursor: 'pointer', marginTop: '8px' }}
                            onClick={() => setSelectedImage(step.assertion_result?.screenshotUrl || step.assertion_result?.screenshotDataUrl || null)}
                          />
                        )
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {selectedImage && (
        <div className="image-modal-overlay" onClick={() => setSelectedImage(null)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
          <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '100%' }}>
            <button onClick={() => setSelectedImage(null)} style={{ position: 'absolute', top: -40, right: 0, background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '4px' }}>
              <XCircle size={32} />
            </button>
            <img src={selectedImage} alt="Enlarged screenshot" style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: '6px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()} />
          </div>
        </div>
      )}
    </div>
  );
}
