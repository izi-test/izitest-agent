import { useMemo, useState } from 'react';
import { ChevronRight, FlaskConical, FolderInput, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { setCreateTestOpen, showToast } from '../store/slices/uiSlice';
import { useGetTestsQuery, useDeleteTestMutation } from '../store/services/testsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useGetRequirementsQuery } from '../store/services/requirementsApi';
import { useStartCampaignMutation } from '../store/services/campaignsApi';
import { useGo, useUrlState } from '../navigation';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { MoveToProjectDialog } from './ProjectSelector';
import { Card, EmptyState, KeyChip, Menu, PageHeader, ProjectChip, Segmented, StatusPill } from './ui';
import { relativeTime, shortDate } from '../format';
import type { Test } from '../types';

// The tests of the project in scope (or of all of them): how each last ran, the requirements it
// checks; searched, filtered and sorted — in the URL, so that they are there again on the way
// back —, and chosen together to run as a campaign, move to a project, or delete.

type Status = 'all' | 'passed' | 'failed' | 'running' | 'never';
type Sort = 'updated' | 'last_run' | 'name' | 'steps';

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? (err as Error)?.message ?? 'The request failed';

/** How a test last ran, as the filter knows it. */
function statusOf(test: Test): Exclude<Status, 'all'> {
  if (!test.last_status) return 'never';
  if (test.last_status === 'success') return 'passed';
  if (test.last_status === 'failed') return 'failed';
  return 'running';
}

export function TestList() {
  const dispatch = useAppDispatch();
  const go = useGo();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: tests = [], isLoading } = useGetTestsQuery(scope ?? undefined);
  const { data: projects = [] } = useGetProjectsQuery();
  const { data: requirements = [] } = useGetRequirementsQuery(scope);
  const [deleteTest] = useDeleteTestMutation();
  const [startCampaign, { isLoading: starting }] = useStartCampaignMutation();

  const [search, setSearch] = useUrlState('q');
  const [status, setStatus] = useUrlState('status', 'all') as [Status, (v: string) => void];
  const [requirement, setRequirement] = useUrlState('req');
  const [sort, setSort] = useUrlState('sort', 'updated') as [Sort, (v: string) => void];
  const [inProject, setInProject] = useUrlState('in');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);

  const project = projects.find((p) => p.id === scope);
  const projectOf = (id: number | null | undefined) => projects.find((p) => p.id === id) ?? null;

  const counts = useMemo(() => {
    const byStatus: Record<Status, number> = { all: tests.length, passed: 0, failed: 0, running: 0, never: 0 };
    for (const t of tests) byStatus[statusOf(t)] += 1;
    return byStatus;
  }, [tests]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = tests.filter((t) =>
      (!q || t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q))
      && (status === 'all' || statusOf(t) === status)
      && (!requirement || t.requirement_keys?.includes(requirement))
      && (!inProject || (inProject === 'none' ? t.project_id == null : String(t.project_id) === inProject)));
    const byDate = (a?: string | null, b?: string | null) => (b ?? '').localeCompare(a ?? '');
    return [...list].sort((a, b) => (
      sort === 'name' ? a.name.localeCompare(b.name)
        : sort === 'steps' ? (b.step_count ?? 0) - (a.step_count ?? 0)
          : sort === 'last_run' ? byDate(a.last_run_at, b.last_run_at)
            : byDate(a.updated_at, b.updated_at)));
  }, [tests, search, status, requirement, inProject, sort]);

  const chosen = shown.filter((t) => selected.has(t.name)).map((t) => t.name);
  const allChosen = shown.length > 0 && chosen.length === shown.length;
  const toggle = (name: string) => setSelected((before) => {
    const next = new Set(before);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const runAsCampaign = async (names: string[]) => {
    try {
      const { campaign } = await startCampaign({ tests: names }).unwrap();
      setSelected(new Set());
      go(`/campaigns/${campaign.id}`, { from: 'Tests' });
    } catch (err) {
      dispatch(showToast({ message: errorOf(err), type: 'error' }));
    }
  };
  const remove = async (names: string[]) => {
    try {
      for (const name of names) await deleteTest(name).unwrap();
      dispatch(showToast({ message: names.length === 1 ? `Test ${names[0]} deleted` : `${names.length} tests deleted` }));
      setSelected((before) => new Set([...before].filter((n) => !names.includes(n))));
    } catch (err) {
      dispatch(showToast({ message: errorOf(err), type: 'error' }));
    }
    setDeleting(null);
  };
  const open = (name: string) => go(`/tests/${encodeURIComponent(name)}`, { from: 'Tests' });

  const filtered = search || status !== 'all' || requirement || inProject;

  return (
    <>
      <PageHeader
        title="Tests"
        subtitle={project ? `${tests.length} test${tests.length === 1 ? '' : 's'} in ${project.name}` : `${tests.length} tests across all projects`}
      />

      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tests by name or description…" aria-label="Search tests" />
        </div>
        <Segmented<Status>
          label="Last run" value={status} onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'passed', label: 'Passed', count: counts.passed, tone: 'green' },
            { value: 'failed', label: 'Failed', count: counts.failed, tone: 'red' },
            ...(counts.running ? [{ value: 'running' as const, label: 'Running', count: counts.running, tone: 'blue' as const }] : []),
            { value: 'never', label: 'Never run', count: counts.never, tone: 'slate' },
          ]}
        />
        <select value={requirement} onChange={(e) => setRequirement(e.target.value)} aria-label="Requirement">
          <option value="">Requirement: any</option>
          {requirements.map((r) => <option key={r.key} value={r.key}>{r.key} — {r.title.slice(0, 50)}</option>)}
        </select>
        {scope === null && (
          <select value={inProject} onChange={(e) => setInProject(e.target.value)} aria-label="Project">
            <option value="">Project: any</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="none">No project</option>
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="updated">Sort: last updated</option>
          <option value="last_run">Sort: last run</option>
          <option value="name">Sort: name</option>
          <option value="steps">Sort: most steps</option>
        </select>
      </div>

      <Card flush>
        {chosen.length > 0 && (
          <div className="bulk-bar">
            <span className="bulk-bar__count">{chosen.length} selected</span>
            <span className="spacer" />
            <Button size="sm" icon={Play} disabled={starting} onClick={() => runAsCampaign(chosen)}>Run as campaign</Button>
            <Button size="sm" variant="secondary" icon={FolderInput} onClick={() => setMoving(chosen)}>Move to project…</Button>
            <Button size="sm" variant="ghost" className="btn--danger-text" icon={Trash2} onClick={() => setDeleting(chosen)}>Delete</Button>
            <Button size="sm" variant="ghost" icon={X} onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        {isLoading ? (
          <p className="empty-state">Loading…</p>
        ) : shown.length === 0 ? (
          filtered
            ? <EmptyState icon={Search} title="No test matches" action={<Button variant="secondary" onClick={() => { setSearch(''); setStatus('all'); setRequirement(''); setInProject(''); }}>Clear the filters</Button>}>Try another search, or other filters.</EmptyState>
            : <EmptyState icon={FlaskConical} title={project ? `No test in ${project.name} yet` : 'No test yet'} action={<Button icon={Plus} onClick={() => dispatch(setCreateTestOpen(true))}>New test</Button>}>Describe one for the AI agent to record, or write it in Gherkin.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" aria-label="Select all" checked={allChosen} onChange={() => setSelected(allChosen ? new Set() : new Set(shown.map((t) => t.name)))} />
                  </th>
                  <th>Test</th>
                  {scope === null && <th>Project</th>}
                  <th>Last run</th>
                  <th className="col-num">Steps</th>
                  <th>Requirements</th>
                  <th>Updated</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const isChosen = selected.has(t.name);
                  return (
                    <tr key={t.name} className={`clickable ${isChosen ? 'selected' : ''}`} onClick={() => open(t.name)}>
                      <td className="col-check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${t.name}`} checked={isChosen} onChange={() => toggle(t.name)} />
                      </td>
                      <td>
                        <div className="test-name-cell">
                          <span className="cell-title mono">{t.name}</span>
                          <span className="cell-sub">{t.description || 'No description'}</span>
                        </div>
                      </td>
                      {scope === null && <td><ProjectChip project={projectOf(t.project_id)} /></td>}
                      <td>
                        <div className="last-run">
                          <StatusPill status={statusOf(t)} />
                          {t.last_run_at && <span className="cell-muted">{relativeTime(t.last_run_at)}</span>}
                        </div>
                      </td>
                      <td className="col-num">{t.step_count ?? 0}</td>
                      <td>
                        <div className="cell-chips">
                          {t.requirement_keys?.length
                            ? t.requirement_keys.map((key) => <KeyChip key={key} onClick={() => go(`/requirements/${encodeURIComponent(key)}`, { from: 'Tests' })}>{key}</KeyChip>)
                            : <span className="cell-muted">—</span>}
                        </div>
                      </td>
                      <td className="cell-muted">{shortDate(t.updated_at)}</td>
                      <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                        <Menu items={[
                          { label: 'Open', icon: ChevronRight, onClick: () => open(t.name) },
                          { label: 'Run as campaign', icon: Play, onClick: () => runAsCampaign([t.name]) },
                          { label: 'Move to project…', icon: FolderInput, onClick: () => setMoving([t.name]) },
                          'divider',
                          { label: 'Delete…', icon: Trash2, danger: true, onClick: () => setDeleting([t.name]) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && (
          <div className="table-footer">
            <span>Showing {shown.length} of {tests.length}</span>
            {chosen.length === 0 && <span>Select tests to run them together as a campaign.</span>}
          </div>
        )}
      </Card>

      {moving && <MoveToProjectDialog tests={moving} currentProjectId={moving.length === 1 ? tests.find((t) => t.name === moving[0])?.project_id ?? null : undefined} onClose={() => setMoving(null)} onMoved={() => setSelected(new Set())} />}
      <ConfirmModal
        isOpen={!!deleting}
        title={deleting?.length === 1 ? `Delete the test “${deleting[0]}”?` : `Delete ${deleting?.length} tests?`}
        message={<p>{deleting?.length === 1 ? 'Its steps and its run history are deleted with it.' : 'Their steps and run histories are deleted with them.'} The requirements they check stay, without this test.</p>}
        confirmLabel={deleting?.length === 1 ? 'Delete test' : `Delete ${deleting?.length} tests`}
        onConfirm={() => deleting && remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
