import { useState } from 'react';
import {
  ClipboardList, Plus, Trash2, Save, ArrowLeft, FlaskConical, Link2, X, ExternalLink, Sparkles, AlertTriangle, FileCode, Bot, Loader2, Play, Upload,
  Search, ChevronRight, Layers,
} from 'lucide-react';
import {
  useGetRequirementsQuery, useGetRequirementQuery, useCreateRequirementMutation, useUpdateRequirementMutation,
  useDeleteRequirementMutation, useAddCaseMutation, useDeleteCaseMutation, useUpdateCaseMutation,
  useDesignRequirementMutation, usePlanDesignMutation, useDismissDesignMutation, usePlaceMissingMutation,
} from '../store/services/requirementsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { useGetCampaignsQuery, useStartCampaignMutation } from '../store/services/campaignsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useGetConnectorsQuery } from '../store/services/settingsApi';
import { RequirementImportPanel } from './RequirementImport';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useBack, useFollowProject, useGo, useUrlState } from '../navigation';
import { withScope } from '../scope';
import { useNavigate } from 'react-router-dom';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { ProjectField } from './ProjectSelector';
import { CreateTestModal, type CreateMode, type CreateTestPreset } from './CreateTestModal';
import { useRunHeadless } from '../headless';
import { Card, Dialog, EmptyState, KeyChip, Menu, PageHeader, ProjectChip, ResultBar, Segmented, StatusPill } from './ui';
import { dateTime, relativeTime } from '../format';
import type { MissingRule, Requirement, RequirementCase, RequirementDesign, DesignedScenario, ScenarioResolution, Technique } from '../types';

// Requirements: what tests are for (mcp-server/lib/requirements.js). A tester writes one here
// — its acceptance criteria, the cases that check each — and links the tests that check them;
// coverage says, criterion by criterion, what is tested and how it went on the last run.
// "Propose scenarios" asks the agent set in Settings for a test design
// (mcp-server/lib/requirement-design.js): the criteria a test cannot judge, with the question to
// ask; what the requirement leaves unsaid; scenarios, each with its technique and its Gherkin.
// The ones chosen are planned; a planned case's test is created from its Gherkin, or recorded
// by the agent following it.

const COVERAGE_LABELS: Record<Requirement['coverage']['status'], string> = {
  passing: 'Passing',
  failing: 'Failing',
  not_run: 'Not run yet',
  not_covered: 'Not covered',
};
const SOURCE_LABELS: Record<string, string> = { prompt: 'From a request', manual: 'Written', import: 'Imported' };

/** What each source of requirements is called: IziTest's own, and each tool's (mcp-server/lib/connectors). */
function useSourceLabels(): Record<string, string> {
  const { data: connectors = [] } = useGetConnectorsQuery();
  return { ...SOURCE_LABELS, ...Object.fromEntries(connectors.filter((c) => c.requirements).map((c) => [c.id, c.name])) };
}
const KINDS = ['nominal', 'alternative', 'error', 'boundary'] as const;
const TECHNIQUE_LABELS: Record<Technique, string> = {
  use_case: 'Use case',
  equivalence_partitioning: 'Equivalence classes',
  boundary_values: 'Boundary values',
  decision_table: 'Decision table',
  state_transition: 'State transition',
  error_guessing: 'Error guessing',
};

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A test's name for a requirement's case: "shop_7_wrong_password_refused". */
const testNameFor = (key: string, title: string) => `${key} ${title}`
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

function CoverageBadge({ coverage }: { coverage: Requirement['coverage'] }) {
  return (
    <StatusPill
      status={coverage.status}
      label={<>{COVERAGE_LABELS[coverage.status]}{coverage.criteria > 0 && ` · ${coverage.covered}/${coverage.criteria} criteria`}</>}
    />
  );
}

// ─── The list ────────────────────────────────────────────────────────

type CoverageFilter = 'all' | Requirement['coverage']['status'];

