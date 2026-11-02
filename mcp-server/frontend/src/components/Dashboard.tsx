import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { setActiveTab } from '../store/slices/testDetailSlice';
import { useGetStatsQuery } from '../store/services/statsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useGetRequirementsQuery } from '../store/services/requirementsApi';
import { useGetCampaignsQuery } from '../store/services/campaignsApi';
import { useGetBugsQuery } from '../store/services/bugsApi';
import { useGo, useUrlState } from '../navigation';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  FlaskConical, Play, Timer, TrendingUp, AlertTriangle, ChevronRight, ArrowUpRight, ClipboardList, Layers, Bug, History,
} from 'lucide-react';
import { Card, EmptyState, PageHeader, Pill, ResultBar, Segmented, StatusPill } from './ui';
import { formatDuration, relativeTime, shortDate } from '../format';

// The dashboard: where the project in scope stands over a period — its tests, how its runs went,
// its requirements' coverage, its last campaign, its open bugs — each a way into the page that
// has the detail.

const COLORS = { passed: '#16A34A', failed: '#DC2626', running: '#2563EB', error: '#D97706', grid: '#E2E8F0', muted: '#64748B' };
const PERIODS = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const;

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function Dashboard() {
  const dispatch = useAppDispatch();
  const go = useGo();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const [days, setDays] = useUrlState('days', '30');
  const { data: stats, isLoading } = useGetStatsQuery({ projectId: scope, days: Number(days) });
  const { data: projects = [] } = useGetProjectsQuery();
  const { data: requirements = [] } = useGetRequirementsQuery(scope);
  const { data: campaigns = [] } = useGetCampaignsQuery(scope);
  const { data: bugs = [] } = useGetBugsQuery({ status: 'open', projectId: scope });
  const project = projects.find((p) => p.id === scope);
  // When the page opened: what "this week" counts from.
  const [now] = useState(() => Date.now());

  const openTest = (name: string, tab?: 'history') => {
    if (tab) dispatch(setActiveTab(tab));
    go(`/tests/${encodeURIComponent(name)}`, { from: 'the dashboard' });
  };

  const header = (
    <PageHeader
      title="Dashboard"
      subtitle={`${project?.name ?? 'All projects'} · last ${days} days`}
      actions={<Segmented label="Period" options={PERIODS.map((p) => ({ ...p }))} value={days as '7' | '30' | '90'} onChange={setDays} />}
    />
  );

  if (isLoading || !stats) {
    return <>{header}<Card><p className="empty-state">Loading the dashboard…</p></Card></>;
  }

  const { tests, executions } = stats;
  const passRate = percent(executions.passed, executions.passed + executions.failed);
  const assertionRate = percent(executions.assertions_passed, executions.assertions_total);
  const lastWeek = executions.trend.filter((d) => Date.parse(d.date) >= now - 7 * 86_400_000).reduce((n, d) => n + d.total, 0);
  const results = [
    { name: 'Passed', value: executions.passed, color: COLORS.passed },
    { name: 'Failed', value: executions.failed, color: COLORS.failed },
    { name: 'Running', value: executions.running, color: COLORS.running },
  ].filter((d) => d.value > 0);

  const coverage = (['passing', 'failing', 'not_run', 'not_covered'] as const).map((status) => ({
    status, count: requirements.filter((r) => r.coverage.status === status).length,
  }));
  const latest = campaigns[0];
  const high = bugs.filter((b) => b.severity === 'high').length;
  const medium = bugs.filter((b) => b.severity === 'medium').length;

  return (
    <>
      {header}

      <div className="kpis">
        <button type="button" className="kpi" onClick={() => go('/tests')}>
          <div className="kpi__top"><span className="kpi__icon"><FlaskConical size={18} /></span><ArrowUpRight size={16} className="kpi__arrow" /></div>
          <span className="kpi__label">Tests</span>
          <span className="kpi__value">{tests.total}</span>
          <span className="kpi__sub">{tests.never_run ? `${tests.never_run} never run` : 'All have run'}</span>
        </button>
        <button type="button" className="kpi" onClick={() => go('/tests?sort=last_run')}>
          <div className="kpi__top"><span className="kpi__icon"><Play size={18} /></span><ArrowUpRight size={16} className="kpi__arrow" /></div>
          <span className="kpi__label">Runs</span>
          <span className="kpi__value">{executions.total}</span>
          <span className="kpi__sub">{days === '7' ? `over ${days} days` : `${lastWeek} this week`}</span>
        </button>
        <button type="button" className="kpi" onClick={() => go('/tests?status=failed')} title="The tests whose last run failed">
          <div className="kpi__top">
            <span className={`kpi__icon ${passRate >= 80 ? 'kpi__icon--green' : 'kpi__icon--red'}`}><TrendingUp size={18} /></span>
            <ArrowUpRight size={16} className="kpi__arrow" />
          </div>
          <span className="kpi__label">Pass rate</span>
          <span className="kpi__value">{executions.total ? `${passRate}%` : '—'}</span>
          <span className="kpi__sub">{executions.assertions_total ? `Assertions ${assertionRate}% passed` : 'No assertion run yet'}</span>
        </button>
        <button type="button" className="kpi" onClick={() => go('/tests?sort=last_run')}>
          <div className="kpi__top"><span className="kpi__icon kpi__icon--amber"><Timer size={18} /></span><ArrowUpRight size={16} className="kpi__arrow" /></div>
          <span className="kpi__label">Avg duration</span>
          <span className="kpi__value">{executions.total ? formatDuration(executions.avg_duration_ms) : '—'}</span>
          <span className="kpi__sub">a run, over {executions.total} run{executions.total === 1 ? '' : 's'}</span>
        </button>
      </div>

      <div className="dash-row dash-row--charts">
        <Card
          title="Runs over time" subtitle="Each day's runs, passed and failed"
          actions={<div className="legend"><span className="legend__item"><span className="legend__dot" style={{ background: COLORS.passed }} />Passed</span><span className="legend__item"><span className="legend__dot" style={{ background: COLORS.failed }} />Failed</span></div>}
        >
          {executions.trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={executions.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradPassed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.passed} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={COLORS.passed} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.failed} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={COLORS.failed} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} fontSize={12} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
                <YAxis fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(label) => shortDate(String(label))} />
                <Area type="monotone" dataKey="passed" name="Passed" stroke={COLORS.passed} fill="url(#gradPassed)" strokeWidth={2} />
                <Area type="monotone" dataKey="failed" name="Failed" stroke={COLORS.failed} fill="url(#gradFailed)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="chart-empty">No run over these {days} days</div>
          )}
        </Card>

        <Card title="Results" subtitle={`Across ${executions.total} run${executions.total === 1 ? '' : 's'}`}>
          {results.length > 0 ? (
            <>
              <div className="donut">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={results} cx="50%" cy="50%" innerRadius={58} outerRadius={80} paddingAngle={2} dataKey="value" stroke="none">
                      {results.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut__center"><span className="donut__value">{executions.total}</span><span className="donut__label">runs</span></div>
              </div>
              <ul className="breakdown">
                {results.map((r) => (
                  <li key={r.name}>
                    <span className="legend__dot" style={{ background: r.color }} />{r.name}
                    <span className="breakdown__value">{r.value}</span>
                    <span className="breakdown__share">{percent(r.value, executions.total)}%</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="chart-empty">No run yet</div>
          )}
        </Card>
      </div>

      <div className="dash-row dash-row--summary">
        <Card title="Requirement coverage" icon={ClipboardList} className="summary-card"
          actions={<span className="tag">{requirements.length} requirement{requirements.length === 1 ? '' : 's'}</span>}>
          {requirements.length ? (
            <>
              <div className="result-bar result-bar--lg">
                {coverage.filter((c) => c.count).map((c) => (
                  <span key={c.status} className={`result-bar__part bar--${{ passing: 'green', failing: 'red', not_run: 'amber', not_covered: 'slate' }[c.status]}`} style={{ flexGrow: c.count }} />
                ))}
              </div>
              <div className="coverage-legend">
                <span><span className="legend__dot" style={{ background: COLORS.passed }} />Passing <strong>{coverage[0].count}</strong></span>
                <span><span className="legend__dot" style={{ background: COLORS.failed }} />Failing <strong>{coverage[1].count}</strong></span>
                <span><span className="legend__dot" style={{ background: COLORS.error }} />Not run <strong>{coverage[2].count}</strong></span>
                <span><span className="legend__dot" style={{ background: '#CBD5E1' }} />Not covered <strong>{coverage[3].count}</strong></span>
              </div>
            </>
          ) : <p className="muted">No requirement yet.</p>}
          <a className="summary-card__link" href="#" onClick={(e) => { e.preventDefault(); go('/requirements'); }}>View requirements →</a>
        </Card>

        <Card title="Latest campaign" icon={Layers} className="summary-card"
          actions={latest && <StatusPill status={latest.running ? 'running' : latest.status} />}>
          {latest ? (
            <>
              <div>
                <div className="summary-card__title">#{latest.id} {latest.name}{latest.version && <span className="campaign-version">v{latest.version}</span>}</div>
                <div className="muted" style={{ fontSize: 13 }}>{relativeTime(latest.created_at)}{latest.duration_ms != null && ` · ${formatDuration(latest.duration_ms)}`}</div>
              </div>
              <div className="result-cell">
                <ResultBar totals={latest.totals} />
                <span>{latest.totals.passed}/{latest.total} passed</span>
              </div>
              {latest.changes?.regressed.length ? <span><Pill tone="red">{latest.changes.regressed.length} regressed</Pill></span> : null}
            </>
          ) : <p className="muted">No campaign yet.</p>}
          <a className="summary-card__link" href="#" onClick={(e) => { e.preventDefault(); go(latest ? `/campaigns/${latest.id}` : '/campaigns', { from: 'the dashboard' }); }}>
            {latest ? 'Open the report →' : 'View campaigns →'}
          </a>
        </Card>

        <Card title="Open bugs" icon={Bug} className="summary-card">
          <div className="summary-card__big" style={{ color: bugs.length ? 'var(--red)' : 'var(--text)' }}>{bugs.length}</div>
          <div className="cell-chips">
            {high > 0 && <Pill tone="red">{high} high</Pill>}
            {medium > 0 && <Pill tone="amber">{medium} medium</Pill>}
            {bugs.length - high - medium > 0 && <Pill tone="slate">{bugs.length - high - medium} low</Pill>}
            {!bugs.length && <span className="muted">Nothing open.</span>}
          </div>
          <a className="summary-card__link" href="#" onClick={(e) => { e.preventDefault(); go('/bugs'); }}>View bugs →</a>
        </Card>
      </div>

      <div className="dash-row dash-row--lists">
        <div className="stack">
          {executions.flaky.length > 0 && (
            <Card title="Flaky tests" icon={AlertTriangle} actions={<Pill tone="amber">{executions.flaky.length}</Pill>} subtitle="Passed and failed over the period">
              <ul className="list">
                {executions.flaky.map((f) => (
                  <li key={f.test_name} className="list__row" onClick={() => openTest(f.test_name, 'history')}>
                    <div className="list__main">
                      <div className="list__title">{f.test_name}</div>
                      <div className="result-cell" style={{ marginTop: 6 }}>
                        <div className="result-bar">
                          <span className="result-bar__part bar--green" style={{ flexGrow: f.pass_count }} />
                          <span className="result-bar__part bar--red" style={{ flexGrow: f.fail_count }} />
                        </div>
                        <span>{f.pass_count} passed · {f.fail_count} failed</span>
                      </div>
                    </div>
                    <Pill tone="amber" dot={false}>{percent(f.pass_count, f.total_runs)}% stable</Pill>
                    <ChevronRight size={16} className="list__chevron" />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Recently updated tests" icon={FlaskConical}>
            {tests.recent.length ? (
              <ul className="list">
                {tests.recent.slice(0, 6).map((t) => (
                  <li key={t.name} className="list__row" onClick={() => openTest(t.name)}>
                    <div className="list__main">
                      <div className="list__title">{t.name}</div>
                      <div className="list__sub">{t.description || 'No description'} · {t.step_count} steps</div>
                    </div>
                    <span className="cell-muted">{relativeTime(t.updated_at)}</span>
                    <ChevronRight size={16} className="list__chevron" />
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={FlaskConical} title="No test yet" action={null}>Create one with “New test”, at the top right.</EmptyState>}
          </Card>
        </div>

        <Card title="Recent runs" icon={History} flush>
          {executions.recent.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Test</th><th>Status</th><th>Assertions</th><th className="col-num">Duration</th><th className="col-num">When</th><th className="col-chevron" /></tr></thead>
                <tbody>
                  {executions.recent.slice(0, 10).map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => openTest(e.test_name, 'history')} title="Open its run history">
                      <td><span className="cell-title mono">{e.test_name}</span></td>
                      <td><StatusPill status={e.status} /></td>
                      <td className="cell-muted">{e.assertions_total > 0 ? `${e.assertions_passed}/${e.assertions_total}` : '—'}</td>
                      <td className="col-num cell-muted">{formatDuration(e.duration_ms)}</td>
                      <td className="col-num cell-muted">{relativeTime(e.started_at)}</td>
                      <td className="col-chevron"><ChevronRight size={16} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState icon={Play} title={`No run over these ${days} days`}>Run a test from its page, or a campaign.</EmptyState>}
        </Card>
      </div>
    </>
  );
}
