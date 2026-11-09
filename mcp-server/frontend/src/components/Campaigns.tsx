import { useEffect, useState } from 'react';
import { Layers, ArrowLeft, Square, RotateCcw, Download, ExternalLink, Trash2, FlaskConical, Loader2, Play, Search, ChevronRight, AlertTriangle, Wand2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  campaignsApi, useGetCampaignsQuery, useGetCampaignQuery, useStartCampaignMutation, useStopCampaignMutation, useDeleteCampaignMutation,
  usePlanCampaignMutation, type CampaignInput,
} from '../store/services/campaignsApi';
import { useGetRequirementsQuery } from '../store/services/requirementsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useBack, useFollowProject, useGo, useUrlState } from '../navigation';
import { withScope } from '../scope';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { CampaignWriteBack } from './CampaignWriteBack';
import { StageEditor } from './StageEditor';
import { HeadlessSwitch } from './HeadlessSwitch';
import { useRunHeadless } from '../headless';
import { Card, Dialog, EmptyState, KeyChip, Menu, PageHeader, Pill, ProjectChip, ResultBar, Segmented, StatusPill } from './ui';
import { dateTime, formatDuration } from '../format';
import { CAUSE_LABELS } from '../triage-labels';
import type { Campaign, CampaignRun, CampaignStage, CampaignTestStatus } from '../types';

// Campaigns: tests replayed together for a version of the app (mcp-server/lib/campaigns.js) —
// a project's, a requirement's, or a chosen list —, a few at a time, each in its own window.
// The report says what failed and why, what regressed since the last campaign of the same
// tests, and where each requirement stands; it downloads as JUnit for a CI, or opens as HTML,
// and is sent to the tools set as connectors — Xray, the Jira stories it checks (CampaignWriteBack).

const STATUS_ORDER: CampaignTestStatus[] = ['passed', 'failed', 'error', 'running', 'pending', 'skipped'];
const STATUS_TONES: Record<CampaignTestStatus, string> = { passed: 'green', failed: 'red', error: 'amber', running: 'blue', pending: 'slate', skipped: 'slate' };
const CRITERION_LABELS = { passing: 'passing', failing: 'failing', not_run: 'not run', not_covered: 'no test' } as const;

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

/** What a campaign ran: a project, a requirement, or tests. */
function scopeLabel(c: Pick<Campaign, 'scope' | 'project'>) {
  if (c.scope.stages?.length) return `${c.scope.tests?.length ?? 0} tests in ${c.scope.stages.length} stage${c.scope.stages.length === 1 ? '' : 's'}`;
  if (c.scope.requirement) return `Requirement ${c.scope.requirement}`;
  if (c.scope.project_id) return `Project ${c.project ?? `#${c.scope.project_id}`}`;
  return `${c.scope.tests?.length ?? 0} chosen test${c.scope.tests?.length === 1 ? '' : 's'}`;
}

// ─── The list ────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'running' | 'done' | 'stopped';

