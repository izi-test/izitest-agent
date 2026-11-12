import { useEffect, useState } from 'react';
import { Bug as BugIcon, Bot, Compass, Loader2, CheckCircle2, XCircle, RotateCcw, FlaskConical, Layers, AlertTriangle, Plus, Send, ExternalLink, SlidersHorizontal } from 'lucide-react';
import { useGetBugsQuery, useUpdateBugMutation, useReportBugMutation, useSendBugMutation, useGetExplorationsQuery, useStartExplorationMutation, type BugChanges } from '../store/services/bugsApi';
import { useGetConnectorsQuery } from '../store/services/settingsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useAppSelector } from '../store/hooks';
import { useGo, useUrlState } from '../navigation';
import { Button } from './Button';
import { Card, EmptyState, KeyChip, PageHeader, Pill, Segmented } from './ui';
import { dateTime } from '../format';
import { CreateTestModal, type CreateTestPreset } from './CreateTestModal';
import type { Bug, BugSend, Connector, ReportedBugDetails, RunBugDetails } from '../types';

// The bugs of the project in scope, from two sources, each with the test that reproduces it:
// - those the explorer found on its own (mcp-server/lib/explore.js) — console errors, failed
//   requests, broken links, accessibility —, and the form that starts an exploration;
// - those a test's run met (mcp-server/lib/bugs.js): its failure put on the app by the
//   diagnosis — a requirement not met, or a regression. Marked fixed when the test passes again.
// - those a person reports, in their words: the agent reproduces it and keeps the test that
//   shows it (Reproduce), which then confirms the fix like any other.
// Each is handled here: how urgent its fix is, who has it, deferred, a duplicate of another, to
// retest — and sent to the team's tracker (a Jira issue), previewed first.
// The filters are in the URL; ?bug=12 shows that one.

const KIND_LABELS: Record<Bug['kind'], string> = {
  non_conformity: 'Non-conformity',
  regression: 'Regression',
  console_error: 'Console error',
  failed_request: 'Failed request',
  broken_link: 'Broken link',
  a11y: 'Accessibility',
  reported: 'Reported',
};

type Status = Bug['status'] | 'all';

const STATUS_LABELS: Record<Bug['status'], string> = {
  open: 'Open', to_retest: 'To retest', deferred: 'Deferred', duplicate: 'Duplicate', fixed: 'Fixed', dismissed: 'Dismissed',
};
/** Still to be dealt with (mcp-server/lib/bugs.js UNRESOLVED_STATUSES). */
const UNRESOLVED: Array<Bug['status']> = ['open', 'to_retest', 'deferred'];
const LEVELS = ['high', 'medium', 'low'] as const;
const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

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
  const [reporting, setReporting] = useState(false);
  // The reported bug the agent is asked to reproduce.
  const [repro, setRepro] = useState<CreateTestPreset | null>(null);
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
        subtitle={`What the tests met — a requirement not met, a regression —, what the explorer found${project ? ` in ${project.name}` : ''} and what people report. Each with the test that reproduces it.`}
        actions={<Button variant={reporting ? 'primary' : 'secondary'} icon={Plus} onClick={() => setReporting(!reporting)}>Report a bug</Button>}
      />

      {reporting && <ReportForm projectId={scope} onClose={() => setReporting(false)} onReported={(bug) => { setReporting(false); setOnly(String(bug.id)); }} />}

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
            { value: 'open' as Status, label: 'Open', count: countOf('open'), tone: 'red' as const },
            // The handling statuses, once a bug is in one.
            ...(['to_retest', 'deferred', 'duplicate'] as const).filter((s) => countOf(s) > 0 || status === s)
              .map((s) => ({ value: s as Status, label: STATUS_LABELS[s], count: countOf(s), tone: s === 'to_retest' ? 'amber' as const : 'slate' as const })),
            { value: 'dismissed' as Status, label: 'Dismissed', count: countOf('dismissed'), tone: 'slate' as const },
            { value: 'fixed' as Status, label: 'Fixed', count: countOf('fixed'), tone: 'green' as const },
            { value: 'all' as Status, label: 'All', count: countOf('all') },
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
          <option value="report">Reported by a person</option>
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
          <EmptyState icon={BugIcon} title={`No ${status === 'all' ? '' : `${STATUS_LABELS[status].toLowerCase()} `}bug${kind || severity ? ' of this kind' : ''}`}>
            A test whose failure is put on the app opens one here; so does exploring an app, or reporting one for the agent to reproduce. Each comes with the test that reproduces it.
            {status === 'open' && countOf('fixed') > 0 && (
              <span style={{ display: 'block', marginTop: 10 }}>
                {countOf('fixed')} bug{countOf('fixed') > 1 ? 's were' : ' was'} fixed — {countOf('fixed') > 1 ? 'their tests pass' : 'its test passes'} again.{' '}
                <a href="#" onClick={(e) => { e.preventDefault(); setStatus('fixed'); }}>Show {countOf('fixed') > 1 ? 'them' : 'it'}</a>
              </span>
            )}
          </EmptyState>
        )}
        <div className="bug-rows">
          {shown.map((bug) => <BugRow key={bug.id} bug={bug} onShow={(id) => setOnly(String(id))} onReproduce={() => setRepro(reproPreset(bug))} />)}
        </div>
      </Card>

      <CreateTestModal
        isOpen={!!repro} preset={repro}
        onClose={() => { setRepro(null); refetchBugs(); }}
        onTestCreated={() => { setRepro(null); refetchBugs(); }}
      />
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

