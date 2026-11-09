// Generate a plain Playwright test file (@playwright/test) from a izitest-agent
// test object. Pure: no DB access, no filesystem. Returns the file content as
// a single string so the caller can write it to disk or bundle it in a zip.

import { chooseTarget, throughLabel, withFixme } from './locators.js';
import { recordedPathNote, uploadPathsOf } from '../upload-files.js';
import { dropTargetOf, dragToCode } from './drag.js';
import { needsCollectors, needsAxe, collectorLines, oracleCode, AXE_IMPORT } from './oracles.js';
import { requirementTags } from './requirement-tags.js';
import { hasExpression } from '../values.js';

/**
 * Whether a test holds computed values ({{today}}, {{unique}}…) or keeps some as it runs
 * (capture, http): its code then carries izitest-values.js.
 */
/** Whether a test types a secret of its project ({{secret.NAME}}), in a step, a variable or a dataset it carries. */
export function usesSecrets(test, datasets = {}) {
  return /\{\{\s*secret\./.test(JSON.stringify([test.steps ?? [], test.variables ?? {}, datasets]));
}

export function usesComputedValues(test) {
  return hasExpression(JSON.stringify(test.steps ?? []))
    || Object.values(test.variables ?? {}).some((v) => hasExpression(v?.defaultValue))
    || (test.steps ?? []).some((step) => step.command === 'capture' || step.command === 'http')
    || Object.keys(datasetsUsed(test)).length > 0;
}

/**
 * The datasets of its project a test's code carries (`test.datasets`, name → rows): the one it
 * runs the rows of (`test.dataset`), and those an expression of it reads ({{users[2].email}}).
 */
export function datasetsUsed(test) {
  const text = JSON.stringify([test.steps ?? [], Object.values(test.variables ?? {}).map((v) => v?.defaultValue)]);
  return Object.fromEntries(Object.entries(test.datasets ?? {})
    .filter(([name]) => name === test.dataset || new RegExp(`\\b${name}\\s*\\[`).test(text)));
}

export function generatePlaywrightPlain(test) {
  const lines = [];
  const steps = Array.isArray(test.steps) ? test.steps : [];
  const computed = usesComputedValues(test);
  lines.push(`import { test, expect } from '@playwright/test';`);
  if (needsAxe(steps)) lines.push(AXE_IMPORT);
  if (computed) lines.push(`import { computeVariables, resolveValues, pathValue, pick, answerTo } from './izitest-values.js';`);
  lines.push('');

  const vars = test.variables || {};
  const varNames = Object.keys(vars);
  // The datasets it carries; bound to one, the test runs once per row of it.
  const datasets = datasetsUsed(test);
  const bound = test.dataset && datasets[test.dataset] ? test.dataset : null;
  const language = test.language === 'fr' ? 'fr' : 'en';
  // A secret of the project ({{secret.NAME}}) is the environment variable of that name: its
  // value is never written in the code.
  const options = `{ language: '${language}'${Object.keys(datasets).length ? ', datasets: (name) => DATASETS[name]' : ''}${usesSecrets(test, datasets) ? ', secrets: (name) => process.env[name]' : ''} }`;
  // Worked out once per run, as IziTest does: the date typed is the one checked. The values the
  // test keeps as it runs (capture) are in VARS too.
  const computing = (defaults) => [
    `const { values: VARS, context: RUN } = computeVariables(${defaults}, ${options});`,
    'RUN.lookup = (name) => VARS[name];',
    'const value = (text) => resolveValues(text, RUN).text;',
  ];
  if (Object.keys(datasets).length) {
    lines.push(`const DATASETS = ${JSON.stringify(datasets, null, 2)};`);
    lines.push('');
  }
  if (bound) {
    lines.push('const DEFAULTS = {');
    for (const key of varNames) lines.push(`  ${safeKey(key)}: ${jsStringLiteral(String(vars[key]?.defaultValue ?? ''))},`);
    lines.push('};');
    lines.push('');
  } else if (computed) {
    lines.push(`const { values: VARS, context: RUN } = computeVariables({`);
    for (const key of varNames) lines.push(`  ${safeKey(key)}: ${jsStringLiteral(String(vars[key]?.defaultValue ?? ''))},`);
    lines.push(`}, ${options});`);
    lines.push(...computing('').slice(1));
    lines.push('');
  } else if (varNames.length > 0) {
    lines.push('const VARS = {');
    for (const key of varNames) {
      const def = vars[key] ?? {};
      const value = def.defaultValue ?? '';
      lines.push(`  ${safeKey(key)}: ${jsStringLiteral(String(value))},`);
    }
    lines.push('};');
    lines.push('');
  }

  if (test.viewport && Number.isFinite(test.viewport.width) && Number.isFinite(test.viewport.height)) {
    lines.push(
      `test.use({ viewport: { width: ${test.viewport.width}, height: ${test.viewport.height} } });`
    );
    lines.push('');
  }

  // The requirements it checks, as tags: `npx playwright test --grep @REQ-12` runs them.
  const tags = requirementTags(test);
  // An API called by the test (http) goes through Playwright's request fixture.
  const calls = steps.some((step) => step.command === 'http');
  // Bound to a dataset: a test per row, the row's values over the defaults.
  const head = bound
    ? `test(\`${String(test.name || 'untitled').replace(/[`\\$]/g, '\\$&')} — row \${index + 1}\`, ${tags.length ? `{ tag: [${tags.map(jsLiteral).join(', ')}] }, ` : ''}async ({ page${calls ? ', request' : ''} }) => {`
    : `test(${jsLiteral(test.name || 'untitled')}, ${tags.length ? `{ tag: [${tags.map(jsLiteral).join(', ')}] }, ` : ''}async ({ page${calls ? ', request' : ''} }) => {`;
  if (bound) lines.push(`for (const [index, ROW] of DATASETS[${jsStringLiteral(bound)}].entries()) {`);
  const push = (line) => lines.push(bound ? (line ? `  ${line}` : line) : line);
  push(head);
  if (bound) for (const line of computing('{ ...DEFAULTS, ...ROW }')) push(`  ${line}`);
  if (calls) push('  let RESPONSE = null;');
  // The answers the page gets, for a step that keeps a value of one.
  if (steps.some((step) => step.command === 'capture' && step.params?.what === 'request')) {
    push('  const ANSWERS = [];');
    push("  page.on('response', (response) => ANSWERS.push(response));");
  }
  for (const requirement of test.requirements ?? []) {
    const criteria = requirement.criteria?.length ? `: criterion ${requirement.criteria.map((c) => c.number).join(', ')}` : '';
    push(`  // Checks ${requirement.key} — ${requirement.title}${criteria}`);
  }

  if (test.description) {
    for (const descLine of String(test.description).split('\n')) {
      push(`  // ${descLine}`);
    }
  }

  // Console errors and failed requests are caught as they happen: listening from the start.
  if (needsCollectors(steps)) for (const line of collectorLines()) push(`  ${line}`);

  for (const step of steps) {
    const rendered = renderStep(step);
    if (!rendered) continue;
    for (const body of rendered.split('\n')) {
      push(`  ${body}`);
    }
  }

  push('});');
  if (bound) lines.push('}');
  return lines.join('\n') + '\n';
}

