// Generate a plain Playwright test file (@playwright/test) from a izitest-agent
// test object. Pure: no DB access, no filesystem. Returns the file content as
// a single string so the caller can write it to disk or bundle it in a zip.

import { chooseTarget, throughLabel, withFixme } from './locators.js';
import { recordedPathNote, uploadPathsOf } from '../upload-files.js';
import { dropTargetOf, dragToCode } from './drag.js';
import { needsCollectors, needsAxe, collectorLines, oracleCode, AXE_IMPORT } from './oracles.js';
import { requirementTags } from './requirement-tags.js';

export function generatePlaywrightPlain(test) {
  const lines = [];
  const steps = Array.isArray(test.steps) ? test.steps : [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  if (needsAxe(steps)) lines.push(AXE_IMPORT);
  lines.push('');

  const vars = test.variables || {};
  const varNames = Object.keys(vars);
  if (varNames.length > 0) {
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
  lines.push(`test(${jsLiteral(test.name || 'untitled')}, ${tags.length ? `{ tag: [${tags.map(jsLiteral).join(', ')}] }, ` : ''}async ({ page }) => {`);
  for (const requirement of test.requirements ?? []) {
    const criteria = requirement.criteria?.length ? `: criterion ${requirement.criteria.map((c) => c.number).join(', ')}` : '';
    lines.push(`  // Checks ${requirement.key} — ${requirement.title}${criteria}`);
  }

  if (test.description) {
    for (const descLine of String(test.description).split('\n')) {
      lines.push(`  // ${descLine}`);
    }
  }

  // Console errors and failed requests are caught as they happen: listening from the start.
  if (needsCollectors(steps)) for (const line of collectorLines()) lines.push(`  ${line}`);

  for (const step of steps) {
    const rendered = renderStep(step);
    if (!rendered) continue;
    for (const body of rendered.split('\n')) {
      lines.push(`  ${body}`);
    }
  }

  lines.push('});');
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
    default:
      return `// TODO: unsupported command '${step.command}'`;
  }
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
