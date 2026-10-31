// Which locator generated code should use for a recorded step.
//
// A step keeps the CSS selector it was recorded with, plus every locator the extension
// computed for its element (testid, css, attribute, placeholder, aria name, text, xpath).
// IziTest's own replay tries them all and takes the first that matches, so a selector that
// broke since the recording goes unnoticed. Generated code gets one locator, and a selector
// built on an ID the page generates at every load fails on the very first run: Bien'ici's
// "Jardin" filter is <label for="<uuid>">, a new uuid each time.
//
// So: the recorded selector when it holds nothing generated, else the first stable
// alternative, in the order a person writing the test would pick it.

// Same rules as isDynamicId / isDynamicClass in extension/src/dom/snapshot.ts, which keep
// generated IDs and classes out of the selectors built at recording time.
function isDynamicId(id) {
  if (/react-aria|radix-|ember|ng-|_r_|rc-|headlessui-/i.test(id)) return true;
  if (/\d{4,}/.test(id)) return true;
  if (/^[a-f0-9-]{8,}$/i.test(id)) return true;
  if (/^:.*:$/.test(id)) return true;
  return false;
}

function isDynamicClass(cls) {
  if (/^[a-z]{1,2}\d+$/i.test(cls)) return true;
  if (/^_/.test(cls)) return true;
  if (/^css-/.test(cls)) return true;
  if (/^sc-/.test(cls)) return true;
  if (/^styles?_/.test(cls)) return true;
  if (/[A-Za-z0-9]{6,}$/.test(cls) && /[_-]/.test(cls) && /\d/.test(cls)) return true;
  if (/^[a-f0-9]{5,}$/i.test(cls)) return true;
  if (/^jsx-\d+$/.test(cls)) return true;
  if (/^go\d+$/.test(cls)) return true;
  return false;
}

// Attributes whose value is an element ID: <label for>, ARIA references, the ID itself.
const ID_ATTRIBUTES = new Set(['id', 'for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']);

/** CSS escapes undone: `\39 2595267` is "92595267". */
function unescapeCss(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
}

/** True when the selector names an ID or a class the page generates, so it will not match next time. */
export function isFragileSelector(selector) {
  if (!selector) return false;
  let rest = String(selector);

  for (const [attrSelector, name, , value] of rest.matchAll(/\[\s*([\w-]+)\s*[~|^$*]?=\s*(["'])((?:\\.|(?!\2).)*)\2\s*i?\s*\]/g)) {
    if (ID_ATTRIBUTES.has(name.toLowerCase()) && unescapeCss(value).split(/\s+/).some(isDynamicId)) return true;
    rest = rest.replace(attrSelector, ' ');
  }
  for (const [, id] of rest.matchAll(/#((?:\\[0-9a-f]{1,6}\s?|\\.|[\w-])+)/gi)) {
    if (isDynamicId(unescapeCss(id))) return true;
  }
  for (const [, cls] of rest.matchAll(/\.((?:\\[0-9a-f]{1,6}\s?|\\.|[\w-])+)/gi)) {
    if (isDynamicClass(unescapeCss(cls))) return true;
  }
  return false;
}

const FIELD_COMMANDS = new Set(['fill', 'type', 'press', 'select']);
const FIELD_TAGS = new Set(['input', 'select', 'textarea']);

/** The tag a recorded selector starts with ("label" for `label[for=…]`), lowercased. */
function tagOf(step) {
  const selectors = [step.params?.selector, ...(step.locators ?? []).filter(l => l.type === 'css').map(l => l.value)];
  for (const selector of selectors) {
    const tag = /^\s*([a-z][a-z0-9-]*)/i.exec(selector ?? '')?.[1];
    if (tag) return tag.toLowerCase();
  }
  return null;
}

/**
 * The target of a step: `{ css }` for a CSS selector, `{ locator }` for a Playwright locator
 * expression built with `literal` (e.g. "page.getByLabel('Jardin')"), plus `fragile: true`
 * when nothing stable was recorded and the original selector is kept anyway.
 */
export function chooseTarget(step, literal) {
  const selector = step.params?.selector ?? '';
  if (!isFragileSelector(selector)) return { css: selector };

  const locators = Array.isArray(step.locators) ? step.locators : [];
  const valueOf = (type) => locators.find(l => l.type === type)?.value;

  const testid = valueOf('testid');
  if (testid) return { css: testid };

  const stableCss = locators.find(l => ['css', 'attribute'].includes(l.type) && l.value && !isFragileSelector(l.value));
  if (stableCss) return { css: stableCss.value };

  const name = valueOf('aria') ?? valueOf('label');
  const tag = tagOf(step);
  // The <label> itself, not the control it names: custom checkboxes hide the real <input>
  // (Bien'ici moves it out of the viewport) and only the label can be clicked.
  if (name && tag === 'label') {
    return { locator: `page.locator('label', { hasText: ${literal(name)} })` };
  }
  if (name && (FIELD_TAGS.has(tag) || FIELD_COMMANDS.has(step.command))) {
    return { locator: `page.getByLabel(${literal(name)})` };
  }

  const placeholder = valueOf('placeholder');
  if (placeholder) return { locator: `page.getByPlaceholder(${literal(placeholder)}, { exact: true })` };

  const text = valueOf('text');
  if (name && text && text === name) return { locator: `page.getByText(${literal(text)}, { exact: true })` };

  return { css: selector, fragile: true };
}
