// Exploration MCP tools: explore_app walks a site on its own and reports its bugs, each with
// a test that reproduces it; check_page runs the same checks on the page the agent is on;
// list_bugs lists what was found. See lib/explore.js and lib/bugs.js.

import { z } from 'zod';
import { currentSession } from '../session.js';
import { CHECKS, DEFAULT_IMPACTS, checkPage, titleOf, severityOf, assertionOf } from '../explore.js';
import { runExploration, formatExploration, listBugs, formatBug, reportBug, updateBug, reproBrief, BUG_STATUSES, BUG_PRIORITIES } from '../bugs.js';
import { connectorsFor, sendBug, formatBugSent } from '../connectors/index.js';

const CHECK_PARAM = z.array(z.enum(['console', 'network', 'links', 'a11y'])).optional()
  .describe('Which checks: console (errors the page logs), network (requests answered 4xx/5xx or failed), links (links to the site\'s own pages that do not answer), a11y (axe-core, WCAG 2.1 A/AA). Default: all.');

export function registerExploreTools(server, { sendCommand: dispatch }) {
  const sess = () => currentSession();
  const sendCommand = (profile, command, params, ...rest) => dispatch(profile, command, sess().scope(params), ...rest);

  // --- Tool: explore_app ---
  server.tool(
    'explore_app',
    [
      'Explore a site on its own and report its bugs — no assertion needed. From `url`, it visits the site\'s pages (same origin,',
      'breadth first, following its links) and on each one checks: the errors the page logs in the console, the requests answered',
      '4xx/5xx or failed, the links to the site\'s own pages that do not answer, the accessibility rules broken (axe-core, serious',
      'and critical). With interact (default true) it also clicks the harmless controls of each page — never delete, pay, log out,',
      'send, confirm… nor a form submit — and checks what each click made the page log or fail.',
      'Each new bug comes with a saved test that reproduces it (bug_<id>_<kind>: the page, the click, the check), replayed at once',
      'to confirm it fails; it will pass once the bug is fixed. Bugs already known are counted again, not doubled.',
      'It runs in a window of its own, closed at the end. Takes about 2–5 s per page.',
    ].join('\n'),
    {
      url: z.string().describe('Where to start: the explorer stays on this URL\'s site'),
      max_pages: z.number().int().min(1).max(50).optional().describe('Pages to visit at most (default 8)'),
      interact: z.boolean().optional().describe('Also click each page\'s harmless controls (default true)'),
      checks: CHECK_PARAM,
      include_moderate: z.boolean().optional().describe('Also report accessibility violations of moderate impact (default: serious and critical only)'),
      confirm: z.boolean().optional().describe('Replay each new bug\'s test to confirm it reproduces the bug (default true)'),
      budget_seconds: z.number().int().min(10).max(900).optional().describe('Time for visiting pages, before the bugs\' tests are replayed (default 120)'),
      project_id: z.number().optional().describe('Project to file the bugs and their tests under. Default: the project whose base URL the url starts with.'),
    },
    async ({ url, max_pages, interact, checks, include_moderate, confirm, budget_seconds, project_id }) => {
      try {
        const report = await runExploration({
          url, sendCommand, projectId: project_id ?? null,
          maxPages: max_pages ?? 8, interact: interact ?? true, checks: checks ?? CHECKS,
          impacts: include_moderate ? [...DEFAULT_IMPACTS, 'moderate'] : DEFAULT_IMPACTS,
          budgetMs: (budget_seconds ?? 120) * 1000, confirm: confirm ?? true,
        });
        return { content: [{ type: 'text', text: formatExploration(report) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Exploration failed: ${err.message}` }] };
      }
    }
  );

  // --- Tool: check_page ---
  server.tool(
    'check_page',
    [
      'Check the page you are on for what goes wrong without an assertion: console errors, requests answered 4xx/5xx or failed,',
      'links to the site\'s own pages that do not answer, accessibility violations (axe-core). Nothing is saved. Console and',
      'network are read from what was captured in this tab since IziTest navigated it (navigate, run_test). To make a test that',
      'reproduces a finding, add the assertion it names with add_assertion to a recorded test of the steps that lead here.',
    ].join('\n'),
    {
      checks: CHECK_PARAM,
      since_seconds: z.number().optional().describe('Console and network: only what happened in the last N seconds (e.g. since your last click). Default: since the tab was navigated.'),
      include_moderate: z.boolean().optional().describe('Also report accessibility violations of moderate impact'),
      tabId: z.number().optional(),
      profile: z.string().optional(),
    },
    async ({ checks, since_seconds, include_moderate, tabId }) => {
      const since = since_seconds ? Date.now() - since_seconds * 1000 : 0;
      const tab = tabId ?? sess().lastTabId;
      const { findings } = await checkPage({
        tabId: tab, sendCommand, since, checks: checks ?? CHECKS,
        impacts: include_moderate ? [...DEFAULT_IMPACTS, 'moderate'] : DEFAULT_IMPACTS,
      });
      if (!findings.length) return { content: [{ type: 'text', text: 'Nothing wrong found on this page.' }] };
      const lines = findings.map((finding) => {
        const assertion = assertionOf(finding);
        const args = Object.entries(assertion).filter(([key]) => key !== 'type').map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ');
        return `[${severityOf(finding)}] ${titleOf(finding)}\n  reproduce with add_assertion(assertion_type: "${assertion.type}", ${args})`;
      });
      return { content: [{ type: 'text', text: `${findings.length} thing(s) wrong on this page:\n\n${lines.join('\n\n')}` }] };
    }
  );

  // --- Tool: list_bugs ---
  server.tool(
    'list_bugs',
    'List the bugs, worst first, each with the test that reproduces it and how it is handled (fix priority, assignee): open ones by default; "unresolved" adds those deferred and those said fixed that wait for their test to confirm it (to_retest). A person reports some (report_bug). Two other sources: a test run whose failure the diagnosis puts on the app (non_conformity: a requirement not met; regression: app_regression) opens one — the same failure seen again is the same bug, marked fixed when its test passes again unchanged — and explore_app finds the others (console errors, failed requests, broken links, accessibility).',
    {
      status: z.enum([...BUG_STATUSES, 'unresolved', 'all']).optional().describe('Default: open'),
      project_id: z.number().optional(),
    },
    async ({ status, project_id }) => {
      const bugs = listBugs({ status: status ?? 'open', projectId: project_id });
      if (!bugs.length) return { content: [{ type: 'text', text: `No ${status && status !== 'all' ? status : ''} bug.`.replace('  ', ' ') }] };
      return { content: [{ type: 'text', text: bugs.map(formatBug).join('\n\n') }] };
    }
  );

  const fail = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true });

  // --- Tool: report_bug ---
  server.tool(
    'report_bug',
    [
      'Keep a bug a person reports, in their words: what goes wrong and how they got there, what they expected, where.',
      'It has no test yet: the answer says how to reproduce it in the browser and record the test that shows it — named bug_<id>_repro,',
      'ending on a check of the EXPECTED behaviour, so that it fails while the bug is there and passes once it is fixed (the bug then closes by itself).',
      'For a failure a test run already met, nothing to report: the run opened the bug.',
    ].join(' '),
    {
      title: z.string().describe('What goes wrong, in a line'),
      description: z.string().optional().describe('What happens and how to get there, as the person tells it'),
      expected: z.string().optional().describe('What should happen instead'),
      page_url: z.string().optional().describe('Where it happens'),
      severity: z.enum(BUG_PRIORITIES).optional().describe('How bad it is for the user (default medium)'),
      priority: z.enum(BUG_PRIORITIES).optional().describe('How urgent its fix is'),
      assignee: z.string().optional().describe('Who has it'),
      project_id: z.number().optional(),
      requirement: z.string().optional().describe('Key of the requirement it breaks, e.g. "REQ-12"'),
    },
    async ({ title, description, expected, page_url, severity, priority, assignee, project_id, requirement }) => {
      try {
        const bug = reportBug({ title, description, expected, pageUrl: page_url, severity: severity ?? 'medium', priority, assignee, projectId: project_id ?? null, requirement });
        return { content: [{ type: 'text', text: `Bug #${bug.id} reported.\n\n${reproBrief(bug)}` }] };
      } catch (err) {
        return fail(err);
      }
    }
  );

  // --- Tool: update_bug ---
  server.tool(
    'update_bug',
    [
      'Handle a bug: its status, how urgent its fix is, who has it.',
      'Statuses: open; to_retest — the developers say it is fixed, its test has to confirm it (run it: passing closes the bug, failing opens it again);',
      'deferred — a real bug, not fixed now (it stays so when seen again, and closes if its test passes); duplicate — the same as another (duplicate_of);',
      'fixed — normally set by its test passing again, by hand only when no test can show it; dismissed — not a bug.',
      'repro_test makes a recorded test the one that reproduces a reported bug.',
    ].join(' '),
    {
      id: z.number().describe('The bug, as list_bugs numbers it'),
      status: z.enum(BUG_STATUSES).optional(),
      priority: z.enum(BUG_PRIORITIES).nullable().optional().describe('How urgent its fix is; null removes it'),
      assignee: z.string().nullable().optional().describe('Who has it; null removes it'),
      duplicate_of: z.number().optional().describe('The bug it repeats: makes it a duplicate'),
      severity: z.enum(BUG_PRIORITIES).optional(),
      title: z.string().optional(),
      repro_test: z.string().nullable().optional().describe('The test that reproduces a reported bug'),
    },
    async ({ id, ...changes }) => {
      try {
        return { content: [{ type: 'text', text: formatBug(updateBug(id, changes)) }] };
      } catch (err) {
        return fail(err);
      }
    }
  );

  // --- Tool: send_bug ---
  server.tool(
    'send_bug',
    [
      `Send a bug to the team's tracker as an issue (${connectorsFor('bugs').map((c) => c.name).join(', ')}): what goes wrong, what was expected, the test that reproduces it, the requirement it breaks.`,
      'A dry run by default: what would be sent, nothing written. Show it to the person, and send (dry_run: false) only on their explicit yes — it writes in their tracker.',
      'Sent again, the same issue is updated, not repeated.',
    ].join(' '),
    {
      id: z.number().describe('The bug, as list_bugs numbers it'),
      connector: z.enum(connectorsFor('bugs').map((c) => c.id)).optional().describe('Default: jira'),
      project_key: z.string().optional().describe('The project of the tracker it goes in, e.g. "SHOP". Default: the one of the requirement it breaks, when that came from the tracker.'),
      issue_type: z.string().optional().describe('Default: Bug'),
      dry_run: z.boolean().optional().describe('Default true: nothing is written'),
    },
    async ({ id, connector, project_key, issue_type, dry_run }) => {
      try {
        const result = await sendBug(connector ?? 'jira', id, { options: { project_key, issue_type }, dryRun: dry_run !== false });
        return { content: [{ type: 'text', text: formatBugSent(result) }] };
      } catch (err) {
        return fail(err);
      }
    }
  );
}
