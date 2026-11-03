// Shared agent tool definitions — used by both MCP (CLI) and API (chat) agents.
// Each tool is a plain object: { name, description, parameters, handler }.
//
// `parameters` is a JSON Schema object (compatible with both Zod conversion for
// MCP and Claude API tool_use input_schema).
//
// `handler(params)` returns { text } for simple results or { data } for structured.

import { db, parseJson } from '../db.js';
import { loadTest, saveTest, listTests } from '../test-store.js';
import { parseFeatureToStepsWith } from '../gherkin/parse.js';
import { serializeTestToFeatureWith } from '../gherkin/serialize.js';
import { withElementNames, elementTargets, listElements } from '../element-store.js';
import {
  writingDefinitions,
  createStepDefinition,
} from '../gherkin/step-definition-store.js';
import { log } from '../logger.js';
import { CODEGEN_FRAMEWORKS, generateTestCode, formatCodeFiles } from '../codegen/index.js';
import { addBusinessStep } from '../business-steps.js';
import { addTestVariable } from '../test-variable.js';
import { linkRecorded, requirementsOfTest } from '../requirements.js';

function projectDefinitions(projectId) {
  return db.prepare(
    'SELECT * FROM step_definitions WHERE project_id = ?'
  ).all(projectId).map(r => ({
    ...r,
    params_template: parseJson(r.params_template) || {},
    steps_template: parseJson(r.steps_template) || null,
  }));
}

// ─── Tool catalogue ─────────────────────────────���──────────────────