// ─── Step rendering ──────────────────────────────────────────────────

function renderStep(step) {
  const p = step.params || {};
  const target = () => chooseTarget(step, jsLiteral);
  switch (step.command) {
    case 'navigate':
      return `await page.goto(${jsLiteral(p.url ?? '')});`;
    case 'click': {
      const t = p.viaLabel ? throughLabel(target(), jsLiteral, 'page', step) : target();
      // A checkbox recorded with its state: check() leaves it so, where click() toggles.
      if (typeof p.checked === 'boolean') return act(t, p.checked ? 'check' : 'uncheck');
      if (p.checked != null) {
        return withFixme(t, `await ${locatorOf(t)}.setChecked(${jsLiteral(p.checked)} === 'true');`);
      }
      return act(t, 'click');
    }
    case 'fill':
      return act(target(), 'fill', p.value ?? '');
    case 'type': {
      const t = target();
      return withFixme(t, `await ${locatorOf(t)}.type(${jsLiteral(p.value ?? '')});`);
    }
    case 'keyboard':
      return `await page.keyboard.press(${jsLiteral(p.key ?? '')});`;
    case 'press':
      return act(target(), 'press', p.key ?? '');
    case 'hover':
      return act(target(), 'hover');
    case 'scroll':
      if (p.selector) {
        const t = target();
        return withFixme(t, `await ${locatorOf(t)}.scrollIntoViewIfNeeded();`);
      }
      return `await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));`;
    case 'select':
      return act(target(), 'selectOption', p.value ?? '');
    case 'upload': {
      const t = target();
      const files = uploadPathsOf(p).map(jsLiteral);
      const arg = files.length === 1 ? files[0] : `[${files.join(', ')}]`;
      const call = withFixme(t, t.locator
        ? `await ${t.locator}.setInputFiles(${arg});`
        : `await page.setInputFiles(${jsLiteral(t.css)}, ${arg});`);
      const note = recordedPathNote(step);
      return note ? `${note}\n${call}` : call;
    }
    case 'drag': {
      const from = target();
      const to = chooseTarget(dropTargetOf(step), jsLiteral);
      return withFixme(from, withFixme(to, dragToCode(locatorOf(from), locatorOf(to), p.position)));
    }
    case 'wait':
      if (p.ms != null && p.ms !== '') {
        const ms = Number(p.ms);
        return `await page.waitForTimeout(${Number.isFinite(ms) ? ms : 0});`;
      }
      if (p.selector) {
        const t = target();
        return withFixme(t, t.locator
          ? `await ${t.locator}.waitFor();`
          : `await page.waitForSelector(${jsLiteral(t.css)});`);
      }
      return `// TODO: wait step without ms or selector`;
    case 'assert':
      return renderAssertion(step.assertion || {});
    case 'capture':
      return renderCapture(step);
    case 'http':
      return renderCall(p);
    default:
      return `// TODO: unsupported command '${step.command}'`;
  }
}

