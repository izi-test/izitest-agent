// Requirement MCP tools: what tests are for (lib/requirements.js). A developer's plain request
// becomes a requirement the agent words as criteria, then plans and records cases for; a
// requirement written in the dashboard or taken from a tool (a Jira story read by the agent)
// is saved the same way. design_tests lays out how to design its tests (lib/requirement-design.js),
// plan_tests keeps the cases chosen; start_recording and create_test_from_gherkin link what they create.

import { z } from 'zod';
import {
  SOURCES, PRIORITIES, CASE_KINDS, TECHNIQUES, saveRequirement, getRequirement, listRequirements, planCases, linkTest, formatRequirement,
} from '../requirements.js';
import { designBrief, withResolution } from '../requirement-design.js';
import { FORMATS, importRequirements, formatImport } from '../requirement-import.js';
import { importFromJira, commentOnJira } from '../jira.js';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] });
const REQUIREMENT = z.string().describe('The requirement: its key ("REQ-12", "SHOP-123") or id');

export function registerRequirementTools(server) {
  // --- Tool: save_requirement ---
  server.tool(
    'save_requirement',
    [
      'Save a requirement — what tests are for: a title, a description, its acceptance criteria. Saved again with the same key,',
      'it is updated (criteria whose text is unchanged keep their tests), and the answer says whether its content changed.',
      'When the user asks for tests from a plain request, with no written requirement ("test that a wrong password is',
      'refused"), save it first: source "prompt", title = their request, criteria = the behaviours you understood it',
      'expects, one per line, each checkable. SHOW those criteria to the user and get their go-ahead before planning or',
      'recording: tests check what the requirement says, not what the app happens to do.',
      'For a story from a tool (a Jira issue you read), source "jira", key = its key, url = its link, criteria = its',
      'acceptance criteria, as written.',
    ].join('\n'),
    {
      title: z.string(),
      criteria: z.array(z.string()).optional().describe('The acceptance criteria, in order: each one observable, with its expected result'),
      description: z.string().optional(),
      key: z.string().optional().describe('Its key in the tool it comes from (e.g. "SHOP-123"). Default: REQ-<id>. Same key → updated.'),
      source: z.enum(SOURCES).optional().describe('prompt (a user\'s request), manual (written by a person), jira, import. Default: manual'),
      url: z.string().optional().describe('Where it lives (the Jira issue)'),
      project_id: z.number().optional(),
      priority: z.enum(PRIORITIES).optional(),
    },
    async ({ title, criteria, description, key, source, url, project_id, priority }) => {
      try {
        const { requirement, isNew, changed } = saveRequirement({
          key, title, description, criteria: criteria ?? [], source, url, projectId: project_id ?? null, priority,
        });
        const head = isNew ? `Saved ${requirement.key}.` : changed ? `Updated ${requirement.key}: its content changed — check that its tests still match it.` : `${requirement.key} is unchanged.`;
        return text(`${head}\n\n${formatRequirement(requirement)}\n\nNext: design_tests(requirement: "${requirement.key}") to review its criteria and design its scenarios, then plan_tests.`);
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: import_requirements ---
  const IMPORTABLE = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm', '.json', '.md', '.markdown'];
  const column = z.string().nullable().optional();
  server.tool(
    'import_requirements',
    [
      'Import requirements from a file: a spreadsheet (CSV, TSV, Excel .xlsx — a test plan, a Jira CSV export), JSON (a list, or a',
      'Jira search result), or a Markdown spec (a heading per requirement, its list items as criteria). Columns are found by their',
      'names, in English or French (Key/Réf., Title/Summary/Intitulé, Description, Acceptance criteria/Critères d\'acceptation,',
      'Priority/Priorité, Link/Lien); criteria written in a description under "Acceptance criteria" are taken out of it.',
      'By default a dry run: it says what is new, what changed, what is unchanged, and saves nothing — show it to the user, then',
      'call again with dry_run: false. Imported again, a requirement is updated under its key (or its title), and its criteria',
      'whose text did not change keep their tests; a changed one with tests linked is flagged.',
    ].join('\n'),
    {
      path: z.string().optional().describe(`The file, by its absolute path on this machine (${IMPORTABLE.join(', ')})`),
      content: z.string().optional().describe('Or the file\'s text (CSV, JSON, Markdown), when there is no file'),
      format: z.enum(FORMATS).optional().describe('Default: told from the file\'s name, else its content'),
      sheet: z.string().optional().describe('Excel: the sheet to read (default: the first)'),
      columns: z.object({ key: column, title: column, description: column, criteria: column, priority: column, url: column }).optional()
        .describe('A table\'s column for a field, by its header, when it is not found by its name; null: not that field'),
      project_id: z.number().optional().describe('The project the requirements belong to'),
      dry_run: z.boolean().optional().describe('Default true: show what would be imported, save nothing'),
    },
    async ({ path, content, format, sheet, columns, project_id, dry_run }) => {
      try {
        let data = content;
        if (path) {
          if (!isAbsolute(path)) return text('Give the file\'s absolute path.', true);
          if (!IMPORTABLE.includes(extname(path).toLowerCase())) return text(`Not a file to import requirements from: ${path} (${IMPORTABLE.join(', ')})`, true);
          if ((await stat(path)).size > 5 * 1024 * 1024) return text('The file is too big (5 MB at most).', true);
          data = await readFile(path);
        }
        if (data == null) return text('Give the file: its path, or its content.', true);
        const result = importRequirements({
          content: data, filename: path ?? '', format, sheet, columns: columns ?? {}, projectId: project_id ?? null, dryRun: dry_run !== false,
        });
        return text(formatImport(result));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: import_from_jira ---
  server.tool(
    'import_from_jira',
    [
      'Read stories from the Jira site set in the dashboard (Settings → Jira) and import them as requirements: those a JQL query',
      'finds ("project = SHOP AND issuetype = Story"), those of their keys, or — sync: true — the ones imported from Jira already,',
      'to see which changed since. Each keeps its key, summary, description, priority and link; its acceptance criteria come',
      'from a field of their own ("Acceptance Criteria") when the site has one, else from the list under "Acceptance criteria" in',
      'its description. By default a dry run: new, changed, unchanged — nothing saved; show it to the user, then call again',
      'with dry_run: false. A changed story with tests linked is flagged: check they still match it. Nothing is written to Jira.',
    ].join('\n'),
    {
      jql: z.string().optional().describe('A JQL query, bounded (e.g. "project = SHOP AND issuetype = Story ORDER BY key")'),
      keys: z.array(z.string()).optional().describe('Or the stories\' keys (e.g. ["SHOP-12", "SHOP-14"])'),
      sync: z.boolean().optional().describe('Or read again the requirements imported from Jira (of project_id, or all)'),
      project_id: z.number().optional().describe('The IziTest project the requirements belong to'),
      dry_run: z.boolean().optional().describe('Default true: show what would be imported, save nothing'),
    },
    async ({ jql, keys, sync, project_id, dry_run }) => {
      try {
        const result = await importFromJira({ jql, keys, sync: !!sync, projectId: project_id ?? null, dryRun: dry_run !== false });
        return text(formatImport(result));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: comment_on_jira ---
  server.tool(
    'comment_on_jira',
    [
      'Tell Jira stories where they stand in IziTest, as a comment on each: its coverage (passing, failing, not run, not',
      'covered), each acceptance criterion with its tests and how they did last, and the campaign it comes from. For the',
      'stories of keys, or those a campaign\'s tests check (its requirements imported from Jira; the others are left out).',
      'One comment a story, IziTest\'s own: posted again, it is updated. This WRITES to the Jira site: by default a dry run',
      'that shows each comment — show it to the user and ask before calling again with dry_run: false.',
    ].join('\n'),
    {
      keys: z.array(z.string()).optional().describe('The stories\' keys (e.g. ["SHOP-12"]): requirements imported from Jira'),
      campaign_id: z.number().int().optional().describe('Or the stories this campaign\'s tests check, with its results'),
      dry_run: z.boolean().optional().describe('Default true: show the comments, post nothing'),
    },
    async ({ keys, campaign_id, dry_run }) => {
      try {
        const result = await commentOnJira({ keys: keys ?? [], campaignId: campaign_id ?? null, dryRun: dry_run !== false });
        const lines = result.comments.map((c) => (c.error
          ? `${c.key}: NOT commented — ${c.error}`
          : `${c.key}: ${result.sent ? `${c.action} — ${c.url}` : `would ${c.action} IziTest's comment:`}${result.sent ? '' : `\n${c.text.replace(/^/gm, '    ')}`}`));
        return text([
          result.sent ? 'Commented on Jira:' : 'Dry run — nothing posted; dry_run: false posts these comments:',
          ...lines, ...result.warnings.map((w) => `Note: ${w}`),
        ].join('\n'));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: design_tests ---
  server.tool(
    'design_tests',
    [
      'How to design the tests of a requirement, laid out for it: its criteria, the cases it already has, the application,',
      'the Gherkin phrases of its project, and the method — review each criterion (can a test tell pass from fail? what to',
      'ask), list what it leaves unsaid, then design scenarios with test techniques (use case, equivalence partitioning,',
      'boundary values, decision table, state transition, error guessing), each with its steps in Gherkin. Apply it, show',
      'the user the result, and plan what they keep with plan_tests. The dashboard\'s "Propose scenarios" uses the same method.',
    ].join('\n'),
    { requirement: REQUIREMENT },
    async ({ requirement }) => {
      const found = getRequirement(requirement);
      return found ? text(designBrief(found, { answer: 'mcp' })) : text(`No requirement ${requirement}.`, true);
    }
  );

  // --- Tool: plan_tests ---
  server.tool(
    'plan_tests',
    [
      'Plan the test cases of a requirement before recording them: for each criterion, the expected path (nominal), and where it',
      'matters another way through (alternative), an error the app must handle (error), a value at the edge (boundary) —',
      'designed with design_tests: with their technique, priority, reason and scenario in Gherkin. Each case gets an id; the',
      'answer says, for each scenario, whether it is ready (every step resolves: create_test_from_gherkin with requirement and',
      'case_id) or has steps to record (start_recording with requirement and case_id). Either way the test is linked to it.',
      'Show the plan to the user before recording. The expected result of each case comes from its criterion: if the app shows',
      'something else when you record, report it as a non-conformity — do not assert what the app shows instead.',
    ].join('\n'),
    {
      requirement: REQUIREMENT,
      cases: z.array(z.object({
        title: z.string().describe('What the case checks, e.g. "A wrong password shows an error and stays on the login page"'),
        criterion: z.number().int().optional().describe('The criterion it checks, by its number (1, 2…). Omit for the whole requirement.'),
        kind: z.enum(CASE_KINDS).optional().describe('Default: nominal'),
        technique: z.enum(TECHNIQUES).optional().describe('The test design technique it comes from'),
        priority: z.enum(PRIORITIES).optional(),
        rationale: z.string().optional().describe('Why this case, in one sentence'),
        gherkin: z.string().optional().describe('Its scenario: "Scenario: …" and its steps, with the project\'s phrases; a step no phrase covers in plain words'),
      })).min(1),
    },
    async ({ requirement, cases }) => {
      try {
        return text(formatRequirement(withResolution(planCases(requirement, cases))));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: link_test ---
  server.tool(
    'link_test',
    'Link a saved test to a requirement: to a planned case (case_id), or to a criterion, or to the whole requirement. Coverage counts it from then on.',
    {
      test_name: z.string(),
      requirement: REQUIREMENT,
      case_id: z.number().int().optional().describe('A case planned with plan_tests'),
      criterion: z.number().int().optional().describe('The criterion it checks, by its number'),
      kind: z.enum(CASE_KINDS).optional(),
    },
    async ({ test_name, requirement, case_id, criterion, kind }) => {
      try {
        return text(formatRequirement(linkTest(requirement, test_name, { caseId: case_id ?? null, criterion: criterion ?? null, kind: kind ?? 'nominal' })));
      } catch (err) {
        return text(err.message, true);
      }
    }
  );

  // --- Tool: get_requirement ---
  server.tool(
    'get_requirement',
    'A requirement with its criteria, the cases of each (planned, or their test and its last run), and its coverage.',
    { requirement: REQUIREMENT },
    async ({ requirement }) => {
      const found = getRequirement(requirement);
      return found ? text(formatRequirement(withResolution(found))) : text(`No requirement ${requirement}.`, true);
    }
  );

  // --- Tool: list_requirements ---
  server.tool(
    'list_requirements',
    'List the requirements, newest first, with their coverage: passing, FAILING, not run yet, not covered.',
    { project_id: z.number().optional() },
    async ({ project_id }) => {
      const requirements = listRequirements({ projectId: project_id });
      if (!requirements.length) return text('No requirement yet. save_requirement records one.');
      return text(requirements.map((r) => {
        const { coverage } = r;
        return `${r.key} — ${r.title} [${r.source}] — ${coverage.status.replace('_', ' ')}${coverage.criteria ? `, ${coverage.covered}/${coverage.criteria} criteria` : ''}, ${coverage.tests} test(s)`;
      }).join('\n'));
    }
  );
}
