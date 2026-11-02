import { useEffect, useState } from 'react';
import { Bug as BugIcon, Compass, Loader2, CheckCircle2, XCircle, RotateCcw, FlaskConical } from 'lucide-react';
import { useGetBugsQuery, useSetBugStatusMutation, useGetExplorationsQuery, useStartExplorationMutation } from '../store/services/bugsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useAppSelector } from '../store/hooks';
import { useGo, useUrlState } from '../navigation';
import { Button } from './Button';
import { Card, EmptyState, PageHeader, Pill, Segmented } from './ui';
import { dateTime } from '../format';
import type { Bug } from '../types';

// The bugs the explorer found on its own (mcp-server/lib/explore.js) — console errors, failed
// requests, broken links, accessibility — each with the test that reproduces it, and the
// form that starts an exploration. Those of the project in scope; the filters are in the URL.

const KIND_LABELS: Record<Bug['kind'], string> = {
  console_error: 'Console error',
  failed_request: 'Failed request',
  broken_link: 'Broken link',
  a11y: 'Accessibility',
};

type Status = 'open' | 'dismissed' | 'fixed' | 'all';

const pathOf = (url: string) => {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
};

export function BugsPage() {
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: projects = [] } = useGetProjectsQuery();
  const project = projects.find((p) => p.id === scope);
  const [status, setStatus] = useUrlState('status', 'open') as [Status, (v: string) => void];
  const [kind, setKind] = useUrlState('kind');
  const [severity, setSeverity] = useUrlState('severity');
  // An exploration may be started elsewhere (explore_app): its progress is asked every 3 s,
  // and while one runs its bugs every 2 s.
  const { data: explorations = [], refetch: refetchExplorations } = useGetExplorationsQuery(undefined, { pollingInterval: 3000 });
  const running = explorations.find((exploration) => exploration.status === 'running');
  const { data: bugs = [], isLoading, refetch: refetchBugs } = useGetBugsQuery({ status, projectId: scope }, { pollingInterval: running ? 2000 : 0 });
  const { data: all = [] } = useGetBugsQuery({ status: 'all', projectId: scope }, { pollingInterval: running ? 2000 : 0 });
  const latest = explorations[0];

  // An exploration that ends has written its last bugs.
  useEffect(() => {
    if (latest?.status === 'done') refetchBugs();
  }, [latest?.id, latest?.status, refetchBugs]);

  const shown = bugs.filter((b) => (!kind || b.kind === kind) && (!severity || b.severity === severity));
  const countOf = (s: Status) => (s === 'all' ? all.length : all.filter((b) => b.status === s).length);

  return (
    <>
      <PageHeader
        title="Bugs"
        subtitle={`Console errors, failed requests, broken links and accessibility issues the explorer found${project ? ` in ${project.name}` : ''} — each with the test that reproduces it.`}
      />

      <ExploreForm key={project?.id ?? 'all'} running={!!running} projectId={scope} baseUrl={project?.base_url ?? ''} onStarted={refetchExplorations}>
        {latest && (
          <div className="explore-status">
            {running ? <Loader2 size={14} className="spin" /> : latest.status === 'failed' ? <XCircle size={14} className="explore-status__bad" /> : <CheckCircle2 size={14} className="explore-status__ok" />}
            <span>Last exploration: <span className="mono">{latest.start_url}</span></span>
            <span className="muted">
              · {latest.pages.length} page{latest.pages.length === 1 ? '' : 's'} visited
              {latest.status === 'done' && ` · ${latest.bugs_found} bug${latest.bugs_found === 1 ? '' : 's'}, ${latest.bugs_new} new`}
              {latest.status === 'running' && ' · exploring…'}
              {latest.error && ` · ${latest.error}`}
            </span>
          </div>
        )}
      </ExploreForm>

      <div className="toolbar">
        <Segmented<Status>
          label="Status" value={status} onChange={setStatus}
          options={[
            { value: 'open', label: 'Open', count: countOf('open'), tone: 'red' },
            { value: 'dismissed', label: 'Dismissed', count: countOf('dismissed'), tone: 'slate' },
            { value: 'fixed', label: 'Fixed', count: countOf('fixed'), tone: 'green' },
            { value: 'all', label: 'All', count: countOf('all') },
          ]}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">Kind: any</option>
          {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="">Severity: any</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      <Card flush>
        {isLoading && <p className="empty-state">Loading…</p>}
        {!isLoading && shown.length === 0 && (
          <EmptyState icon={BugIcon} title={`No ${status === 'all' ? '' : `${status} `}bug${kind || severity ? ' of this kind' : ''}`}>
            Explore an app to look for some: every new one comes with a test that reproduces it.
          </EmptyState>
        )}
        <div className="bug-rows">
          {shown.map((bug) => <BugRow key={bug.id} bug={bug} />)}
        </div>
      </Card>
    </>
  );
}

