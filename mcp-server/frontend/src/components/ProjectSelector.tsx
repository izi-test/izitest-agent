import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, ChevronsUpDown, LayoutGrid, Pencil, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useGetProjectsQuery, useCreateProjectMutation, useUpdateProjectMutation, useDeleteProjectMutation } from '../store/services/projectsApi';
import { useAssignToProjectMutation, useGetTestsQuery } from '../store/services/testsApi';
import { useGo, useSwitchProject } from '../navigation';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { Dialog, Drawer, ProjectAvatar } from './ui';
import { ProjectSecrets } from './ProjectSecrets';
import type { Project } from '../types';

// Projects: the switcher at the top of the sidebar — which one is in scope, all of them, a new
// one —, the drawer a project is created and edited in, the dialog that deletes one (saying what
// is left without a project), and the one that moves tests to another project.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? (err as Error)?.message ?? 'The request failed';

const SECTION_NAMES: Record<string, string> = {
  '/': 'the dashboard', '/tests': 'Tests', '/requirements': 'Requirements', '/campaigns': 'Campaigns', '/bugs': 'Bugs',
  '/projects': 'Projects', '/settings': 'Settings', '/chat': 'the chat',
};

export function ProjectSwitcher() {
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: projects = [] } = useGetProjectsQuery();
  const { data: allTests = [] } = useGetTestsQuery(undefined);
  const switchProject = useSwitchProject();
  const go = useGo();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const current = projects.find((p) => p.id === scope) ?? null;
  const matching = projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  // The choices, in the order the arrow keys go through them: all projects, then each one.
  const choices: Array<number | null> = [...(query.trim() ? [] : [null]), ...matching.map((p) => p.id)];
  const section = location.pathname.match(/^\/[a-z]*/)?.[0] ?? '/';

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (projectId: number | null) => {
    setOpen(false);
    setQuery('');
    if (projectId !== scope) switchProject(projectId);
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') setOpen(false);
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, choices.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter' && choices.length) { event.preventDefault(); choose(choices[Math.min(active, choices.length - 1)]); }
  };

  return (
    <div className="switcher" ref={ref} onKeyDown={onKey}>
      <button type="button" className={`switcher__trigger ${open ? 'open' : ''}`} onClick={() => { setOpen(!open); setActive(0); }} aria-haspopup="listbox" aria-expanded={open}>
        {current ? <ProjectAvatar project={current} size={30} /> : <span className="switcher__all-icon"><LayoutGrid size={16} /></span>}
        <span className="switcher__label">
          <span className="switcher__name">{current ? current.name : 'All projects'}</span>
          <span className="switcher__meta">{current ? `${current.test_count ?? 0} tests` : `${allTests.length} tests`}</span>
        </span>
        <ChevronsUpDown size={16} className="switcher__chevron" />
      </button>

      {open && (
        <div className="switcher__popover" role="listbox">
          <div className="switcher__search">
            <Search size={14} />
            <input autoFocus placeholder="Find a project…" value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
            <kbd>Esc</kbd>
          </div>
          <div className="switcher__options">
            {!query.trim() && (
              <button type="button" role="option" aria-selected={scope === null}
                className={`switcher__option ${scope === null ? 'selected' : ''} ${choices[active] === null ? 'active' : ''}`} onClick={() => choose(null)}>
                <span className="switcher__all-icon switcher__all-icon--sm"><LayoutGrid size={14} /></span>
                <span className="switcher__option-name">All projects</span>
                <span className="switcher__count">{allTests.length}</span>
                {scope === null && <Check size={14} className="switcher__check" />}
              </button>
            )}
            <div className="switcher__group">Projects</div>
            {matching.map((p) => (
              <button key={p.id} type="button" role="option" aria-selected={scope === p.id}
                className={`switcher__option ${scope === p.id ? 'selected' : ''} ${choices[active] === p.id ? 'active' : ''}`} onClick={() => choose(p.id)}>
                <ProjectAvatar project={p} size={22} />
                <span className="switcher__option-name">{p.name}</span>
                <span className="switcher__count">{p.test_count ?? 0}</span>
                {scope === p.id && <Check size={14} className="switcher__check" />}
              </button>
            ))}
            {matching.length === 0 && <div className="switcher__none">No project named so.</div>}
          </div>
          <div className="switcher__actions">
            <button type="button" className="switcher__action switcher__action--primary" onClick={() => { setOpen(false); setEditing('new'); }}><Plus size={14} /> New project…</button>
            {current && <button type="button" className="switcher__action" onClick={() => { setOpen(false); setEditing(current); }}><Pencil size={14} /> Edit {current.name}…</button>}
            <button type="button" className="switcher__action" onClick={() => { setOpen(false); go('/projects'); }}><Settings2 size={14} /> Manage projects</button>
          </div>
          <div className="switcher__hint">Switching keeps you on {SECTION_NAMES[section] ?? 'this page'}.</div>
        </div>
      )}

      {editing && (
        <ProjectDrawer
          project={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id, created) => { setEditing(null); if (created) switchProject(id); }}
        />
      )}
    </div>
  );
}