/** What the agent is asked to reproduce a reported bug: its report; the server adds how (mcp-server/lib/bugs.js reproBrief). */
function reproPreset(bug: Bug): CreateTestPreset {
  const d = bug.details as unknown as ReportedBugDetails;
  return {
    mode: 'ai', name: `bug_${bug.id}_repro`, gherkin: null, projectId: bug.project_id, bugId: bug.id,
    description: [`Reproduce bug #${bug.id}: ${bug.title}`, d.description, d.expected ? `Expected: ${d.expected}` : '', bug.page_url ? `Where: ${bug.page_url}` : ''].filter(Boolean).join('\n'),
  };
}

/** A bug a person reports, in their words: what happens, what was expected, where. */
function ReportForm({ projectId, onClose, onReported }: { projectId: number | null; onClose: () => void; onReported: (bug: Bug) => void }) {
  const [report, { isLoading }] = useReportBugMutation();
  const [form, setForm] = useState({ title: '', description: '', expected: '', page_url: '', severity: 'medium' as Bug['severity'], priority: '', assignee: '', requirement: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [field]: e.target.value });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { bug } = await report({
        title: form.title, description: form.description, expected: form.expected || undefined, page_url: form.page_url || undefined,
        severity: form.severity, priority: (form.priority || undefined) as Bug['priority'] | undefined,
        assignee: form.assignee || undefined, requirement: form.requirement || undefined, project_id: projectId,
      }).unwrap();
      onReported(bug);
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <Card title="Report a bug" icon={BugIcon}
      subtitle="Say what goes wrong in your own words. The agent then reproduces it in the browser and keeps the test that shows it: that test fails while the bug is there, and confirms the fix when it passes.">
      <form className="bug-report" onSubmit={submit}>
        <label className="field bug-report__wide">
          <span className="field__label">What goes wrong<span className="field__required">*</span></span>
          <input type="text" required placeholder="The total is wrong after removing a line" value={form.title} onChange={set('title')} />
        </label>
        <label className="field bug-report__wide">
          <span className="field__label">What happens, and how you got there<span className="field__required">*</span></span>
          <textarea required rows={3} placeholder="Logged in as a manager, I open an expense note with two lines and remove one: the total still counts it." value={form.description} onChange={set('description')} />
        </label>
        <label className="field bug-report__wide">
          <span className="field__label">What you expected</span>
          <input type="text" placeholder="The total is the sum of the lines left" value={form.expected} onChange={set('expected')} />
        </label>
        <label className="field bug-report__wide">
          <span className="field__label">Page<span className="field__optional">optional</span></span>
          <input type="text" placeholder="https://staging.example.com/notes/12" value={form.page_url} onChange={set('page_url')} />
        </label>
        <label className="field">
          <span className="field__label">Severity</span>
          <select value={form.severity} onChange={set('severity')}>{LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</select>
          <span className="field__hint">How bad it is</span>
        </label>
        <label className="field">
          <span className="field__label">Priority</span>
          <select value={form.priority} onChange={set('priority')}><option value="">not set</option>{LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</select>
          <span className="field__hint">How urgent its fix is</span>
        </label>
        <label className="field">
          <span className="field__label">Assigned to</span>
          <input type="text" placeholder="nobody yet" value={form.assignee} onChange={set('assignee')} />
        </label>
        <label className="field">
          <span className="field__label">Requirement</span>
          <input type="text" placeholder="REQ-12" value={form.requirement} onChange={set('requirement')} spellCheck={false} />
          <span className="field__hint">The one it breaks, if known</span>
        </label>
        {error && <div className="alert alert--error bug-report__wide">{error}</div>}
        <div className="repair-actions bug-report__wide">
          <Button type="submit" variant="save" icon={isLoading ? Loader2 : Plus} disabled={isLoading || !form.title.trim() || !form.description.trim()}>Report</Button>
          <Button variant="cancel" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function BugRow({ bug, onShow, onReproduce }: { bug: Bug; onShow: (id: number) => void; onReproduce: () => void }) {
  const go = useGo();
  const [update, { isLoading }] = useUpdateBugMutation();
  const [handling, setHandling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolved = UNRESOLVED.includes(bug.status);
  const change = async (changes: BugChanges) => {
    setError(null);
    try {
      await update({ id: bug.id, ...changes }).unwrap();
    } catch (err) {
      setError(errorOf(err));
    }
  };
  const setStatus = ({ status }: { id: number; status: Bug['status'] }) => change({ status });

  return (
    <div className={`bug-item bug-item--${bug.severity} ${unresolved ? '' : 'bug-item--closed'}`}>
      <div className="bug-item__main">
        <div className="bug-item__head">
          <Pill tone={bug.severity === 'high' ? 'red' : bug.severity === 'medium' ? 'amber' : 'slate'} dot={false}>{bug.severity}</Pill>
          <span className="tag">{KIND_LABELS[bug.kind] ?? bug.kind}</span>
          <span className="bug-item__title">{bug.title}</span>
          {bug.status !== 'open' && <Pill tone={bug.status === 'fixed' ? 'green' : bug.status === 'to_retest' ? 'amber' : 'slate'}>{STATUS_LABELS[bug.status].toLowerCase()}</Pill>}
          {bug.status === 'duplicate' && bug.duplicate_of && <button className="test-link" onClick={() => onShow(bug.duplicate_of!)}>of #{bug.duplicate_of}</button>}
          {bug.priority && <span className={`tag ${bug.priority === 'high' ? 'tag--red' : bug.priority === 'medium' ? 'tag--amber' : ''}`} title="How urgent its fix is">priority {bug.priority}</span>}
          {bug.assignee && <span className="tag" title="Who has it">{bug.assignee}</span>}
        </div>
        {bug.source === 'test' && <RunBugFacts bug={bug} />}
        {bug.source === 'report' && <ReportedBugFacts bug={bug} />}
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
          {bug.source === 'report' && !bug.repro_test && <span className="proof proof--no">no test yet</span>}
          {(bug.sent_to ?? []).map((s) => (
            s.url ? <a key={s.connector} className="campaign-link" href={s.url} target="_blank" rel="noreferrer">{s.name} {s.ref} <ExternalLink size={11} /></a> : <span key={s.connector}>{s.name} {s.ref}</span>
          ))}
        </div>
      </div>
      <div className="bug-item__actions">
        {bug.source === 'report' && !bug.repro_test && unresolved && <Button size="sm" icon={Bot} onClick={onReproduce}>Reproduce</Button>}
        {unresolved ? (
          <>
            <Button size="sm" variant="secondary" icon={CheckCircle2} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'fixed' })}>Fixed</Button>
            <Button size="sm" variant="ghost" icon={XCircle} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'dismissed' })}>Dismiss</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" icon={RotateCcw} disabled={isLoading} onClick={() => setStatus({ id: bug.id, status: 'open' })}>Reopen</Button>
        )}
        <Button size="sm" variant={handling ? 'primary' : 'ghost'} icon={SlidersHorizontal} onClick={() => setHandling(!handling)}>Handle</Button>
      </div>
      {error && <div className="alert alert--error bug-item__below">{error}</div>}
      {handling && <BugHandling bug={bug} busy={isLoading} change={change} />}
    </div>
  );
}

