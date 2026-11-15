import { useState } from 'react';
import { rowFirstValues, rowValuesText } from '../rows';
import { useGetExecutionsQuery, useLazyGetExecutionQuery, useReportRunBugMutation } from '../store/services/executionsApi';
import { useGo } from '../navigation';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import type { Execution, ExecutionStep } from '../types';
import { TriagePanel } from './TriagePanel';
import { CAUSE_LABELS } from '../triage-labels';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  RotateCcw,
  ShieldCheck,
  Video,
  Bug as BugIcon
} from 'lucide-react';
import { RunVideo } from './RunVideo';

/**
 * A text a run told (what a check read, an error), folded past `max` characters: a check of a
 * whole <body> read thousands of them, its scripts with them.
 */
function LongText({ text, max = 400 }: { text: string; max?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= max) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, max)}…`}{' '}
      <button type="button" className="long-text__toggle" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        {open ? 'Show less' : `Show all (${text.length} characters)`}
      </button>
    </>
  );
}

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
  /** A repair was applied: the test's steps changed. */
  onTestChanged?: () => void;
}

export function ExecutionHistory({ testName, refreshTrigger, onTestChanged }: ExecutionHistoryProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // The run whose video is shown (lib/run-video.js): kept when it failed, or Record video was ticked.
  const [videoOf, setVideoOf] = useState<number | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<ExecutionStep[]>([]);
  const [expanded, setExpanded] = useState<Execution | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const go = useGo();
  const dispatch = useAppDispatch();
  const [reportRunBug, { isLoading: reporting }] = useReportRunBugMutation();
  // A person reports the bug a failed run met: the project opens none by itself (auto_bugs off).
  const report = async (executionId: number) => {
    try {
      const { bug, existing } = await reportRunBug(executionId).unwrap();
      dispatch(showToast({ message: existing ? `Already reported: bug #${bug.id}` : `Bug #${bug.id} reported`, type: 'success' }));
    } catch (err) {
      dispatch(showToast({ message: (err as { data?: { error?: string } })?.data?.error ?? 'The bug could not be reported', type: 'error' }));
    }
  };

  const { data: executions = [], isLoading } = useGetExecutionsQuery(
    { testName, limit: 20 },
    { refetchOnMountOrArgChange: refreshTrigger }
  );

  const [triggerGetExecution] = useLazyGetExecutionQuery();

  const toggleExpand = async (executionId: number) => {
    if (expandedId === executionId) {
      setExpandedId(null);
      setExpandedSteps([]);
      setExpanded(null);
      return;
    }
    await loadExecution(executionId);
  };

  const loadExecution = async (executionId: number) => {
    try {
      const execution = await triggerGetExecution(executionId).unwrap();
      setExpandedSteps(execution?.steps || []);
      setExpanded(execution ?? null);
      setExpandedId(executionId);
    } catch {
      setExpandedSteps([]);
      setExpanded(null);
      setExpandedId(executionId);
    }
  };

  if (isLoading) return <p className="empty-state">Loading execution history...</p>;
  if (executions.length === 0) return <p className="empty-state">No executions yet. Click Run Test to execute.</p>;

  return (
    <div className="exec-history">
      {videoOf !== null && <RunVideo executionId={videoOf} onClose={() => setVideoOf(null)} />}
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
              {exec.data_row ? (
                // The row of the test it played, told by its first values (all of them below, opened).
                <span className="row-chip" title={rowValuesText(exec.data_values)}>Row {exec.data_row}{rowFirstValues(exec.data_values)}</span>
              ) : null}
            </div>
            <div className="exec-meta">
              {exec.triage_cause && <span className={`exec-trigger triage-badge triage-${exec.triage_cause}`}>{CAUSE_LABELS[exec.triage_cause].split(' — ')[0]}</span>}
              {exec.trigger !== 'manual' && <span className="exec-trigger">{exec.trigger}</span>}
              {exec.new_window && <span className="exec-trigger">new window</span>}
              {exec.status === 'failed' && (exec.bug_id ? (
                <button type="button" className="exec-video-btn" title="The bug this run met, in the Bugs page"
                  onClick={(e) => { e.stopPropagation(); go(`/bugs?bug=${exec.bug_id}`, { from: testName }); }}>
                  <BugIcon size={13} /> Bug #{exec.bug_id}
                </button>
              ) : (
                <button type="button" className="exec-video-btn" disabled={reporting} title="Open a bug from this run: its failed step, what it expected and read, its page"
                  onClick={(e) => { e.stopPropagation(); report(exec.id); }}>
                  <BugIcon size={13} /> Report a bug
                </button>
              ))}
              {(exec.video_frames ?? 0) > 0 && (
                <button type="button" className="exec-video-btn" title="Watch the run again, its steps beside it"
                  onClick={(e) => { e.stopPropagation(); setVideoOf(exec.id); }}>
                  <Video size={13} /> Video
                </button>
              )}
              <span className="exec-expand-icon">
                {expandedId === exec.id ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </span>
            </div>
          </div>

          {exec.error && (
            <div className="exec-error"><LongText text={exec.error} /></div>
          )}

          {expandedId === exec.id && exec.data_row ? (
            <div className="row-values" aria-label={`Values of row ${exec.data_row}`}>
              <strong>Row {exec.data_row} played:</strong>
              {Object.entries(exec.data_values ?? {}).map(([name, value]) => <span key={name}>{`{{${name}}}`} = <code>{value === '' ? '(empty)' : value}</code></span>)}
              {Object.keys(exec.data_values ?? {}).length === 0 && <span>its values were not kept</span>}
            </div>
          ) : null}

          {expandedId === exec.id && expanded?.triage && (
            <TriagePanel
              triage={expanded.triage}
              repairs={expanded.repairs ?? []}
              onChanged={() => loadExecution(exec.id)}
              onApplied={onTestChanged}
            />
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
                  {step.error && (step.status === 'skipped' || !step.assertion_result?.message) && (
                    // An optional step not done is told, not a failure: the test went on.
                    <div className={`exec-step-error ${step.status === 'skipped' ? 'exec-step-error--skipped' : ''}`}><LongText text={step.error} /></div>
                  )}
                  {step.assertion_result && (
                    <div className={`exec-step-assertion ${step.assertion_result.passed ? 'passed' : step.status === 'skipped' ? 'skipped' : 'failed'}`}>
                      {step.assertion_result.message && (
                        <div className="exec-step-assertion-message">{step.assertion_result.message}</div>
                      )}
                      <span>Expected: {step.assertion_result.expected}</span>
                      <span>Actual: <LongText text={String(step.assertion_result.actual ?? '')} /></span>
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
