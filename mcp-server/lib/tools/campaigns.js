// Campaign MCP tools (lib/campaigns.js): run a project's tests, a requirement's, a list, or those
// a change needs (lib/regression.js, plan_regression), for a version of the app, and read what
// came of it — what failed and why, what regressed since each test's last campaign, where each
// requirement stands — and its results sent to a tool (lib/connectors: Xray).

import { z } from 'zod';
import { progressReport, formatProgress } from '../reports.js';
import { startCampaign, getCampaign, listCampaigns, stopCampaign, formatCampaign, MAX_CONCURRENCY } from '../campaigns.js';
import { connectorsFor, sendResults, formatResults } from '../connectors/index.js';
import { selectTests, formatSelection } from '../regression.js';

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] });

// How long run_campaign waits for the end before answering with where it stands.
const WAIT_MS = 10 * 60_000;

// What a change is, as the tools take it.
const changeParams = {
  changed_files: z.array(z.string()).optional().describe('The files the change touches, from the app\'s repository root (git diff --name-only)'),
  touched: z.array(z.string()).optional().describe('What the change touches in the app, as you know from its code: routes and pages — "POST /api/notes", "/api/review/notes/:id/approve", "/notes/*". Narrows a file whose name says no part of the app (server.js holding every route, App.tsx, api.ts) to what it changes; without it, such a file runs every test'),
  include: z.array(z.string()).optional().describe('Tests to run anyway, by name: the critical paths (logging in, the main flow)'),
};
const commitParam = z.object({
  sha: z.string().optional().describe('git rev-parse HEAD'),
  branch: z.string().optional(),
  message: z.string().optional().describe('Its message: the requirements it names (NDF-3) bring their tests'),
  dirty: z.boolean().optional().describe('true: changes not committed yet are tested with it'),
}).optional();

const exitParam = z.object({
  high_requirements_passing: z.boolean().optional().describe('Every requirement of high priority or high risk the campaign checks passes'),
  no_open_high_bug: z.boolean().optional().describe('No high-severity bug the campaign met is left open'),
  min_coverage: z.number().min(0).max(100).optional().describe('The share of the acceptance criteria a test of the campaign ran for, in %'),
  min_pass_rate: z.number().min(0).max(100).optional().describe('The share of its tests that passed, in %'),
}).optional().describe('Its exit criteria: the campaign\'s report says whether each is met, and the verdict');

