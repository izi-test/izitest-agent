#!/usr/bin/env node

// Run a campaign from a CI job or a terminal, and give its result as an exit code.
//
// It asks a running IziTest Agent server (the one whose Chrome has the extension) to replay a
// project's tests, a requirement's or a list, waits for the end, writes the JUnit XML a CI
// reads and the HTML report, and prints a line per failure.
//
//   node bin/campaign.js --project 3 --version 1.4.0 --junit reports/junit.xml
//   node bin/campaign.js --requirement REQ-12 --html reports/campaign.html
//   node bin/campaign.js --tests login,checkout --concurrency 2
//   node bin/campaign.js --project 3 --headless      (in the server's Chrome without windows)
//   node bin/campaign.js --stages stages.json        (the tests in stages: [{ "mode": "sequential",
//                                                     "tests": ["create_order"] }, { "tests": […],
//                                                     "needs_previous": true }])
//
// Only the tests a change needs (lib/regression.js), from the app's repository:
//   node bin/campaign.js --project 3 --changed origin/main          (the files changed since the
//                                                     branch left origin/main, committed or not)
//   node bin/campaign.js --project 3 --files api/src/server.js --touched "POST /api/notes"
//   node bin/campaign.js --project 3 --changed HEAD~1 --include login --plan   (the choice only)
// --repo <dir>: the repository, if not the current folder. With --changed, --files or --commit,
// the commit tested (sha, branch, message) is kept with the campaign, its short sha the version.
// Nothing to run (the change touches no test): exit code 0.
//
// A campaign with a test plan and exit criteria — what says the testing can stop:
//   node bin/campaign.js --project 3 --objective "Release 1.4 can ship" --scope-note "Not the admin pages" \
//     --require-high --no-high-bug --min-coverage 80 --min-pass-rate 95
// --require-high: every requirement of high priority or high risk passes; --no-high-bug: no
// high-severity bug met is left open; --min-coverage: % of the acceptance criteria a test ran
// for; --min-pass-rate: % of the tests that passed. The exit code then follows the verdict.
//
// The token is read from IZITEST_TOKEN, the server from IZITEST_URL (default
// http://127.0.0.1:3467). Exit code 0: every test passed — or, with exit criteria, they are all
// met; 1: a test failed or did not run, or a criterion is not met; 2: the campaign could not be run.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const BASE = (process.env.IZITEST_URL || 'http://127.0.0.1:3467').replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json', ...(process.env.IZITEST_TOKEN ? { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` } : {}) };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(isJson ? data.error ?? `HTTP ${res.status}` : `HTTP ${res.status}`);
  return data;
}

const list = (value) => value?.split(',').map((t) => t.trim()).filter(Boolean);
const repo = option('repo') ?? process.cwd();
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The files changed since `ref` (since the branch left it), committed or not, new ones included. */
function changedSince(ref) {
  const base = git('merge-base', ref, 'HEAD');
  const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set([...lines(git('diff', '--name-only', base)), ...lines(git('ls-files', '--others', '--exclude-standard'))])];
}

/** The commit tested: HEAD, and whether changes not committed are tested with it. */
function headCommit() {
  return {
    sha: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    message: git('log', '-1', '--format=%B'),
    dirty: git('status', '--porcelain') !== '',
  };
}

function save(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`Written: ${file}`);
}

