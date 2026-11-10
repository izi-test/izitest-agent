// Exploration MCP tools: explore_app walks a site on its own and reports its bugs, each with
// a test that reproduces it; check_page runs the same checks on the page the agent is on;
// list_bugs lists what was found. See lib/explore.js and lib/bugs.js.

import { z } from 'zod';
import { currentSession } from '../session.js';
import { CHECKS, DEFAULT_IMPACTS, checkPage, titleOf, severityOf, assertionOf } from '../explore.js';
import { runExploration, formatExploration, listBugs, formatBug } from '../bugs.js';

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
    'List the bugs, worst first, each with the test that reproduces it: open ones by default. Two sources: a test run whose failure the diagnosis puts on the app (non_conformity: a requirement not met; regression: app_regression) opens one — the same failure seen again is the same bug, marked fixed when its test passes again unchanged — and explore_app finds the others (console errors, failed requests, broken links, accessibility).',
    {
      status: z.enum(['open', 'dismissed', 'fixed', 'all']).optional().describe('Default: open'),
      project_id: z.number().optional(),
    },
    async ({ status, project_id }) => {
      const bugs = listBugs({ status: status ?? 'open', projectId: project_id });
      if (!bugs.length) return { content: [{ type: 'text', text: `No ${status && status !== 'all' ? status : ''} bug.`.replace('  ', ' ') }] };
      return { content: [{ type: 'text', text: bugs.map(formatBug).join('\n\n') }] };
    }
  );
}
