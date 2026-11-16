// The elements of a project: what its recorded steps act on, each known by an exact key —
// the page it is on, then its role and accessible name (with the container that tells it
// apart when the page has several), else its test ID, the label of a field, or a stable CSS
// selector. Never by resemblance: a "Save" on the notes page and a "Save" on the profile page
// are two elements, even with the same name or the same selector; the same "Save" recorded
// by two tests is one. Recorded differently — by its label in one test, by its selector in
// another —, a field is one element too once two steps of its page share its id, its test
// ID, its name or its placeholder (marksOf). A step recorded before steps kept their page
// belongs to none, until a run of its test gives it its page (test-execute.js).
//
// An element has a name, unique in its project: the dashboard's Gherkin says it instead of a
// selector (When I click on "Save profile"), and reads it back as the element. Pure: the
// elements a project has are kept by element-store.js.

import { isFragileSelector, isPositionalSelector, lastTag, unescapeCss } from './codegen/locators.js';

// The commands that act on an element of the page; drag, on the one it moves; an assertion,
// on the one it checks (ELEMENT_ASSERTIONS); a capture, on the one it reads; a wait, on the one
// it waits for (a wait of a time only has none).
const TARGET_COMMANDS = new Set(['click', 'fill', 'select', 'upload', 'drag', 'assert', 'capture', 'wait']);
const FIELD_COMMANDS = new Set(['fill', 'select', 'upload']);
const NAME_LOCATORS = ['label', 'aria'];
// The assertions that check an element, named by their selector. text_contains without one
// reads the whole page.
const ELEMENT_ASSERTIONS = new Set([
  'element_exists', 'element_not_exists', 'element_visible', 'element_hidden',
  'text_equals', 'text_contains', 'text_not_contains', 'attribute_equals', 'element_count',
]);

/** Whether a command acts on an element of the page. */
export const actsOnElement = (command) => TARGET_COMMANDS.has(command);

// An assertion keeps what it checks in `assertion` (in `params` inside a business step).
const dataOf = (step) => (step.command === 'assert' ? step.assertion ?? step.params : step.params) ?? {};

/**
 * The page of a URL as a step keeps it: host and path, without query or fragment. A part of
 * the path holding a digit (an id, a slug with an id) or a long token is starred: the note
 * 42 and the note 43 are one page. A hash route (#/notes/42) is part of the path. Null for
 * what is no web page (about:blank, chrome://…).
 */
export function pageOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const route = parsed.hash.startsWith('#/') ? parsed.hash.slice(1) : '';
  const parts = `${parsed.pathname}${route}`.split('/').filter(Boolean)
    .map((part) => (/\d/.test(part) || part.length >= 24 ? '*' : part));
  return `${parsed.host.toLowerCase()}/${parts.join('/')}`;
}

const quoted = (text) => JSON.stringify(String(text));
const scopeOf = ({ testid, css } = {}) => (testid ? `testid ${quoted(testid)}` : css ?? '');

/**
 * What a step acts on, in words, without its page: `button "Save" in #note-3`, `field
 * "E-mail"`, `testid "save"`, `css #search`. Null when it acts on no element, on one a
 * variable picks (an item of a list), or on one only its position tells apart.
 */
