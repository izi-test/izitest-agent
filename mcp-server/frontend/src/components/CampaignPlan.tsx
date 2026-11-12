import { useState } from 'react';
import { ClipboardCheck, CheckCircle2, XCircle, Clock, Pencil, ShieldAlert } from 'lucide-react';
import { useUpdateCampaignPlanMutation } from '../store/services/campaignsApi';
import { Button } from './Button';
import { Card, KeyChip, Pill, StatusPill } from './ui';
import type { Campaign, ExitCriteria } from '../types';

// A campaign's test plan (mcp-server/lib/campaigns.js): what it is for, what is in and out of
// scope, and its exit criteria — what says the testing can stop. The report then says where the
// campaign stands against each, and which requirements at risk do not pass: the residual risk.

export interface PlanDraft {
  objective: string;
  scope_note: string;
  high_requirements_passing: boolean;
  no_open_high_bug: boolean;
  min_coverage: string;
  min_pass_rate: string;
}

export const emptyPlan: PlanDraft = { objective: '', scope_note: '', high_requirements_passing: false, no_open_high_bug: false, min_coverage: '', min_pass_rate: '' };

export const draftOf = (c: Pick<Campaign, 'objective' | 'scope_note' | 'exit_criteria'>): PlanDraft => ({
  objective: c.objective ?? '', scope_note: c.scope_note ?? '',
  high_requirements_passing: !!c.exit_criteria?.high_requirements_passing, no_open_high_bug: !!c.exit_criteria?.no_open_high_bug,
  min_coverage: c.exit_criteria?.min_coverage ? String(c.exit_criteria.min_coverage) : '',
  min_pass_rate: c.exit_criteria?.min_pass_rate ? String(c.exit_criteria.min_pass_rate) : '',
});

/** What the API takes of a draft: nothing set is no plan. */
export function planOf(draft: PlanDraft): { objective: string | null; scope_note: string | null; exit_criteria: ExitCriteria | null } {
  const criteria: ExitCriteria = {};
  if (draft.high_requirements_passing) criteria.high_requirements_passing = true;
  if (draft.no_open_high_bug) criteria.no_open_high_bug = true;
  if (Number(draft.min_coverage) > 0) criteria.min_coverage = Number(draft.min_coverage);
  if (Number(draft.min_pass_rate) > 0) criteria.min_pass_rate = Number(draft.min_pass_rate);
  return { objective: draft.objective.trim() || null, scope_note: draft.scope_note.trim() || null, exit_criteria: Object.keys(criteria).length ? criteria : null };
}

export const hasPlan = (draft: PlanDraft) => { const p = planOf(draft); return !!(p.objective || p.scope_note || p.exit_criteria); };