export const AGENT_TOOLS = [
  {
    name: 'get_project_context',
    description: 'Get the full context of the current project: name, description, base URL, type, specs/context text, the language its tests are written in (en, fr), its step definitions in that language, and the elements its tests act on — in a Gherkin phrase, the name of one of them goes where a CSS selector goes.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
      },
      required: ['project_id'],
    },
    handler({ project_id }) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
      if (!project) return { error: 'Project not found' };

      const definitions = writingDefinitions(project_id);
      const tests = db.prepare(
        `SELECT t.name, t.description FROM tests t WHERE t.project_id = ?`
      ).all(project_id);

      return {
        data: {
          id: project.id,
          name: project.name,
          description: project.description,
          context: project.context || '',
          project_type: project.project_type,
          base_url: project.base_url,
          // Its tests are written in it: Gherkin, business steps, intents (a feature in French starts with "# language: fr").
          language: project.language ?? 'en',
          step_definitions: definitions.map(d => ({
            id: d.id,
            keyword: d.keyword,
            pattern: d.pattern,
            command: d.command,
            is_default: d.is_default,
            steps_template: d.steps_template,
          })),
          existing_tests: tests.map(t => t.name),
          // By name: where a phrase takes a CSS selector, the name acts on that element.
          elements: listElements(project_id).filter(e => e.used_by.length).map(({ name, page, target }) => ({ name, page, target })),
        },
      };
    },
  },

  {
    name: 'list_project_tests',
    description: 'List all tests in a project with their steps and descriptions.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
      },
      required: ['project_id'],
    },
    handler({ project_id }) {
      const rows = db.prepare(
        `SELECT t.name, t.description, t.variables,
                COUNT(s.id) as step_count
         FROM tests t
         LEFT JOIN test_steps s ON s.test_id = t.id
         WHERE t.project_id = ?
         GROUP BY t.id
         ORDER BY t.updated_at DESC`
      ).all(project_id);

      return {
        data: rows.map(r => ({
          name: r.name,
          description: r.description,
          variables: parseJson(r.variables) || {},
          step_count: r.step_count,
        })),
      };
    },
  },

  {
    name: 'create_test_from_gherkin',
    description: 'Create a new test by parsing a Gherkin feature document. The Gherkin is resolved against the project step definitions to produce executable test steps. Write it in the language of the project\'s tests (get_project_context: language; in French, the feature starts with "# language: fr" and its keywords are Fonctionnalité, Scénario, Soit, Quand, Alors, Et). Where a phrase takes a CSS selector, the name of an element of the project (get_project_context lists them, e.g. When I click on "Save profile") acts on that element as its tests recorded it.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
        gherkin: { type: 'string', description: 'The full Gherkin .feature content to parse' },
        test_name: { type: 'string', description: 'Name for the test' },
        test_description: { type: 'string', description: 'Optional description' },
        requirement: { type: 'string', description: 'The requirement this test checks (key, e.g. "REQ-12"): the test is linked to it' },
        case_id: { type: 'number', description: 'The planned case it is (from plan_tests)' },
        criterion: { type: 'number', description: 'Without a case: the criterion it checks, by its number' },
      },
      required: ['project_id', 'gherkin', 'test_name'],
    },
    handler({ project_id, gherkin, test_name, test_description, requirement, case_id, criterion }) {
      const definitions = db.prepare(
        'SELECT * FROM step_definitions WHERE project_id = ?'
      ).all(project_id).map(r => ({
        ...r,
        params_template: parseJson(r.params_template) || {},
        steps_template: parseJson(r.steps_template) || null,
      }));

      let steps;
      try {
        // A name of an element of the project, where a selector goes, acts on that element.
        steps = parseFeatureToStepsWith(gherkin, definitions, { targets: elementTargets(project_id) });
      } catch (err) {
        if (err.code === 'GHERKIN_UNRESOLVED') {
          return { error: err.message, unresolved: err.errors };
        }
        return { error: err.message };
      }

      const testId = saveTest({
        name: test_name,
        description: test_description || '',
        steps,
      });

      // Assign test to project
      db.prepare('UPDATE tests SET project_id = ? WHERE id = ?').run(project_id, testId);

      log(`[Agent Tool] Created test "${test_name}" (${steps.length} steps) in project ${project_id}`);
      // Linked to what it checks, like a recording started for a requirement.
      const linked = requirement ? linkRecorded({ name: test_name, link: { requirement, caseId: case_id ?? null, criterion: criterion ?? null } }).trim() : null;
      return {
        data: {
          test_id: testId,
          test_name,
          step_count: steps.length,
          steps: steps.map(s => ({ command: s.command, intent: s.intent })),
          ...(linked ? { requirement: linked } : {}),
        },
      };
    },
  },

  {
    name: 'create_step_definition',
    description: 'Create a new step definition (single or composite) in the project. A composite step definition maps one Gherkin phrase to multiple test steps.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
        keyword: { type: 'string', enum: ['Given', 'When', 'Then'], description: 'Gherkin keyword' },
        pattern: { type: 'string', description: 'Cucumber expression pattern, e.g. "I login with {string} and {string}"' },
        command: { type: 'string', description: 'IziTest Agent command (for single step). Omit if steps_template is provided.' },
        params_template: { type: 'object', description: 'Parameter template (for single step)' },
        steps_template: {
          type: 'array',
          description: 'For composite definitions: array of sub-steps, each with command and params',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['command', 'params'],
          },
        },
      },
      required: ['project_id', 'keyword', 'pattern'],
    },
    handler({ project_id, keyword, pattern, command, params_template, steps_template }) {
      const isComposite = Array.isArray(steps_template) && steps_template.length > 0;
      if (!command && !isComposite) {
        return { error: 'Either command or steps_template is required' };
      }

      try {
        const def = createStepDefinition(project_id, {
          keyword,
          pattern,
          command: isComposite ? 'composite' : command,
          params_template: params_template || {},
          steps_template: isComposite ? steps_template : null,
        });
        log(`[Agent Tool] Created step definition "${pattern}" in project ${project_id}`);
        return { data: def };
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { error: `Step definition with pattern "${pattern}" already exists` };
        }
        return { error: err.message };
      }
    },
  },

  {
    name: 'create_business_step',
    description: [
      'Group a run of steps of a recorded test into one business step: a Gherkin phrase in the language of the',
      'domain ("When I keep only houses with a garden") instead of one technical step per click. The step',
      'definition is built from the recorded steps themselves, selectors and locators included, so nothing has',
      'to be retyped. The Cucumber export of this test, and of any test with the same steps, then shows the',
      'phrase, and features/steps/composite.steps.js holds the Playwright actions behind it.',
      'Values that change from one scenario to the next go into the phrase as {string} or {int}, each mapped to',
      'a recorded value by `args`. In the phrase, ( ) and / mean optional text and alternatives in Cucumber',
      'expressions: avoid them. Returns the test\'s feature as it now reads.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID. A test that has no project yet is assigned to this one.' },
        test_name: { type: 'string', description: 'Name of the recorded test' },
        from_step: { type: 'number', description: 'First step to group, numbered from 1' },
        to_step: { type: 'number', description: 'Last step to group, included' },
        keyword: { type: 'string', enum: ['Given', 'When', 'Then'], description: 'Gherkin keyword' },
        pattern: { type: 'string', description: 'The business phrase as a Cucumber expression, e.g. "I keep only houses with a garden" or "I look for a house in {string}"' },
        args: {
          type: 'array',
          description: 'One per parameter of the pattern, in order. { step, param } takes the whole recorded value (e.g. { "step": 3, "param": "value" }); { step, param, value } only that part of it (e.g. { "step": 1, "param": "url", "value": "antony-92160" }); { variable } a variable of the test (e.g. { "variable": "ville" }), which the Cucumber export turns into a Scenario Outline column. Every variable the grouped steps use needs one.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'number' },
              param: { type: 'string' },
              value: { type: 'string' },
              variable: { type: 'string' },
            },
          },
        },
      },
      required: ['project_id', 'test_name', 'from_step', 'to_step', 'keyword', 'pattern'],
    },
    handler({ project_id, test_name, from_step, to_step, keyword, pattern, args = [] }) {
      const test = loadTest(test_name);
      if (!test) return { error: `Test "${test_name}" not found` };
      if (test.project_id && test.project_id !== project_id) {
        return { error: `Test "${test_name}" belongs to project ${test.project_id}, not ${project_id}` };
      }
      if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id)) {
        return { error: `Project ${project_id} not found` };
      }

      const added = addBusinessStep(project_id, test, { from_step, to_step, keyword, pattern, args });
      if (added.error) return { error: added.error };
      return {
        data: {
          step_definition_id: added.definition.id,
          steps_grouped: added.steps_grouped,
          feature: serializeTestToFeatureWith(withElementNames({ ...test, project_id }), projectDefinitions(project_id)),
        },
      };
    },
  },

  {
    name: 'add_test_variable',
    description: [
      'Turn a value recorded in a step into a variable of the test: {{name}} replaces it in the step, and the',
      'recorded value becomes its default. Recording only detects typed values and list choices; use this for',
      'the rest, typically a city or a budget inside a URL. The variable then shows in the dashboard (Data),',
      'run_test can override it, playwright-plain code reads it from VARS, and the Cucumber export makes it a',
      'column of a Scenario Outline. A business step grouping that step maps it with { "variable": "<name>" }.',
      'A name the test already has reuses that variable: e.g. an assertion that checks the e-mail typed in step 2',
      '(add_assertion links new assertions by itself).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        test_name: { type: 'string', description: 'Name of the recorded test' },
        step: { type: 'number', description: 'Step holding the value, numbered from 1' },
        param: { type: 'string', description: 'Parameter of that step, e.g. "url" or "value"' },
        value: { type: 'string', description: 'The part of the recorded value to replace, e.g. "antony-92160" in the URL. Omit it for the whole value.' },
        name: { type: 'string', description: 'Variable name: letters, digits and _, e.g. "ville"' },
        description: { type: 'string', description: 'What the variable stands for (shown in the dashboard)' },
      },
      required: ['test_name', 'step', 'param', 'name'],
    },
    handler({ test_name, step, param, value, name, description }) {
      const test = loadTest(test_name);
      if (!test) return { error: `Test "${test_name}" not found` };

      const result = addTestVariable(test, { step, param, value, name, description });
      if (result.error) return { error: result.error };

      saveTest(result.test);
      log(`[Agent Tool] ${result.reused ? 'Reused' : 'Added'} variable {{${name}}} in step ${step} of "${test_name}"`);
      const { params, assertion, command } = result.test.steps[step - 1];
      return {
        data: {
          variable: name,
          reused: result.reused,
          defaultValue: result.test.variables[name].defaultValue,
          step: { number: step, command, [param]: (command === 'assert' ? assertion : params)[param] },
          variables: Object.keys(result.test.variables),
        },
      };
    },
  },

  {
    name: 'get_test_as_gherkin',
    description: 'Serialize an existing test to Gherkin format.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
        test_name: { type: 'string', description: 'Name of the test' },
      },
      required: ['project_id', 'test_name'],
    },
    handler({ project_id, test_name }) {
      const test = loadTest(test_name);
      if (!test) return { error: `Test "${test_name}" not found` };

      const feature = serializeTestToFeatureWith(withElementNames(test), projectDefinitions(project_id));
      return { data: { feature } };
    },
  },

  {
    name: 'get_test_as_code',
    description: [
      'Generate Playwright code for a recorded test, to commit in the project under test: it runs with plain',
      'Playwright, without the extension and without an LLM, in CI too.',
      '"playwright-plain" (default): one tests/<name>.spec.js, run with `npx playwright test`.',
      '"playwright-cucumber": a standalone project (.feature, step definitions, World, cucumber.js and its own',
      'package.json); the test must belong to a project. Write it in a folder of its own (e.g. e2e/), never over',
      'the repository\'s package.json.',
      'Nothing is written on disk: the files come back as text, write them yourself.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        test_name: { type: 'string', description: 'Name of the test' },
        framework: { type: 'string', enum: CODEGEN_FRAMEWORKS, description: '"playwright-plain" (default) or "playwright-cucumber"' },
      },
      required: ['test_name'],
    },
    handler({ test_name, framework = 'playwright-plain' }) {
      const test = loadTest(test_name);
      if (!test) return { error: `Test "${test_name}" not found` };

      const result = generateTestCode({ ...test, requirements: requirementsOfTest(test.name) }, framework, projectDefinitions);
      if (result.error) return { error: result.error };

      const count = result.files.length;
      return { text: `${count} file${count > 1 ? 's' : ''} for "${test_name}" (${framework}):\n\n${formatCodeFiles(result.files)}` };
    },
  },

  {
    name: 'update_project_context',
    description: 'Update the project context (specs, notes, URLs, type). This context is used to guide test creation.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
        context: { type: 'string', description: 'Free-text project context (specs, notes, URLs...)' },
        project_type: { type: 'string', enum: ['frontend', 'backend', 'fullstack'], description: 'Type of project' },
        base_url: { type: 'string', description: 'Base URL of the application' },
      },
      required: ['project_id'],
    },
    handler({ project_id, context, project_type, base_url }) {
      const sets = [];
      const vals = [];
      if (context !== undefined) { sets.push('context = ?'); vals.push(context); }
      if (project_type !== undefined) { sets.push('project_type = ?'); vals.push(project_type); }
      if (base_url !== undefined) { sets.push('base_url = ?'); vals.push(base_url); }

      if (sets.length === 0) return { error: 'Nothing to update' };

      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      vals.push(project_id);

      const result = db.prepare(
        `UPDATE projects SET ${sets.join(', ')} WHERE id = ? RETURNING *`
      ).get(...vals);

      if (!result) return { error: 'Project not found' };
      log(`[Agent Tool] Updated context for project ${project_id}`);
      return { data: { id: result.id, name: result.name, context: result.context, project_type: result.project_type, base_url: result.base_url } };
    },
  },
];

// ─── Helpers for adapters ──────────────────────────────────────────

/** Build a tool map keyed by name for quick lookup. */
export function getToolMap() {
  const map = {};
  for (const t of AGENT_TOOLS) map[t.name] = t;
  return map;
}

/** Convert tools to Claude API format (for tool_use). */
export function toClaudeTools() {
  return AGENT_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
