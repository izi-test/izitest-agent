import { useState } from 'react';
import { Stethoscope, Wrench, Check, X, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react';
import { useRepairActionMutation } from '../store/services/executionsApi';
import { testsApi } from '../store/services/testsApi';
import { projectsApi } from '../store/services/projectsApi';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { Button } from './Button';
import { SharedUses } from './SharedUses';
import { usesCount } from '../uses';
import type { Repair, Triage } from '../types';
import { CAUSE_LABELS } from '../triage-labels';

// Why a run failed, worked out on the page it failed on, and the repairs proposed for it:
// verified by replaying the test with them, saved into the test only when the user applies one.
// A repair that finds an element another way is offered to the other steps acting on it.

const REPAIR_STATUS: Record<Repair['status'], string> = {
  proposed: 'Proposed',
  verified: 'Verified — the test passes with it',
  failed: 'Did not fix it',
  applied: 'Applied',
  rejected: 'Rejected',
  superseded: 'Superseded',
  stale: 'Outdated — the step changed since',
};

const OPEN = new Set<Repair['status']>(['proposed', 'verified', 'failed']);

interface TriagePanelProps {
  triage: Triage;
  repairs: Repair[];
  /** The execution changed (a repair verified, applied or rejected): read it again. */
  onChanged: () => void;
  /** A repair was saved into the test: its steps changed. */
  onApplied?: () => void;
}

export function TriagePanel({ triage, repairs, onChanged, onApplied }: TriagePanelProps) {
  const page = triage.evidence?.page;
  const history = triage.evidence?.history;

  return (
    <div className={`triage-panel triage-${triage.cause}`}>
      <div className="triage-head">
        <Stethoscope size={14} />
        <strong>{CAUSE_LABELS[triage.cause] ?? triage.cause}</strong>
        <span className="triage-confidence">{triage.confidence} confidence</span>
      </div>
      <div className="triage-summary">{triage.summary}</div>
      <div className="triage-evidence">
        {page?.url && <span>Page: {page.url}</span>}
        {page?.alerts?.map((alert) => <span key={alert}>The page says: {alert}</span>)}
        {page?.failedRequests?.map((request) => (
          <span key={`${request.method} ${request.url}`}>Failed request: {request.method} {request.url} → {request.status || 'no response'}</span>
        ))}
        {!!history?.passes && <span>Passed {history.passes} time(s) before{history.lastPass ? `, last on ${new Date(history.lastPass).toLocaleString()}` : ''}</span>}
      </div>
      {repairs.map((repair) => (
        <RepairCard key={repair.id} repair={repair} onChanged={onChanged} onApplied={onApplied} />
      ))}
    </div>
  );
}

function RepairCard({ repair, onChanged, onApplied }: { repair: Repair; onChanged: () => void; onApplied?: () => void }) {
  const dispatch = useAppDispatch();
  const [runAction, { isLoading }] = useRepairActionMutation();
  const [pending, setPending] = useState<'verify' | 'apply' | 'reject' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The same element, found another way: fixed in every step acting on it unless unchecked.
  const [allUses, setAllUses] = useState(true);

  const act = async (action: 'verify' | 'apply' | 'reject', everyUse = false) => {
    setPending(action);
    setMessage(null);
    try {
      const result = await runAction({ id: repair.id, action, allUses: everyUse }).unwrap();
      if (action === 'verify' && !result.passed) setMessage('The test still fails with this repair.');
      if (action === 'apply') {
        const relocated = result.relocated ?? [];
        if (relocated.length) {
          dispatch(showToast({ message: `Repair applied, and to ${usesCount(relocated)} acting on the same element` }));
          dispatch(testsApi.util.invalidateTags([...new Set(relocated.map((r) => r.test))].map((test) => ({ type: 'Test' as const, id: test }))));
        }
        dispatch(projectsApi.util.invalidateTags(['Elements']));
        onApplied?.();
      }
    } catch (err) {
      setMessage((err as { data?: { error?: string } })?.data?.error ?? 'The request failed');
    } finally {
      setPending(null);
      onChanged();
    }
  };

  return (
    <div className={`repair-card repair-${repair.status}`}>
      <div className="repair-head">
        <Wrench size={12} />
        <span>Repair #{repair.id} · step {repair.step_order} · {repair.kind}</span>
        <span className="repair-status">{REPAIR_STATUS[repair.status] ?? repair.status}</span>
      </div>
      <div className="repair-summary">{repair.summary}</div>
      {repair.needs_review && OPEN.has(repair.status) && (
        <div className="repair-warning">
          <AlertTriangle size={12} />
          Apply only if this change is intended: the test would stop reporting it.
        </div>
      )}
      {repair.diff.length > 0 && (
        <ul className="repair-diff">
          {repair.diff.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {repair.verify_error && repair.status === 'failed' && <div className="repair-error">{repair.verify_error.split('\n')[0]}</div>}
      {repair.shared && repair.status !== 'applied' && repair.status !== 'failed' && (
        <SharedUses
          shared={repair.shared}
          check={{ label: 'Apply the repair to them too', checked: allUses, onChange: setAllUses, disabled: isLoading }}
        />
      )}
      {repair.shared && repair.status === 'applied' && (
        <SharedUses shared={repair.shared}>
          <div className="repair-actions">
            <span className="shared-uses__note">They still find it the old way.</span>
            <Button size="sm" variant="action" icon={pending === 'apply' ? Loader2 : Check} disabled={isLoading} onClick={() => act('apply', true)}>
              Apply the repair to them too
            </Button>
          </div>
        </SharedUses>
      )}
      {message && <div className="repair-error">{message}</div>}
      {OPEN.has(repair.status) && (
        <div className="repair-actions">
          <Button size="sm" variant="action" icon={pending === 'verify' ? Loader2 : RefreshCw} disabled={isLoading} onClick={() => act('verify')}>
            {pending === 'verify' ? 'Replaying…' : 'Verify'}
          </Button>
          {repair.status !== 'failed' && (
            <Button size="sm" variant="save" icon={Check} disabled={isLoading} onClick={() => act('apply', !!repair.shared && allUses)}>
              {repair.shared && allUses ? `Apply to ${repair.shared.uses.length + 1} steps` : 'Apply'}
            </Button>
          )}
          <Button size="sm" variant="cancel" icon={X} disabled={isLoading} onClick={() => act('reject')}>Reject</Button>
        </div>
      )}
    </div>
  );
}
