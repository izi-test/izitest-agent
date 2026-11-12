// The progress report: where the testing stands over a period, for someone who does not open
// the tool — what ran and how it did, where the requirements stand, the bugs opened and fixed
// and their trend, what is in the way, what stays at risk, what comes next. The completion
// report of one campaign is its own report (lib/campaigns.js htmlReport).

import { db, parseJson } from './db.js';
import { listCampaigns } from './campaigns.js';
import { listRequirements, riskRank } from './requirements.js';
import { UNRESOLVED_STATUSES } from './bugs.js';

const DAY = 24 * 3600 * 1000;
const SEVERITIES = ['high', 'medium', 'low'];
const COVERAGE = ['passing', 'failing', 'not_run', 'not_covered'];
const COVERAGE_LABELS = { passing: 'passing', failing: 'failing', not_run: 'not run yet', not_covered: 'not covered' };

const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const dayOf = (iso) => String(iso).slice(0, 10);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A bound of the period: a date ("2026-11-03": its first instant, or its last for the end) or an instant. */
function boundOf(value, name, end = false) {
  if (value instanceof Date) return value;
  const text = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T${end ? '23:59:59.999' : '00:00:00.000'}Z`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`"${value}" is not a date for ${name} (e.g. 2026-11-03)`);
  return date;
}

/** The period reported: `to` is now when not said, `from` seven days before it. */
export function periodOf({ from, to, now = new Date() } = {}) {
  const end = to ? boundOf(to, 'to', true) : now;
  const start = from ? boundOf(from, 'from') : new Date(end.getTime() - 7 * DAY);
  if (start > end) throw new Error('The period ends before it starts');
  return { from: start.toISOString(), to: end.toISOString(), days: Math.max(1, Math.ceil((end - start) / DAY)) };
}

/**
 * Bugs opened and fixed over the period, in buckets of a day (of several days past a month),
 * with what was left unresolved at the end of each. A bug set aside (dismissed, duplicate) is
 * not in the backlog; a deferred one still is.
 */
function trendOf(bugs, period) {
  const size = Math.ceil(period.days / 31);
  const counted = bugs.filter((b) => !['dismissed', 'duplicate'].includes(b.status));
  const buckets = [];
  for (let start = Date.parse(period.from); start < Date.parse(period.to); start += size * DAY) {
    const from = new Date(start).toISOString();
    const to = new Date(Math.min(start + size * DAY, Date.parse(period.to) + 1)).toISOString();
    const within = (iso) => iso && iso >= from && iso < to;
    buckets.push({
      date: dayOf(from),
      opened: counted.filter((b) => within(b.first_seen)).length,
      fixed: counted.filter((b) => b.status === 'fixed' && within(b.fixed_at)).length,
      unresolved: counted.filter((b) => b.first_seen < to && !(b.status === 'fixed' && b.fixed_at && b.fixed_at < to)).length,
    });
  }
  return buckets;
}

/** What the figures say is in the way, each with how many and what to do about it. */
function obstaclesOf({ runs, repairs, bugs, requirements }) {
  const list = [];
  if (runs.causes.environment) {
    list.push({ id: 'environment', count: runs.causes.environment, text: `${plural(runs.causes.environment, 'run')} failed on the environment (the app did not answer, a page did not load): the results of those tests say nothing about the app.` });
  }
  if (repairs) list.push({ id: 'repairs', count: repairs, text: `${plural(repairs, 'test repair')} proposed and not decided: those tests stay red until someone accepts or refuses the repair.` });
  const outdated = (runs.causes.test_outdated ?? 0);
  if (outdated) list.push({ id: 'test_outdated', count: outdated, text: `${plural(outdated, 'run')} failed because the test is behind its requirement: the test is to be recorded again.` });
  const unreproduced = bugs.filter((b) => b.source === 'report' && UNRESOLVED_STATUSES.includes(b.status) && !b.reproduced);
  if (unreproduced.length) {
    list.push({ id: 'unreproduced', count: unreproduced.length, text: `${plural(unreproduced.length, 'reported bug')} not reproduced yet (${unreproduced.map((b) => `#${b.id}`).join(', ')}): no test shows ${unreproduced.length === 1 ? 'it' : 'them'}, so no run can confirm a fix.` });
  }
  const unassigned = bugs.filter((b) => b.severity === 'high' && ['open', 'to_retest'].includes(b.status) && !b.assignee);
  if (unassigned.length) list.push({ id: 'unassigned', count: unassigned.length, text: `${plural(unassigned.length, 'high-severity bug')} with nobody assigned (${unassigned.map((b) => `#${b.id}`).join(', ')}).` });
  const blind = requirements.filter((r) => r.coverage.status === 'not_covered' && (r.risk === 'high' || r.priority === 'high'));
  if (blind.length) list.push({ id: 'not_covered', count: blind.length, text: `${plural(blind.length, 'requirement')} of high risk or priority with no test (${blind.map((r) => r.key).join(', ')}).` });
  return list;
}

/** What comes next, the most pressing first. */
function nextOf({ bugs, residual, requirements, lastCampaign, repairs }) {
  const list = [];
  const ids = (rows) => rows.map((b) => `#${b.id}`).join(', ');
  const high = bugs.filter((b) => b.status === 'open' && b.severity === 'high');
  if (high.length) list.push(`Fix the ${plural(high.length, 'open high-severity bug')}: ${ids(high)}.`);
  const retest = bugs.filter((b) => b.status === 'to_retest');
  if (retest.length) list.push(`Run the confirmation test of ${plural(retest.length, 'bug')} said fixed: ${ids(retest)}.`);
  const unreproduced = bugs.filter((b) => b.source === 'report' && UNRESOLVED_STATUSES.includes(b.status) && !b.reproduced);
  if (unreproduced.length) list.push(`Have the agent reproduce ${plural(unreproduced.length, 'reported bug')}: ${ids(unreproduced)}.`);
  if (lastCampaign?.exit?.verdict === 'not_met') {
    const missed = lastCampaign.exit.criteria.filter((x) => !x.met).map((x) => x.label.toLowerCase());
    list.push(`Campaign #${lastCampaign.id} did not meet its exit criteria (${missed.join('; ')}): run it again once fixed.`);
  }
  const uncovered = residual.filter((r) => r.status === 'not_covered');
  if (uncovered.length) list.push(`Record tests for the ${plural(uncovered.length, 'requirement')} at risk that ${uncovered.length === 1 ? 'has' : 'have'} none: ${uncovered.map((r) => r.key).join(', ')}.`);
  const notRun = requirements.filter((r) => r.coverage.status === 'not_run');
  if (notRun.length) list.push(`Run the tests of ${plural(notRun.length, 'requirement')} never run: ${notRun.map((r) => r.key).join(', ')}.`);
  if (repairs) list.push(`Decide the ${plural(repairs, 'test repair')} proposed.`);
  const deferred = bugs.filter((b) => b.status === 'deferred');
  if (deferred.length) list.push(`Review the ${plural(deferred.length, 'deferred bug')} before the release: ${ids(deferred)}.`);
  if (!list.length) list.push('Nothing is pending: the requirements pass and no bug is left to deal with.');
  return list;
}

