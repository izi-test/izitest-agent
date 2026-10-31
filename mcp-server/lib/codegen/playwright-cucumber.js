// Generate a Playwright-Cucumber project from a izitest-agent test.
// Emits a multi-file bundle: the .feature file, reusable step definitions,
// a Playwright World with browser lifecycle, and a cucumber.js config.
// Pure: no DB, no filesystem. Returns `{ files: [{ path, content }] }`.

import { serializeTestToFeatureWith } from '../gherkin/serialize.js';
import { chooseTarget, withFixme } from './locators.js';

export function generatePlaywrightCucumber(test, definitions) {
  const slug = slugify(test.name || 'test');
  const feature = toScenarioOutline(serializeTestToFeatureWith(test, definitions), test.variables);

  const composites = definitions.filter(d => d.steps_template);
  const files = [
    { path: `features/${slug}.feature`, content: feature },
    { path: 'features/steps/default.steps.js', content: DEFAULT_STEPS_JS },
    { path: 'features/support/world.js', content: WORLD_JS },
    { path: 'cucumber.js', content: CUCUMBER_CONFIG_JS },
    { path: 'package.json', content: renderPackageJson(slug) },
  ];

  if (composites.length > 0) {
    files.push({
      path: 'features/steps/composite.steps.js',
      content: renderCompositeSteps(composites),
    });
  }

  return { files };
}

/**
 * Variables of the test ({{ville}} in the feature IziTest edits) as a Scenario Outline:
 * <ville> in the steps, one Examples row of default values. Cucumber puts the value in
 * before matching, so an {int} parameter still matches; left as is, "{{ville}}" would
 * have been typed into the page.
 */
export function toScenarioOutline(feature, variables = {}) {
  const used = [];
  const outline = feature.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (_, name) => {
    if (!used.includes(name)) used.push(name);
    return `<${name}>`;
  });
  if (!used.length) return feature;

  const cell = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');
  return outline.replace(/^(\s*)Scenario:/m, '$1Scenario Outline:').trimEnd() + '\n\n' +
    '    Examples:\n' +
    `      | ${used.join(' | ')} |\n` +
    `      | ${used.map(name => cell(variables?.[name]?.defaultValue)).join(' | ')} |\n`;
}

// ─── Templates ──────────────────────────────────────────────────────

const DEFAULT_STEPS_JS = `import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

// ─── Navigation ─────────────────────────────────────────────────────
Given('I am on {string}', async function (url) {
  await this.page.goto(url);
});

When('I navigate to {string}', async function (url) {
  await this.page.goto(url);
});

// ─── Interaction ────────────────────────────────────────────────────
When('I click on {string}', async function (selector) {
  await this.page.click(selector);
});

When('I fill {string} with {string}', async function (selector, value) {
  await this.page.fill(selector, value);
});

When('I check {string}', async function (selector) {
  await this.page.locator(selector).check();
});

When('I uncheck {string}', async function (selector) {
  await this.page.locator(selector).uncheck();
});

When('I set {string} checked to {string}', async function (selector, checked) {
  await this.page.locator(selector).setChecked(checked === 'true');
});

When('I press {string}', async function (key) {
  await this.page.keyboard.press(key);
});

When('I scroll to {string}', async function (selector) {
  await this.page.locator(selector).scrollIntoViewIfNeeded();
});

// ─── Waits ──────────────────────────────────────────────────────────
When('I wait {int} seconds', async function (seconds) {
  await this.page.waitForTimeout(seconds * 1000);
});

When('I wait for {string}', async function (selector) {
  await this.page.waitForSelector(selector);
});

// ─── Assertions ─────────────────────────────────────────────────────
Then('I should see {string}', async function (expected) {
  await expect(this.page.locator('body')).toContainText(expected);
});

Then('I should not see {string}', async function (selector) {
  await expect(this.page.locator(selector)).toHaveCount(0);
});

Then('{string} should be visible', async function (selector) {
  await expect(this.page.locator(selector)).toBeVisible();
});

Then('{string} should contain {string}', async function (selector, expected) {
  await expect(this.page.locator(selector)).toContainText(expected);
});

Then('the URL should be {string}', async function (expected) {
  await expect(this.page).toHaveURL(expected);
});

Then('the URL should contain {string}', async function (expected) {
  await expect(this.page).toHaveURL(new RegExp(expected));
});

Then('the title should be {string}', async function (expected) {
  await expect(this.page).toHaveTitle(expected);
});
`;

const WORLD_JS = `import { Before, After, setWorldConstructor, World } from '@cucumber/cucumber';
import { chromium } from 'playwright';

class PlaywrightWorld extends World {
  constructor(options) {
    super(options);
  }
}

setWorldConstructor(PlaywrightWorld);

Before(async function () {
  this.browser = await chromium.launch();
  this.context = await this.browser.newContext();
  this.page = await this.context.newPage();
});

After(async function () {
  if (this.page) await this.page.close();
  if (this.context) await this.context.close();
  if (this.browser) await this.browser.close();
});
`;

const CUCUMBER_CONFIG_JS = `export default {
  default: {
    paths: ['features/**/*.feature'],
    import: ['features/support/**/*.js', 'features/steps/**/*.js'],
    format: ['progress'],
  },
};
`;

// ─── Composite step code generation ────────────────────────────────

