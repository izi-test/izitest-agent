import { useState } from 'react';
import {
  ClipboardList, Plus, Trash2, Save, ArrowLeft, FlaskConical, Link2, X, ExternalLink, Sparkles, AlertTriangle, FileCode, Bot, Loader2, Play,
} from 'lucide-react';
import {
  useGetRequirementsQuery, useGetRequirementQuery, useCreateRequirementMutation, useUpdateRequirementMutation,
  useDeleteRequirementMutation, useAddCaseMutation, useDeleteCaseMutation, useUpdateCaseMutation,
  useDesignRequirementMutation, usePlanDesignMutation, useDismissDesignMutation,
} from '../store/services/requirementsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { useStartCampaignMutation } from '../store/services/campaignsApi';
import { useAppSelector } from '../store/hooks';
import { Button } from './Button';
import { CreateTestModal, type CreateMode, type CreateTestPreset } from './CreateTestModal';
import type { Requirement, RequirementCase, RequirementDesign, DesignedScenario, ScenarioResolution, Technique } from '../types';

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
const SOURCE_LABELS: Record<Requirement['source'], string> = { prompt: 'From a request', manual: 'Written', jira: 'Jira', import: 'Imported' };
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
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

function CoverageBadge({ coverage }: { coverage: Requirement['coverage'] }) {
  return (
    <span className={`coverage-badge coverage-${coverage.status}`}>
      {COVERAGE_LABELS[coverage.status]}
      {coverage.criteria > 0 && ` · ${coverage.covered}/${coverage.criteria} criteria`}
    </span>
  );
}

// ─── The list ────────────────────────────────────────────────────────

