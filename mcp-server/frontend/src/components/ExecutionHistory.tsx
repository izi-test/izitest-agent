import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Execution, ExecutionStep } from '../types';
import { 
  ChevronDown, 
  ChevronRight, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Play,
  RotateCcw
} from 'lucide-react';

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  success: { label: 'Success', className: 'exec-status-success' },
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
  workflowName: string;
  refreshTrigger: number;
}

export function ExecutionHistory({ workflowName, refreshTrigger }: ExecutionHistoryProps) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<ExecutionStep[]>([]);
  const [loading, setLoading] = useState(true);

  const loadExecutions = async () => {
    try {
      const data = await api('GET', `/api/workflows/${encodeURIComponent(workflowName)}/executions?limit=20`);
      setExecutions(data.executions || []);
    } catch {
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadExecutions();
  }, [workflowName, refreshTrigger]);

  const toggleExpand = async (executionId: number) => {
    if (expandedId === executionId) {
      setExpandedId(null);
      setExpandedSteps([]);
      return;
    }
    try {
      const data = await api('GET', `/api/executions/${executionId}`);
      setExpandedSteps(data.execution?.steps || []);
      setExpandedId(executionId);
    } catch {
      setExpandedSteps([]);
      setExpandedId(executionId);
    }
  };

  if (loading) return <p className="empty-state">Loading execution history...</p>;
  if (executions.length === 0) return <p className="empty-state">No executions yet. Click Play to run the workflow.</p>;

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
                  <span className="exec-step-command">{step.command}</span>
                  {step.intent && <span className="exec-step-intent">{step.intent}</span>}
                  <span className="exec-step-duration">{formatDuration(step.duration_ms)}</span>
                  {step.locator_used && <span className="exec-step-locator">via {step.locator_used}</span>}
                  {step.error && <div className="exec-step-error">{step.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
