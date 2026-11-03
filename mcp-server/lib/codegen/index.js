// Playwright code for a recorded test, in either framework — shared by the dashboard's
// codegen route and the get_test_as_code tool. Pure: no DB, no filesystem. The project's
// step definitions come from the caller, and are read only for playwright-cucumber.

import { extname } from 'path';
import { readFileSync } from 'fs';
import { generatePlaywrightPlain, usesComputedValues } from './playwright-plain.js';
import { generatePlaywrightCucumber } from './playwright-cucumber.js';

// The code of a test holding computed values carries the very file IziTest computes them with.
export const VALUES_JS = readFileSync(new URL('../values.js', import.meta.url), 'utf8');

export const CODEGEN_FRAMEWORKS = ['playwright-plain', 'playwright-cucumber'];

const FENCE_LANGUAGES = { '.js': 'js', '.ts': 'ts', '.feature': 'gherkin', '.json': 'json' };

/**
 * `{ files: [{ path, content }] }`, or `{ error, status }` where status is what the HTTP
 * API answers. `loadDefinitions(projectId)` returns the project's step definitions.
 */
export function generateTestCode(test, framework, loadDefinitions) {
  if (!CODEGEN_FRAMEWORKS.includes(framework)) {
    return {
      status: 400,
      error: `Unknown framework '${framework}'. Expected one of: ${CODEGEN_FRAMEWORKS.join(', ')}`,
    };
  }

  if (framework === 'playwright-plain') {
    const slug = (test.name || 'test')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'test';
    return {
      files: [
        { path: `tests/${slug}.spec.js`, content: generatePlaywrightPlain(test) },
        ...(usesComputedValues(test) ? [{ path: 'tests/izitest-values.js', content: VALUES_JS }] : []),
      ],
    };
  }

  // playwright-cucumber requires step definitions from the project.
  if (!test.project_id) {
    return {
      status: 400,
      error: 'Test is not assigned to a project; assign it first to generate playwright-cucumber code',
    };
  }
  return { files: generatePlaywrightCucumber(test, loadDefinitions(test.project_id), { valuesJs: VALUES_JS }).files };
}

/**
 * Files as Markdown an agent can write out verbatim: a heading with the path, then the
 * content in a fence longer than any run of backticks it holds.
 */
export function formatCodeFiles(files) {
  return files.map(({ path, content }) => {
    const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    const body = content.endsWith('\n') ? content : `${content}\n`;
    return `### ${path}\n${fence}${FENCE_LANGUAGES[extname(path)] ?? ''}\n${body}${fence}`;
  }).join('\n\n');
}
