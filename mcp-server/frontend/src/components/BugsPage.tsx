import { useEffect, useState } from 'react';
import { Bug as BugIcon, Compass, Loader2, CheckCircle2, XCircle, RotateCcw, FlaskConical, Layers, AlertTriangle } from 'lucide-react';
import { useGetBugsQuery, useSetBugStatusMutation, useGetExplorationsQuery, useStartExplorationMutation } from '../store/services/bugsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useAppSelector } from '../store/hooks';
import { useGo, useUrlState } from '../navigation';
import { Button } from './Button';
import { Card, EmptyState, KeyChip, PageHeader, Pill, Segmented } from './ui';
import { dateTime } from '../format';
import type { Bug, RunBugDetails } from '../types';

// The bugs of the project in scope, from two sources, each with the test that reproduces it:
// - those the explorer found on its own (mcp-server/lib/explore.js) — console errors, failed
//   requests, broken links, accessibility —, and the form that starts an exploration;
// - those a test's run met (mcp-server/lib/bugs.js): its failure put on the app by the
//   diagnosis — a requirement not met, or a regression. Marked fixed when the test passes again.
// The filters are in the URL; ?bug=12 shows that one.

const KIND_LABELS: Record<Bug['kind'], string> = {
  non_conformity: 'Non-conformity',
  regression: 'Regression',
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
  const [origin, setOrigin] = useUrlState('origin');
  // One bug, linked from a campaign or a run: shown whatever its status.
  const [only, setOnly] = useUrlState('bug');
  // An exploration may be started elsewhere (explore_app): its progress is asked every 3 s,
  // and while one runs its bugs every 2 s.
  const { data: explorations = [], refetch: refetchExplorations } = useGetExplorationsQuery(undefined, { pollingInterval: 3000 });
  const running = explorations.find((exploration) => exploration.status === 'running');
  const { currentData, refetch: refetchBugs } = useGetBugsQuery({ status, projectId: scope }, { pollingInterval: running ? 2000 : 0 });
  // Another status asked for: nothing to show until its answer comes, not the last list.
  const bugs = currentData ?? [];
  const { currentData: everyBug } = useGetBugsQuery({ status: 'all', projectId: scope }, { pollingInterval: running ? 2000 : 0 });
  const all = everyBug ?? [];
  const latest = explorations[0];

  // An exploration that ends has written its last bugs.
  useEffect(() => {
    if (latest?.status === 'done') refetchBugs();
  }, [latest?.id, latest?.status, refetchBugs]);

  const waiting = only ? everyBug === undefined : currentData === undefined;
  const shown = only
    ? all.filter((b) => String(b.id) === only)
    : bugs.filter((b) => (!kind || b.kind === kind) && (!severity || b.severity === severity) && (!origin || b.source === origin));
  const countOf = (s: Status) => (s === 'all' ? all.length : all.filter((b) => b.status === s).length);

  return (
    <>
      <PageHeader
        title="Bugs"
        subtitle={`What the tests met — a requirement not met, a regression — and what the explorer found${project ? ` in ${project.name}` : ''}: console errors, failed requests, broken links, accessibility. Each with the test that reproduces it.`}
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
        <select value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Origin">
          <option value="">Origin: any</option>
          <option value="test">Met by a test</option>
          <option value="exploration">Found exploring</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="">Severity: any</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {only && (
        <div className="alert alert--info">
          Bug #{only} only. <a href="#" onClick={(e) => { e.preventDefault(); setOnly(''); }}>Show all bugs</a>
        </div>
      )}

      <Card flush>
        {waiting && <p className="empty-state">Loading…</p>}
        {!waiting && shown.length === 0 && (
          <EmptyState icon={BugIcon} title={`No ${status === 'all' ? '' : `${status} `}bug${kind || severity ? ' of this kind' : ''}`}>
            A test whose failure is put on the app opens one here; so does exploring an app. Each comes with the test that reproduces it.
            {status === 'open' && countOf('fixed') > 0 && (
              <div style={{ marginTop: 10 }}>
                {countOf('fixed')} bug{countOf('fixed') > 1 ? 's were' : ' was'} fixed — {countOf('fixed') > 1 ? 'their tests pass' : 'its test passes'} again.{' '}
                <a href="#" onClick={(e) => { e.preventDefault(); setStatus('fixed'); }}>Show {countOf('fixed') > 1 ? 'them' : 'it'}</a>
              </div>
            )}
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
        {bug.source === 'test' && <RunBugFacts bug={bug} />}
        <div className="bug-item__meta">
          <span className="mono">#{bug.id}</span>
          {bug.page_url && <span className="mono">{pathOf(bug.page_url)}</span>}
          <span>seen {bug.occurrences} time{bug.occurrences > 1 ? 's' : ''}, last {dateTime(bug.last_seen)}</span>
          {bug.repro_test && (
            <button className="test-link" onClick={() => go(`/tests/${encodeURIComponent(bug.repro_test!)}`, { from: 'Bugs' })}>
              <FlaskConical size={12} /> {bug.repro_test}
            </button>
          )}
          {bug.source === 'test' && <RunBugLinks bug={bug} />}
          {bug.source !== 'test' && bug.reproduced === true && <span className="proof proof--ok">reproduced by its test</span>}
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

/** What a test's run kept of the bug: the diagnosis, and the requirement criterion it breaks. */
function RunBugFacts({ bug }: { bug: Bug }) {
  const go = useGo();
  const d = bug.details as unknown as RunBugDetails;
  const criteria = (d.requirements ?? []).flatMap((r): Array<{ key: string; number: number | null; text: string }> =>
    (r.criteria.length ? r.criteria.map((c) => ({ key: r.key, number: c.number, text: c.text })) : [{ key: r.key, number: null, text: r.title }]));
  return (
    <div className="bug-item__facts">
      {d.summary && <div className="bug-item__summary">{d.summary}</div>}
      {criteria.length > 0 && (
        <ul className="bug-item__criteria">
          {criteria.map((c) => (
            <li key={`${c.key}-${c.number}`}>
              <KeyChip onClick={() => go(`/requirements/${encodeURIComponent(c.key)}`, { from: 'Bugs' })}>{c.key}</KeyChip>
              {c.number != null && <span className="muted">criterion {c.number}:</span>} {c.text}
            </li>
          ))}
        </ul>
      )}
      {bug.status === 'open' && d.passed_after_change && (
        <div className="alert alert--warning">
          <AlertTriangle size={14} /> Its test passed in run #{d.passed_after_change}, but was changed since the bug was seen: it may no longer check what failed. Check by hand that it is fixed.
        </div>
      )}
    </div>
  );
}

/** Where a test's bug was seen: the step of its test, the campaign; the run that fixed it. */
function RunBugLinks({ bug }: { bug: Bug }) {
  const go = useGo();
  const d = bug.details as unknown as RunBugDetails;
  return (
    <>
      {d.step?.order != null && <span>step {d.step.order}{bug.data_row ? `, row ${bug.data_row}` : ''}</span>}
      {d.campaign && (
        <button className="test-link" onClick={() => go(`/campaigns/${d.campaign!.id}`, { from: 'Bugs' })}>
          <Layers size={12} /> campaign #{d.campaign.id}{d.campaign.commit ? ` · ${d.campaign.commit}` : ''}
        </button>
      )}
      {bug.status === 'fixed' && bug.fixed_execution_id
        ? <span className="proof proof--ok">fixed: its test passes again (run #{bug.fixed_execution_id})</span>
        : <span className="proof proof--no">its test fails on it</span>}
    </>
  );
}
