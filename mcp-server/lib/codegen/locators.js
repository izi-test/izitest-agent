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

/**
 * True when the selector finds the element by its position among its siblings
 * (`#login-form > div:nth-of-type(3) > button:nth-of-type(1)`): it holds as long as the
 * layout does. Better than a generated ID, worse than a role and a name.
 */
export function isPositionalSelector(selector) {
  return /:nth-(of-type|child|last-of-type|last-child)\(/.test(String(selector ?? ''));
}

const FIELD_COMMANDS = new Set(['fill', 'type', 'press', 'select']);
const FIELD_TAGS = new Set(['input', 'select', 'textarea']);
// Roles getByRole finds by a tag a recorded selector ends with. Inputs are left out: their
// role depends on their type, which a selector rarely says; fields go by their label.
const ROLE_OF_TAG = {
  button: 'button', summary: 'button', a: 'link', select: 'combobox', textarea: 'textbox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
};

/** The tag of the element a selector ends on ("button" in `#f > div > button.btn`), lowercased. */
export function lastTag(selector) {
  const compounds = String(selector ?? '').replace(/\[[^\]]*\]/g, '[]').split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return /^([a-z][a-z0-9-]*)/i.exec(compounds.at(-1) ?? '')?.[1]?.toLowerCase() ?? null;
}

/** The tag of a step's element, from the recorded selector or its CSS locators. */
function tagOf(step) {
  const selectors = [step.params?.selector, ...(step.locators ?? []).filter(l => l.type === 'css').map(l => l.value)];
  for (const selector of selectors) {
    const tag = lastTag(selector);
    if (tag) return tag;
  }
  return null;
}

// A value inside a Playwright selector string, quoted: role=button[name="Sign in"s].
const quoted = (value) => JSON.stringify(String(value));

/**
 * The target of a step: `{ css }` for a CSS selector, `{ locator }` for a Playwright locator
 * expression on `page` built with `literal` (e.g. "page.getByLabel('Jardin')") and `selector`,
 * the same target as a Playwright selector string (`page.locator(selector)` finds it: what a
 * Cucumber step takes), plus `fragile: true` when nothing stable was recorded and the
 * original selector is kept anyway.
 */
