// Generated code for the checks of what a page does wrong on its own — the assertions a bug's
// test makes (lib/explore.js): no console error, no failed request, a link that answers, no
// accessibility violation. Playwright has no such assertion: the errors and failed requests
// are collected from the start of the test, links are asked with page.request, accessibility
// is checked by @axe-core/playwright.

export const COLLECTED = new Set(['no_console_errors', 'no_failed_requests']);
export const AXE_IMPORT = `import AxeBuilder from '@axe-core/playwright'; // npm i -D @axe-core/playwright`;

const assertionsOf = (steps) => (steps ?? []).map((step) => step.assertion ?? (step.command === 'assert' ? step.params : null)).filter(Boolean);

/** Whether the steps check console errors or failed requests: collectors are needed from the start. */
export const needsCollectors = (steps) => assertionsOf(steps).some((a) => COLLECTED.has(a.type));
export const needsAxe = (steps) => assertionsOf(steps).some((a) => a.type === 'no_a11y_violations');

/** The collectors, at the start of a test: what the page logs as errors, the requests it fails. */
export function collectorLines(page = 'page', errors = 'const consoleErrors', failures = 'const failedRequests') {
  const list = (declaration) => declaration.replace(/^const /, '');
  return [
    '// What the page logs as errors, and the requests it fails, from the start: the checks read them.',
    `${errors} = [];`,
    `${page}.on('console', (message) => { if (message.type() === 'error') ${list(errors)}.push(message.text()); });`,
    `${page}.on('pageerror', (error) => ${list(errors)}.push(error.message));`,
    `${failures} = [];`,
    `${page}.on('response', (response) => { if (response.status() >= 400) ${list(failures)}.push(\`\${response.request().method()} \${response.url()} → \${response.status()}\`); });`,
    `${page}.on('requestfailed', (request) => ${list(failures)}.push(\`\${request.method()} \${request.url()} → failed\`));`,
  ];
}

/**
 * The code of one such check, `literal` quoting values. `errors` and `failures` name the
 * collected lists. Null for another assertion type.
 */
export function oracleCode(assertion, literal, { page = 'page', errors = 'consoleErrors', failures = 'failedRequests' } = {}) {
  const { type, expected, selector } = assertion;
  switch (type) {
    case 'no_console_errors':
      return expected
        ? `expect(${errors}.filter((text) => text.includes(${literal(expected)}))).toEqual([]);`
        : `expect(${errors}).toEqual([]);`;
    case 'no_failed_requests':
      return expected
        ? `expect(${failures}.filter((line) => line.includes(${literal(expected)}))).toEqual([]);`
        : `expect(${failures}).toEqual([]);`;
    case 'link_ok':
      return [
        '{',
        `  const href = await ${page}.locator(${literal(selector ?? 'a')}).first().getAttribute('href');`,
        `  const response = await ${page}.request.get(new URL(href, ${page}.url()).href);`,
        '  expect(response.status()).toBeLessThan(400);',
        '}',
      ].join('\n');
    case 'no_a11y_violations': {
      const rules = expected ? `.withRules([${literal(expected)}])` : '';
      const part = selector ? `.include(${literal(selector)})` : '';
      return [
        '{',
        `  const { violations } = await new AxeBuilder({ page: ${page} })${rules}${part}.analyze();`,
        '  expect(violations.map((violation) => violation.id)).toEqual([]);',
        '}',
      ].join('\n');
    }
    default:
      return null;
  }
}
