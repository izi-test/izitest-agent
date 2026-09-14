import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../store/hooks';
import { useGetStatsQuery } from '../store/services/statsApi';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  BarChart, Bar,
} from 'recharts';
import {
  FlaskConical, Play, CheckCircle2, XCircle, Clock, ShieldCheck,
  TrendingUp, AlertTriangle, Layers, ChevronRight,
} from 'lucide-react';

const COLORS = {
  passed: '#34d399',
  failed: '#f87171',
  running: '#818cf8',
  pending: '#8888a8',
  accent: '#8a4cfc',
};

function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function Dashboard() {
  const navigate = useNavigate();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);
  const { data: stats, isLoading } = useGetStatsQuery(selectedProjectId);

  if (isLoading || !stats) {
    return (
      <section className="dashboard">
        <p className="empty-state">Loading dashboard...</p>
      </section>
    );
  }

  const { tests, executions } = stats;
  const passRate = executions.total > 0
    ? Math.round((executions.passed / executions.total) * 100)
    : 0;
  const assertionRate = executions.assertions_total > 0
    ? Math.round((executions.assertions_passed / executions.assertions_total) * 100)
    : 0;

  const pieData = [
    { name: 'Passed', value: executions.passed, color: COLORS.passed },
    { name: 'Failed', value: executions.failed, color: COLORS.failed },
    ...(executions.running > 0 ? [{ name: 'Running', value: executions.running, color: COLORS.running }] : []),
  ].filter(d => d.value > 0);

  const hasData = executions.total > 0;

  return (
    <section className="dashboard">
      {/* ── Stat Cards ── */}
      <div className="dash-cards">
        <div className="dash-card">
          <div className="dash-card__icon" style={{ background: 'rgba(129,140,248,0.10)', color: '#818cf8' }}>
            <FlaskConical size={22} />
          </div>
          <div className="dash-card__body">
            <span className="dash-card__value">{tests.total}</span>
            <span className="dash-card__label">Total Tests</span>
          </div>
        </div>

        <div className="dash-card">
          <div className="dash-card__icon" style={{ background: 'rgba(52,211,153,0.10)', color: '#34d399' }}>
            <Play size={22} />
          </div>
          <div className="dash-card__body">
            <span className="dash-card__value">{executions.total}</span>
            <span className="dash-card__label">Executions</span>
          </div>
        </div>

        <div className="dash-card">
          <div className="dash-card__icon" style={{ background: passRate >= 80 ? 'rgba(52,211,153,0.10)' : 'rgba(248,113,113,0.10)', color: passRate >= 80 ? '#34d399' : '#f87171' }}>
            <TrendingUp size={22} />
          </div>
          <div className="dash-card__body">
            <span className="dash-card__value">{passRate}%</span>
            <span className="dash-card__label">Pass Rate</span>
          </div>
        </div>

        <div className="dash-card">
          <div className="dash-card__icon" style={{ background: 'rgba(251,191,36,0.10)', color: '#fbbf24' }}>
            <Clock size={22} />
          </div>
          <div className="dash-card__body">
            <span className="dash-card__value">{formatDuration(executions.avg_duration_ms)}</span>
            <span className="dash-card__label">Avg Duration</span>
          </div>
        </div>

        <div className="dash-card">
          <div className="dash-card__icon" style={{ background: 'rgba(138,76,252,0.15)', color: '#bd9dff' }}>
            <ShieldCheck size={22} />
          </div>
          <div className="dash-card__body">
            <span className="dash-card__value">{assertionRate}%</span>
            <span className="dash-card__label">Assertions Pass</span>
          </div>
        </div>
      </div>

      {/* ── Charts Row ── */}
      <div className="dash-charts">
        {/* Execution Trend */}
        <div className="dash-panel">
          <h3 className="dash-panel__title">Execution Trend (30 days)</h3>
          {executions.trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={executions.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradPassed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.passed} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={COLORS.passed} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.failed} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={COLORS.failed} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" />
                <XAxis dataKey="date" tickFormatter={formatDate} fontSize={12} tick={{ fill: 'var(--text-muted)' }} />
                <YAxis fontSize={12} tick={{ fill: 'var(--text-muted)' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#252531', border: '1px solid rgba(72,71,81,0.25)', borderRadius: '8px', fontSize: '13px', color: '#f2effb' }}
                  labelFormatter={(label) => formatDate(String(label))}
                />
                <Area type="monotone" dataKey="passed" name="Passed" stroke={COLORS.passed} fill="url(#gradPassed)" strokeWidth={2} />
                <Area type="monotone" dataKey="failed" name="Failed" stroke={COLORS.failed} fill="url(#gradFailed)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="dash-panel__empty">No execution data yet</div>
          )}
        </div>

        {/* Pass/Fail Pie */}
        <div className="dash-panel dash-panel--narrow">
          <h3 className="dash-panel__title">Pass / Fail</h3>
          {hasData && pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="45%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                  stroke="none"
                >
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Legend
                  verticalAlign="bottom"
                  iconType="circle"
                  iconSize={8}
                  formatter={(value: string) => <span style={{ fontSize: '12px', color: '#8888a8' }}>{value}</span>}
                />
                <Tooltip
                  contentStyle={{ background: '#252531', border: '1px solid rgba(72,71,81,0.25)', borderRadius: '8px', fontSize: '13px', color: '#f2effb' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="dash-panel__empty">No execution data yet</div>
          )}
        </div>
      </div>

      {/* ── Flaky Tests ── */}
      {executions.flaky.length > 0 && (
        <div className="dash-panel">
          <h3 className="dash-panel__title">
            <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
            Flaky Tests
          </h3>
          <ResponsiveContainer width="100%" height={Math.max(120, executions.flaky.length * 44)}>
            <BarChart data={executions.flaky} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" horizontal={false} />
              <XAxis type="number" fontSize={12} tick={{ fill: 'var(--text-muted)' }} allowDecimals={false} />
              <YAxis type="category" dataKey="test_name" width={160} fontSize={12} tick={{ fill: '#f2effb' }} />
              <Tooltip
                contentStyle={{ background: '#252531', border: '1px solid rgba(72,71,81,0.25)', borderRadius: '8px', fontSize: '13px', color: '#f2effb' }}
              />
              <Bar dataKey="pass_count" name="Passed" stackId="a" fill={COLORS.passed} radius={[0, 0, 0, 0]} />
              <Bar dataKey="fail_count" name="Failed" stackId="a" fill={COLORS.failed} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Tables Row ── */}
      <div className="dash-tables">
        {/* Recent Tests */}
        <div className="dash-panel">
          <h3 className="dash-panel__title">
            <FlaskConical size={16} />
            Recent Tests
          </h3>
          {tests.recent.length > 0 ? (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Steps</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tests.recent.map(t => (
                  <tr key={t.name} className="dash-table__row--clickable" onClick={() => navigate(`/tests/${encodeURIComponent(t.name)}`)}>
                    <td>
                      <span className="dash-table__name">{t.name}</span>
                      {t.description && <span className="dash-table__desc">{t.description}</span>}
                    </td>
                    <td>
                      <span className="dash-table__badge">
                        <Layers size={12} /> {t.step_count}
                      </span>
                    </td>
                    <td className="dash-table__muted">{formatDate(t.updated_at)}</td>
                    <td><ChevronRight size={14} className="dash-table__arrow" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dash-panel__empty">No tests yet</div>
          )}
        </div>

        {/* Recent Executions */}
        <div className="dash-panel">
          <h3 className="dash-panel__title">
            <Play size={16} />
            Recent Reports
          </h3>
          {executions.recent.length > 0 ? (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Status</th>
                  <th>Assertions</th>
                  <th>Duration</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {executions.recent.map(e => (
                  <tr key={e.id}>
                    <td>
                      <span className="dash-table__name">{e.test_name}</span>
                    </td>
                    <td>
                      <span className={`dash-status dash-status--${e.status}`}>
                        {e.status === 'success' ? <CheckCircle2 size={13} /> : e.status === 'failed' ? <XCircle size={13} /> : <Clock size={13} />}
                        {e.status}
                      </span>
                    </td>
                    <td>
                      {e.assertions_total > 0 ? (
                        <span className="dash-table__assertions">
                          <span className="dash-assertion dash-assertion--pass">{e.assertions_passed}</span>
                          /
                          <span className="dash-assertion dash-assertion--fail">{e.assertions_failed}</span>
                          / {e.assertions_total}
                        </span>
                      ) : (
                        <span className="dash-table__muted">—</span>
                      )}
                    </td>
                    <td className="dash-table__muted">{formatDuration(e.duration_ms)}</td>
                    <td className="dash-table__muted">{formatDateTime(e.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dash-panel__empty">No executions yet</div>
          )}
        </div>
      </div>
    </section>
  );
}