export function CampaignsPage() {
  const go = useGo();
  const projectId = useAppSelector((state) => state.ui.selectedProjectId);
  // Polled while one of them runs.
  const anyRunning = useAppSelector((state) => campaignsApi.endpoints.getCampaigns.select(projectId)(state).data?.some((c) => c.running));
  const { data: campaigns = [], isLoading } = useGetCampaignsQuery(projectId, { pollingInterval: anyRunning ? 2000 : 0 });
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useUrlState('q');
  const [status, setStatus] = useUrlState('status', 'all') as [StatusFilter, (v: string) => void];
  const project = projects.find((p) => p.id === projectId);
  const open = (id: number) => go(`/campaigns/${id}`, { from: 'Campaigns' });

  const q = search.trim().toLowerCase();
  const stateOf = (c: (typeof campaigns)[number]) => (c.running ? 'running' : c.status === 'done' ? 'done' : 'stopped');
  const shown = campaigns.filter((c) =>
    (!q || c.name.toLowerCase().includes(q) || String(c.id) === q.replace('#', '') || (c.version ?? '').toLowerCase().includes(q))
    && (status === 'all' || stateOf(c) === status));

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="Tests replayed together for a version of the app, each in its own window. The report compares with the last campaign of the same tests. An agent runs one with run_campaign, a CI with node bin/campaign.js."
        actions={<Button icon={Play} onClick={() => setCreating(true)}>New campaign</Button>}
      />

      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, number or version…" aria-label="Search campaigns" />
        </div>
        <Segmented<StatusFilter>
          label="Status" value={status} onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: campaigns.length },
            { value: 'running', label: 'Running', tone: 'blue', count: campaigns.filter((c) => c.running).length },
            { value: 'done', label: 'Done', tone: 'green' },
            { value: 'stopped', label: 'Stopped', tone: 'slate' },
          ]}
        />
      </div>

      <Card flush>
        {isLoading ? <p className="empty-state">Loading…</p> : shown.length === 0 ? (
          campaigns.length === 0
            ? <EmptyState icon={Layers} title={project ? `No campaign in ${project.name} yet` : 'No campaign yet'} action={<Button icon={Play} onClick={() => setCreating(true)}>New campaign</Button>}>
                Replay a project's tests, a requirement's, or a few chosen on the Tests page.
              </EmptyState>
            : <EmptyState icon={Search} title="No campaign matches" action={<Button variant="secondary" onClick={() => { setSearch(''); setStatus('all'); }}>Clear the filters</Button>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>#</th><th>Campaign</th>{projectId === null && <th>Project</th>}<th>Started</th><th>Result</th><th>Changes</th><th>Status</th><th className="col-chevron" /></tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => open(c.id)}>
                    <td className="mono cell-muted">#{c.id}</td>
                    <td>
                      <div className="cell-title">{c.name}{c.version && <span className="campaign-version">v{c.version}</span>}</div>
                      <div className="cell-sub">{scopeLabel(c)}{c.headless && ' · headless'}</div>
                    </td>
                    {projectId === null && <td><ProjectChip project={projects.find((p) => p.id === c.project_id)} /></td>}
                    <td className="cell-muted">{dateTime(c.created_at)}</td>
                    <td><div className="result-cell"><ResultBar totals={c.totals} /><span>{c.totals.passed}/{c.total} passed</span></div></td>
                    <td>
                      <div className="cell-chips">
                        {c.changes?.regressed.length ? <Pill tone="red">{c.changes.regressed.length} regressed</Pill> : null}
                        {c.changes?.fixed.length ? <Pill tone="green">{c.changes.fixed.length} fixed</Pill> : null}
                        {!c.changes?.regressed.length && !c.changes?.fixed.length && <span className="cell-muted">—</span>}
                      </div>
                    </td>
                    <td><StatusPill status={c.running ? 'running' : c.status} icon={c.running ? Loader2 : undefined} /></td>
                    <td className="col-chevron"><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && <div className="table-footer"><span>Showing {shown.length} of {campaigns.length}</span></div>}
      </Card>

      {creating && (
        <Dialog title="New campaign" onClose={() => setCreating(false)} width={620}>
          <CampaignForm projectId={projectId} onStarted={(id) => { setCreating(false); open(id); }} onCancel={() => setCreating(false)} />
        </Dialog>
      )}
    </>
  );
}

type ScopeKind = 'project' | 'requirement' | 'tests';
type Ordering = 'together' | 'stages';