/**
 * Where the testing of a project (or of everything) stands over a period.
 * `from`, `to`: dates or instants; by default the last seven days.
 */
export function progressReport({ projectId = null, from, to, now = new Date() } = {}) {
  const period = periodOf({ from, to, now });
  const project = projectId ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) : null;
  if (projectId && !project) throw new Error(`No project #${projectId}`);
  const inPeriod = (iso) => iso && iso >= period.from && iso <= period.to;

  // Campaigns of the period, oldest first, with their verdict.
  const campaigns = listCampaigns({ projectId, limit: 500 }).filter((c) => inPeriod(c.created_at)).reverse().map((c) => ({
    id: c.id, name: c.name, version: c.version, created_at: c.created_at, status: c.running ? 'running' : c.status,
    total: c.total, passed: c.totals.passed, failed: (c.totals.failed ?? 0) + (c.totals.error ?? 0),
    pass_rate: percentOf(c.totals.passed, c.total), exit: c.exit, objective: c.objective,
    regressed: c.changes?.regressed ?? [], residual_risk: c.residual_risk ?? [],
  }));

  // Every run of the period, in a campaign or not.
  const runRows = db.prepare(
    `SELECT e.status, e.triage, e.test_name FROM test_executions e JOIN tests t ON t.id = e.test_id
     WHERE e.started_at >= ? AND e.started_at <= ?${projectId ? ' AND t.project_id = ?' : ''}`,
  ).all(...[period.from, period.to, ...(projectId ? [projectId] : [])]);
  // A run is kept as success, failed or error (a campaign calls the first passed).
  const finished = runRows.filter((r) => ['success', 'failed', 'error'].includes(r.status));
  const causes = {};
  for (const r of finished.filter((x) => x.status !== 'success')) {
    const cause = parseJson(r.triage)?.cause ?? 'not_diagnosed';
    causes[cause] = (causes[cause] ?? 0) + 1;
  }
  const passed = finished.filter((r) => r.status === 'success').length;
  const runs = {
    total: finished.length, passed, failed: finished.length - passed, pass_rate: percentOf(passed, finished.length),
    tests: new Set(finished.map((r) => r.test_name)).size, causes,
  };

  // The requirements as they stand now.
  const all = listRequirements({ projectId: projectId ?? undefined });
  const byStatus = Object.fromEntries(COVERAGE.map((s) => [s, all.filter((r) => r.coverage.status === s).length]));
  const criteria = all.reduce((sum, r) => sum + r.coverage.criteria, 0);
  const covered = all.reduce((sum, r) => sum + r.coverage.covered, 0);
  const requirements = {
    total: all.length, ...byStatus, criteria, criteria_covered: covered, coverage: percentOf(covered, criteria),
    by_risk: Object.fromEntries(['high', 'medium', 'low'].map((risk) => {
      const of = all.filter((r) => r.risk === risk);
      return [risk, { total: of.length, passing: of.filter((r) => r.coverage.status === 'passing').length }];
    })),
    unrated: all.filter((r) => !r.risk).length,
  };
  const residual = all.filter((r) => (r.risk === 'high' || r.risk === 'medium') && r.coverage.status !== 'passing')
    .sort((a, b) => riskRank(b) - riskRank(a))
    .map((r) => ({ key: r.key, title: r.title, risk: r.risk, priority: r.priority, status: r.coverage.status }));

  // The bugs: what the period opened and fixed, what is left.
  const bugRows = db.prepare(`SELECT * FROM bugs${projectId ? ' WHERE project_id = ?' : ''}`).all(...(projectId ? [projectId] : []))
    .map((b) => ({ ...b, reproduced: !!b.reproduced }));
  const unresolved = bugRows.filter((b) => UNRESOLVED_STATUSES.includes(b.status));
  const brief = (b) => ({ id: b.id, title: b.title, severity: b.severity, priority: b.priority, assignee: b.assignee, status: b.status, first_seen: b.first_seen });
  const bugs = {
    opened: bugRows.filter((b) => inPeriod(b.first_seen) && !['dismissed', 'duplicate'].includes(b.status)).length,
    fixed: bugRows.filter((b) => b.status === 'fixed' && inPeriod(b.fixed_at)).length,
    unresolved: unresolved.length,
    by_severity: Object.fromEntries(SEVERITIES.map((s) => [s, unresolved.filter((b) => b.severity === s).length])),
    by_status: Object.fromEntries(UNRESOLVED_STATUSES.map((s) => [s, unresolved.filter((b) => b.status === s).length])),
    list: unresolved.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id - b.id).map(brief),
    trend: trendOf(bugRows, period),
  };

  const repairs = db.prepare(
    `SELECT COUNT(*) AS n FROM test_repairs r JOIN tests t ON t.id = r.test_id WHERE r.status = 'proposed'${projectId ? ' AND t.project_id = ?' : ''}`,
  ).get(...(projectId ? [projectId] : [])).n;

  const lastCampaign = campaigns.filter((c) => c.status !== 'running').at(-1) ?? null;
  return {
    project, period, generated_at: now.toISOString(),
    campaigns, runs, requirements, bugs, residual_risk: residual,
    obstacles: obstaclesOf({ runs, repairs, bugs: bugRows, requirements: all }),
    next: nextOf({ bugs: bugRows, residual, requirements: all, lastCampaign, repairs }),
  };
}

