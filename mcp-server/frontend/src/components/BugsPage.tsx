import { useEffect, useState } from 'react';
import { Bug as BugIcon, Compass, Loader2, CheckCircle2, XCircle, RotateCcw, FlaskConical } from 'lucide-react';
import { useGetBugsQuery, useSetBugStatusMutation, useGetExplorationsQuery, useStartExplorationMutation } from '../store/services/bugsApi';
import { Button } from './Button';
import type { Bug } from '../types';

// The bugs the explorer found on its own (mcp-server/lib/explore.js) — console errors, failed
// requests, broken links, accessibility — each with the test that reproduces it, and the
// form that starts an exploration.

const KIND_LABELS: Record<Bug['kind'], string> = {
  console_error: 'Console error',
  failed_request: 'Failed request',
  broken_link: 'Broken link',
  a11y: 'Accessibility',
};

const STATUSES = ['open', 'dismissed', 'fixed', 'all'] as const;

const pathOf = (url: string) => {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
};

export function BugsPage({ onOpenTest }: { onOpenTest: (name: string) => void }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('open');
  // An exploration may be started elsewhere (explore_app): its progress is asked every 3 s,
  // and while one runs its bugs every 2 s.
  const { data: explorations = [], refetch: refetchExplorations } = useGetExplorationsQuery(undefined, { pollingInterval: 3000 });
  const running = explorations.find((exploration) => exploration.status === 'running');
  const { data: bugs = [], isLoading, refetch: refetchBugs } = useGetBugsQuery({ status }, { pollingInterval: running ? 2000 : 0 });
  const latest = explorations[0];

  // An exploration that ends has written its last bugs.
  useEffect(() => {
    if (latest?.status === 'done') refetchBugs();
  }, [latest?.id, latest?.status, refetchBugs]);

  return (
    <div className="dashboard bugs-page">
      <ExploreForm running={!!running} onStarted={refetchExplorations} />

      {explorations[0] && (
        <div className="dash-panel">
          <div className="dash-panel__title"><Compass size={16} /> Last exploration</div>
          <div className="exploration-summary">
            {running ? <Loader2 size={14} className="spin" /> : explorations[0].status === 'failed' ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
            <span>{explorations[0].start_url}</span>
            <span className="dash-table__muted">
              {explorations[0].pages.length} page(s) visited
              {explorations[0].status === 'done' && ` · ${explorations[0].bugs_found} bug(s), ${explorations[0].bugs_new} new`}
              {explorations[0].status === 'running' && ' · exploring…'}
              {explorations[0].error && ` · ${explorations[0].error}`}
            </span>
          </div>
        </div>
      )}

      <div className="dash-panel">
        <div className="dash-panel__title">
          <BugIcon size={16} /> Bugs
          <div className="bug-filters">
            {STATUSES.map((s) => (
              <button key={s} className={`bug-filter ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>{s}</button>
            ))}
          </div>
        </div>
        {isLoading && <p className="dash-panel__empty">Loading…</p>}
        {!isLoading && bugs.length === 0 && (
          <p className="dash-panel__empty">No {status === 'all' ? '' : `${status} `}bug. Explore an app to look for some.</p>
        )}
        <div className="bug-list">
          {bugs.map((bug) => <BugRow key={bug.id} bug={bug} onOpenTest={onOpenTest} />)}
        </div>
      </div>
    </div>
  );
}

function ExploreForm({ running, onStarted }: { running: boolean; onStarted: () => void }) {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(8);
  const [interact, setInteract] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [start, { isLoading }] = useStartExplorationMutation();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await start({ url, max_pages: maxPages, interact }).unwrap();
      onStarted();
    } catch (err) {
      setError((err as { data?: { error?: string } })?.data?.error ?? 'The exploration could not start');
    }
  };

  return (
    <form className="dash-panel explore-form" onSubmit={submit}>
      <div className="dash-panel__title"><Compass size={16} /> Explore an app</div>
      <p className="explore-help">
        Visits the pages of the site from this URL and, on each one, checks the console errors, the requests answered 4xx/5xx,
        the broken links and the accessibility rules broken — and what clicking each harmless control does. Every new bug comes
        with a test that reproduces it.
      </p>
      <div className="explore-fields">
        <input type="url" required placeholder="https://staging.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        <label>
          Pages
          <input type="number" min={1} max={50} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
        </label>
        <label className="explore-check">
          <input type="checkbox" checked={interact} onChange={(e) => setInteract(e.target.checked)} />
          Click controls
        </label>
        <Button type="submit" icon={running || isLoading ? Loader2 : Compass} disabled={running || isLoading || !url}>
          {running ? 'Exploring…' : 'Explore'}
        </Button>
      </div>
      {error && <div className="repair-error">{error}</div>}
    </form>
  );
}

function BugRow({ bug, onOpenTest }: { bug: Bug; onOpenTest: (name: string) => void }) {
  const [setStatus, { isLoading }] = useSetBugStatusMutation();

  return (
    <div className={`bug-row bug-${bug.severity} bug-status-${bug.status}`}>
      <span className={`bug-severity bug-severity--${bug.severity}`} title={`${bug.severity} severity`} />
      <div className="bug-main">
        <div className="bug-head">
          <span className="exec-trigger">{KIND_LABELS[bug.kind] ?? bug.kind}</span>
          <span className="bug-title">{bug.title}</span>
        </div>
        <div className="bug-meta">
          <span>#{bug.id}</span>
          <span>{pathOf(bug.page_url)}</span>
          <span>seen {bug.occurrences} time{bug.occurrences > 1 ? 's' : ''}, last {new Date(bug.last_seen).toLocaleString()}</span>
          {bug.repro_test && (
            <button className="bug-test" onClick={() => onOpenTest(bug.repro_test!)}>
              <FlaskConical size={12} /> {bug.repro_test}
            </button>
          )}
          {bug.reproduced === true && <span className="bug-proof ok">reproduced by its test</span>}
          {bug.reproduced === false && <span className="bug-proof">not reproduced — intermittent?</span>}
        </div>
      </div>
      <div className="bug-actions">
        {bug.status === 'open' ? (
          <>
            <Button size="sm" variant="save" icon={CheckCircle2} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'fixed' })}>Fixed</Button>
            <Button size="sm" variant="cancel" icon={XCircle} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'dismissed' })}>Dismiss</Button>
          </>
        ) : (
          <Button size="sm" variant="action" icon={RotateCcw} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'open' })}>Reopen</Button>
        )}
      </div>
    </div>
  );
}
