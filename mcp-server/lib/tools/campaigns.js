// Campaign MCP tools (lib/campaigns.js): run a project's tests, a requirement's or a list
// together, for a version of the app, and read what came of it — what failed and why, what
// regressed since the last campaign of the same tests, where each requirement stands — and its
// results sent to a tool (lib/connectors: Xray).

import { z } from 'zod';
import { startCampaign, getCampaign, listCampaigns, stopCampaign, formatCampaign, MAX_CONCURRENCY } from '../campaigns.js';
import { connectorsFor, sendResults, formatResults } from '../connectors/index.js';

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] });

// How long run_campaign waits for the end before answering with where it stands.
const WAIT_MS = 10 * 60_000;

export function registerCampaignTools(server, { sendCommand }) {
  // --- Tool: run_campaign ---
  server.tool(
    'run_campaign',
    [
      'Run a campaign: the tests of a project, of a requirement (the tests linked to it), or a list, replayed together for a',
      'version of the app — each in a window of its own, closed after, a few at a time. A failure is diagnosed as with run_test.',
      'The answer is the report: what passed, what failed and why (the triage), what regressed or was fixed since the last',
      'campaign of the same tests, where each requirement stands criterion by criterion, the non-conformities. It waits for',
      'the end (up to 10 minutes; past that, get_campaign follows it). The dashboard shows it too, with JUnit and HTML reports.',
      'With stages, the tests run stage after stage — a stage side by side or one test after the other —, and a value a test',
      'keeps (capture) is given to the tests after it: a test that creates an order, then those that use its number. Keep tests',
      'independent when they can be (each creates its own data); stages are for what cannot.',
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
    },
    async ({ project_id, requirement, tests, stages, version, name, concurrency, wait, headless }) => {
      let started;
      try {
        started = startCampaign({ name, tests, requirement, projectId: project_id ?? null, version, concurrency, headless: headless === true, stages: stages ?? null }, { sendCommand });
      } catch (err) {
        return text(err.message, true);
      }
      const { campaign, finished } = started;
      if (wait !== false) await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
      return text(formatCampaign(getCampaign(campaign.id)));
    }
  );

  // --- Tool: get_campaign ---
  server.tool(
    'get_campaign',
    'A campaign\'s report: each test and how it did, the failures and their triage, what regressed or was fixed since the last campaign of the same tests, the requirements criterion by criterion.',
    { id: z.number().int() },
    async ({ id }) => {
      const campaign = getCampaign(id);
      return campaign ? text(formatCampaign(campaign)) : text(`No campaign #${id}.`, true);
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