/** How a bug is dealt with: how urgent, who has it, where it stands — and its issue in the team's tracker. */
function BugHandling({ bug, busy, change }: { bug: Bug; busy: boolean; change: (changes: BugChanges) => void }) {
  const { data: connectors = [] } = useGetConnectorsQuery();
  const trackers = connectors.filter((t) => t.bugs);
  const [assignee, setAssignee] = useState(bug.assignee ?? '');
  const [original, setOriginal] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const saveAssignee = () => { if (assignee.trim() !== (bug.assignee ?? '')) change({ assignee: assignee.trim() || null }); };

  return (
    <div className="bug-handling bug-item__below">
      <div className="writeback-fields">
        <label>Severity
          <select value={bug.severity} disabled={busy} onChange={(e) => change({ severity: e.target.value as Bug['severity'] })}>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label>Priority
          <select value={bug.priority ?? ''} disabled={busy} onChange={(e) => change({ priority: (e.target.value || null) as Bug['priority'] })}>
            <option value="">not set</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label>Assigned to
          <input type="text" value={assignee} placeholder="nobody" onChange={(e) => setAssignee(e.target.value)} onBlur={saveAssignee}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
        <label>Duplicate of
          <span className="bug-handling__inline">
            <input type="number" min={1} value={original} placeholder="bug #" onChange={(e) => setOriginal(e.target.value)} />
            <Button size="sm" variant="secondary" disabled={busy || !original} onClick={() => { change({ duplicate_of: Number(original) }); setOriginal(''); }}>Mark</Button>
          </span>
        </label>
      </div>
      <div className="repair-actions">
        {bug.status !== 'to_retest' && bug.status !== 'fixed' && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => change({ status: 'to_retest' })} title="Said fixed: its test has not confirmed it yet">To retest</Button>
        )}
        {bug.status !== 'deferred' && bug.status !== 'fixed' && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => change({ status: 'deferred' })} title="Known, not fixed for now">Defer</Button>
        )}
        {bug.status !== 'open' && <Button size="sm" variant="secondary" icon={RotateCcw} disabled={busy} onClick={() => change({ status: 'open' })}>Reopen</Button>}
        {trackers.map((t) => (
          t.config
            ? <Button key={t.id} size="sm" variant={sending === t.id ? 'primary' : 'secondary'} icon={Send} onClick={() => setSending(sending === t.id ? null : t.id)}>
                {(bug.sent_to ?? []).some((s) => s.connector === t.id) ? `Update in ${t.name}…` : `Send to ${t.name}…`}
              </Button>
            : <span key={t.id} className="help">Set {t.name} in Settings → Connectors to send it there.</span>
        ))}
      </div>
      {trackers.filter((t) => sending === t.id).map((t) => <SendBugPanel key={t.id} bug={bug} connector={t} onClose={() => setSending(null)} />)}
    </div>
  );
}

