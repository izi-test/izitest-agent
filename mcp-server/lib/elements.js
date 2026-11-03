// The elements of a project: what its recorded steps act on, each known by an exact key —
// the page it is on, then its role and accessible name (with the container that tells it
// apart when the page has several), else its test ID, the label of a field, or a stable CSS
// selector. Never by resemblance: a "Save" on the notes page and a "Save" on the profile page
// are two elements, even with the same name or the same selector; the same "Save" recorded
// by two tests is one. A step recorded before steps kept their page belongs to none, until a
// run of its test gives it its page (test-execute.js).
//
// An element has a name, unique in its project: the dashboard's Gherkin says it instead of a
// selector (When I click on "Save profile"), and reads it back as the element. Pure: the
// elements a project has are kept by element-store.js.

import { isFragileSelector, isPositionalSelector, lastTag } from './codegen/locators.js';

// The commands that act on an element of the page; drag, on the one it moves; an assertion,
// on the one it checks (ELEMENT_ASSERTIONS); a capture, on the one it reads.
const TARGET_COMMANDS = new Set(['click', 'fill', 'select', 'upload', 'drag', 'assert', 'capture']);
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
  const name = locators.find((l) => NAME_LOCATORS.includes(l.type) && l.value)?.value;
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

/** What a person reads on the element: its name, its label, its placeholder, its test ID. */
export function baseName(step) {
  const locators = step.locators ?? [];
  const named = locators.find((l) => l.type === 'role' && l.name)?.name
    ?? locators.find((l) => NAME_LOCATORS.includes(l.type) && l.value)?.value
    ?? locators.find((l) => l.type === 'placeholder' && l.value)?.value
    ?? locators.find((l) => l.type === 'testid' && l.value)?.value
    ?? dataOf(step).selector
    ?? 'element';
  return String(named).replace(/\s+/g, ' ').trim().slice(0, 60) || 'element';
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