// A value kept for the steps after (lib/server-steps.js), into VARS.
function renderCapture(step) {
  const p = step.params || {};
  const into = `VARS[${jsStringLiteral(p.name ?? '')}]`;
  const read = (() => {
    switch (p.what ?? 'text') {
      case 'url': return 'page.url()';
      case 'title': return 'await page.title()';
      case 'response': return `pathValue(RESPONSE, ${jsLiteral(p.path ?? '')})`;
      case 'request': return `await answerTo(ANSWERS, ${jsLiteral(p.url ?? '')}, ${p.path ? jsLiteral(p.path) : 'null'}${p.method ? `, ${jsStringLiteral(p.method)}` : ''})`;
      case 'value': return `await ${locatorOf(chooseTarget(step, jsLiteral))}.first().inputValue()`;
      case 'attribute': return `await ${locatorOf(chooseTarget(step, jsLiteral))}.first().getAttribute(${jsLiteral(p.attribute ?? '')})`;
      default: return `((await ${locatorOf(chooseTarget(step, jsLiteral))}.first().textContent()) ?? '').trim()`;
    }
  })();
  return `${into} = ${p.pattern ? `pick(${read}, ${jsStringLiteral(p.pattern)})` : read};`;
}

// An API called to prepare data; its answer read by the captures after it.
function renderCall(p) {
  const method = String(p.method ?? 'GET').toUpperCase();
  const body = p.body != null && p.body !== '' ? `, data: ${jsLiteral(typeof p.body === 'string' ? p.body : JSON.stringify(p.body))}, headers: { 'content-type': 'application/json' }` : '';
  return [
    '{',
    `  const response = await request.fetch(${jsLiteral(p.url ?? '')}, { method: ${jsStringLiteral(method)}${body} });`,
    `  expect(response.ok(), await response.text()).toBeTruthy();`,
    `  RESPONSE = await response.json().catch(() => null);`,
    '}',
  ].join('\n');
}

