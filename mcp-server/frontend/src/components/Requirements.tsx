import { useState } from 'react';
import { ClipboardList, Plus, Trash2, Save, ArrowLeft, FlaskConical, Link2, X, ExternalLink } from 'lucide-react';
import {
  useGetRequirementsQuery, useGetRequirementQuery, useCreateRequirementMutation, useUpdateRequirementMutation,
  useDeleteRequirementMutation, useAddCaseMutation, useDeleteCaseMutation,
} from '../store/services/requirementsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { useAppSelector } from '../store/hooks';
import { Button } from './Button';
import type { Requirement, RequirementCase } from '../types';

// Requirements: what tests are for (mcp-server/lib/requirements.js). A tester writes one here
// — its acceptance criteria, the cases that check each — and links the tests that check them;
// coverage says, criterion by criterion, what is tested and how it went on the last run.

const COVERAGE_LABELS: Record<Requirement['coverage']['status'], string> = {
  passing: 'Passing',
  failing: 'Failing',
  not_run: 'Not run yet',
  not_covered: 'Not covered',
};
const SOURCE_LABELS: Record<Requirement['source'], string> = { prompt: 'From a request', manual: 'Written', jira: 'Jira', import: 'Imported' };
const KINDS = ['nominal', 'alternative', 'error', 'boundary'] as const;

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

export function RequirementPage({ requirementKey, onBack, onOpenTest }: { requirementKey: string; onBack: () => void; onOpenTest: (name: string) => void }) {
  const { data: requirement, isLoading } = useGetRequirementQuery(requirementKey);
  if (isLoading) return <p className="empty-state">Loading…</p>;
  if (!requirement) return <p className="empty-state">No requirement {requirementKey}.</p>;
  // Keyed by its last update: a save elsewhere (an agent) shows here as it is now.
  return <RequirementEditor key={requirement.updated_at} requirement={requirement} onBack={onBack} onOpenTest={onOpenTest} />;
}

function RequirementEditor({ requirement, onBack, onOpenTest }: { requirement: Requirement; onBack: () => void; onOpenTest: (name: string) => void }) {
  const [title, setTitle] = useState(requirement.title);
  const [description, setDescription] = useState(requirement.description);
  const [priority, setPriority] = useState(requirement.priority);
  const [criteria, setCriteria] = useState(requirement.criteria.map((c) => ({ id: c.id as number | undefined, text: c.text })));
  const [error, setError] = useState<string | null>(null);
  const [update, { isLoading: saving }] = useUpdateRequirementMutation();
  const [remove] = useDeleteRequirementMutation();
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
          return (
            <div key={criterion.id ?? `new-${i}`} className="criterion">
              <div className="criterion__head">
                <span className="criterion__number">{i + 1}.</span>
                <input value={criterion.text} onChange={(e) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, text: e.target.value } : c)))} />
                <button className="icon-btn" title="Remove this criterion" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}><X size={14} /></button>
              </div>
              {saved && (
                <CasesOf requirement={requirement} criterion={saved.position} cases={requirement.cases.filter((c) => c.criterion_id === saved.id)} onOpenTest={onOpenTest} />
              )}
            </div>
          );
        })}
        <Button size="sm" variant="action" icon={Plus} onClick={() => setCriteria([...criteria, { id: undefined, text: '' }])}>Add a criterion</Button>
        {error && <div className="repair-error">{error}</div>}
        <div className="repair-actions requirement-save">
          <Button size="sm" variant="save" icon={Save} disabled={!dirty || saving} onClick={save}>Save</Button>
          <Button size="sm" variant="danger" icon={Trash2} onClick={destroy}>Delete</Button>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel__title">The whole requirement</div>
        <CasesOf requirement={requirement} criterion={null} cases={requirement.cases.filter((c) => c.criterion_id == null)} onOpenTest={onOpenTest} />
      </div>
    </div>
  );
}

/** The cases of one criterion (or of the whole requirement): their test, how it last ran; plan one, link a test. */
function CasesOf({ requirement, criterion, cases, onOpenTest }: { requirement: Requirement; criterion: number | null; cases: RequirementCase[]; onOpenTest: (name: string) => void }) {
  const { data: tests = [] } = useGetTestsQuery(undefined);
  const [addCase, { isLoading }] = useAddCaseMutation();
  const [deleteCase] = useDeleteCaseMutation();
  const [title, setTitle] = useState('');
  const [testName, setTestName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('nominal');
  const [error, setError] = useState<string | null>(null);

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
        <div key={c.id} className="case-row">
          <span className={`case-kind case-kind--${c.kind}`}>{c.kind}</span>
          <span className="case-title">{c.title}</span>
          {c.test ? (
            <>
              <button className="bug-test" onClick={() => onOpenTest(c.test!)}><FlaskConical size={12} /> {c.test}</button>
              <span className={`case-run case-run--${c.last_run?.status ?? 'never'}`}>{c.last_run ? c.last_run.status : 'never run'}</span>
            </>
          ) : (
            <select className="case-link" value="" onChange={(e) => e.target.value && add({ test_name: e.target.value, case_id: c.id })}>
              <option value="">Planned — link a test…</option>
              {tests.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          )}
          <button className="icon-btn" title={c.test ? 'Unlink this test' : 'Remove this case'} onClick={() => deleteCase({ ref: requirement.key, caseId: c.id })}><X size={12} /></button>
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