type ProjectFields = { name: string; description: string; context: string; project_type: string; base_url: string; language: 'en' | 'fr' };

// A new project's tests are written in the language of the browser, French or else English.
const browserLanguage = (): 'en' | 'fr' => (navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en');

/** A project, created or edited: its name, description, base URL, type, and the context given to the AI. */
export function ProjectDrawer({ project, onClose, onSaved, onDelete }: {
  project: Project | null; onClose: () => void; onSaved?: (id: number, created: boolean) => void; onDelete?: (project: Project) => void;
}) {
  const dispatch = useAppDispatch();
  const [createProject, { isLoading: creating }] = useCreateProjectMutation();
  const [updateProject, { isLoading: updating }] = useUpdateProjectMutation();
  const [fields, setFields] = useState<ProjectFields>({
    name: project?.name ?? '', description: project?.description ?? '', context: project?.context ?? '',
    project_type: project?.project_type ?? '', base_url: project?.base_url ?? '',
    language: project ? project.language ?? 'en' : browserLanguage(),
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ProjectFields>(field: K, value: ProjectFields[K]) => { setFields({ ...fields, [field]: value }); setError(null); };

  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!fields.name.trim()) return setError('A project needs a name');
    const body = { ...fields, name: fields.name.trim(), description: fields.description.trim(), context: fields.context.trim(), base_url: fields.base_url.trim() };
    try {
      if (project) {
        await updateProject({ id: project.id, ...body }).unwrap();
        dispatch(showToast({ message: 'Project saved' }));
        onSaved?.(project.id, false);
      } else {
        const created = await createProject(body).unwrap();
        dispatch(showToast({ message: `Project ${created.name} created` }));
        onSaved?.(created.id, true);
      }
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <Drawer
      title={project ? `Edit project — ${project.name}` : 'New project'} onClose={onClose}
      footer={(
        <>
          {project && onDelete && <Button variant="ghost" className="btn--danger-text" icon={Trash2} onClick={() => onDelete(project)}>Delete project…</Button>}
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save()} disabled={creating || updating}>{project ? 'Save' : 'Create project'}</Button>
        </>
      )}
    >
      <form className="form" onSubmit={save}>
        <label className="field">
          <span className="field__label">Name</span>
          <input autoFocus value={fields.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Shop" />
        </label>
        <label className="field">
          <span className="field__label">Description <span className="field__optional">optional</span></span>
          <input value={fields.description} onChange={(e) => set('description', e.target.value)} placeholder="What this app is" />
        </label>
        <div className="form__row">
          <label className="field form__grow">
            <span className="field__label">Base URL</span>
            <input value={fields.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder="https://staging.example.com" spellCheck={false} />
          </label>
          <label className="field" style={{ width: 150 }}>
            <span className="field__label">Type</span>
            <select value={fields.project_type} onChange={(e) => set('project_type', e.target.value)}>
              <option value="">—</option>
              <option value="frontend">Frontend</option>
              <option value="backend">Backend</option>
              <option value="fullstack">Fullstack</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field__label">Tests written in</span>
          <select value={fields.language} onChange={(e) => set('language', e.target.value as ProjectFields['language'])}>
            <option value="en">English — Given, When, Then</option>
            <option value="fr">Français — Soit, Quand, Alors</option>
          </select>
          <span className="field__hint">
            The Gherkin of its tests, its business steps and what the AI writes for it. Changed, its tests read in the new language; the phrases they were written with still work.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Context for the AI</span>
          <textarea rows={9} value={fields.context} onChange={(e) => set('context', e.target.value)}
            placeholder="The app's pages, features, user flows, API endpoints: anything the AI should know to write tests." />
          <span className="field__hint">Sent to the AI agent as context when it creates tests for this project.</span>
        </label>
        {error && <div className="alert alert--error">{error}</div>}
        <button type="submit" hidden />
      </form>
      {/* Its secrets, saved one by one: a new project has them once created. */}
      {project && <ProjectSecrets projectId={project.id} />}
    </Drawer>
  );
}

/** Deleting a project: what stays, without a project, and what goes with it. */
export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted?: () => void }) {
  const dispatch = useAppDispatch();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const switchProject = useSwitchProject();
  const [deleteProject, { isLoading }] = useDeleteProjectMutation();
  const [typed, setTyped] = useState('');

  const confirm = async () => {
    try {
      await deleteProject(project.id).unwrap();
      dispatch(showToast({ message: `Project ${project.name} deleted` }));
      if (scope === project.id) switchProject(null);
      onDeleted?.();
      onClose();
    } catch (err) {
      dispatch(showToast({ message: errorOf(err), type: 'error' }));
    }
  };
  const counts: Array<[number | undefined, string]> = [
    [project.test_count, 'test'], [project.requirement_count, 'requirement'], [project.campaign_count, 'campaign'], [project.open_bug_count, 'open bug'],
  ];

  return (
    <ConfirmModal
      isOpen title={`Delete the project “${project.name}”?`} confirmLabel="Delete project"
      confirmDisabled={isLoading || typed.trim() !== project.name}
      message={<p>Nothing else is deleted. These stay, without a project:</p>}
      onConfirm={confirm} onCancel={onClose}
    >
      <ul className="impact-list">
        {counts.map(([n, what]) => <li key={what}><strong>{n ?? 0}</strong> {what}{n === 1 ? '' : 's'}</li>)}
      </ul>
      <p className="muted">Its step definitions, its AI context and its chat conversations are deleted with it.</p>
      <label className="field">
        <span className="field__label">Type <strong>{project.name}</strong> to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
    </ConfirmModal>
  );
}

/** Moving tests to a project, or out of any. */
export function MoveToProjectDialog({ tests, currentProjectId, onClose, onMoved }: {
  tests: string[]; currentProjectId?: number | null; onClose: () => void; onMoved?: (projectId: number | null) => void;
}) {
  const dispatch = useAppDispatch();
  const { data: projects = [] } = useGetProjectsQuery();
  const [assign, { isLoading }] = useAssignToProjectMutation();
  const [target, setTarget] = useState<string>(currentProjectId != null ? String(currentProjectId) : '');
  const label = useMemo(() => (tests.length === 1 ? tests[0] : `${tests.length} tests`), [tests]);

  const move = async () => {
    const projectId = target === 'none' ? null : Number(target);
    try {
      for (const testName of tests) await assign({ testName, projectId }).unwrap();
      const name = projectId == null ? 'no project' : projects.find((p) => p.id === projectId)?.name;
      dispatch(showToast({ message: `${label} moved to ${name}` }));
      onMoved?.(projectId);
      onClose();
    } catch (err) {
      dispatch(showToast({ message: errorOf(err), type: 'error' }));
    }
  };

  return (
    <Dialog
      title={`Move ${label}`} onClose={onClose} width={440}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={move} disabled={!target || isLoading}>Move</Button></>}
    >
      <label className="field">
        <span className="field__label">To the project</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} autoFocus>
          <option value="" disabled>Choose a project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.test_count ?? 0} tests</option>)}
          <option value="none">No project</option>
        </select>
      </label>
    </Dialog>
  );
}

/**
 * Which project something goes into: the one in scope to start with; with all projects in scope,
 * chosen — "No project" too, but on purpose.
 */
export function ProjectField({ value, onChange, label = 'Project', required = true, hint, allowNone = true }: {
  value: number | null | undefined; onChange: (projectId: number | null) => void; label?: string; required?: boolean; hint?: string; allowNone?: boolean;
}) {
  const { data: projects = [] } = useGetProjectsQuery();
  const selected = value === undefined ? '' : value === null ? 'none' : String(value);
  return (
    <label className="field">
      <span className="field__label">{label}{required && <span className="field__required">*</span>}</span>
      <select value={selected} onChange={(e) => onChange(e.target.value === 'none' ? null : Number(e.target.value))} className={selected === '' ? 'select--placeholder' : ''}>
        <option value="" disabled>Choose a project…</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.test_count ?? 0} tests</option>)}
        {allowNone && <option value="none">No project</option>}
      </select>
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}