// `page.click(css)` for a CSS selector, as generated so far; `locator.click()` when the step
// needs a Playwright locator instead (see codegen/locators.js).
function act(target, method, ...args) {
  const values = args.map(arg => jsLiteral(arg));
  const call = target.locator
    ? `await ${target.locator}.${method}(${values.join(', ')});`
    : `await page.${method}(${[jsLiteral(target.css), ...values].join(', ')});`;
  return withFixme(target, call);
}

function locatorOf(target) {
  return target.locator ?? `page.locator(${jsLiteral(target.css)})`;
}

function renderAssertion(a) {
  const oracle = oracleCode(a, jsLiteral);
  if (oracle) return oracle;
  switch (a.type) {
    case 'text_contains':
      if (a.selector) {
        return `await expect(page.locator(${jsLiteral(a.selector)})).toContainText(${jsLiteral(a.expected ?? '')});`;
      }
      return `await expect(page.locator('body')).toContainText(${jsLiteral(a.expected ?? '')});`;
    case 'text_not_contains':
      return `await expect(page.locator(${jsLiteral(a.selector ?? 'body')})).not.toContainText(${jsLiteral(a.expected ?? '')});`;
    case 'text_equals':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toHaveText(${jsLiteral(a.expected ?? '')});`;
    case 'attribute_equals':
      // "value": what the field holds now, as the replay reads it — not the attribute.
      return a.attribute === 'value'
        ? `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toHaveValue(${jsLiteral(a.expected ?? '')});`
        : `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toHaveAttribute(${jsLiteral(a.attribute ?? '')}, ${jsLiteral(a.expected ?? '')});`;
    case 'element_count':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toHaveCount(${parseInt(a.expected, 10) || 0});`;
    case 'element_visible':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toBeVisible();`;
    case 'element_hidden':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toBeHidden();`;
    case 'element_exists':
      // At least one, as the replay checks: toHaveCount(1) failed when two matched.
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')}).first()).toBeAttached();`;
    case 'element_not_exists':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toHaveCount(0);`;
    case 'url_equals':
      return `await expect(page).toHaveURL(${jsLiteral(a.expected ?? '')});`;
    case 'url_contains':
      return `await expect(page).toHaveURL(new RegExp(${jsStringLiteral(escapeRegex(String(a.expected ?? '')))}));`;
    case 'title_equals':
      return `await expect(page).toHaveTitle(${jsLiteral(a.expected ?? '')});`;
    case 'title_contains':
      return `await expect(page).toHaveTitle(new RegExp(${jsStringLiteral(escapeRegex(String(a.expected ?? '')))}));`;
    default:
      return `// TODO: unsupported assertion '${a.type}'`;
  }
}

// ─── JS literal helpers ──────────────────────────────────────────────

// Render a value as a JS string literal. When the value contains `{{var}}`
// placeholders, we emit a template literal that references `VARS.var` so
// the generated file can be regenerated deterministically without string
// concatenation.
function jsLiteral(value) {
  const s = String(value ?? '');
  // A computed value ({{today + 3 days | dd/MM/yyyy}}) is worked out when the test runs.
  if (hasExpression(s)) return `value(${jsStringLiteral(s)})`;
  if (/\{\{\s*\w+\s*\}\}/.test(s)) {
    // Escape for template literal, then inject VARS references.
    let out = s
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${');
    out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => '${VARS.' + name + '}');
    return '`' + out + '`';
  }
  return jsStringLiteral(s);
}

function jsStringLiteral(s) {
  return (
    "'" +
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r') +
    "'"
  );
}

function safeKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : jsStringLiteral(key);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