export function RequirementsPage() {
  const go = useGo();
  const sources = useSourceLabels();
  const projectId = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: requirements = [], isLoading } = useGetRequirementsQuery(projectId);
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useUrlState('q');
  const [coverage, setCoverage] = useUrlState('coverage', 'all') as [CoverageFilter, (v: string) => void];
  const [source, setSource] = useUrlState('source');
  const project = projects.find((p) => p.id === projectId);
  const open = (key: string) => go(`/requirements/${encodeURIComponent(key)}`, { from: 'Requirements' });

  const count = (status: Requirement['coverage']['status']) => requirements.filter((r) => r.coverage.status === status).length;
  const q = search.trim().toLowerCase();
  const shown = requirements.filter((r) =>
    (!q || r.key.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
    && (coverage === 'all' || r.coverage.status === coverage)
    && (!source || r.source === source));

  const tiles: Array<{ status: Requirement['coverage']['status']; tone: string }> = [
    { status: 'passing', tone: 'green' }, { status: 'failing', tone: 'red' }, { status: 'not_run', tone: 'amber' }, { status: 'not_covered', tone: 'slate' },
  ];

  return (
    <>
      <PageHeader
        title="Requirements"
        subtitle="What the tests are for: each requirement, its acceptance criteria and the tests that check them. A request made in “New test” is kept here too."
        actions={(
          <>
            <Button variant="secondary" icon={Upload} onClick={() => setImporting(true)}>Import</Button>
            <Button icon={Plus} onClick={() => setCreating(true)}>New requirement</Button>
          </>
        )}
      />

      <div className="kpis">
        {tiles.map(({ status, tone }) => (
          <button key={status} type="button" className={`kpi kpi--small ${coverage === status ? 'active' : ''}`} onClick={() => setCoverage(coverage === status ? 'all' : status)}>
            <span className="kpi__label" style={{ color: `var(--${tone === 'slate' ? 'slate' : tone})` }}>{COVERAGE_LABELS[status]}</span>
            <span className="kpi__value">{count(status)}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by key or title…" aria-label="Search requirements" />
        </div>
        <Segmented<CoverageFilter>
          label="Coverage" value={coverage} onChange={setCoverage}
          options={[
            { value: 'all', label: 'All', count: requirements.length },
            { value: 'passing', label: 'Passing', tone: 'green' },
            { value: 'failing', label: 'Failing', tone: 'red' },
            { value: 'not_run', label: 'Not run', tone: 'amber' },
            { value: 'not_covered', label: 'Not covered', tone: 'slate' },
          ]}
        />
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">Source: any</option>
          {Object.entries(sources).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>

      <Card flush>
        {isLoading ? <p className="empty-state">Loading…</p> : shown.length === 0 ? (
          requirements.length === 0
            ? <EmptyState icon={ClipboardList} title={project ? `No requirement in ${project.name} yet` : 'No requirement yet'}
                action={<div className="repair-actions"><Button variant="secondary" icon={Upload} onClick={() => setImporting(true)}>Import</Button><Button icon={Plus} onClick={() => setCreating(true)}>New requirement</Button></div>}>
                Write one, import a test plan or the issues of a tool (Jira, GitHub…) — or let an agent save them with save_requirement.
              </EmptyState>
            : <EmptyState icon={Search} title="No requirement matches" action={<Button variant="secondary" onClick={() => { setSearch(''); setCoverage('all'); setSource(''); }}>Clear the filters</Button>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th><th>Title</th>{projectId === null && <th>Project</th>}<th>Source</th><th>Criteria covered</th><th className="col-num">Tests</th><th>Coverage</th><th className="col-chevron" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => open(r.key)}>
                    <td><KeyChip>{r.key}</KeyChip></td>
                    <td className="req-title">{r.title}</td>
                    {projectId === null && <td><ProjectChip project={projects.find((p) => p.id === r.project_id)} /></td>}
                    <td><span className="tag">{sources[r.source] ?? r.source}</span></td>
                    <td>
                      <div className="coverage-cell">
                        <div className="result-bar">
                          <span className="result-bar__part bar--blue" style={{ flexGrow: r.coverage.covered }} />
                          <span className="result-bar__part" style={{ flexGrow: Math.max(0, r.coverage.criteria - r.coverage.covered) }} />
                        </div>
                        <span>{r.coverage.covered}/{r.coverage.criteria}</span>
                      </div>
                    </td>
                    <td className="col-num">{r.coverage.tests}{r.coverage.planned > 0 && <span className="cell-muted"> +{r.coverage.planned} planned</span>}</td>
                    <td><StatusPill status={r.coverage.status} label={COVERAGE_LABELS[r.coverage.status]} /></td>
                    <td className="col-chevron"><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && <div className="table-footer"><span>Showing {shown.length} of {requirements.length}</span></div>}
      </Card>

      {importing && (
        <Dialog title="Import requirements" onClose={() => setImporting(false)} width={780}>
          <RequirementImportPanel defaultProjectId={projectId} onDone={() => setImporting(false)} onCancel={() => setImporting(false)} />
        </Dialog>
      )}
      {creating && (
        <Dialog title="New requirement" onClose={() => setCreating(false)} width={620}>
          <RequirementForm defaultProjectId={projectId} onSaved={(key) => { setCreating(false); open(key); }} onCancel={() => setCreating(false)} />
        </Dialog>
      )}
    </>
  );
}

function RequirementForm({ defaultProjectId, onSaved, onCancel }: { defaultProjectId: number | null; onSaved: (key: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  // The project in scope; with all of them in scope, chosen.
  const [projectId, setProjectId] = useState<number | null | undefined>(defaultProjectId ?? undefined);
  const [error, setError] = useState<string | null>(null);
  const [create, { isLoading }] = useCreateRequirementMutation();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (projectId === undefined) return setError('Choose the project it belongs to');
    try {
      const { requirement } = await create({
        title, description, key: key.trim() || undefined, url: url.trim() || null, project_id: projectId,
        criteria: criteria.split('\n').map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean),
      }).unwrap();
      onSaved(requirement.key);
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <ProjectField value={projectId} onChange={setProjectId} />
      <label className="field">
        <span className="field__label">Title</span>
        <input required autoFocus placeholder="e.g. A wrong password is refused" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Description <span className="field__optional">optional</span></span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Acceptance criteria</span>
        <textarea rows={4} placeholder={'One per line:\nA wrong password shows "Invalid credentials"\nThe user stays on the login page'} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </label>
      <div className="form__row">
        <label className="field form__grow">
          <span className="field__label">Key <span className="field__optional">optional</span></span>
          <input placeholder="e.g. SHOP-123" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="field form__grow">
          <span className="field__label">Link <span className="field__optional">optional</span></span>
          <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      <div className="form__actions">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" icon={Save} disabled={isLoading || !title.trim()}>Save requirement</Button>
      </div>
    </form>
  );
}

// ─── One requirement ─────────────────────────────────────────────────

export function RequirementPage({ requirementKey }: { requirementKey: string }) {
  const { data: requirement, isLoading } = useGetRequirementQuery(requirementKey);
  if (isLoading) return <Card><p className="empty-state">Loading…</p></Card>;
  if (!requirement) return <Card><EmptyState icon={ClipboardList} title={`No requirement ${requirementKey}`}>It may have been deleted.</EmptyState></Card>;
  // Keyed by its last update: a save elsewhere (an agent) shows here as it is now.
  return <RequirementEditor key={requirement.updated_at} requirement={requirement} />;
}

function RequirementEditor({ requirement }: { requirement: Requirement }) {
  const dispatch = useAppDispatch();
  const sources = useSourceLabels();
  const go = useGo();
  const navigate = useNavigate();
  const back = useBack('/requirements', 'Requirements');
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const { data: campaigns = [] } = useGetCampaignsQuery(requirement.project_id);
  const [title, setTitle] = useState(requirement.title);
  const [description, setDescription] = useState(requirement.description);
  const [priority, setPriority] = useState(requirement.priority);
  const [criteria, setCriteria] = useState(requirement.criteria.map((c) => ({ id: c.id as number | undefined, text: c.text })));
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<CreateTestPreset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [update, { isLoading: saving }] = useUpdateRequirementMutation();
  const [remove] = useDeleteRequirementMutation();
  const [startCampaign, { isLoading: launching }] = useStartCampaignMutation();
  const headless = useRunHeadless();
  const design = requirement.design;
  const missing = (design?.missing ?? []).filter((m) => !criteria.some((c) => sameText(c.text, m.text)));
  const dirty = title !== requirement.title || description !== requirement.description || priority !== requirement.priority
    || JSON.stringify(criteria) !== JSON.stringify(requirement.criteria.map((c) => ({ id: c.id, text: c.text })));
  const project = projects.find((p) => p.id === requirement.project_id) ?? null;
  const ranIn = campaigns.filter((c) => c.scope.requirement === requirement.key);
  const tests = requirement.cases.filter((c) => c.test);

  // A requirement of another project: that project comes into scope.
  useFollowProject(requirement.project_id, (owner) => {
    dispatch(showToast({ message: `Now in ${projects.find((p) => p.id === owner)?.name ?? 'all projects'}: the project of ${requirement.key}` }));
  });

  const save = async () => {
    setError(null);
    try {
      await update({ ref: requirement.key, title, description, priority, criteria: criteria.filter((c) => c.text.trim()) }).unwrap();
      dispatch(showToast({ message: `${requirement.key} saved` }));
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const moveTo = async (projectId: number | null) => {
    if (projectId == null) return;
    try {
      await update({ ref: requirement.key, project_id: projectId }).unwrap();
      dispatch(showToast({ message: `${requirement.key} moved to ${projects.find((p) => p.id === projectId)?.name}` }));
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const destroy = async () => {
    await remove(requirement.key).unwrap();
    dispatch(showToast({ message: `${requirement.key} deleted` }));
    back.go();
  };
  // Its tests replayed together, as a campaign: where it stands now, criterion by criterion.
  const runTests = async () => {
    setError(null);
    try {
      const { campaign } = await startCampaign({ requirement: requirement.key, headless }).unwrap();
      go(`/campaigns/${campaign.id}`, { from: requirement.key });
    } catch (err) {
      setError(errorOf(err));
    }
  };
  // A planned case's test: created from its Gherkin, or recorded by the agent following it.
  const createFor = (c: RequirementCase, mode: CreateMode) => {
    const criterion = requirement.criteria.find((x) => x.id === c.criterion_id);
    setPreset({
      mode, name: testNameFor(requirement.key, c.title),
      description: criterion ? `${c.title} — checks criterion ${criterion.position}: ${criterion.text}` : c.title,
      projectId: requirement.project_id, gherkin: c.gherkin, requirement: requirement.key, caseId: c.id,
    });
  };
  const onOpenTest = (name: string) => go(`/tests/${encodeURIComponent(name)}`, { from: requirement.key });

  return (
    <>
      <Card className="req-head">
        <div><Button variant="back" size="sm" icon={ArrowLeft} onClick={back.go}>{back.label}</Button></div>
        <div className="req-head__top">
          <div className="detail-head__titles">
            <div className="detail-meta-row">
              <KeyChip>{requirement.key}</KeyChip>
              <CoverageBadge coverage={requirement.coverage} />
              <span className="tag">{sources[requirement.source] ?? requirement.source}</span>
              {requirement.external_url && (
                <a className="meta-item" href={requirement.external_url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Source</a>
              )}
            </div>
            <input className="inline-edit inline-edit--title" style={{ fontFamily: 'var(--font)' }} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          </div>
          <div className="detail-head__actions">
            <Button
              icon={launching ? Loader2 : Play}
              disabled={launching || requirement.coverage.tests === 0} title={requirement.coverage.tests ? 'Replay its tests together, as a campaign' : 'No test linked yet'}
              onClick={runTests}
            >
              Run its tests
            </Button>
            <Menu items={[{ label: 'Delete requirement…', icon: Trash2, danger: true, onClick: () => setDeleting(true) }]} />
          </div>
        </div>
        <div className="req-head__fields">
          <label className="field">
            <span className="field__label">Description</span>
            <textarea rows={2} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Requirement['priority'])}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>
        {dirty && (
          <div className="unsaved">
            Unsaved changes to the requirement
            <span className="spacer" />
            <Button size="sm" icon={Save} disabled={saving} onClick={save}>Save</Button>
          </div>
        )}
        {error && <div className="alert alert--error">{error}</div>}
      </Card>

      <div className="detail-layout">
        <div className="stack">
          <Card title="Acceptance criteria" subtitle="Each criterion with the cases that check it, their tests and how they last ran.">
            {criteria.length === 0 && <p className="muted">No criterion yet: add one, or let “Propose scenarios” point at what is missing.</p>}
            {criteria.map((criterion, i) => {
              const saved = requirement.criteria.find((c) => c.id === criterion.id);
              // What the review said of it, until it is reworded.
              const note = saved && criterion.text === saved.text ? design?.review.find((r) => sameText(r.criterion_text, saved.text)) : undefined;
              return (
                <div key={criterion.id ?? `new-${i}`} className="criterion">
                  <div className="criterion__head">
                    <span className="criterion__number">{i + 1}.</span>
                    <input value={criterion.text} onChange={(e) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, text: e.target.value } : c)))} />
                    <button className="icon-button" title="Remove this criterion" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}><X size={14} /></button>
                  </div>
                  {note && (
                    <ReviewNote note={note} onUse={() => setCriteria(criteria.map((c, j) => (j === i ? { ...c, text: note.suggestion ?? c.text } : c)))} />
                  )}
                  {saved && (
                    <CasesOf requirement={requirement} criterion={saved.position} cases={requirement.cases.filter((c) => c.criterion_id === saved.id)} onOpenTest={onOpenTest} onCreate={createFor} />
                  )}
                </div>
              );
            })}
            {missing.length > 0 && (
              <MissingRules requirement={requirement} rules={missing} onAdd={(text) => setCriteria([...criteria, { id: undefined, text }])} />
            )}
            <div className="repair-actions" style={{ marginTop: 12 }}>
              <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCriteria([...criteria, { id: undefined, text: '' }])}>Add a criterion</Button>
              {dirty && <Button size="sm" icon={Save} disabled={saving} onClick={save}>Save</Button>}
            </div>
          </Card>

          <DesignPanel key={design?.designed_at ?? 'none'} requirement={requirement} unsaved={dirty} />

          <Card title="The whole requirement" subtitle="Cases that check it as a whole, not one criterion.">
            <CasesOf requirement={requirement} criterion={null} cases={requirement.cases.filter((c) => c.criterion_id == null)} onOpenTest={onOpenTest} onCreate={createFor} />
          </Card>
        </div>

        <div className="stack">
          <Card title="Details">
            <dl className="details-list">
              <dt>Project</dt>
              <dd>
                <ProjectChip project={project} onClick={project ? () => navigate(withScope('/requirements', project.id)) : undefined} />
              </dd>
              <dt>Move to</dt>
              <dd>
                <select value="" onChange={(e) => e.target.value && moveTo(Number(e.target.value))} aria-label="Move to another project" style={{ width: '100%' }}>
                  <option value="">Another project…</option>
                  {projects.filter((p) => p.id !== requirement.project_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </dd>
              <dt>Source</dt><dd>{sources[requirement.source] ?? requirement.source}</dd>
              <dt>Created</dt><dd>{dateTime(requirement.created_at)}</dd>
              <dt>Updated</dt><dd>{dateTime(requirement.updated_at)}</dd>
            </dl>
          </Card>
          <Card title="Tests" icon={FlaskConical}>
            {tests.length === 0 ? <p className="muted">No test linked yet.</p> : (
              <div className="side-list">
                {tests.map((c) => (
                  <div key={c.id} className="side-list__row side-list__row--link" onClick={() => onOpenTest(c.test!)}>
                    <div className="side-list__main">
                      <span className="side-list__title mono">{c.test}</span>
                      <span className="side-list__sub">{c.last_run ? relativeTime(c.last_run.started_at) : 'never run'}</span>
                    </div>
                    <StatusPill status={c.last_run?.status ?? 'never'} />
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Campaigns" icon={Layers}>
            {ranIn.length === 0 ? <p className="muted">Its tests have not run together yet: “Run its tests”.</p> : (
              <div className="side-list">
                {ranIn.slice(0, 4).map((c) => (
                  <div key={c.id} className="side-list__row side-list__row--link" onClick={() => go(`/campaigns/${c.id}`, { from: requirement.key })}>
                    <div className="side-list__main">
                      <span className="side-list__title">#{c.id}{c.version && <span className="campaign-version">v{c.version}</span>}</span>
                      <span className="side-list__sub">{relativeTime(c.created_at)} · {c.totals.passed}/{c.total} passed</span>
                    </div>
                    <ResultBar totals={c.totals} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <ConfirmModal
        isOpen={deleting} title={`Delete ${requirement.key}?`} confirmLabel="Delete requirement"
        message={<p>Its tests stay; only the requirement, its criteria and their links to the tests go.</p>}
        onConfirm={destroy} onCancel={() => setDeleting(false)}
      />

      <CreateTestModal
        isOpen={!!preset}
        preset={preset}
        onClose={() => setPreset(null)}
        onTestCreated={(name) => { setPreset(null); onOpenTest(name); }}
      />
    </>
  );
}

/** What the review says of a criterion: why a test cannot judge it, what to ask, a rewording to use. */
// The level a test checks a rule best at, as the test design says.
const LEVELS: Record<NonNullable<MissingRule['level']>, { label: string; hint: string }> = {
  e2e: { label: 'End to end', hint: 'Through the screens of the app: a test of IziTest.' },
  api: { label: 'API', hint: 'Through the API of the app: a test of IziTest that calls it (call_api).' },
  unit: { label: 'Unit · developers', hint: 'In the code, by its developers: the test is theirs, the rule still belongs in a requirement.' },
};

/**
 * What the requirement leaves unsaid, as the test design found it: each rule with the level a
 * test checks it best at, and where it belongs — added to these criteria (then saved with
 * them), to the other requirement it names, or as a requirement of its own for the whole
 * project. Or not needed: it leaves the design.
 */
function MissingRules({ requirement, rules, onAdd }: { requirement: Requirement; rules: MissingRule[]; onAdd: (text: string) => void }) {
  const dispatch = useAppDispatch();
  const go = useGo();
  const [place, { isLoading }] = usePlaceMissingMutation();
  const act = async (rule: MissingRule, dismiss = false) => {
    try {
      const { placed } = await place({ ref: requirement.key, text: rule.text, dismiss }).unwrap();
      dispatch(showToast({ message: dismiss ? 'Left out' : rule.scope === 'other' ? `Added to the criteria of ${placed}` : `${placed} created, for the whole project` }));
    } catch (err) {
      dispatch(showToast({ message: errorOf(err), type: 'error' }));
    }
  };
  const open = (key: string) => go(`/requirements/${encodeURIComponent(key)}`, { from: requirement.key });
  return (
    <div className="missing">
      <div className="missing__title">The requirement does not say</div>
      {rules.map((rule) => (
        <div key={rule.text} className="missing__item">
          <div className="missing__body">
            <span>{rule.text}</span>
            <span className="missing__meta">
              {rule.level && <span className={`level-badge level-badge--${rule.level}`} title={LEVELS[rule.level].hint}>{LEVELS[rule.level].label}</span>}
              {rule.scope === 'other' && rule.requirement && (
                <span>Belongs to <button className="link-btn" onClick={() => open(rule.requirement!)}>{rule.requirement}</button></span>
              )}
              {rule.scope === 'project' && <span>For the whole project, not this requirement</span>}
              {rule.why && <span className="missing__why">{rule.why}</span>}
            </span>
          </div>
          <div className="missing__actions">
            {rule.scope === 'this' && <button className="link-btn" onClick={() => onAdd(rule.text)}>Add as a criterion</button>}
            {rule.scope === 'other' && <button className="link-btn" disabled={isLoading} onClick={() => act(rule)}>Add to {rule.requirement}</button>}
            {rule.scope === 'project' && <button className="link-btn" disabled={isLoading} onClick={() => act(rule)}>Create a requirement</button>}
            <button className="link-btn link-btn--quiet" disabled={isLoading} onClick={() => act(rule, true)}>Not needed</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewNote({ note, onUse }: { note: RequirementDesign['review'][number]; onUse: () => void }) {
  return (
    <div className="review-note">
      <AlertTriangle size={13} />
      <div>
        <div>{note.issue}</div>
        {note.question && <div className="review-note__question">Ask: {note.question}</div>}
        {note.suggestion && (
          <div className="review-note__suggestion">
            “{note.suggestion}” <button className="link-btn" onClick={onUse}>Use this wording</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** How far a scenario's Gherkin resolves: the test can be created from it, or an agent records some steps. */
function ResolutionChip({ resolution }: { resolution?: ScenarioResolution | null }) {
  if (!resolution) return null;
  if (resolution.error) return <span className="resolution resolution--error" title={resolution.error}>Gherkin does not parse</span>;
  if (resolution.ready) return <span className="resolution resolution--ready">Ready to create</span>;
  return (
    <span className="resolution resolution--record" title={`No phrase covers:\n${resolution.unresolved.join('\n')}`}>
      {resolution.unresolved.length} step{resolution.unresolved.length === 1 ? '' : 's'} to record
    </span>
  );
}

/**
 * The test design: asked of the agent set in Settings, then its scenarios to choose from,
 * criterion by criterion. Its review shows on the criteria above.
 */
function DesignPanel({ requirement, unsaved }: { requirement: Requirement; unsaved: boolean }) {
  const design = requirement.design;
  const [designRequirement, { isLoading: designing }] = useDesignRequirementMutation();
  const [planDesign, { isLoading: planning }] = usePlanDesignMutation();
  const [dismissDesign] = useDismissDesignMutation();
  const [error, setError] = useState<string | null>(null);
  // The low-priority ones left out to start with.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(design?.scenarios.filter((s) => s.priority !== 'low').map((s) => s.id)));
  const scenarios = [...(design?.scenarios ?? [])].sort((a, b) => (a.criterion ?? Infinity) - (b.criterion ?? Infinity));
  const picked = scenarios.filter((s) => chosen.has(s.id));

  const propose = async () => {
    setError(null);
    try {
      await designRequirement(requirement.key).unwrap();
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const plan = async () => {
    setError(null);
    try {
      await planDesign({ ref: requirement.key, scenarios: picked.map((s) => s.id) }).unwrap();
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const toggle = (id: string) => setChosen((before) => {
    const next = new Set(before);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const issues = design?.review.length ?? 0;

  return (
    <Card
      className="design-panel" title="Test design" icon={Sparkles}
      actions={(
        <Button
          size="sm" variant="secondary" icon={designing ? Loader2 : Sparkles}
          disabled={designing || unsaved} title={unsaved ? 'Save the requirement first' : undefined} onClick={propose}
        >
          {designing ? 'Designing…' : design ? 'Propose again' : 'Propose scenarios'}
        </Button>
      )}
    >
      {!design && !designing && (
        <p className="explore-help">
          The agent set in Settings reviews each criterion — can a test tell pass from fail? — lists what the requirement leaves
          unsaid, and proposes scenarios with test design techniques, written in Gherkin with this project's phrases.
          You choose which to plan.
        </p>
      )}
      {designing && <p className="explore-help"><Loader2 size={12} className="spin" /> The agent is reading the requirement. It takes up to a few minutes.</p>}
      {error && <div className="repair-error">{error}</div>}
      {design && (
        <>
          <p className="explore-help">
            Proposed by {design.agent ?? 'the agent'}, {new Date(design.designed_at).toLocaleString()}.
            {issues > 0 && ` ${issues} criteri${issues === 1 ? 'on' : 'a'} to clarify: see the notes above.`}
          </p>
          {requirement.design_stale && (
            <div className="design-stale">The requirement changed since: these scenarios were designed for an earlier version. Propose again, or plan them as they are.</div>
          )}
          {scenarios.length === 0 && <p className="muted">No scenario left to plan.</p>}
          {scenarios.map((s, i) => (
            <div key={s.id}>
              {(i === 0 || scenarios[i - 1].criterion !== s.criterion) && (
                <div className="scenario-group">{s.criterion ? `Criterion ${s.criterion} — ${s.criterion_text}` : 'The whole requirement'}</div>
              )}
              <ScenarioItem scenario={s} checked={chosen.has(s.id)} onToggle={() => toggle(s.id)} />
            </div>
          ))}
          <div className="repair-actions requirement-save">
            {scenarios.length > 0 && (
              <Button size="sm" variant="save" icon={Plus} disabled={!picked.length || planning} onClick={plan}>
                Plan {picked.length} scenario{picked.length === 1 ? '' : 's'}
              </Button>
            )}
            <Button size="sm" variant="cancel" onClick={() => dismissDesign(requirement.key)}>Dismiss</Button>
          </div>
        </>
      )}
    </Card>
  );
}

function ScenarioItem({ scenario, checked, onToggle }: { scenario: DesignedScenario; checked: boolean; onToggle: () => void }) {
  const id = `scenario-${scenario.id}`;
  return (
    <div className={`scenario ${checked ? 'scenario--chosen' : ''}`}>
      <input id={id} type="checkbox" checked={checked} onChange={onToggle} />
      <div className="scenario__body">
        <div className="case-row">
          <span className={`case-kind case-kind--${scenario.kind}`}>{scenario.kind}</span>
          <label htmlFor={id} className="case-title">{scenario.title}</label>
          {scenario.technique && <span className="case-technique">{TECHNIQUE_LABELS[scenario.technique]}</span>}
          <span className={`case-priority case-priority--${scenario.priority}`}>{scenario.priority}</span>
          <ResolutionChip resolution={scenario.resolution} />
        </div>
        {scenario.rationale && <div className="scenario__why">{scenario.rationale}</div>}
        {scenario.gherkin && (
          <details className="scenario__gherkin">
            <summary>Gherkin</summary>
            <pre>{scenario.gherkin}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** A planned case's scenario, edited: checked against the project's phrases when saved. */
function CaseScenario({ requirement, item, onClose }: { requirement: Requirement; item: RequirementCase; onClose: () => void }) {
  // A first scenario in the language of the project's tests.
  const { data: projects = [] } = useGetProjectsQuery(undefined);
  const french = projects.find((p) => p.id === requirement.project_id)?.language === 'fr';
  const [text, setText] = useState(item.gherkin
    ?? (french ? `Scénario: ${item.title}\n  Soit je suis sur "https://"\n` : `Scenario: ${item.title}\n  Given I am on "https://"\n`));
  const [updateCase, { isLoading }] = useUpdateCaseMutation();
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await updateCase({ ref: requirement.key, caseId: item.id, gherkin: text }).unwrap();
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const unresolved = item.resolution && !item.resolution.ready ? item.resolution : null;
  return (
    <div className="case-scenario">
      <textarea className="gherkin-textarea" rows={Math.min(14, text.split('\n').length + 1)} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      {unresolved?.error && <div className="repair-error">{unresolved.error}</div>}
      {unresolved && !unresolved.error && (
        <div className="case-scenario__unresolved">
          No phrase of the project covers {unresolved.unresolved.length === 1 ? 'this step' : 'these steps'} — reword with a phrase, or let the agent record it:
          <ul>{unresolved.unresolved.map((u) => <li key={u}><code>{u}</code></li>)}</ul>
        </div>
      )}
      {error && <div className="repair-error">{error}</div>}
      <div className="repair-actions">
        <Button size="sm" variant="save" icon={Save} disabled={isLoading || text === item.gherkin} onClick={save}>Save scenario</Button>
        <Button size="sm" variant="cancel" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

/** The cases of one criterion (or of the whole requirement): their test, how it last ran; plan one, link a test. */
function CasesOf({ requirement, criterion, cases, onOpenTest, onCreate }: {
  requirement: Requirement; criterion: number | null; cases: RequirementCase[];
  onOpenTest: (name: string) => void; onCreate: (c: RequirementCase, mode: CreateMode) => void;
}) {
  const { data: tests = [] } = useGetTestsQuery(undefined);
  const [addCase, { isLoading }] = useAddCaseMutation();
  const [deleteCase] = useDeleteCaseMutation();
  const [title, setTitle] = useState('');
  const [testName, setTestName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('nominal');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const add = async (body: { test_name?: string; case_id?: number; title?: string }) => {
    setError(null);
    try {
      await addCase({ ref: requirement.key, criterion, kind, ...body }).unwrap();
      setTitle('');
      setTestName('');
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <div className="cases">
      {cases.map((c) => (
        <div key={c.id}>
          <div className="case-row">
            <span className={`case-kind case-kind--${c.kind}`}>{c.kind}</span>
            <span className="case-title" title={c.rationale ?? undefined}>{c.title}</span>
            {c.technique && <span className="case-technique">{TECHNIQUE_LABELS[c.technique]}</span>}
            {c.priority && <span className={`case-priority case-priority--${c.priority}`}>{c.priority}</span>}
            {c.test ? (
              <>
                <button className="test-link" onClick={() => onOpenTest(c.test!)}><FlaskConical size={12} /> {c.test}</button>
                <StatusPill status={c.last_run?.status ?? 'never'} />
              </>
            ) : (
              <>
                <ResolutionChip resolution={c.resolution} />
                <button className="link-btn" onClick={() => setEditing(editing === c.id ? null : c.id)}>{c.gherkin ? 'Scenario' : 'Write its scenario'}</button>
                <Button
                  size="sm" variant="action" icon={FileCode} disabled={!c.resolution?.ready} onClick={() => onCreate(c, 'gherkin')}
                  title={c.resolution?.ready ? 'Create the test from its scenario' : c.gherkin ? 'Some steps are in plain words: reword them with the project\'s phrases, or record it' : 'Write its scenario first'}
                >
                  Create
                </Button>
                <Button size="sm" variant="action" icon={Bot} title="The agent records it in the browser, following its scenario" onClick={() => onCreate(c, 'ai')}>Record</Button>
                <select className="case-link" value="" onChange={(e) => e.target.value && add({ test_name: e.target.value, case_id: c.id })}>
                  <option value="">…or link a test</option>
                  {tests.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </>
            )}
            <button className="icon-btn" title={c.test ? 'Unlink this test' : 'Remove this case'} onClick={() => deleteCase({ ref: requirement.key, caseId: c.id })}><X size={12} /></button>
          </div>
          {editing === c.id && !c.test && <CaseScenario key={c.gherkin ?? ''} requirement={requirement} item={c} onClose={() => setEditing(null)} />}
        </div>
      ))}
      <div className="case-add">
        <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input placeholder="Plan a case…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button size="sm" variant="secondary" icon={Plus} disabled={!title.trim() || isLoading} onClick={() => add({ title })}>Plan</Button>
        <select value={testName} onChange={(e) => setTestName(e.target.value)}>
          <option value="">…or link a test</option>
          {tests.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <Button size="sm" variant="secondary" icon={Link2} disabled={!testName || isLoading} onClick={() => add({ test_name: testName })}>Link</Button>
      </div>
      {error && <div className="repair-error">{error}</div>}
    </div>
  );
}