export function chooseTarget(step, literal, page = 'page') {
  const selector = step.params?.selector ?? '';
  const sound = (css) => !isFragileSelector(css) && !isPositionalSelector(css);
  if (!selector || sound(selector)) return { css: selector };

  const locators = Array.isArray(step.locators) ? step.locators : [];
  const valueOf = (type) => locators.find(l => l.type === type)?.value;

  const testid = valueOf('testid');
  if (testid) return { css: testid };

  // A box of a group shares its name attribute with the others (name="interests"): that
  // selector finds all of them.
  const isToggle = step.params?.checked !== undefined;
  const stableCss = locators.find(l => ['css', 'attribute'].includes(l.type) && l.value && sound(l.value)
    && !(isToggle && /\[name=/.test(l.value)));
  if (stableCss) return { css: stableCss.value };

  // The role and name Chrome gave the element when it was clicked: exactly what getByRole
  // matches. "Sign in" the button, not the heading that says it too (getByText finds both).
  // Found more than once on the page, it was recorded with where it is: inside the closest
  // ancestor that holds only this one, or else its rank — getByRole alone failed on strict
  // mode with the "Clear" of two forms.
  const recorded = locators.find(l => l.type === 'role' && l.value && l.name);
  if (recorded) {
    const { testid, css } = recorded.scope ?? {};
    const within = testid ? `${page}.getByTestId(${literal(testid)})` : css ? `${page}.locator(${literal(css)})` : page;
    const withinSelector = testid ? `[data-testid=${quoted(testid)}] >> ` : css ? `${css} >> ` : '';
    const nth = Number.isInteger(recorded.nth) && !recorded.scope ? recorded.nth : null;
    return {
      locator: `${within}.getByRole('${recorded.value}', { name: ${literal(recorded.name)}, exact: true })${nth !== null ? `.nth(${nth})` : ''}`,
      selector: `${withinSelector}role=${recorded.value}[name=${quoted(recorded.name)}s]${nth !== null ? ` >> nth=${nth}` : ''}`,
    };
  }

  const name = valueOf('aria') ?? valueOf('label');
  const tag = tagOf(step);
  // Recorded before Chrome's role was kept: the role the tag implies, and the name the
  // snapshot computed — the same as Chrome's for a button or a link named by its text.
  const role = ROLE_OF_TAG[tag];
  if (name && role) {
    return {
      locator: `${page}.getByRole('${role}', { name: ${literal(name)}, exact: true })`,
      selector: `role=${role}[name=${quoted(name)}s]`,
    };
  }
  // The <label> itself, not the control it names: custom checkboxes hide the real <input>
  // (Bien'ici moves it out of the viewport) and only the label can be clicked.
  if (name && tag === 'label') {
    return { locator: `${page}.locator('label', { hasText: ${literal(name)} })`, selector: `label:has-text(${quoted(name)})` };
  }
  if (name && (FIELD_TAGS.has(tag) || FIELD_COMMANDS.has(step.command))) {
    return { locator: `${page}.getByLabel(${literal(name)})`, selector: `internal:label=${quoted(name)}i` };
  }

  const placeholder = valueOf('placeholder');
  if (placeholder) {
    return { locator: `${page}.getByPlaceholder(${literal(placeholder)}, { exact: true })`, selector: `[placeholder=${quoted(placeholder)}]` };
  }

  const text = valueOf('text');
  if (name && text && text === name) {
    return { locator: `${page}.getByText(${literal(text)}, { exact: true })`, selector: `text=${quoted(text)}` };
  }

  // Nothing better recorded: a position holds from one page load to the next, a generated
  // ID does not.
  if (!isFragileSelector(selector)) return { css: selector };
  const positional = locators.find(l => l.type === 'css' && l.value && !isFragileSelector(l.value));
  if (positional) return { css: positional.value };

  return { css: selector, fragile: true };
}

/**
 * A checkbox or radio styled away (opacity 0, no size), operated through its <label>:
 * check() on the input itself times out. Recorded as `viaLabel` by the click — with
 * `labelFor`, the input's id, when the label is a separate <label for> rather than one
 * holding the input: that label then, or the one with its text when the id is generated.
 */
export function throughLabel(target, literal, page = 'page', step = {}) {
  const labelFor = step.params?.labelFor;
  if (labelFor) {
    const css = `label[for=${quoted(labelFor)}]`;
    if (!isFragileSelector(css)) return { css };
    const name = (step.locators ?? []).find(l => l.type === 'aria')?.value;
    if (name) return { locator: `${page}.locator('label', { hasText: ${literal(name)} })`, selector: `label:has-text(${quoted(name)})` };
    return { css, fragile: true };
  }
  const inner = target.locator ?? `${page}.locator(${literal(target.css)})`;
  return {
    fragile: target.fragile,
    locator: `${page}.locator('label', { has: ${inner} })`,
    ...(target.css && { selector: `label:has(${target.css})` }),
  };
}

/**
 * A step's target as a Playwright selector string, for the Cucumber export's generic steps
 * (`When I click on "…"` runs page.locator(selector)): the same choice as generated code
 * makes, instead of the selector as recorded.
 */
export function selectorFor(step) {
  const chosen = chooseTarget(step, quoted);
  const target = step.command === 'click' && step.params?.viaLabel ? throughLabel(chosen, quoted, 'page', step) : chosen;
  return target.css ?? target.selector ?? step.params?.selector;
}

/** `line` preceded by a FIXME comment when the step's target is a fragile selector kept as is. */
export function withFixme(target, line) {
  if (!target.fragile) return line;
  return `// FIXME: this selector holds an ID the page generates at each load, and nothing stable was recorded: replace it.\n${line}`;
}