function CampaignForm({ projectId, onStarted, onCancel }: { projectId: number | null; onStarted: (id: number) => void; onCancel: () => void }) {
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const { data: requirements = [] } = useGetRequirementsQuery(projectId);
  // All the tests when all projects are in scope (not only those of no project).
  const { data: tests = [] } = useGetTestsQuery(projectId ?? undefined);
  const [kind, setKind] = useState<ScopeKind>('project');
  const [project, setProject] = useState<number | null>(projectId);
  const [requirement, setRequirement] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [name, setName] = useState('');
  const [concurrency, setConcurrency] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [start, { isLoading }] = useStartCampaignMutation();
  const [plan, { isLoading: planning }] = usePlanCampaignMutation();
  const [ordering, setOrdering] = useState<Ordering>('together');
  const [stages, setStages] = useState<CampaignStage[] | null>(null);
  const headless = useRunHeadless();

  const scope: CampaignInput | null = kind === 'project' ? (project ? { project_id: project } : null)
    : kind === 'requirement' ? (requirement ? { requirement } : null)
      : chosen.length ? { tests: chosen } : null;
  const scopeKey = JSON.stringify(scope);

  // In stages: those proposed for the tests chosen, each time they change (a test using a
  // value another one keeps runs after it).
  const propose = async () => {
    if (!scope) return setStages(null);
    try {
      setStages((await plan(scope).unwrap()).stages);
    } catch (err) {
      setError(errorOf(err));
    }
  };
  useEffect(() => {
    if (ordering === 'stages') propose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordering, scopeKey]);

  // In stages, the campaign is of tests: named after what they were chosen from.
  const defaultName = kind === 'project' ? projects.find((p) => p.id === project)?.name
    : kind === 'requirement' ? (() => { const r = requirements.find((x) => x.key === requirement); return r ? `${r.key} — ${r.title}` : undefined; })() : undefined;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!scope) return;
    setError(null);
    const staged = ordering === 'stages' && stages?.length;
    try {
      const { campaign } = await start({
        ...(staged ? { stages: stages! } : scope), version: version.trim() || undefined,
        name: name.trim() || (staged ? defaultName : undefined) || undefined, concurrency, headless,
      }).unwrap();
      onStarted(campaign.id);
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Segmented<ScopeKind>
        label="What to run" value={kind} onChange={setKind}
        options={[{ value: 'project', label: 'A project\'s tests' }, { value: 'requirement', label: 'A requirement\'s tests' }, { value: 'tests', label: 'Chosen tests' }]}
      />
      {kind === 'project' && (
        <label className="field">
          <span className="field__label">Project</span>
          <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose a project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.test_count ?? 0} tests</option>)}
          </select>
        </label>
      )}
      {kind === 'requirement' && (
        <label className="field">
          <span className="field__label">Requirement</span>
          <select value={requirement} onChange={(e) => setRequirement(e.target.value)}>
            <option value="">Choose a requirement…</option>
            {requirements.map((r) => <option key={r.key} value={r.key}>{r.key} — {r.title} ({r.coverage.tests} test{r.coverage.tests === 1 ? '' : 's'})</option>)}
          </select>
        </label>
      )}
      {kind === 'tests' && (
        <div className="field">
          <span className="field__label">Tests <span className="field__optional">{chosen.length} chosen</span></span>
          <div className="campaign-form__tests">
            {tests.map((t) => (
              <label key={t.name}>
                <input type="checkbox" checked={chosen.includes(t.name)}
                  onChange={() => setChosen(chosen.includes(t.name) ? chosen.filter((n) => n !== t.name) : [...chosen, t.name])} />
                <span className="mono">{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {scope && (
        <div className="field">
          <span className="field__label">Order</span>
          <Segmented<Ordering>
            label="How the tests run" value={ordering} onChange={setOrdering}
            options={[{ value: 'together', label: 'All together' }, { value: 'stages', label: 'In stages' }]}
          />
          {ordering === 'together' ? (
            <p className="field__hint">Side by side, {concurrency} at a time, in no set order.</p>
          ) : (
            <>
              <p className="field__hint">
                Stage after stage: a set-up first, the tests that use what it made after it. A value a test keeps (capture) is given
                to the tests after it. Keep tests independent when they can be.
                {' '}<button type="button" className="link-btn" onClick={propose} disabled={planning}><Wand2 size={12} /> Propose again</button>
              </p>
              {planning && !stages ? <p className="muted">Proposing…</p> : stages && <StageEditor stages={stages} onChange={setStages} />}
            </>
          )}
        </div>
      )}
      <div className="form__row">
        <label className="field form__grow">
          <span className="field__label">Version of the app <span className="field__optional">optional</span></span>
          <input placeholder="e.g. 1.4.0, a commit" value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
        <label className="field form__grow">
          <span className="field__label">Name <span className="field__optional">optional</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" style={{ width: 110 }}>
          <span className="field__label">At a time</span>
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <HeadlessSwitch />
      {error && <div className="alert alert--error">{error}</div>}
      <div className="form__actions">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" icon={Play} disabled={!scope || isLoading}>{headless ? 'Start headless' : 'Start'}</Button>
      </div>
    </form>
  );
}

// ─── One campaign ────────────────────────────────────────────────────

export function CampaignPage({ id }: { id: number }) {
  const dispatch = useAppDispatch();
  const go = useGo();
  const navigate = useNavigate();
  const back = useBack('/campaigns', 'Campaigns');
  // Polled while it runs.
  const live = useAppSelector((state) => campaignsApi.endpoints.getCampaign.select(id)(state).data?.running);
  const { data: campaign, isLoading } = useGetCampaignQuery(id, { pollingInterval: live === false ? 0 : 2000 });
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const [stop, { isLoading: stopping }] = useStopCampaignMutation();
  const [start, { isLoading: restarting }] = useStartCampaignMutation();
  const [remove] = useDeleteCampaignMutation();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // A campaign of another project: that project comes into scope.
  useFollowProject(campaign ? campaign.project_id : undefined, (owner) => {
    dispatch(showToast({ message: `Now in ${projects.find((p) => p.id === owner)?.name ?? 'all projects'}: the project of campaign #${id}` }));
  });

  if (isLoading) return <Card><p className="empty-state">Loading…</p></Card>;
  if (!campaign) return <Card><EmptyState icon={Layers} title={`No campaign #${id}`}>It may have been deleted.</EmptyState></Card>;
  const c = campaign;
  const project = projects.find((p) => p.id === c.project_id) ?? null;
  const label = `campaign #${c.id}`;
  const openTest = (name: string) => go(`/tests/${encodeURIComponent(name)}`, { from: label });
  const openRequirement = (key: string) => go(`/requirements/${encodeURIComponent(key)}`, { from: label });

  const again = async () => {
    setError(null);
    try {
      const scope = c.scope.stages?.length ? { stages: c.scope.stages }
        : c.scope.requirement ? { requirement: c.scope.requirement } : c.scope.project_id ? { project_id: c.scope.project_id } : { tests: c.scope.tests };
      const { campaign: next } = await start({ ...scope, name: c.scope.stages?.length ? c.name : undefined, version: c.version ?? undefined, concurrency: c.concurrency, headless: c.headless }).unwrap();
      navigate(withScope(`/campaigns/${next.id}`, c.project_id), { replace: true, state: back.state });
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const destroy = async () => {
    await remove(c.id).unwrap();
    dispatch(showToast({ message: `Campaign #${c.id} deleted` }));
    back.go();
  };
  const done = c.total - c.totals.pending - c.totals.running;

  return (
    <>
      <Card className="detail-head">
        <div><Button variant="back" size="sm" icon={ArrowLeft} onClick={back.go}>{back.label}</Button></div>
        <div className="detail-head__top">
          <div className="detail-head__titles">
            <h1 className="page-title">
              <span className="mono cell-muted">#{c.id}</span> {c.name}{c.version && <span className="campaign-version">v{c.version}</span>}
              {' '}<StatusPill status={c.running ? 'running' : c.status} icon={c.running ? Loader2 : undefined} label={c.running ? `Running · ${done}/${c.total}` : undefined} />
            </h1>
            <div className="detail-meta-row">
              <span className="meta-item">{scopeLabel(c)}</span>
              <span className="meta-sep" />
              <ProjectChip project={project} onClick={project ? () => navigate(withScope('/campaigns', project.id)) : undefined} />
              <span className="meta-sep" />
              <span className="meta-item">{dateTime(c.created_at)}</span>
              <span className="meta-item">· {c.concurrency} at a time</span>
              {c.headless && <span className="tag tag--blue">headless</span>}
              {c.duration_ms != null && <span className="meta-item">· {formatDuration(c.duration_ms)}</span>}
            </div>
          </div>
          <div className="detail-head__actions">
            {c.running
              ? <Button variant="danger" icon={Square} disabled={stopping} onClick={() => stop(c.id)}>Stop</Button>
              : <Button variant="secondary" icon={RotateCcw} disabled={restarting} onClick={again}>Run again</Button>}
            <a className="btn btn--secondary" href={`/api/campaigns/${c.id}/junit.xml`} download><Download size={16} /> JUnit</a>
            <a className="btn btn--secondary" href={`/api/campaigns/${c.id}/report.html`} target="_blank" rel="noreferrer"><ExternalLink size={16} /> HTML report</a>
            {!c.running && <Menu items={[{ label: 'Delete campaign…', icon: Trash2, danger: true, onClick: () => setDeleting(true) }]} />}
          </div>
        </div>
        <div className="totals">
          {STATUS_ORDER.filter((s) => c.totals[s] || s === 'passed' || s === 'failed').map((s) => (
            <div key={s} className={`total-tile total-tile--${c.totals[s] ? STATUS_TONES[s] : 'slate'}`}>
              <div className="total-tile__value">{c.totals[s]}</div>
              <div className="total-tile__label">{s}</div>
            </div>
          ))}
        </div>
        <div className="result-bar result-bar--lg"><ResultBarParts totals={c.totals} /></div>
        {error && <div className="alert alert--error">{error}</div>}
      </Card>

      {c.non_conformities.length > 0 && (
        <Card title="Non-conformities" icon={AlertTriangle} subtitle="The app does not do what the requirement says — report it, do not change the test.">
          <div className="cell-chips">
            {c.non_conformities.map((name) => <button key={name} className="test-link" onClick={() => openTest(name)}><FlaskConical size={12} /> {name}</button>)}
          </div>
        </Card>
      )}

      {c.changes && (
        <Card title={<>Since campaign #{c.changes.since.id}{c.changes.since.version && ` (v${c.changes.since.version})`}{c.running && ', so far'}</>}
          actions={<button className="link-btn" onClick={() => go(`/campaigns/${c.changes!.since.id}`, { from: label })}>Open #{c.changes.since.id}</button>}>
          {!c.changes.regressed.length && !c.changes.fixed.length && <p className="muted">Nothing regressed, nothing fixed.</p>}
          {c.changes.regressed.length > 0 && (
            <div className="change-line"><Pill tone="red">Regressed</Pill>{c.changes.regressed.map((name) => <button key={name} className="test-link" onClick={() => openTest(name)}><FlaskConical size={12} /> {name}</button>)}</div>
          )}
          {c.changes.fixed.length > 0 && (
            <div className="change-line"><Pill tone="green">Fixed</Pill>{c.changes.fixed.map((name) => <button key={name} className="test-link" onClick={() => openTest(name)}><FlaskConical size={12} /> {name}</button>)}</div>
          )}
        </Card>
      )}

      <Card title="Tests" icon={FlaskConical} flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Test</th><th>Status</th><th className="col-num">Duration</th><th>Why</th></tr></thead>
            {(c.stages ?? [null]).map((stage, s) => {
              const runs = stage ? c.runs.filter((t) => (t.stage ?? 0) === s) : c.runs;
              return (
                <tbody key={s}>
                  {stage && (
                    <tr className="stage-row">
                      <td colSpan={4}>
                        <span className="stage-card__number">{stage.number}</span>
                        <strong>{stage.name || `Stage ${stage.number}`}</strong>
                        <span className="cell-muted"> · {stage.mode === 'parallel' ? 'side by side' : 'one after the other'}{stage.needs_previous ? ' · only if the stages before passed' : ''}</span>
                        {' '}<StatusPill status={stage.status} icon={stage.status === 'running' ? Loader2 : undefined} />
                      </td>
                    </tr>
                  )}
                  {runs.map((t) => <RunRow key={t.label ?? t.name} run={t} onOpen={openTest} />)}
                </tbody>
              );
            })}
          </table>
        </div>
      </Card>

      {c.requirements.length > 0 && (
        <Card title="Requirements" subtitle="Where each requirement the tests check stands after this campaign, criterion by criterion.">
          {c.requirements.map((r) => (
            <div key={r.key} className="campaign-requirement">
              <div className="case-row">
                <KeyChip onClick={() => openRequirement(r.key)}>{r.key}</KeyChip>
                <span className="case-title">{r.title}</span>
                <StatusPill status={r.status} />
              </div>
              <ol className="criteria-status">
                {r.criteria.map((x) => (
                  <li key={x.number}>{x.text}<StatusPill status={x.status} label={CRITERION_LABELS[x.status]} /></li>
                ))}
              </ol>
            </div>
          ))}
        </Card>
      )}

      <CampaignWriteBack campaign={c} />

      <ConfirmModal
        isOpen={deleting} title={`Delete campaign #${c.id}?`} confirmLabel="Delete campaign"
        message={<p>Its runs stay in each test's history; only the campaign and its report go.</p>}
        onConfirm={destroy} onCancel={() => setDeleting(false)}
      />
    </>
  );
}

/** A test of a campaign: how it did, and why. */
function RunRow({ run: t, onOpen }: { run: CampaignRun; onOpen: (name: string) => void }) {
  return (
    <tr>
      <td><button className="test-link" onClick={() => onOpen(t.name)}><FlaskConical size={12} /> {t.label ?? t.name}</button></td>
      <td><StatusPill status={t.status} icon={t.status === 'running' ? Loader2 : undefined} /></td>
      <td className="col-num cell-muted">{t.duration_ms != null ? formatDuration(t.duration_ms) : '—'}</td>
      <td className="why">
        {t.error && <div className="why__error">{t.failed_step ? `Step ${t.failed_step}/${t.total_steps}: ` : ''}{t.error.split('\n')[0]}</div>}
        {t.triage && <div><strong>{CAUSE_LABELS[t.triage.cause] ?? t.triage.cause}</strong> — {t.triage.summary}</div>}
        {t.status === 'skipped' && t.skipped_because && <span className="cell-muted">{t.skipped_because}</span>}
        {!t.error && !t.triage && !(t.status === 'skipped' && t.skipped_because) && <span className="cell-muted">—</span>}
      </td>
    </tr>
  );
}

/** The parts of a large result bar, inside its own container. */
function ResultBarParts({ totals }: { totals: Campaign['totals'] }) {
  return (
    <>
      {STATUS_ORDER.filter((s) => totals[s]).map((s) => <span key={s} className={`result-bar__part bar--${STATUS_TONES[s]}`} style={{ flexGrow: totals[s] }} />)}
    </>
  );
}
