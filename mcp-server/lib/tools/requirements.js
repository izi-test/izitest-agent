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