export function registerCampaignTools(server, { sendCommand }) {
  // --- Tool: run_campaign ---
  server.tool(
    'run_campaign',
    [
      'Run a campaign: the tests of a project, of a requirement (the tests linked to it), or a list, replayed together for a',
      'version of the app — each in a window of its own, closed after, a few at a time. A failure is diagnosed as with run_test.',
      'The answer is the report: what passed, what failed and why (the triage), what regressed or was fixed since each test\'s',
      'last campaign, where each requirement stands criterion by criterion, the non-conformities. It waits for',
      'the end (up to 10 minutes; past that, get_campaign follows it). The dashboard shows it too, with JUnit and HTML reports.',
      'With stages, the tests run stage after stage — a stage side by side or one test after the other —, and a value a test',
      'keeps (capture) is given to the tests after it: a test that creates an order, then those that use its number. Keep tests',
      'independent when they can be (each creates its own data); stages are for what cannot.',
      'With changed_files (and project_id): only the tests the change needs, each chosen with why — plan_regression shows',
      'the choice first. commit: the commit tested, kept with the campaign; its short sha is the version.',
      'A test manager\'s campaign has a plan: objective, scope_note, and exit_criteria — what says the testing can stop. The',
      'report then gives the verdict (met or not, criterion by criterion) and the residual risk: the requirements at risk that',
      'do not pass. The tests of a project or a requirement run the riskiest first (save_requirement: likelihood, impact).',
    ].join('\n'),
    {
      project_id: z.number().optional().describe('All the tests of this project'),
      requirement: z.string().optional().describe('The tests linked to this requirement (its key, e.g. "REQ-12")'),
      tests: z.array(z.string()).optional().describe('These tests, by name'),
      stages: z.array(z.object({
        name: z.string().optional(),
        tests: z.array(z.string()).min(1).describe('Its tests, by name: each test in one stage only'),
        mode: z.enum(['parallel', 'sequential']).optional().describe('parallel (default): side by side, concurrency at a time; sequential: one after the other, in this order'),
        needs_previous: z.boolean().optional().describe('Runs only if every test of the stages before passed; otherwise its tests are skipped, told why'),
      })).optional().describe('Instead of project_id, requirement or tests: the tests in stages, run one stage after the other'),
      version: z.string().optional().describe('The version of the app tested (e.g. "1.4.0", a commit): campaigns are compared by it'),
      name: z.string().optional().describe('Default: the project\'s or the requirement\'s name'),
      concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional().describe('Tests run at a time (default 3). In the user\'s Chrome, whose windows share its cookies, the tests of a site one of them logs in to still run one at a time; headless, each lane has a Chrome of its own and they run side by side'),
      wait: z.boolean().optional().describe('Wait for the end and answer with the report (default true); false answers at once'),
      headless: z.boolean().optional().describe('Run in the Chrome without windows the server starts (its own profile: no login of the user\'s Chrome), out of the user\'s sight. Installed from the dashboard: Settings → Headless browser'),
      ...changeParams,
      commit: commitParam.describe('The commit tested: kept with the campaign, its short sha the version by default'),
      objective: z.string().optional().describe('Its test plan, first line: what this campaign is for ("check release 1.4 can ship")'),
      scope_note: z.string().optional().describe('Its test plan: what is in scope and what is left out, in a sentence or two'),
      exit_criteria: exitParam,
    },
    async ({ project_id, requirement, tests, stages, version, name, concurrency, wait, headless, changed_files, touched, include, commit, objective, scope_note, exit_criteria }) => {
      let started;
      const changes = changed_files?.length || touched?.length ? { changed_files: changed_files ?? [], touched: touched ?? [], include: include ?? [] } : null;
      try {
        started = startCampaign({ name, tests, requirement, projectId: project_id ?? null, version, concurrency, headless: headless === true, stages: stages ?? null, changes, commit: commit ?? null, objective, scopeNote: scope_note, exitCriteria: exit_criteria ?? null }, { sendCommand });
      } catch (err) {
        // A change that touches no test: nothing to run is an answer, not a failure.
        return text(err.message, err.code !== 'NOTHING_TO_RUN');
      }
      const { campaign, finished } = started;
      if (wait !== false) await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
      return text(formatCampaign(getCampaign(campaign.id)));
    }
  );

  // --- Tool: plan_regression ---
  server.tool(
    'plan_regression',
    [
      'Before a commit, or for one: the tests of a project that the change needs, each with why, and those left out with',
      'why — nothing is run. A test is chosen when a changed file\'s words are in the routes it went to or called the last',
      'time it passed (server/routes/notes.js → POST /api/notes), or in its name; when touched names a route it goes to;',
      'when the commit message names a requirement it checks; when what it touches is not known yet (no run kept it);',
      'when it failed last time; when a chosen test uses a value it keeps. Every test is chosen when a file is shared',
      '(dependencies, configuration, a middleware, the database schema, global styles), or when touched is not given and',
      'a file says no part of the app (server.js, App.tsx) or ties to no test. Run them with run_campaign(project_id,',
      'changed_files, touched, include, commit). The left-out tests are the risk: widen with include when in doubt.',
    ].join('\n'),
    {
      project_id: z.number().int().describe('The project whose tests are chosen (list_projects)'),
      ...changeParams,
      commit_message: z.string().optional().describe('The commit message: a requirement it names (NDF-3) brings its tests'),
    },
    async ({ project_id, changed_files, touched, include, commit_message }) => {
      try {
        return text(formatSelection(selectTests({ projectId: project_id, changedFiles: changed_files ?? [], touched: touched ?? [], include: include ?? [], commitMessage: commit_message ?? '' })));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: get_campaign ---
  server.tool(
    'get_campaign',
    'A campaign\'s report: each test and how it did, the failures and their triage, what regressed or was fixed since each test\'s last campaign, the requirements criterion by criterion, the commit tested and why its tests were chosen.',
    { id: z.number().int() },
    async ({ id }) => {
      const campaign = getCampaign(id);
      return campaign ? text(formatCampaign(campaign)) : text(`No campaign #${id}.`, true);
    }
  );

  // --- Tool: get_progress_report ---
  server.tool(
    'get_progress_report',
    [
      'The test progress report over a period (the last 7 days by default): the runs and how many passed, the campaigns and',
      'whether each met its exit criteria, where the requirements stand (by coverage, by risk), the bugs opened and fixed with',
      'their trend and those unresolved, what is in the way, the residual risk, what comes next. For a test manager who',
      'reports to people who do not open the tool: give it as it is, or shortened. The same report is a page to share at',
      '/api/reports/progress.html (the dashboard\'s Reports page). A campaign\'s own report (get_campaign) is its completion report.',
    ].join('\n'),
    {
      project_id: z.number().optional().describe('The project reported; all of them when not said'),
      from: z.string().optional().describe('First day of the period, e.g. "2026-11-03" (default: 7 days before `to`)'),
      to: z.string().optional().describe('Last day of the period (default: now)'),
    },
    async ({ project_id, from, to }) => {
      try {
        return text(formatProgress(progressReport({ projectId: project_id ?? null, from, to })));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: list_campaigns ---
  server.tool(
    'list_campaigns',
    'List the campaigns, newest first: their version, what passed and failed, the requirements failing.',
    { project_id: z.number().optional() },
    async ({ project_id }) => {
      const campaigns = listCampaigns({ projectId: project_id });
      if (!campaigns.length) return text('No campaign yet. run_campaign runs one.');
      return text(campaigns.map((c) => `#${c.id} "${c.name}"${c.version ? ` v${c.version}` : ''} — ${c.running ? 'running' : c.status}: `
        + `${c.totals.passed}/${c.total} passed${c.failed.length ? `, failed: ${c.failed.join(', ')}` : ''}`
        + `${c.changes?.regressed.length ? `, REGRESSED: ${c.changes.regressed.join(', ')}` : ''}`
        + `${c.failing_requirements.length ? `, requirements failing: ${c.failing_requirements.join(', ')}` : ''} (${c.created_at})`).join('\n'));
    }
  );

  // --- Tool: send_results ---
  const takers = connectorsFor('results');
  server.tool(
    'send_results',
    [
      'Send a campaign\'s results to a tool set in the dashboard (Settings → Connectors) — sent again, what was sent is',
      'updated. This WRITES to the tool: by default a dry run that shows what would be sent — show it to the user and ask',
      'before calling again with dry_run: false. The connectors:',
      ...takers.map((c) => `- ${c.id}: ${c.name}, a ${c.results.what}${c.results.options?.length ? `; options: ${c.results.options.map((o) => `${o.name} (${o.label}, ${o.placeholder})`).join(', ')}` : ''}. ${c.results.note ?? ''}`.trim()),
    ].join('\n'),
    {
      connector: z.enum(takers.map((c) => c.id)).describe('The tool to send to'),
      id: z.number().int().describe('The campaign'),
      options: z.record(z.string()).optional().describe('The connector\'s options (e.g. { "project_key": "SHOP", "test_plan_key": "SHOP-40" })'),
      dry_run: z.boolean().optional().describe('Default true: show what would be sent, send nothing'),
    },
    async ({ connector, id, options, dry_run }) => {
      try {
        return text(formatResults(await sendResults(connector, id, { options: options ?? {}, dryRun: dry_run !== false })));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: stop_campaign ---
  server.tool(
    'stop_campaign',
    'Stop a running campaign: the tests running finish, the others are not started.',
    { id: z.number().int() },
    async ({ id }) => {
      try {
        return text(formatCampaign(stopCampaign(id)));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );
}