const VERDICTS = { met: 'exit criteria met', not_met: 'exit criteria NOT met', pending: 'running' };
const periodLabel = (p) => `${dayOf(p.from)} → ${dayOf(p.to)}`;

/** The report as text: what an agent reads, and what goes in a message. */
export function formatProgress(r) {
  const { runs, requirements: q, bugs } = r;
  const lines = [
    `Test progress report — ${r.project ? r.project.name : 'all projects'} — ${periodLabel(r.period)} (${plural(r.period.days, 'day')})`,
    '',
    '## Progress',
    runs.total
      ? `${plural(runs.total, 'run')} of ${plural(runs.tests, 'test')}: ${runs.passed} passed, ${runs.failed} failed (${runs.pass_rate}% passed).`
      : 'No test ran in the period.',
    ...(Object.keys(runs.causes).length ? [`Why runs failed: ${Object.entries(runs.causes).sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${cause.replace(/_/g, ' ')} ${n}`).join(', ')}.`] : []),
    q.total
      ? `${plural(q.total, 'requirement')}: ${COVERAGE.filter((s) => q[s]).map((s) => `${q[s]} ${COVERAGE_LABELS[s]}`).join(', ')}. Acceptance criteria covered by a test: ${q.criteria ? `${q.coverage}% (${q.criteria_covered} of ${q.criteria})` : 'none written'}.`
      : 'No requirement yet.',
    ...(q.total && q.unrated < q.total ? [`By risk: ${['high', 'medium', 'low'].filter((k) => q.by_risk[k].total).map((k) => `${k} ${q.by_risk[k].passing}/${q.by_risk[k].total} passing`).join(', ')}${q.unrated ? `, ${q.unrated} not rated` : ''}.`] : []),
    '',
    '## Campaigns',
    ...(r.campaigns.length
      ? r.campaigns.map((c) => `- #${c.id} "${c.name}"${c.version ? ` v${c.version}` : ''} (${dayOf(c.created_at)}): ${c.passed}/${c.total} passed${c.exit ? ` — ${VERDICTS[c.exit.verdict]}` : ''}${c.regressed.length ? ` — regressed: ${c.regressed.join(', ')}` : ''}`)
      : ['No campaign in the period.']),
    '',
    '## Bugs',
    `${bugs.opened} opened and ${bugs.fixed} fixed in the period; ${bugs.unresolved} unresolved now${bugs.unresolved ? ` (${SEVERITIES.filter((s) => bugs.by_severity[s]).map((s) => `${bugs.by_severity[s]} ${s}`).join(', ')}; ${UNRESOLVED_STATUSES.filter((s) => bugs.by_status[s]).map((s) => `${bugs.by_status[s]} ${s.replace('_', ' ')}`).join(', ')})` : ''}.`,
    ...bugs.list.slice(0, 15).map((b) => `- #${b.id} [${b.severity}] ${b.title} — ${b.status.replace('_', ' ')}${b.priority ? `, ${b.priority} priority` : ''}${b.assignee ? `, ${b.assignee}` : ''}`),
    ...(bugs.list.length > 15 ? [`… and ${bugs.list.length - 15} more`] : []),
    ...(bugs.trend.some((d) => d.opened || d.fixed) ? ['Trend (opened / fixed / unresolved at the end):', ...bugs.trend.filter((d) => d.opened || d.fixed).map((d) => `  ${d.date}: +${d.opened} / -${d.fixed} / ${d.unresolved}`)] : []),
    '',
    '## Obstacles',
    ...(r.obstacles.length ? r.obstacles.map((o) => `- ${o.text}`) : ['None seen.']),
    '',
    '## Residual risk',
    ...(r.residual_risk.length
      ? r.residual_risk.map((x) => `- ${x.key} ${x.title} — ${x.risk} risk, ${COVERAGE_LABELS[x.status]}`)
      : [q.unrated === q.total && q.total ? 'No requirement has a risk rated (save_requirement: likelihood, impact).' : 'Every requirement at risk passes.']),
    '',
    '## Next',
    ...r.next.map((x) => `- ${x}`),
  ];
  return lines.join('\n');
}