export function PlanFields({ draft, onChange }: { draft: PlanDraft; onChange: (draft: PlanDraft) => void }) {
  const set = <K extends keyof PlanDraft>(field: K, value: PlanDraft[K]) => onChange({ ...draft, [field]: value });
  return (
    <div className="plan-fields">
      <label className="field">
        <span className="field__label">Objective <span className="field__optional">optional</span></span>
        <input placeholder="What this campaign has to show, e.g. version 1.4 can go to production" value={draft.objective} onChange={(e) => set('objective', e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">In and out of scope <span className="field__optional">optional</span></span>
        <textarea rows={2} placeholder="What is tested, and what is knowingly left out and why" value={draft.scope_note} onChange={(e) => set('scope_note', e.target.value)} />
      </label>
      <div className="field">
        <span className="field__label">Exit criteria <span className="field__optional">what says the testing can stop</span></span>
        <div className="plan-criteria">
          <label><input type="checkbox" checked={draft.high_requirements_passing} onChange={(e) => set('high_requirements_passing', e.target.checked)} /> Every high-risk or high-priority requirement passes</label>
          <label><input type="checkbox" checked={draft.no_open_high_bug} onChange={(e) => set('no_open_high_bug', e.target.checked)} /> No high-severity bug is left unresolved</label>
          <label>At least <input type="number" min={0} max={100} value={draft.min_coverage} onChange={(e) => set('min_coverage', e.target.value)} placeholder="—" /> % of the acceptance criteria are covered by a test</label>
          <label>At least <input type="number" min={0} max={100} value={draft.min_pass_rate} onChange={(e) => set('min_pass_rate', e.target.value)} placeholder="—" /> % of the tests pass</label>
        </div>
      </div>
    </div>
  );
}

const VERDICTS = {
  met: { tone: 'green', label: 'Exit criteria met', icon: CheckCircle2 },
  not_met: { tone: 'red', label: 'Exit criteria not met', icon: XCircle },
  pending: { tone: 'slate', label: 'Still running', icon: Clock },
} as const;

/** Where a campaign stands against its plan; the plan is written or changed here, after the run too. */
export function CampaignPlanCard({ campaign: c, onOpenRequirement }: { campaign: Campaign; onOpenRequirement: (key: string) => void }) {
  const [save, { isLoading }] = useUpdateCampaignPlanMutation();
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planned = !!(c.objective || c.scope_note || c.exit_criteria);
  const verdict = c.exit ? VERDICTS[c.exit.verdict] : null;

  const submit = async () => {
    setError(null);
    try {
      await save({ id: c.id, ...planOf(draft!) }).unwrap();
      setDraft(null);
    } catch (err) {
      setError((err as { data?: { error?: string } })?.data?.error ?? 'The plan could not be saved');
    }
  };

  return (
    <Card
      title="Test plan" icon={ClipboardCheck}
      subtitle={planned ? undefined : 'What this campaign is for and what says the testing can stop. Without one, the report gives the results and no verdict.'}
      actions={!draft && <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setDraft(draftOf(c))}>{planned ? 'Edit' : 'Write the plan'}</Button>}
    >
      {draft ? (
        <>
          <PlanFields draft={draft} onChange={setDraft} />
          {error && <div className="alert alert--error">{error}</div>}
          <div className="repair-actions" style={{ marginTop: 12 }}>
            <Button size="sm" variant="save" disabled={isLoading} onClick={submit}>Save the plan</Button>
            <Button size="sm" variant="cancel" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </>
      ) : planned && (
        <div className="plan">
          {c.objective && <p><span className="plan__label">Objective</span>{c.objective}</p>}
          {c.scope_note && <p><span className="plan__label">Scope</span>{c.scope_note}</p>}
          {c.exit && verdict && (
            <>
              <div className={`plan__verdict plan__verdict--${verdict.tone}`}><verdict.icon size={16} /> {verdict.label}</div>
              <table className="table">
                <thead><tr><th>Exit criterion</th><th>Target</th><th>Now</th><th /></tr></thead>
                <tbody>
                  {c.exit.criteria.map((x) => (
                    <tr key={x.id}>
                      <td>{x.label}{x.failing?.length ? <div className="cell-chips" style={{ marginTop: 4 }}>{x.failing.map((key) => <KeyChip key={key} onClick={/^\d+$/.test(key) ? undefined : () => onOpenRequirement(key)}>{key}</KeyChip>)}</div> : null}</td>
                      <td>{x.target}</td>
                      <td>{x.actual}</td>
                      <td><Pill tone={x.met ? 'green' : c.running ? 'slate' : 'red'}>{x.met ? 'met' : c.running ? 'not yet' : 'not met'}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
      {!draft && c.residual_risk?.length > 0 && (
        <div className="plan__residual">
          <div className="plan__residual-title"><ShieldAlert size={14} /> Residual risk: {c.residual_risk.length} requirement{c.residual_risk.length === 1 ? '' : 's'} at risk {c.residual_risk.length === 1 ? 'does' : 'do'} not pass</div>
          <ul className="campaign-bugs">
            {c.residual_risk.map((r) => (
              <li key={r.key}>
                <KeyChip onClick={() => onOpenRequirement(r.key)}>{r.key}</KeyChip>
                <span className={`tag ${r.risk === 'high' ? 'tag--red' : 'tag--amber'}`}>{r.risk} risk</span>
                <StatusPill status={r.status} label={r.status.replace('_', ' ')} />
                <span className="campaign-bugs__title">{r.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