try {
  const project = option('project');
  const stagesFile = option('stages');
  const changedFiles = option('changed') ? changedSince(option('changed')) : list(option('files')) ?? [];
  const touched = list(option('touched')) ?? [];
  const include = list(option('include')) ?? [];
  const forChange = changedFiles.length > 0 || touched.length > 0;
  if ((option('changed') || option('files')) && !forChange) {
    console.log('Nothing to run: no file changed.');
    process.exit(0);
  }
  const commit = forChange || args.includes('--commit') ? headCommit() : undefined;
  if (args.includes('--plan')) {
    const { selection } = await api('POST', '/api/campaigns/select', {
      project_id: project ? Number(project) : undefined, changed_files: changedFiles, touched, include, commit_message: commit?.message,
    });
    console.log(`${selection.tests.length} of ${selection.total} test(s) to run${selection.full ? ` — all of them: ${selection.why_full.join('; ')}` : ''}`);
    for (const t of selection.tests) console.log(`  ✓ ${t.name}: ${t.reasons.join('; ')}`);
    for (const t of selection.left_out) console.log(`  · ${t.name}: ${t.why}`);
    if (selection.uncovered.length) console.log(`No test goes to ${selection.uncovered.join(', ')}`);
    process.exit(0);
  }
  const answer = await api('POST', '/api/campaigns', {
    changed_files: forChange ? changedFiles : undefined,
    touched: forChange ? touched : undefined,
    include: forChange ? include : undefined,
    commit,
    stages: stagesFile ? JSON.parse(readFileSync(stagesFile, 'utf8')) : undefined,
    project_id: project ? Number(project) : undefined,
    requirement: option('requirement'),
    tests: option('tests')?.split(',').map((t) => t.trim()).filter(Boolean),
    version: option('version'),
    name: option('name'),
    concurrency: option('concurrency') ? Number(option('concurrency')) : undefined,
    headless: args.includes('--headless'),
    objective: option('objective'),
    scope_note: option('scope-note'),
    exit_criteria: {
      high_requirements_passing: args.includes('--require-high') || undefined,
      no_open_high_bug: args.includes('--no-high-bug') || undefined,
      min_coverage: option('min-coverage') ? Number(option('min-coverage')) : undefined,
      min_pass_rate: option('min-pass-rate') ? Number(option('min-pass-rate')) : undefined,
    },
  });
  if (answer.nothing_to_run) {
    console.log(answer.message);
    process.exit(0);
  }
  const started = answer.campaign;
  console.log(`Campaign #${started.id} "${started.name}": ${started.total} test(s)${started.selection && !started.selection.full ? `, chosen for the change (${started.selection.left_out.length} left out)` : ''}`);

  let campaign = started;
  while (campaign.running) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    ({ campaign } = await api('GET', `/api/campaigns/${started.id}`));
  }

  const { totals } = campaign;
  console.log(`${totals.passed} passed, ${totals.failed} failed${totals.error ? `, ${totals.error} could not run` : ''}${totals.skipped ? `, ${totals.skipped} not run` : ''}`);
  for (const t of campaign.runs.filter((r) => r.status === 'failed' || r.status === 'error')) {
    console.log(`  ✗ ${t.name}${t.failed_step ? ` (step ${t.failed_step})` : ''}${t.triage ? ` — ${t.triage.cause}: ${t.triage.summary}` : ''}`);
  }
  if (campaign.changes?.regressed.length) console.log(`Regressed since their last campaign: ${campaign.changes.regressed.join(', ')}`);
  // Failures put on the app, kept in the Bugs page (lib/bugs.js); and those fixed now.
  for (const b of campaign.bugs?.met ?? []) console.log(`Bug #${b.id} (${b.new ? 'new' : `seen ${b.occurrences} times`}) — ${b.test}: ${b.title}`);
  if (campaign.bugs?.fixed.length) console.log(`Fixed: ${campaign.bugs.fixed.map((b) => `bug #${b.id} (${b.test})`).join(', ')} — their test passes again`);

  if (option('junit')) save(option('junit'), await api('GET', `/api/campaigns/${started.id}/junit.xml`));
  if (option('html')) save(option('html'), await api('GET', `/api/campaigns/${started.id}/report.html`));
  if (campaign.residual_risk?.length) console.log(`Residual risk: ${campaign.residual_risk.map((r) => `${r.key} (${r.risk} risk, ${r.status.replace('_', ' ')})`).join(', ')}`);
  // With exit criteria, they decide: a campaign can be done with a low-risk test failing.
  if (campaign.exit) {
    console.log(`Exit criteria ${campaign.exit.verdict === 'met' ? 'met' : 'NOT met'}:`);
    for (const x of campaign.exit.criteria) console.log(`  ${x.met ? '✓' : '✗'} ${x.label} (${x.target}): ${x.actual}${x.failing?.length ? ` — ${x.failing.join(', ')}` : ''}`);
    process.exit(campaign.exit.verdict === 'met' ? 0 : 1);
  }
  process.exit(totals.passed === campaign.total ? 0 : 1);
} catch (err) {
  console.error(`Campaign not run: ${err.message}`);
  process.exit(2);
}
