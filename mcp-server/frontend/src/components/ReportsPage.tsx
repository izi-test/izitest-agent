import { BarChart3, ExternalLink, Layers, Bug as BugIcon, ClipboardList, ShieldAlert, AlertTriangle, ArrowRight } from 'lucide-react';
import { useAppSelector } from '../store/hooks';
import { useGetProgressReportQuery } from '../store/services/campaignsApi';
import { useGo, useUrlState } from '../navigation';
import { Card, EmptyState, KeyChip, PageHeader, Pill, StatusPill } from './ui';
import { shortDate } from '../format';
import { CAUSE_LABELS } from '../triage-labels';
import type { ProgressReport, RiskLevel, Triage } from '../types';

// Where the testing stands over a period (mcp-server/lib/reports.js): what ran, where the
// requirements are, the bugs opened and fixed and their trend, the risk left, what is in the
// way and what to do next. The same report opens as a page of its own, to print or send.

const day = (date: Date) => date.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d); };

export function ReportsPage() {
  const go = useGo();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const [from, setFrom] = useUrlState('from', daysAgo(30));
  const [to, setTo] = useUrlState('to', day(new Date()));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const { data: r, isFetching, error } = useGetProgressReportQuery({ projectId: scope, from, to }, { skip: !valid });
  const href = `/api/reports/progress.html?from=${from}&to=${to}${scope ? `&project_id=${scope}` : ''}`;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`Where the testing stands${r?.project ? ` on ${r.project.name}` : ', all projects together'}: progress over a period, to follow the work or to close it.`}
        actions={valid && <a className="btn btn--secondary" href={href} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open as a page to print or send</a>}
      />
      <Card>
        <div className="form__row report-period">
          <label className="field"><span className="field__label">From</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span className="field__label">To</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <div className="report-period__quick">
            {[7, 30, 90].map((n) => <button type="button" key={n} className="btn btn--ghost btn--sm" onClick={() => { setFrom(daysAgo(n)); setTo(day(new Date())); }}>Last {n} days</button>)}
          </div>
        </div>
        {!valid && <div className="alert alert--warning">Choose a period: a first day, then a last day after it.</div>}
        {error && <div className="alert alert--error">{(error as { data?: { error?: string } })?.data?.error ?? 'The report could not be built'}</div>}
      </Card>
      {valid && !r && isFetching && <Card><p className="empty-state">Loading…</p></Card>}
      {valid && r && <Report report={r} onOpen={go} />}
    </>
  );
}

const RISKS: RiskLevel[] = ['high', 'medium', 'low'];

