// Generate a plain Playwright test file (@playwright/test) from a izitest-agent
// test object. Pure: no DB access, no filesystem. Returns the file content as
// a single string so the caller can write it to disk or bundle it in a zip.

export function generatePlaywrightPlain(test) {
  const lines = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
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

  lines.push(`test(${jsLiteral(test.name || 'untitled')}, async ({ page }) => {`);

  if (test.description) {
    for (const descLine of String(test.description).split('\n')) {
      lines.push(`  // ${descLine}`);
    }
  }

  const steps = Array.isArray(test.steps) ? test.steps : [];
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
  switch (step.command) {
    case 'navigate':
      return `await page.goto(${jsLiteral(p.url ?? '')});`;
    case 'click':
      return `await page.click(${jsLiteral(p.selector ?? '')});`;
    case 'fill':
      return `await page.fill(${jsLiteral(p.selector ?? '')}, ${jsLiteral(p.value ?? '')});`;
    case 'type':
      return `await page.locator(${jsLiteral(p.selector ?? '')}).type(${jsLiteral(p.value ?? '')});`;
    case 'keyboard':
      return `await page.keyboard.press(${jsLiteral(p.key ?? '')});`;
    case 'press':
      return `await page.press(${jsLiteral(p.selector ?? '')}, ${jsLiteral(p.key ?? '')});`;
    case 'hover':
      return `await page.hover(${jsLiteral(p.selector ?? '')});`;
    case 'scroll':
      if (p.selector) {
        return `await page.locator(${jsLiteral(p.selector)}).scrollIntoViewIfNeeded();`;
      }
      return `await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));`;
    case 'select':
      return `await page.selectOption(${jsLiteral(p.selector ?? '')}, ${jsLiteral(p.value ?? '')});`;
    case 'wait':
      if (p.ms != null && p.ms !== '') {
        const ms = Number(p.ms);
        return `await page.waitForTimeout(${Number.isFinite(ms) ? ms : 0});`;
      }
      if (p.selector) {
        return `await page.waitForSelector(${jsLiteral(p.selector)});`;
      }
      return `// TODO: wait step without ms or selector`;
    case 'assert':
      return renderAssertion(step.assertion || {});
    default:
      return `// TODO: unsupported command '${step.command}'`;
  }
}

function renderAssertion(a) {
  switch (a.type) {
    case 'text_contains':
      if (a.selector) {
        return `await expect(page.locator(${jsLiteral(a.selector)})).toContainText(${jsLiteral(a.expected ?? '')});`;
      }
      return `await expect(page.locator('body')).toContainText(${jsLiteral(a.expected ?? '')});`;
    case 'element_visible':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toBeVisible();`;
    case 'element_hidden':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toBeHidden();`;
    case 'element_exists':
      return `await expect(page.locator(${jsLiteral(a.selector ?? '')})).toHaveCount(1);`;
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