function renderCompositeSteps(composites) {
  const lines = [
    `import { Given, When, Then } from '@cucumber/cucumber';`,
    `import { expect } from '@playwright/test';`,
    ``,
  ];

  for (const def of composites) {
    const keyword = def.keyword;  // Given, When, or Then
    const argCount = countPatternArgs(def.pattern);
    const argNames = Array.from({ length: argCount }, (_, i) => `arg${i}`);
    const argList = argNames.length > 0 ? argNames.join(', ') : '';

    lines.push(`${keyword}(${jsString(def.pattern)}, async function (${argList}) {`);
    for (const tpl of def.steps_template) {
      for (const code of commandToPlaywright(tpl, argNames).split('\n')) {
        lines.push(`  ${code}`);
      }
    }
    lines.push(`});`);
    lines.push(``);
  }

  return lines.join('\n');
}

function countPatternArgs(pattern) {
  const matches = pattern.match(/\{(string|int|float|word)\}/g);
  return matches ? matches.length : 0;
}

function commandToPlaywright(tpl, argNames) {
  const params = tpl.params || {};
  const resolve = (val) => resolveTemplateValue(val, argNames);
  // A sub-step built from a recording (create_business_step) carries its locators: the
  // same stable choice as plain Playwright code. Without them, the selector as before.
  const target = () => chooseTarget(tpl, resolve, 'this.page');
  const act = (method, ...values) => {
    const t = target();
    const args = values.map(resolve);
    return withFixme(t, t.locator
      ? `await ${t.locator}.${method}(${args.join(', ')});`
      : `await this.page.${method}(${[resolve(t.css), ...args].join(', ')});`);
  };

  switch (tpl.command) {
    case 'navigate':
      return `await this.page.goto(${resolve(params.url)});`;
    case 'click':
      // A checkbox recorded with its state: check() leaves it so, where click() toggles.
      if (typeof params.checked === 'boolean') return act(params.checked ? 'check' : 'uncheck');
      if (params.checked != null) {
        const t = target();
        return withFixme(t, `await ${t.locator ?? `this.page.locator(${resolve(t.css)})`}.setChecked(${resolve(params.checked)} === 'true');`);
      }
      return act('click');
    case 'fill':
      return act('fill', params.value);
    case 'keyboard':
      return `await this.page.keyboard.press(${resolve(params.key)});`;
    case 'scroll': {
      const t = target();
      return withFixme(t, `await ${t.locator ?? `this.page.locator(${resolve(t.css)})`}.scrollIntoViewIfNeeded();`);
    }
    case 'wait':
      if (params.selector) {
        const t = target();
        return withFixme(t, t.locator
          ? `await ${t.locator}.waitFor();`
          : `await this.page.waitForSelector(${resolve(t.css)});`);
      }
      return `await this.page.waitForTimeout(${resolve(params.ms)});`;
    case 'assert':
      return assertionToPlaywright(params, argNames);
    default:
      return `// Unsupported command: ${tpl.command}`;
  }
}

function assertionToPlaywright(params, argNames) {
  const resolve = (val) => resolveTemplateValue(val, argNames);
  switch (params.type) {
    case 'text_contains':
      if (params.selector) {
        return `await expect(this.page.locator(${resolve(params.selector)})).toContainText(${resolve(params.expected)});`;
      }
      return `await expect(this.page.locator('body')).toContainText(${resolve(params.expected)});`;
    case 'element_visible':
      return `await expect(this.page.locator(${resolve(params.selector)})).toBeVisible();`;
    case 'element_not_exists':
      return `await expect(this.page.locator(${resolve(params.selector)})).toHaveCount(0);`;
    case 'url_equals':
      return `await expect(this.page).toHaveURL(${resolve(params.expected)});`;
    case 'url_contains':
      return `await expect(this.page).toHaveURL(new RegExp(${resolve(params.expected)}));`;
    case 'title_equals':
      return `await expect(this.page).toHaveTitle(${resolve(params.expected)});`;
    default:
      return `// Unsupported assertion type: ${params.type}`;
  }
}

/**
 * Resolve a template value like "{0}", "literal", or "{0}000" into a
 * JavaScript expression string suitable for embedding in generated code.
 */
function resolveTemplateValue(val, argNames) {
  if (val == null) return "''";
  const str = String(val);

  // Pure placeholder "{N}" → variable reference
  const pure = str.match(/^\{(\d+)\}$/);
  if (pure) return argNames[Number(pure[1])] || "''";

  // No placeholders → quoted string literal
  if (!/\{\d+\}/.test(str)) return jsString(str);

  // Mixed → template literal. Its literal parts are escaped too: a CSS escape such as
  // `\39 ` left raw is an octal escape, a syntax error in an ES module.
  const resolved = str.split(/(\{\d+\})/).map(part => {
    const placeholder = part.match(/^\{(\d+)\}$/);
    if (placeholder) {
      const name = argNames[Number(placeholder[1])];
      return name ? `\${${name}}` : '';
    }
    return part.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }).join('');
  return `\`${resolved}\``;
}

function jsString(value) {
  return `'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}'`;
}

function renderPackageJson(slug) {
  return JSON.stringify(
    {
      name: slug,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        test: 'cucumber-js',
      },
      devDependencies: {
        '@cucumber/cucumber': '^11.0.0',
        '@playwright/test': '^1.47.0',
        playwright: '^1.47.0',
      },
    },
    null,
    2
  ) + '\n';
}

// ─── Helpers ────────────────────────────────────────────────────────

function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'test';
}