function Report({ report: r, onOpen }: { report: ProgressReport; onOpen: (to: string, options?: { from?: string }) => void }) {
  const open = (to: string) => onOpen(to, { from: 'Reports' });
  const q = r.requirements;
  const causes = Object.entries(r.runs.causes).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div className="kpis">
        <Kpi label="Test runs" value={r.runs.total} detail={r.runs.total ? `${r.runs.pass_rate}% passed, on ${r.runs.tests} test${r.runs.tests === 1 ? '' : 's'}` : 'none in the period'} />
        <Kpi label="Requirements passing" value={`${q.passing} / ${q.total}`} detail={`${q.coverage}% of the acceptance criteria covered`} />
        <Kpi label="Bugs opened" value={r.bugs.opened} detail={`${r.bugs.fixed} fixed in the period`} />
        <Kpi label="Bugs unresolved" value={r.bugs.unresolved} detail={r.bugs.by_severity.high ? `${r.bugs.by_severity.high} of high severity` : 'none of high severity'} tone={r.bugs.by_severity.high ? 'red' : undefined} />
      </div>

      <Card title="What to do next" icon={ArrowRight}>
        <ul className="report-list">{r.next.map((line, i) => <li key={i}>{line}</li>)}</ul>
      </Card>

      {r.obstacles.length > 0 && (
        <Card title="In the way" icon={AlertTriangle} subtitle="What slows the testing down or hides its result.">
          <ul className="report-list">{r.obstacles.map((o) => <li key={o.id}>{o.text}</li>)}</ul>
        </Card>
      )}

      <Card title="Campaigns" icon={Layers} flush={r.campaigns.length > 0}>
        {r.campaigns.length === 0 ? <EmptyState icon={Layers} title="No campaign in the period">A campaign runs a set of tests together and says where its requirements stand.</EmptyState> : (
          <table className="table">
            <thead><tr><th>Campaign</th><th>Started</th><th>Passed</th><th>Exit criteria</th><th>Regressed</th></tr></thead>
            <tbody>
              {r.campaigns.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => open(`/campaigns/${c.id}`)}>
                  <td><strong>#{c.id}</strong> {c.name}{c.version && <span className="muted"> · {c.version}</span>}{c.objective && <div className="muted">{c.objective}</div>}</td>
                  <td>{shortDate(c.created_at)}</td>
                  <td>{c.passed} / {c.total} <span className="muted">({c.pass_rate}%)</span></td>
                  <td>{c.exit ? <Pill tone={c.exit.verdict === 'met' ? 'green' : c.exit.verdict === 'not_met' ? 'red' : 'slate'}>{c.exit.verdict === 'met' ? 'met' : c.exit.verdict === 'not_met' ? 'not met' : 'running'}</Pill> : <span className="muted">no plan</span>}</td>
                  <td>{c.regressed.length ? c.regressed.join(', ') : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Requirements" icon={ClipboardList} subtitle="Where they stand today, and by product risk.">
        <div className="report-split">
          <table className="table">
            <tbody>
              <tr><td>Passing</td><td>{q.passing}</td></tr>
              <tr><td>Failing</td><td>{q.failing}</td></tr>
              <tr><td>Covered, not run yet</td><td>{q.not_run}</td></tr>
              <tr><td>Not covered by a test</td><td>{q.not_covered}</td></tr>
              <tr><td>Acceptance criteria covered</td><td>{q.criteria_covered} / {q.criteria} ({q.coverage}%)</td></tr>
            </tbody>
          </table>
          <table className="table">
            <thead><tr><th>Risk</th><th>Requirements</th><th>Passing</th></tr></thead>
            <tbody>
              {RISKS.map((level) => (
                <tr key={level}><td><span className={`tag ${level === 'high' ? 'tag--red' : level === 'medium' ? 'tag--amber' : 'tag--green'}`}>{level}</span></td><td>{q.by_risk[level].total}</td><td>{q.by_risk[level].passing}</td></tr>
              ))}
              <tr><td className="muted">not rated</td><td>{q.unrated}</td><td /></tr>
            </tbody>
          </table>
        </div>
      </Card>

      {r.residual_risk.length > 0 && (
        <Card title="Residual risk" icon={ShieldAlert} subtitle="Requirements at risk that do not pass: what would go to production untested or failing.">
          <ul className="campaign-bugs">
            {r.residual_risk.map((x) => (
              <li key={x.key}>
                <KeyChip onClick={() => open(`/requirements/${encodeURIComponent(x.key)}`)}>{x.key}</KeyChip>
                <span className={`tag ${x.risk === 'high' ? 'tag--red' : 'tag--amber'}`}>{x.risk} risk</span>
                <StatusPill status={x.status} label={x.status.replace('_', ' ')} />
                <span className="campaign-bugs__title">{x.title}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Bugs" icon={BugIcon} subtitle="Opened and fixed in the period, and how many were left unresolved day after day.">
        <BugTrend trend={r.bugs.trend} />
        {r.bugs.list.length > 0 && (
          <table className="table" style={{ marginTop: 16 }}>
            <thead><tr><th>Unresolved</th><th>Severity</th><th>Priority</th><th>Assigned to</th><th>Status</th><th>Since</th></tr></thead>
            <tbody>
              {r.bugs.list.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => open(`/bugs?bug=${b.id}`)}>
                  <td><strong>#{b.id}</strong> {b.title}</td>
                  <td><span className={`tag ${b.severity === 'high' ? 'tag--red' : b.severity === 'medium' ? 'tag--amber' : ''}`}>{b.severity}</span></td>
                  <td>{b.priority ?? <span className="muted">—</span>}</td>
                  <td>{b.assignee ?? <span className="muted">—</span>}</td>
                  <td>{b.status.replace('_', ' ')}</td>
                  <td>{shortDate(b.first_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {causes.length > 0 && (
        <Card title="Why tests failed" icon={BarChart3} subtitle={`${r.runs.failed} failed run${r.runs.failed === 1 ? '' : 's'} in the period, by cause.`}>
          <table className="table">
            <tbody>{causes.map(([cause, count]) => <tr key={cause}><td>{CAUSE_LABELS[cause as Triage['cause']] ?? cause}</td><td>{count}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Kpi({ label, value, detail, tone }: { label: string; value: React.ReactNode; detail: string; tone?: 'red' }) {
  return (
    <div className="kpi kpi--static">
      <div className="kpi__label">{label}</div>
      <div className="kpi__value" style={tone === 'red' ? { color: 'var(--red)' } : undefined}>{value}</div>
      <div className="kpi__sub">{detail}</div>
    </div>
  );
}

/** The bugs left unresolved, day after day: a line, with the days a bug was opened or fixed told on hover. */
function BugTrend({ trend }: { trend: ProgressReport['bugs']['trend'] }) {
  if (trend.length < 2 || trend.every((d) => !d.unresolved && !d.opened && !d.fixed)) return <p className="muted">No bug was opened, fixed or left unresolved in the period.</p>;
  const W = 720, H = 140, left = 28, bottom = 20, top = 8;
  const max = Math.max(1, ...trend.map((d) => d.unresolved));
  const x = (i: number) => left + (i * (W - left - 8)) / (trend.length - 1);
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const line = trend.map((d, i) => `${x(i)},${y(d.unresolved)}`).join(' ');
  const last = trend[trend.length - 1];
  return (
    <figure className="bug-trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Unresolved bugs from ${trend[0].date} to ${last.date}: ${trend[0].unresolved} then ${last.unresolved}`}>
        {[0, max].map((v) => <g key={v}><line x1={left} x2={W - 8} y1={y(v)} y2={y(v)} className="bug-trend__grid" /><text x={left - 6} y={y(v) + 4} textAnchor="end" className="bug-trend__tick">{v}</text></g>)}
        <polygon points={`${x(0)},${y(0)} ${line} ${x(trend.length - 1)},${y(0)}`} className="bug-trend__area" />
        <polyline points={line} className="bug-trend__line" />
        {trend.map((d, i) => (d.opened || d.fixed) ? <circle key={d.date} cx={x(i)} cy={y(d.unresolved)} r={3.5} className="bug-trend__dot"><title>{`${d.date}: ${d.opened} opened, ${d.fixed} fixed, ${d.unresolved} unresolved`}</title></circle> : null)}
        <text x={left} y={H - 4} className="bug-trend__tick">{trend[0].date}</text>
        <text x={W - 8} y={H - 4} textAnchor="end" className="bug-trend__tick">{last.date}</text>
      </svg>
      <figcaption className="muted">Unresolved bugs at the end of each day. A dot marks a day a bug was opened or fixed.</figcaption>
    </figure>
  );
}