export function RequirementsPage({ onOpen }: { onOpen: (key: string) => void }) {
  const projectId = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: requirements = [], isLoading } = useGetRequirementsQuery(projectId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="dashboard requirements-page">
      <div className="dash-panel">
        <div className="dash-panel__title">
          <ClipboardList size={16} /> Requirements
          <Button size="sm" variant="action" icon={Plus} className="requirements-new" onClick={() => setCreating(!creating)}>New requirement</Button>
        </div>
        <p className="explore-help">
          What the tests are for: each requirement, its acceptance criteria, and the tests that check them. A request made in
          “Create Test with AI” is kept here too; an agent saves them with save_requirement.
        </p>
        {creating && <RequirementForm projectId={projectId} onSaved={(key) => { setCreating(false); onOpen(key); }} onCancel={() => setCreating(false)} />}
        {isLoading && <p className="dash-panel__empty">Loading…</p>}
        {!isLoading && requirements.length === 0 && !creating && <p className="dash-panel__empty">No requirement yet.</p>}
        <div className="bug-list">
          {requirements.map((r) => (
            <button key={r.id} className="requirement-row" onClick={() => onOpen(r.key)}>
              <span className="requirement-key">{r.key}</span>
              <span className="requirement-title">{r.title}</span>
              <span className="exec-trigger">{SOURCE_LABELS[r.source]}</span>
              <span className="dash-table__muted">{r.coverage.tests} test{r.coverage.tests === 1 ? '' : 's'}</span>
              <CoverageBadge coverage={r.coverage} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RequirementForm({ projectId, onSaved, onCancel }: { projectId: number | null; onSaved: (key: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [create, { isLoading }] = useCreateRequirementMutation();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
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
    <form className="requirement-form" onSubmit={submit}>
      <input required placeholder="Title — e.g. A wrong password is refused" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea rows={2} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <textarea rows={4} placeholder={'Acceptance criteria, one per line:\nA wrong password shows "Invalid credentials"\nThe user stays on the login page'} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      <div className="requirement-form__row">
        <input placeholder="Key (optional, e.g. SHOP-123)" value={key} onChange={(e) => setKey(e.target.value)} />
        <input placeholder="Link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      {error && <div className="repair-error">{error}</div>}
      <div className="repair-actions">
        <Button type="submit" size="sm" variant="save" icon={Save} disabled={isLoading || !title.trim()}>Save</Button>
        <Button type="button" size="sm" variant="cancel" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ─── One requirement ─────────────────────────────────────────────────

type RequirementPageProps = { onBack: () => void; onOpenTest: (name: string) => void; onOpenCampaign: (id: number) => void };

export function RequirementPage({ requirementKey, ...props }: { requirementKey: string } & RequirementPageProps) {
  const { data: requirement, isLoading } = useGetRequirementQuery(requirementKey);
  if (isLoading) return <p className="empty-state">Loading…</p>;
  if (!requirement) return <p className="empty-state">No requirement {requirementKey}.</p>;
  // Keyed by its last update: a save elsewhere (an agent) shows here as it is now.
  return <RequirementEditor key={requirement.updated_at} requirement={requirement} {...props} />;
}

function RequirementEditor({ requirement, onBack, onOpenTest, onOpenCampaign }: { requirement: Requirement } & RequirementPageProps) {
  const [title, setTitle] = useState(requirement.title);
  const [description, setDescription] = useState(requirement.description);
  const [priority, setPriority] = useState(requirement.priority);
  const [criteria, setCriteria] = useState(requirement.criteria.map((c) => ({ id: c.id as number | undefined, text: c.text })));
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<CreateTestPreset | null>(null);
  const [update, { isLoading: saving }] = useUpdateRequirementMutation();
  const [remove] = useDeleteRequirementMutation();
  const [startCampaign, { isLoading: launching }] = useStartCampaignMutation();
  const design = requirement.design;
  const missing = (design?.missing ?? []).filter((m) => !criteria.some((c) => sameText(c.text, m)));
  const dirty = title !== requirement.title || description !== requirement.description || priority !== requirement.priority
    || JSON.stringify(criteria) !== JSON.stringify(requirement.criteria.map((c) => ({ id: c.id, text: c.text })));

  const save = async () => {
    setError(null);
    try {
      await update({ ref: requirement.key, title, description, priority, criteria: criteria.filter((c) => c.text.trim()) }).unwrap();
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const destroy = async () => {
    if (!window.confirm(`Delete ${requirement.key}? Its tests stay; only the requirement and its links go.`)) return;
    await remove(requirement.key).unwrap();
    onBack();
  };
  // Its tests replayed together, as a campaign: where it stands now, criterion by criterion.
  const runTests = async () => {
    setError(null);
    try {
      const { campaign } = await startCampaign({ requirement: requirement.key }).unwrap();
      onOpenCampaign(campaign.id);
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

  return (
    <div className="dashboard requirements-page">
      <div className="dash-panel">
        <div className="dash-panel__title">
          <button className="btn-back" onClick={onBack}><ArrowLeft size={14} /></button>
          <span className="requirement-key">{requirement.key}</span>
          <span className="exec-trigger">{SOURCE_LABELS[requirement.source]}</span>
          <CoverageBadge coverage={requirement.coverage} />
          {requirement.external_url && (
            <a className="requirement-link" href={requirement.external_url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> source</a>
          )}
          <Button
            size="sm" variant="action" icon={launching ? Loader2 : Play} className="requirements-new"
            disabled={launching || requirement.coverage.tests === 0} title={requirement.coverage.tests ? 'Replay its tests together, as a campaign' : 'No test linked yet'}
            onClick={runTests}
          >
            Run its tests
          </Button>
        </div>
        <div className="requirement-form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={2} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <label className="requirement-priority">
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as Requirement['priority'])}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel__title">Acceptance criteria</div>
        {criteria.map((criterion, i) => {
          const saved = requirement.criteria.find((c) => c.id === criterion.id);
          // What the review said of it, until it is reworded.
          const note = saved && criterion.text === saved.text ? design?.review.find((r) => sameText(r.criterion_text, saved.text)) : undefined;
          return (
            <div key={criterion.id ?? `new-${i}`} className="criterion">
              <div className="criterion__head">
                <span className="criterion__number">{i + 1}.</span>
                <input value={criterion.text} onChange={(e) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, text: e.target.value } : c)))} />
                <button className="icon-btn" title="Remove this criterion" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}><X size={14} /></button>
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
          <div className="missing">
            <div className="missing__title">The requirement does not say</div>
            {missing.map((m) => (
              <div key={m} className="missing__item">
                <span>{m}</span>
                <button className="link-btn" onClick={() => setCriteria([...criteria, { id: undefined, text: m }])}>Add as a criterion</button>
              </div>
            ))}
          </div>
        )}
        <Button size="sm" variant="action" icon={Plus} onClick={() => setCriteria([...criteria, { id: undefined, text: '' }])}>Add a criterion</Button>
        {error && <div className="repair-error">{error}</div>}
        <div className="repair-actions requirement-save">
          <Button size="sm" variant="save" icon={Save} disabled={!dirty || saving} onClick={save}>Save</Button>
          <Button size="sm" variant="danger" icon={Trash2} onClick={destroy}>Delete</Button>
        </div>
      </div>

      <DesignPanel key={design?.designed_at ?? 'none'} requirement={requirement} unsaved={dirty} />

      <div className="dash-panel">
        <div className="dash-panel__title">The whole requirement</div>
        <CasesOf requirement={requirement} criterion={null} cases={requirement.cases.filter((c) => c.criterion_id == null)} onOpenTest={onOpenTest} onCreate={createFor} />
      </div>

      <CreateTestModal
        isOpen={!!preset}
        preset={preset}
        onClose={() => setPreset(null)}
        onTestCreated={(name) => { setPreset(null); onOpenTest(name); }}
      />
    </div>
  );
}

/** What the review says of a criterion: why a test cannot judge it, what to ask, a rewording to use. */
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
    <div className="dash-panel design-panel">
      <div className="dash-panel__title">
        <Sparkles size={15} /> Test design
        <Button
          size="sm" variant="action" icon={designing ? Loader2 : Sparkles} className="requirements-new"
          disabled={designing || unsaved} title={unsaved ? 'Save the requirement first' : undefined} onClick={propose}
        >
          {designing ? 'Designing…' : design ? 'Propose again' : 'Propose scenarios'}
        </Button>
      </div>
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
          {scenarios.length === 0 && <p className="dash-panel__empty">No scenario left to plan.</p>}
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
    </div>
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
  const [text, setText] = useState(item.gherkin ?? `Scenario: ${item.title}\n  Given I am on "https://"\n`);
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
                <button className="bug-test" onClick={() => onOpenTest(c.test!)}><FlaskConical size={12} /> {c.test}</button>
                <span className={`case-run case-run--${c.last_run?.status ?? 'never'}`}>{c.last_run ? c.last_run.status : 'never run'}</span>
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
        <Button size="sm" variant="action" icon={Plus} disabled={!title.trim() || isLoading} onClick={() => add({ title })}>Plan</Button>
        <select value={testName} onChange={(e) => setTestName(e.target.value)}>
          <option value="">…or link a test</option>
          {tests.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <Button size="sm" variant="action" icon={Link2} disabled={!testName || isLoading} onClick={() => add({ test_name: testName })}>Link</Button>
      </div>
      {error && <div className="repair-error">{error}</div>}
    </div>
  );
}
