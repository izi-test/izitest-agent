import { useState } from 'react';
import { Layers, Plus, ArrowLeft, Square, RotateCcw, Download, ExternalLink, Trash2, FlaskConical, Loader2, Play } from 'lucide-react';
import {
  campaignsApi, useGetCampaignsQuery, useGetCampaignQuery, useStartCampaignMutation, useStopCampaignMutation, useDeleteCampaignMutation,
  type CampaignInput,
} from '../store/services/campaignsApi';
import { useGetRequirementsQuery } from '../store/services/requirementsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useAppSelector } from '../store/hooks';
import { Button } from './Button';
import { CampaignWriteBack } from './CampaignWriteBack';
import { CAUSE_LABELS } from '../triage-labels';
import type { Campaign, CampaignSummary, CampaignTestStatus } from '../types';

// Campaigns: tests replayed together for a version of the app (mcp-server/lib/campaigns.js) —
// a project's, a requirement's, or a chosen list —, a few at a time, each in its own window.
// The report says what failed and why, what regressed since the last campaign of the same
// tests, and where each requirement stands; it downloads as JUnit for a CI, or opens as HTML,
// and is sent to Xray and to the Jira stories it checks (CampaignWriteBack).

const STATUS_ORDER: CampaignTestStatus[] = ['passed', 'failed', 'error', 'running', 'pending', 'skipped'];
const STATUS_LABELS: Record<Campaign['status'], string> = { running: 'Running', done: 'Done', stopped: 'Stopped', interrupted: 'Interrupted' };
const CRITERION_LABELS = { passing: 'passing', failing: 'failing', not_run: 'not run', not_covered: 'no test' } as const;

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';
const duration = (ms: number | null) => (ms == null ? '' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`);

/** What a campaign ran: a project, a requirement, or tests. */
function scopeLabel(c: Pick<Campaign, 'scope' | 'project'>) {
  if (c.scope.requirement) return `Requirement ${c.scope.requirement}`;
  if (c.scope.project_id) return `Project ${c.project ?? `#${c.scope.project_id}`}`;
  return `${c.scope.tests?.length ?? 0} chosen test${c.scope.tests?.length === 1 ? '' : 's'}`;
}

/** The share of each result, as a bar. */
function ResultBar({ campaign }: { campaign: Pick<Campaign, 'totals' | 'total'> }) {
  return (
    <div className="campaign-bar" title={STATUS_ORDER.filter((s) => campaign.totals[s]).map((s) => `${campaign.totals[s]} ${s}`).join(', ')}>
      {STATUS_ORDER.filter((s) => campaign.totals[s]).map((s) => (
        <span key={s} className={`campaign-bar__part run-status--${s}`} style={{ flexGrow: campaign.totals[s] }} />
      ))}
    </div>
  );
}

// ─── The list ────────────────────────────────────────────────────────

export function CampaignsPage({ onOpen }: { onOpen: (id: number) => void }) {
  const projectId = useAppSelector((state) => state.ui.selectedProjectId);
  // Polled while one of them runs.
  const anyRunning = useAppSelector((state) => campaignsApi.endpoints.getCampaigns.select(projectId)(state).data?.some((c) => c.running));
  const { data: campaigns = [], isLoading } = useGetCampaignsQuery(projectId, { pollingInterval: anyRunning ? 2000 : 0 });
  const [creating, setCreating] = useState(false);

  return (
    <div className="dashboard requirements-page">
      <div className="dash-panel">
        <div className="dash-panel__title">
          <Layers size={16} /> Campaigns
          <Button size="sm" variant="action" icon={Plus} className="requirements-new" onClick={() => setCreating(!creating)}>New campaign</Button>
        </div>
        <p className="explore-help">
          Tests replayed together for a version of the app — a project's, a requirement's, or a few chosen —, each in its own window.
          A failure is diagnosed as any run's; the report compares with the last campaign of the same tests. An agent runs one with
          run_campaign, a CI with <code>node bin/campaign.js</code>.
        </p>
        {creating && <CampaignForm projectId={projectId} onStarted={(id) => { setCreating(false); onOpen(id); }} onCancel={() => setCreating(false)} />}
        {isLoading && <p className="dash-panel__empty">Loading…</p>}
        {!isLoading && campaigns.length === 0 && !creating && <p className="dash-panel__empty">No campaign yet.</p>}
        <div className="bug-list">
          {campaigns.map((c) => <CampaignRow key={c.id} campaign={c} onOpen={() => onOpen(c.id)} />)}
        </div>
      </div>
    </div>
  );
}

function CampaignRow({ campaign: c, onOpen }: { campaign: CampaignSummary; onOpen: () => void }) {
  return (
    <button className="requirement-row campaign-row" onClick={onOpen}>
      <span className="requirement-key">#{c.id}</span>
      <span className="requirement-title">
        <span>{c.name}{c.version && <span className="campaign-version">v{c.version}</span>}</span>
        <span className="campaign-row__meta">{scopeLabel(c)} · {new Date(c.created_at).toLocaleString()}</span>
      </span>
      {c.changes?.regressed.length ? <span className="campaign-regressed">{c.changes.regressed.length} regressed</span> : null}
      <span className="dash-table__muted">{c.totals.passed}/{c.total} passed</span>
      <ResultBar campaign={c} />
      <span className={`campaign-status campaign-status--${c.running ? 'running' : c.status}`}>{c.running ? 'Running' : STATUS_LABELS[c.status]}</span>
    </button>
  );
}

type ScopeKind = 'project' | 'requirement' | 'tests';

function CampaignForm({ projectId, onStarted, onCancel }: { projectId: number | null; onStarted: (id: number) => void; onCancel: () => void }) {
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const { data: requirements = [] } = useGetRequirementsQuery(projectId);
  const { data: tests = [] } = useGetTestsQuery(projectId);
  const [kind, setKind] = useState<ScopeKind>('project');
  const [project, setProject] = useState<number | null>(projectId);
  const [requirement, setRequirement] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [name, setName] = useState('');
  const [concurrency, setConcurrency] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [start, { isLoading }] = useStartCampaignMutation();

  const scope: CampaignInput | null = kind === 'project' ? (project ? { project_id: project } : null)
    : kind === 'requirement' ? (requirement ? { requirement } : null)
      : chosen.length ? { tests: chosen } : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!scope) return;
    setError(null);
    try {
      const { campaign } = await start({ ...scope, version: version.trim() || undefined, name: name.trim() || undefined, concurrency }).unwrap();
      onStarted(campaign.id);
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <form className="requirement-form campaign-form" onSubmit={submit}>
      <div className="campaign-form__scopes">
        {(['project', 'requirement', 'tests'] as const).map((k) => (
          <label key={k}>
            <input type="radio" name="scope" checked={kind === k} onChange={() => setKind(k)} />
            {{ project: 'A project\'s tests', requirement: 'A requirement\'s tests', tests: 'Chosen tests' }[k]}
          </label>
        ))}
      </div>
      {kind === 'project' && (
        <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose a project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {kind === 'requirement' && (
        <select value={requirement} onChange={(e) => setRequirement(e.target.value)}>
          <option value="">Choose a requirement…</option>
          {requirements.map((r) => <option key={r.key} value={r.key}>{r.key} — {r.title} ({r.coverage.tests} test{r.coverage.tests === 1 ? '' : 's'})</option>)}
        </select>
      )}
      {kind === 'tests' && (
        <div className="campaign-form__tests">
          {tests.map((t) => (
            <label key={t.name}>
              <input type="checkbox" checked={chosen.includes(t.name)}
                onChange={() => setChosen(chosen.includes(t.name) ? chosen.filter((n) => n !== t.name) : [...chosen, t.name])} />
              {t.name}
            </label>
          ))}
        </div>
      )}
      <div className="requirement-form__row">
        <input placeholder="Version of the app (e.g. 1.4.0, a commit)" value={version} onChange={(e) => setVersion(e.target.value)} />
        <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="requirement-priority">
          At a time
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="repair-error">{error}</div>}
      <div className="repair-actions">
        <Button type="submit" size="sm" variant="save" icon={Play} disabled={!scope || isLoading}>Start</Button>
        <Button type="button" size="sm" variant="cancel" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ─── One campaign ────────────────────────────────────────────────────

export function CampaignPage({ id, onBack, onOpen, onOpenTest, onOpenRequirement }: {
  id: number; onBack: () => void; onOpen: (id: number) => void; onOpenTest: (name: string) => void; onOpenRequirement: (key: string) => void;
}) {
  // Polled while it runs.
  const live = useAppSelector((state) => campaignsApi.endpoints.getCampaign.select(id)(state).data?.running);
  const { data: campaign, isLoading } = useGetCampaignQuery(id, { pollingInterval: live === false ? 0 : 2000 });
  const [stop, { isLoading: stopping }] = useStopCampaignMutation();
  const [start, { isLoading: restarting }] = useStartCampaignMutation();
  const [remove] = useDeleteCampaignMutation();
  const [error, setError] = useState<string | null>(null);
  if (isLoading) return <p className="empty-state">Loading…</p>;
  if (!campaign) return <p className="empty-state">No campaign #{id}.</p>;
  const c = campaign;

  const again = async () => {
    setError(null);
    try {
      const scope = c.scope.requirement ? { requirement: c.scope.requirement } : c.scope.project_id ? { project_id: c.scope.project_id } : { tests: c.scope.tests };
      const { campaign: next } = await start({ ...scope, version: c.version ?? undefined, concurrency: c.concurrency }).unwrap();
      onOpen(next.id);
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const destroy = async () => {
    if (!window.confirm(`Delete campaign #${c.id}? Its runs stay in each test's history.`)) return;
    await remove(c.id).unwrap();
    onBack();
  };
  const done = c.total - c.totals.pending - c.totals.running;

  return (
    <div className="dashboard requirements-page">
      <div className="dash-panel">
        <div className="dash-panel__title">
          <button className="btn-back" onClick={onBack}><ArrowLeft size={14} /></button>
          <span className="requirement-key">#{c.id}</span>
          <span>{c.name}</span>
          {c.version && <span className="campaign-version">v{c.version}</span>}
          <span className={`campaign-status campaign-status--${c.running ? 'running' : c.status}`}>
            {c.running ? <><Loader2 size={11} className="spin" /> {done}/{c.total}</> : STATUS_LABELS[c.status]}
          </span>
        </div>
        <p className="explore-help">
          {scopeLabel(c)} · {new Date(c.created_at).toLocaleString()} · {c.concurrency} at a time{c.duration_ms != null && ` · ${duration(c.duration_ms)}`}
        </p>
        <div className="campaign-totals">
          {STATUS_ORDER.filter((s) => c.totals[s]).map((s) => (
            <div key={s} className={`run-status--${s}`}><strong>{c.totals[s]}</strong> {s}</div>
          ))}
        </div>
        <ResultBar campaign={c} />
        {error && <div className="repair-error">{error}</div>}
        <div className="repair-actions requirement-save">
          {c.running
            ? <Button size="sm" variant="danger" icon={Square} disabled={stopping} onClick={() => stop(c.id)}>Stop</Button>
            : <Button size="sm" variant="action" icon={RotateCcw} disabled={restarting} onClick={again}>Run again</Button>}
          <a className="campaign-link" href={`/api/campaigns/${c.id}/junit.xml`} download><Download size={12} /> JUnit</a>
          <a className="campaign-link" href={`/api/campaigns/${c.id}/report.html`} target="_blank" rel="noreferrer"><ExternalLink size={12} /> HTML report</a>
          {!c.running && <Button size="sm" variant="danger" icon={Trash2} onClick={destroy}>Delete</Button>}
        </div>
      </div>

      <CampaignWriteBack campaign={c} />

      {c.non_conformities.length > 0 && (
        <div className="dash-panel">
          <div className="dash-panel__title campaign-bad">Non-conformities</div>
          <p className="explore-help">The app does not do what the requirement says — report it, do not change the test:</p>
          {c.non_conformities.map((name) => <button key={name} className="bug-test" onClick={() => onOpenTest(name)}><FlaskConical size={12} /> {name}</button>)}
        </div>
      )}

      {c.changes && (
        <div className="dash-panel">
          <div className="dash-panel__title">
            Since campaign #{c.changes.since.id}{c.changes.since.version && ` (v${c.changes.since.version})`}{c.running && ', so far'}
          </div>
          {!c.changes.regressed.length && !c.changes.fixed.length && <p className="explore-help">Nothing regressed, nothing fixed.</p>}
          {c.changes.regressed.length > 0 && <p className="campaign-change"><strong className="campaign-bad">Regressed</strong> {c.changes.regressed.join(', ')}</p>}
          {c.changes.fixed.length > 0 && <p className="campaign-change"><strong className="campaign-good">Fixed</strong> {c.changes.fixed.join(', ')}</p>}
        </div>
      )}

      {c.requirements.length > 0 && (
        <div className="dash-panel">
          <div className="dash-panel__title">Requirements</div>
          {c.requirements.map((r) => (
            <div key={r.key} className="campaign-requirement">
              <div className="case-row">
                <button className="requirement-key link-btn" onClick={() => onOpenRequirement(r.key)}>{r.key}</button>
                <span className="case-title">{r.title}</span>
                <span className={`coverage-badge coverage-${r.status}`}>{r.status.replace('_', ' ')}</span>
              </div>
              <ol className="campaign-criteria">
                {r.criteria.map((x) => (
                  <li key={x.number}>{x.text} <span className={`criterion-status criterion-status--${x.status}`}>{CRITERION_LABELS[x.status]}</span></li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      <div className="dash-panel">
        <div className="dash-panel__title">Tests</div>
        <table className="campaign-table">
          <tbody>
            {c.runs.map((t) => (
              <tr key={t.name}>
                <td><button className="bug-test" onClick={() => onOpenTest(t.name)}><FlaskConical size={12} /> {t.name}</button></td>
                <td><span className={`run-status run-status--${t.status}`}>{t.status === 'running' && <Loader2 size={10} className="spin" />} {t.status}</span></td>
                <td className="dash-table__muted">{duration(t.duration_ms)}</td>
                <td>
                  {t.error && <div className="campaign-error">{t.failed_step ? `Step ${t.failed_step}/${t.total_steps}: ` : ''}{t.error.split('\n')[0]}</div>}
                  {t.triage && <div className="campaign-why"><strong>{CAUSE_LABELS[t.triage.cause] ?? t.triage.cause}</strong> — {t.triage.summary}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