function targetOf(step) {
  if (!TARGET_COMMANDS.has(step.command) || step.variable?.listContext) return null;
  // A suggestion picked after typing (variable-detection.js): one element for the suggestions of
  // a field, in every test, whatever its variable is named there. Its text is a value of the test.
  if (step.variable?.suggestionOf) return step.variable.field ? `suggestion of ${step.variable.field}` : null;
  if (step.command === 'assert' && !(ELEMENT_ASSERTIONS.has(dataOf(step).type) && dataOf(step).selector)) return null;
  const selector = dataOf(step).selector;
  if (typeof selector === 'string' && /\{\{|\{\d+\}/.test(selector)) return null;
  const locators = step.locators ?? [];

  // Chrome's role and name, with where it is when the page has more than one.
  const role = locators.find((l) => l.type === 'role' && l.value && l.name);
  if (role) {
    const where = role.scope ? ` in ${scopeOf(role.scope)}` : Number.isInteger(role.nth) ? ` (nth ${role.nth})` : '';
    return `${role.value} ${quoted(role.name)}${where}`;
  }
  const testid = locators.find((l) => l.type === 'testid' && l.value)?.value;
  if (testid) return `testid ${quoted(testid)}`;
  // A name that is a variable ({{country}}) is no element's: another test names it otherwise.
  const name = locators.find((l) => NAME_LOCATORS.includes(l.type) && l.value && !/\{\{/.test(l.value))?.value;
  if (name) return `${FIELD_COMMANDS.has(step.command) ? 'field' : lastTag(selector) ?? 'element'} ${quoted(name)}`;
  if (typeof selector === 'string' && selector && !isFragileSelector(selector) && !isPositionalSelector(selector)) return `css ${selector}`;
  return null;
}

/** The selector a step was recorded with: of its element, or of the one its assertion checks. */
export const selectorOf = (step) => dataOf(step).selector;

/** The key of the element a step acts on: its page, then what it is. Null without a page. */
export function elementKey(step) {
  if (!step?.page) return null;
  const target = targetOf(step);
  return target ? `${step.page} ${target}` : null;
}

// ── One element, recorded in several ways ───────────────────────────────────────────────
// The same field can get several keys: one test kept its label, another only its selector, a
// third checks it by its placeholder. What tells an element apart for sure on its page joins
// them — its id, its test ID, and for a field, the name it is sent under or its placeholder:
// two steps of a page that share one act on the same element (element-store.js merges them).

const ID_SELECTOR = /^(?:[a-z][a-z0-9-]*)?#((?:\\[0-9a-f]{1,6}\s?|\\.|[\w-])+)$/i;
const ATTRIBUTE_SELECTOR = /^([a-z][a-z0-9-]*)?\[\s*([\w-]+)\s*=\s*(["'])((?:\\.|(?!\3).)*)\3\s*\]$/i;
const XPATH_ID = /^\/\/\*\[@id=(["'])([^"']+)\1\]$/;
const TESTID_ATTRIBUTES = new Set(['data-testid', 'data-test-id', 'data-cy']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

/**
 * What tells the element a step acts on apart for sure on its page, each with the page:
 * `shop.test/login ~id=email`, `~testid=save`; for a field typed or chosen in, or read by a
 * selector naming it so, `~name=email` and `~placeholder=Your e-mail` too. A click gives
 * neither: the name of a box or a radio is its whole group's. None for an element told apart
 * by its container or its position (what it shares with its siblings says nothing), nor for
 * the suggestions of a field.
 */
export function marksOf(step) {
  if (!elementKey(step) || step.variable?.suggestionOf) return [];
  const locators = step.locators ?? [];
  if (locators.some((l) => l.type === 'role' && (l.scope || Number.isInteger(l.nth)))) return [];
  const field = FIELD_COMMANDS.has(step.command);
  const marks = new Set();
  const add = (kind, value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text && !/\{\{|\{\d+\}/.test(text)) marks.add(`${step.page} ~${kind}=${text}`);
  };
  const read = (selector) => {
    const css = typeof selector === 'string' ? selector.trim() : '';
    if (!css || isFragileSelector(css)) return;
    const id = ID_SELECTOR.exec(css)?.[1];
    if (id) return add('id', unescapeCss(id));
    const [, tag, attribute, , value] = ATTRIBUTE_SELECTOR.exec(css) ?? [];
    const name = attribute?.toLowerCase();
    if (TESTID_ATTRIBUTES.has(name)) add('testid', unescapeCss(value));
    else if ((name === 'name' || name === 'placeholder') && (field || (step.command === 'assert' && FIELD_TAGS.has(tag?.toLowerCase())))) {
      add(name, unescapeCss(value));
    }
  };
  read(selectorOf(step));
  for (const { type, value } of locators) {
    if (type === 'css' || type === 'attribute') read(value);
    else if (type === 'testid') ATTRIBUTE_SELECTOR.test(String(value ?? '').trim()) ? read(value) : add('testid', value);
    else if (type === 'placeholder' && field) add('placeholder', value);
    else if (type === 'xpath') {
      const id = XPATH_ID.exec(String(value ?? ''))?.[2];
      if (id && !isFragileSelector(`#${id}`)) add('id', id);
    }
  }
  return [...marks];
}

/** The name a person reads in a key — `Save` in `notes.test/x button "Save"` —, null for a test ID or a selector. */
export function nameInKey(key, page) {
  const target = String(key ?? '').slice(page ? page.length + 1 : 0);
  if (/^(?:testid|css|suggestion) /.test(target)) return null;
  const quotedName = /^\S+ ("(?:[^"\\]|\\.)*")/.exec(target)?.[1];
  try {
    return quotedName ? JSON.parse(quotedName) : null;
  } catch {
    return null;
  }
}

/** Whether two versions of a step find their element differently: another selector, other locators. */
export function findsDifferently(before, after) {
  return selectorOf(before ?? {}) !== selectorOf(after ?? {})
    || JSON.stringify(before?.locators ?? []) !== JSON.stringify(after?.locators ?? []);
}

/**
 * `step` finding its element the way `source` finds it, still doing what it does — its
 * command, its value, what its assertion expects. An assertion takes the selector. An action
 * takes the selector and the locators; given those of an assertion, which has none, it is
 * found by that selector alone: one of its old locators, raced against it, could still find
 * the element as it was.
 */
export function foundLike(step, source) {
  // A suggestion is found by its text, each test's own variable ({{country}} in one test,
  // {{country_choice}} in another): copied over, the way it is found names this step's.
  const from = source.variable?.suggestionOf && source.variable.name;
  const to = step.variable?.suggestionOf && step.variable.name;
  const own = (value) => (from && to && from !== to && value != null
    ? JSON.parse(JSON.stringify(value).split(`{{${from}}}`).join(`{{${to}}}`)) : value);
  const selector = own(selectorOf(source));
  if (typeof selector !== 'string' || !selector) return step;
  if (step.command === 'assert') {
    return step.assertion ? { ...step, assertion: { ...step.assertion, selector } } : { ...step, params: { ...step.params, selector } };
  }
  const locators = source.locators?.length ? own(source.locators)
    : step.locators?.length ? [{ type: 'css', value: selector }] : step.locators;
  return { ...step, params: { ...step.params, selector }, ...(locators !== undefined && { locators }) };
}

/**
 * What a person reads on the element: its name, its label, the text of what is clicked, its
 * placeholder, its test ID — else words drawn from its selector ("Shop cart total" for
 * #shop-cart-total), never the selector itself: it says how the element is found, not what it is.
 */
export function baseName(step) {
  if (step.variable?.suggestionOf && step.variable.field) return `Suggestion of "${step.variable.fieldName ?? step.variable.field}"`.slice(0, 60);
  const locators = step.locators ?? [];
  // The text of a button or a link clicked — not of an item picked from a list: that one changes.
  const text = !step.variable && step.command !== 'fill' ? locators.find((l) => l.type === 'text' && readableText(l.value))?.value : null;
  const named = locators.find((l) => l.type === 'role' && l.name)?.name
    ?? locators.find((l) => NAME_LOCATORS.includes(l.type) && l.value)?.value
    ?? text
    ?? locators.find((l) => l.type === 'placeholder' && l.value)?.value
    ?? words(locators.find((l) => l.type === 'testid' && l.value)?.value)
    ?? readableSelector(dataOf(step).selector)
    ?? dataOf(step).selector
    ?? 'element';
  // The glyph of an icon font (\uE900, drawn before "Me connecter") reads as nothing.
  return String(named).replace(ICON_GLYPHS, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'element';
}

const ICON_GLYPHS = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

// A text that names a button or a link: short, no {{value}}, not a number or a price alone.
const readableText = (value) => typeof value === 'string' && value.trim().length > 1 && value.length <= 40
  && !value.includes('{{') && /\p{L}/u.test(value) && !/^[\d\s.,:%€$£-]+\p{L}{0,3}$/u.test(value.trim());

/** "shop-cart-total", "flashMessage", "note_submit" as words: "Shop cart total", "Flash message". */
export function words(value) {
  if (typeof value !== 'string') return null;
  const parts = value.replace(/\{\{[^}]*\}\}/g, ' ')
    .split(/[-_\s.:/]+|(?<=[a-z])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !/^\d+$/.test(w))
    .filter((w, i, all) => w !== all[i - 1]);
  // A letter alone ("j_username", "#shop-q") says nothing beside other words.
  const said = parts.length > 1 ? parts.filter((w) => w.length > 1) : parts;
  if (!said.length) return null;
  parts.splice(0, parts.length, ...said);
  const text = parts.join(' ');
  return text[0].toUpperCase() + text.slice(1);
}

// What a tag is, said in words, when nothing else names the element.
const TAG_WORDS = {
  a: 'link', button: 'button', input: 'field', textarea: 'field', select: 'list', option: 'option', img: 'image',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', label: 'label',
  li: 'item', ul: 'list', ol: 'list', tr: 'row', td: 'cell', th: 'column', table: 'table', form: 'form', nav: 'menu',
  dialog: 'dialog', article: 'card', section: 'section', header: 'header', footer: 'footer', main: 'main content', p: 'text',
};
const ATTRIBUTE = (name) => new RegExp(`\\[${name}\\s*[~|^$*]?=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|([^\\]\\s]+))\\s*\\]`, 'i');
const attribute = (part, name) => { const m = ATTRIBUTE(name).exec(part); return m ? unescapeCss(m[1] ?? m[2] ?? m[3]) : null; };

/**
 * A name in words drawn from a CSS selector, from the part that picks the element itself (the
 * last one): its aria-label as written, else the words of its test ID, its id, its name, its
 * placeholder, its last class, else what its tag is. Null when it says nothing.
 */
export function readableSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim()) return null;
  const last = selector.trim().split(/\s*[>+~]\s*|\s+(?![^[]*\])/).filter(Boolean).at(-1) ?? '';
  const label = attribute(last, 'aria-label');
  if (label && readableText(label)) return label;
  const fromWords = words(attribute(last, 'data-(?:testid|test-id|test|qa|cy)'))
    ?? words(/#((?:\\.|[\w-])+)/.exec(last)?.[1] && unescapeCss(/#((?:\\.|[\w-])+)/.exec(last)[1]))
    ?? words(attribute(last, 'name'))
    ?? words(attribute(last, 'placeholder'))
    ?? words([...last.matchAll(/\.((?:\\.|[\w-])+)/g)].at(-1)?.[1]);
  if (fromWords) return fromWords;
  const tag = /^[a-z][a-z0-9]*/i.exec(last)?.[0]?.toLowerCase();
  return tag && TAG_WORDS[tag] ? TAG_WORDS[tag][0].toUpperCase() + TAG_WORDS[tag].slice(1) : null;
}

/** Names already given in a project, told apart whatever their case: "Save" is "save". */
export function takenNames(names) {
  const lower = new Set([...names].map((name) => String(name).toLowerCase()));
  return { has: (name) => lower.has(String(name).toLowerCase()), add: (name) => lower.add(String(name).toLowerCase()) };
}

// The last part of a page's path that is no id: "notes" for localhost:5180/notes/*.
const pageLabel = (page) => page.split('/').slice(1).filter((part) => part && part !== '*').at(-1) ?? page.split('/')[0];

/** "Save", taken: "Save (profile)", then "Save (profile) 2"… */
export function uniqueName(base, page, taken) {
  if (!taken.has(base)) return base;
  const onPage = `${base} (${pageLabel(page)})`;
  if (!taken.has(onPage)) return onPage;
  let n = 2;
  while (taken.has(`${onPage} ${n}`)) n += 1;
  return `${onPage} ${n}`;
}