/** The bug as an issue of the tracker: what would be written, then written. Nothing is sent before the preview. */
function SendBugPanel({ bug, connector: t, onClose }: { bug: Bug; connector: Connector; onClose: () => void }) {
  const role = t.bugs!;
  const [send, { isLoading }] = useSendBugMutation();
  const [options, setOptions] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<BugSend | null>(null);
  const [sent, setSent] = useState<BugSend | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (dryRun: boolean) => {
    setError(null);
    const given = Object.fromEntries(Object.entries(options).map(([name, value]) => [name, value.trim()]).filter(([, value]) => value));
    try {
      const result = await send({ id: bug.id, connector: t.id, options: given, dry_run: dryRun }).unwrap();
      if (dryRun) setPreview(result);
      else setSent(result);
    } catch (err) {
      setError(errorOf(err));
      if (dryRun) setPreview(null);
    }
  };
  if (sent) {
    return (
      <div className="import-panel writeback-panel">
        <p className="alert alert--success">
          {sent.updates ? 'Updated' : 'Sent'} in {t.name}: {sent.url ? <a href={sent.url} target="_blank" rel="noreferrer">{sent.ref} <ExternalLink size={11} /></a> : sent.ref ?? `a ${role.what}`}, in {sent.target}.
        </p>
        <div className="repair-actions"><Button size="sm" variant="secondary" onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  return (
    <div className="import-panel writeback-panel">
      {role.note && <p className="help">{role.note}</p>}
      <div className="writeback-fields">
        {role.options.map((o) => (
          <label key={o.name}>{o.label} <input type="text" value={options[o.name] ?? ''} placeholder={o.placeholder} onChange={(e) => setOptions({ ...options, [o.name]: e.target.value })} spellCheck={false} /></label>
        ))}
        <Button size="sm" variant="secondary" disabled={isLoading} onClick={() => ask(true)}>{preview ? 'Preview again' : 'Preview'}</Button>
      </div>
      {isLoading && <p className="help"><Loader2 size={12} className="spin" /> {preview ? 'Sending…' : 'Preparing…'}</p>}
      {error && <div className="alert alert--error">{error}</div>}
      {preview && (
        <>
          <p className="help">
            Would {preview.updates ? <>update the {role.what} <strong>{preview.ref}</strong></> : <>create a {preview.type ?? role.what}</>} in <strong>{preview.target}</strong>:
          </p>
          <div><strong>{preview.title}</strong></div>
          <pre className="writeback-comment">{preview.text}</pre>
        </>
      )}
      <div className="repair-actions">
        <Button size="sm" variant="save" icon={Send} disabled={!preview || isLoading} onClick={() => ask(false)}>
          {preview?.updates ? `Update ${preview.ref}` : `Send to ${t.name}`}
        </Button>
        <Button size="sm" variant="cancel" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** What a person reported: what happens, what was expected, the requirement it breaks. */
function ReportedBugFacts({ bug }: { bug: Bug }) {
  const go = useGo();
  const d = bug.details as unknown as ReportedBugDetails;
  return (
    <div className="bug-item__facts">
      {d.description && <div className="bug-item__summary">{d.description}</div>}
      {d.expected && <div className="bug-item__summary"><span className="muted">Expected:</span> {d.expected}</div>}
      {(d.requirements ?? []).length > 0 && (
        <ul className="bug-item__criteria">
          {d.requirements.map((r) => (
            <li key={r.key}><KeyChip onClick={() => go(`/requirements/${encodeURIComponent(r.key)}`, { from: 'Bugs' })}>{r.key}</KeyChip> {r.title}</li>
          ))}
        </ul>
      )}
      {UNRESOLVED.includes(bug.status) && d.passed_unreproduced && (
        <div className="alert alert--warning">
          <AlertTriangle size={14} /> Its test passed in run #{d.passed_unreproduced} without ever having failed on the bug: that is not taken as a fix. The test may not check what was reported.
        </div>
      )}
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