const html = (value) => String(value ?? '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);
const RISK_COLORS = { high: '#b91c1c', medium: '#b45309', low: '#6b7280' };
const COVERAGE_COLORS = { passing: '#15803d', failing: '#b91c1c', not_run: '#1d4ed8', not_covered: '#6b7280' };

/** The bug trend as a picture: opened and fixed side by side per bucket, the backlog as a line. */
function trendChart(trend) {
  if (!trend.some((d) => d.opened || d.fixed || d.unresolved)) return '<p class="meta">No bug in the period.</p>';
  const width = 900; const height = 180; const left = 28; const bottom = 22; const top = 8;
  const max = Math.max(1, ...trend.flatMap((d) => [d.opened, d.fixed, d.unresolved]));
  const slot = (width - left) / trend.length;
  const bar = Math.max(2, Math.min(14, slot / 3));
  const y = (value) => top + (height - top - bottom) * (1 - value / max);
  const every = Math.ceil(trend.length / 10);
  const bars = trend.map((d, i) => {
    const x = left + slot * i + slot / 2;
    return `${d.opened ? `<rect x="${(x - bar).toFixed(1)}" y="${y(d.opened).toFixed(1)}" width="${bar.toFixed(1)}" height="${(height - bottom - y(d.opened)).toFixed(1)}" fill="#b91c1c"><title>${d.date}: ${d.opened} opened</title></rect>` : ''}`
      + `${d.fixed ? `<rect x="${x.toFixed(1)}" y="${y(d.fixed).toFixed(1)}" width="${bar.toFixed(1)}" height="${(height - bottom - y(d.fixed)).toFixed(1)}" fill="#15803d"><title>${d.date}: ${d.fixed} fixed</title></rect>` : ''}`
      + `${i % every === 0 ? `<text x="${x.toFixed(1)}" y="${height - 6}" text-anchor="middle">${d.date.slice(5)}</text>` : ''}`;
  }).join('');
  const line = trend.map((d, i) => `${(left + slot * i + slot / 2).toFixed(1)},${y(d.unresolved).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Bugs opened, fixed and left unresolved over the period">
    <line x1="${left}" y1="${height - bottom}" x2="${width}" y2="${height - bottom}" stroke="#e5e7eb"/>
    <text x="${left - 6}" y="${top + 8}" text-anchor="end">${max}</text><text x="${left - 6}" y="${height - bottom}" text-anchor="end">0</text>
    ${bars}<polyline points="${line}" fill="none" stroke="#1d4ed8" stroke-width="1.5"/>
  </svg>
  <p class="meta"><span class="key" style="background:#b91c1c"></span>opened <span class="key" style="background:#15803d"></span>fixed <span class="key" style="background:#1d4ed8;height:2px"></span>unresolved at the end of the day</p>`;
}

/** The report as a page that stands alone: to send, to print, to read without the tool. */
export function htmlProgress(r) {
  const chip = (text, color) => `<span class="chip" style="color:${color};border-color:${color}">${html(text)}</span>`;
  const { runs, requirements: q, bugs } = r;
  const title = `Test progress report — ${r.project ? r.project.name : 'All projects'}`;
  const figure = (value, label, color = '#111827') => `<div style="color:${color}">${html(value)}<span>${html(label)}</span></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #111827; background: #f9fafb; margin: 0; padding: 24px 16px; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 0 0 8px; }
  section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-top: 16px; }
  .meta { color: #6b7280; } .bad { color: #b91c1c; } .good { color: #15803d; }
  .totals { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 12px; }
  .totals div { font-size: 22px; font-weight: 600; } .totals span { display: block; font-size: 12px; font-weight: 400; color: #6b7280; }
  .chip { display: inline-block; font-size: 11px; padding: 0 6px; border: 1px solid; border-radius: 999px; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 8px; border-top: 1px solid #f3f4f6; vertical-align: top; }
  th { font-size: 12px; color: #6b7280; font-weight: 500; } ul { margin: 0; padding-left: 20px; }
  svg { width: 100%; height: auto; } svg text { font-size: 10px; fill: #6b7280; }
  .key { display: inline-block; width: 10px; height: 10px; margin: 0 4px 0 10px; vertical-align: middle; }
  @media print { body { background: #fff; padding: 0; } section { break-inside: avoid; } }
</style></head>
<body><main>
<h1>${html(title)}</h1>
<div class="meta">${html(periodLabel(r.period))} · ${plural(r.period.days, 'day')} · generated ${html(new Date(r.generated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }))} UTC</div>
<div class="totals">
  ${figure(runs.total ? `${runs.pass_rate}%` : '—', `tests passed (${runs.passed} of ${plural(runs.total, 'run')})`, runs.failed ? '#b45309' : '#15803d')}
  ${figure(q.total ? `${q.passing}/${q.total}` : '—', 'requirements passing')}
  ${figure(q.criteria ? `${q.coverage}%` : '—', 'acceptance criteria covered')}
  ${figure(`+${bugs.opened} / −${bugs.fixed}`, 'bugs opened / fixed')}
  ${figure(bugs.unresolved, 'bugs unresolved', bugs.by_severity.high ? '#b91c1c' : '#111827')}
</div>
<section><h2>What is next</h2><ul>${r.next.map((x) => `<li>${html(x)}</li>`).join('')}</ul></section>
<section><h2>Obstacles</h2>${r.obstacles.length ? `<ul>${r.obstacles.map((o) => `<li>${html(o.text)}</li>`).join('')}</ul>` : '<p class="meta">None seen.</p>'}</section>
<section><h2>Residual risk</h2>${r.residual_risk.length
    ? `<p class="meta">Requirements at risk that do not pass today.</p><table><tr><th>Requirement</th><th>Risk</th><th>Where it stands</th></tr>${r.residual_risk.map((x) => `<tr><td><strong>${html(x.key)}</strong> ${html(x.title)}</td><td>${chip(`${x.risk} risk`, RISK_COLORS[x.risk])}</td><td>${chip(COVERAGE_LABELS[x.status], COVERAGE_COLORS[x.status])}</td></tr>`).join('')}</table>`
    : `<p class="meta">${q.total && q.unrated === q.total ? 'No requirement has a risk rated yet.' : 'Every requirement at risk passes.'}</p>`}</section>
<section><h2>Requirements</h2>${q.total
    ? `<p>${COVERAGE.filter((s) => q[s]).map((s) => `${chip(`${q[s]} ${COVERAGE_LABELS[s]}`, COVERAGE_COLORS[s])}`).join(' ')}</p>
       ${q.unrated < q.total ? `<table><tr><th>Risk</th><th>Requirements</th><th>Passing</th></tr>${['high', 'medium', 'low'].filter((k) => q.by_risk[k].total).map((k) => `<tr><td>${chip(k, RISK_COLORS[k])}</td><td>${q.by_risk[k].total}</td><td>${q.by_risk[k].passing}</td></tr>`).join('')}${q.unrated ? `<tr><td class="meta">not rated</td><td>${q.unrated}</td><td></td></tr>` : ''}</table>` : ''}`
    : '<p class="meta">No requirement yet.</p>'}</section>
<section><h2>Campaigns</h2>${r.campaigns.length
    ? `<table><tr><th>Campaign</th><th>Date</th><th>Passed</th><th>Exit criteria</th><th>Regressed</th></tr>${r.campaigns.map((c) => `<tr><td><strong>#${c.id}</strong> ${html(c.name)}${c.version ? ` <span class="meta">v${html(c.version)}</span>` : ''}${c.objective ? `<div class="meta">${html(c.objective)}</div>` : ''}</td><td>${dayOf(c.created_at)}</td><td>${c.passed}/${c.total} (${c.pass_rate}%)</td><td>${c.exit ? chip({ met: 'met', not_met: 'not met', pending: 'pending' }[c.exit.verdict], { met: '#15803d', not_met: '#b91c1c', pending: '#1d4ed8' }[c.exit.verdict]) : '<span class="meta">none set</span>'}</td><td>${c.regressed.length ? c.regressed.map(html).join(', ') : ''}</td></tr>`).join('')}</table>`
    : '<p class="meta">No campaign in the period.</p>'}
  ${Object.keys(runs.causes).length ? `<p class="meta">Why runs failed in the period: ${Object.entries(runs.causes).sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${html(cause.replace(/_/g, ' '))} ${n}`).join(', ')}.</p>` : ''}</section>
<section><h2>Bugs — trend</h2>${trendChart(bugs.trend)}</section>
<section><h2>Bugs unresolved</h2>${bugs.list.length
    ? `<table><tr><th>Bug</th><th>Severity</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Since</th></tr>${bugs.list.map((b) => `<tr><td><strong>#${b.id}</strong> ${html(b.title)}</td><td>${chip(b.severity, RISK_COLORS[b.severity])}</td><td>${html(b.status.replace('_', ' '))}</td><td>${html(b.priority ?? '')}</td><td>${html(b.assignee ?? '')}</td><td>${dayOf(b.first_seen)}</td></tr>`).join('')}</table>`
    : '<p class="meta">None.</p>'}</section>
</main></body></html>
`;
}