function ExploreForm({ running, projectId, baseUrl, onStarted, children }: {
  running: boolean; projectId: number | null; baseUrl: string; onStarted: () => void; children?: React.ReactNode;
}) {
  // The project's base URL to start from.
  const [url, setUrl] = useState(baseUrl);
  const [maxPages, setMaxPages] = useState(8);
  const [interact, setInteract] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [start, { isLoading }] = useStartExplorationMutation();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await start({ url, max_pages: maxPages, interact, project_id: projectId }).unwrap();
      onStarted();
    } catch (err) {
      setError((err as { data?: { error?: string } })?.data?.error ?? 'The exploration could not start');
    }
  };

  return (
    <Card title="Explore an app" icon={Compass}
      subtitle="Visits the site's pages from this URL and checks on each: console errors, requests answered 4xx/5xx, broken links, accessibility rules broken — and what clicking each harmless control does.">
      <form className="explore-row" onSubmit={submit}>
        <label className="field field--url">
          <span className="field__label">Start URL</span>
          <input type="url" required placeholder="https://staging.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field field--pages">
          <span className="field__label">Pages</span>
          <input type="number" min={1} max={50} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
        </label>
        <label className="switch" style={{ paddingBottom: 8 }}>
          <input type="checkbox" checked={interact} onChange={(e) => setInteract(e.target.checked)} />
          <span className="switch__text">Click controls</span>
        </label>
        <Button type="submit" icon={running || isLoading ? Loader2 : Compass} disabled={running || isLoading || !url}>
          {running ? 'Exploring…' : 'Explore'}
        </Button>
      </form>
      {error && <div className="alert alert--error" style={{ marginTop: 12 }}>{error}</div>}
      {children}
    </Card>
  );
}

function BugRow({ bug }: { bug: Bug }) {
  const go = useGo();
  const [setStatus, { isLoading }] = useSetBugStatusMutation();

  return (
    <div className={`bug-item bug-item--${bug.severity} ${bug.status !== 'open' ? 'bug-item--closed' : ''}`}>
      <div className="bug-item__main">
        <div className="bug-item__head">
          <Pill tone={bug.severity === 'high' ? 'red' : bug.severity === 'medium' ? 'amber' : 'slate'} dot={false}>{bug.severity}</Pill>
          <span className="tag">{KIND_LABELS[bug.kind] ?? bug.kind}</span>
          <span className="bug-item__title">{bug.title}</span>
          {bug.status !== 'open' && <Pill tone={bug.status === 'fixed' ? 'green' : 'slate'}>{bug.status}</Pill>}
        </div>
        <div className="bug-item__meta">
          <span className="mono">#{bug.id}</span>
          <span className="mono">{pathOf(bug.page_url)}</span>
          <span>seen {bug.occurrences} time{bug.occurrences > 1 ? 's' : ''}, last {dateTime(bug.last_seen)}</span>
          {bug.repro_test && (
            <button className="test-link" onClick={() => go(`/tests/${encodeURIComponent(bug.repro_test!)}`, { from: 'Bugs' })}>
              <FlaskConical size={12} /> {bug.repro_test}
            </button>
          )}
          {bug.reproduced === true && <span className="proof proof--ok">reproduced by its test</span>}
          {bug.reproduced === false && <span className="proof proof--no">not reproduced — intermittent?</span>}
        </div>
      </div>
      <div className="bug-item__actions">
        {bug.status === 'open' ? (
          <>
            <Button size="sm" variant="secondary" icon={CheckCircle2} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'fixed' })}>Fixed</Button>
            <Button size="sm" variant="ghost" icon={XCircle} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'dismissed' })}>Dismiss</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" icon={RotateCcw} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'open' })}>Reopen</Button>
        )}
      </div>
    </div>
  );
}
