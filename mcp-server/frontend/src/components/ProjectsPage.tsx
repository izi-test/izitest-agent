import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FolderKanban, Globe, Pencil, Plus, Trash2 } from 'lucide-react';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { withScope } from '../scope';
import { Button } from './Button';
import { DeleteProjectDialog, ProjectDrawer } from './ProjectSelector';
import { Card, EmptyState, Menu, PageHeader, ProjectAvatar, ResultBar, StatusPill } from './ui';
import { relativeTime } from '../format';
import type { Project } from '../types';

// The projects: each with its base URL, its type, what belongs to it — tests, requirements,
// campaigns —, its last campaign and the context the AI is given; created, edited and deleted
// here, and opened (brought into scope).

const TYPE_LABELS: Record<string, string> = { frontend: 'Frontend', backend: 'Backend', fullstack: 'Fullstack' };

export function ProjectsPage() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useGetProjectsQuery();
  const { data: tests = [] } = useGetTestsQuery(undefined);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const loose = tests.filter((t) => t.project_id == null).length;

  // Into a project: its dashboard, or one of its lists.
  const open = (project: Project, path = '/') => navigate(withScope(path, project.id));

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Each project groups the tests, requirements and campaigns of one app, with its base URL and the context given to the AI."
        actions={<Button icon={Plus} onClick={() => setEditing('new')}>New project</Button>}
      />

      {loose > 0 && (
        <div className="info-strip">
          <FolderKanban size={16} />
          <span>{loose} test{loose === 1 ? ' belongs' : 's belong'} to no project.</span>
          <a href="#" onClick={(e) => { e.preventDefault(); navigate(withScope('/tests?in=none', null)); }}>Show {loose === 1 ? 'it' : 'them'} →</a>
        </div>
      )}

      {isLoading ? <Card><p className="empty-state">Loading…</p></Card> : projects.length === 0 ? (
        <Card>
          <EmptyState icon={FolderKanban} title="No project yet" action={<Button icon={Plus} onClick={() => setEditing('new')}>New project</Button>}>
            A project is one app: its base URL, its tests, its requirements, and what the AI should know about it.
          </EmptyState>
        </Card>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <Card key={p.id} className="project-card">
              <div className="project-card__head">
                <ProjectAvatar project={p} size={36} />
                <span className="project-card__name" title={p.name}>{p.name}</span>
                {p.project_type && <span className="tag">{TYPE_LABELS[p.project_type] ?? p.project_type}</span>}
                <Menu items={[
                  { label: 'Open', icon: ArrowRight, onClick: () => open(p) },
                  { label: 'Edit…', icon: Pencil, onClick: () => setEditing(p) },
                  'divider',
                  { label: 'Delete…', icon: Trash2, danger: true, onClick: () => setDeleting(p) },
                ]} />
              </div>
              <div className="project-card__desc">{p.description || <span className="muted">No description</span>}</div>
              <div className="project-card__url">
                <Globe size={13} className="muted" />
                {p.base_url
                  ? <a href={p.base_url} target="_blank" rel="noreferrer" title={p.base_url}>{p.base_url}</a>
                  : <button className="link-btn" onClick={() => setEditing(p)}>Add a base URL</button>}
              </div>
              <div className="project-card__counts">
                <button type="button" className="count-tile" onClick={() => open(p, '/tests')}><strong>{p.test_count ?? 0}</strong><span>test{p.test_count === 1 ? '' : 's'}</span></button>
                <button type="button" className="count-tile" onClick={() => open(p, '/requirements')}><strong>{p.requirement_count ?? 0}</strong><span>requirement{p.requirement_count === 1 ? '' : 's'}</span></button>
                <button type="button" className="count-tile" onClick={() => open(p, '/campaigns')}><strong>{p.campaign_count ?? 0}</strong><span>campaign{p.campaign_count === 1 ? '' : 's'}</span></button>
              </div>
              <div className="project-card__last">
                {p.last_campaign ? (
                  <>
                    Last campaign
                    <a href="#" onClick={(e) => { e.preventDefault(); open(p, `/campaigns/${p.last_campaign!.id}`); }}>#{p.last_campaign.id}{p.last_campaign.version && ` v${p.last_campaign.version}`}</a>
                    <StatusPill status={p.last_campaign.running ? 'running' : p.last_campaign.totals.failed ? 'failed' : 'passed'} />
                    <ResultBar totals={p.last_campaign.totals} />
                    <span className="muted">{relativeTime(p.last_campaign.created_at)}</span>
                  </>
                ) : <span className="muted">No campaign yet</span>}
              </div>
              <div className="project-card__context" title={p.context || undefined}>
                {p.context || 'No context for the AI yet: what the app is, its pages, its flows.'}
              </div>
              <div className="project-card__footer">
                <Button size="sm" variant="secondary" icon={ArrowRight} onClick={() => open(p)}>Open</Button>
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(p)}>Edit</Button>
              </div>
            </Card>
          ))}
          <button type="button" className="card project-card project-card--new" onClick={() => setEditing('new')}>
            <Plus size={22} />
            <strong>New project</strong>
            <span>A name, a base URL, and the context for the AI.</span>
          </button>
        </div>
      )}

      {editing && (
        <ProjectDrawer
          project={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
          onDelete={(p) => { setEditing(null); setDeleting(p); }}
        />
      )}
      {deleting && <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}
