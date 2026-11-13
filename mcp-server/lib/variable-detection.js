// Names and shapes of the variables a recording detects at save time. Shared by the MCP
// recorder (tools/test.js) and the dashboard agent (agent-executor.js), which each had
// their own copy.

import { isFragileSelector, isPositionalSelector } from './codegen/locators.js';

function slug(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')            // displayName → display Name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9\s_]/g, ' ')                      // keep alphanum, spaces, _
    .trim()
    .replace(/[\s_]+/g, '_')
    .substring(0, 30)
    .replace(/_+$/, '');
}

// The id a CSS selector names, when a developer wrote it: "#inline-title", not "#r1".
const idOf = (selector) => /^#([A-Za-z][A-Za-z_-]*)$/.exec(selector ?? '')?.[1];

// Where a field's name is read, best first: what a person reads next to it (its label, its
// accessible name), then the name the form submits it under, then its id, then the
// placeholder last — a placeholder is an example value: "you@example.com" made
// {{youexamplecom}}. An accessible name that is only the placeholder (a field without a
// label) ranks as the placeholder: "Start typing..." had made {{start_typing}} of a field
// submitted as "country".
const FIELD_NAME_SOURCES = [
  (l) => l.type === 'label' && l.value,
  (l, placeholders) => l.type === 'aria' && !placeholders.has(l.value) && l.value,
  (l) => l.type === 'attribute' && /\[name="([^"]+)"\]/.exec(l.value)?.[1],
  (l) => l.type === 'css' && idOf(l.value),
  (l) => l.type === 'placeholder' && l.value,
];

/** A variable name for the field a step fills, from its recorded locators; null without one. */
export function deriveVarNameFromLocators(step) {
  // A field filled by selector has no locators: its selector is all there is. One a Gherkin
  // phrase names by its label ("I fill the field "Email" with …"): that label.
  const locators = step.locators?.length ? step.locators
    : step.params?.selector ? [{ type: 'css', value: step.params.selector }]
    : step.params?.label ? [{ type: 'label', value: step.params.label }] : [];
  const placeholders = new Set(locators.filter((l) => l.type === 'placeholder').map((l) => l.value));
  for (const source of FIELD_NAME_SOURCES) {
    for (const locator of locators) {
      const text = source(locator, placeholders);
      const name = text ? slug(text) : '';
      if (name.length >= 2 && !/^\d/.test(name)) return name;
    }
  }
  return null;
}

// What a step puts in a field: the param that holds it, and the variable's type.
const INPUTS = {
  fill: { param: 'value', type: 'text', fallback: 'input' },
  select: { param: 'value', type: 'select', fallback: 'select' },
  // One file (`file`); several (`files`) stay as they are.
  upload: { param: 'file', type: 'file', fallback: 'file' },
};

/**
 * Turn what a step typed (fill), picked in a <select> or gave a file input (upload) into a
 * {{variable}} of the test, named after the field. A <select> was left out: its option stayed
 * fixed, run_test could not change it, and its Examples column was missing. False for any
 * other step. Recorded playing a dataset, `row` is its first row: a value of it is its column's,
 * which each row of the dataset gives at run.
 */
export function variabilizeInput(step, index, usedNames, row = null) {
  const input = INPUTS[step.command];
  const value = input && step.params?.[input.param];
  if (!value || step._skipVariable) return false;
  const column = row && columnOf(row, value);
  if (column) {
    usedNames.add(column);
    step.variable = { name: column, type: input.type, defaultValue: row[column] };
    step.params[input.param] = `{{${column}}}`;
    return true;
  }
  // The name the agent gave it (record_step variable_name), else one from its field.
  const name = uniqueVarName(step._variableNameOverride || deriveVarNameFromLocators(step) || `${input.fallback}_${index + 1}`, usedNames);
  step.variable = { name, type: input.type, defaultValue: value };
  step.params[input.param] = `{{${name}}}`;
  return true;
}

/**
 * The column of a dataset's row a value typed is: written {{email}}, or the very value of a
 * column (3 characters or more: a 1 typed in a quantity is no id of the row).
 */
function columnOf(row, value) {
  const named = /^\{\{\s*([A-Za-z_]\w*)\s*\}\}$/.exec(value)?.[1];
  if (named) return Object.hasOwn(row, named) ? named : null;
  return value.length >= 3 ? Object.keys(row).find((column) => row[column] === value) ?? null : null;
}

export function uniqueVarName(baseName, usedNames) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }
  let suffix = 2;
  while (usedNames.has(`${baseName}_${suffix}`)) suffix++;
  const unique = `${baseName}_${suffix}`;
  usedNames.add(unique);
  return unique;
}

/**
 * The text a list item is known by: whitespace collapsed, and a trailing count dropped —
 * "Jardin (44)" is "Jardin", whose count changes from one search to the next. Replay
 * matches a by_text value as a substring, so "Jardin" still finds "Jardin (62)".
 */
export function itemLabel(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[([]\s*\d[\d\s.,]*[)\]]\s*$/, '')
    .substring(0, 80);
}

/** The step variable for a click on one item of a list, as classified. */
export function listVariable(name, listContext, { selectionMode }) {
  return {
    name,
    type: listContext.type === 'box' ? 'box_item' : 'list_item',
    defaultValue: selectionMode === 'by_text' ? itemLabel(listContext.selectedText) : String(listContext.selectedIndex),
    listContext: {
      type: listContext.type,
      parentSelector: listContext.parentSelector,
      itemXpath: listContext.itemXpath,
      totalItems: listContext.totalItems,
      selectedIndex: listContext.selectedIndex,
      selectedText: listContext.selectedText,
      selectionMode,
    },
  };
}

/**
 * Whether a click found in a list is navigation — a menu, a tab bar, a side menu —: where the
 * test goes, not a value it varies, so not a variable. Made one, a tab was replayed by its label
 * ("Runs7", a count in it, changed at the next run) or by its position, without the checks of
 * a click. The page says so (`listContext.navigation`), else the classifier did (`menu_item`).
 *
 * Never a list of choices: the page says it is one (`listContext.choice`: options, the
 * suggestions of a field), or it came right after the test typed (`afterTyping`) — a search
 * field's suggestions, which the classifier may call a dropdown menu, and which may sit in the
 * header's <nav>. Which suggestion is picked is a value of the test.
 */
export function isNavigation(listContext, classified = null, { afterTyping = false } = {}) {
  if (listContext?.choice || afterTyping) return false;
  return !!listContext?.navigation || classified?.variableName === 'menu_item';
}

/**
 * Whether the action before step `i` of a recording typed in a field — a wait for its
 * suggestions in between does not count —: what the click picks may be one of them.
 */
export function typedJustBefore(steps, i) {
  let j = i - 1;
  while (j >= 0 && steps[j].command === 'wait') j--;
  const before = steps[j];
  return !!before && (before.command === 'fill' || (before.command === 'keyboard' && /^.$/u.test(before.params?.key ?? '')));
}

// What a field's variable name ends with when it holds what is typed to search for the value
// picked: country_input → country.
const TYPED_SUFFIX = /_(?:input|search|query|field|text|box|typed)$/;

/** Accents and case dropped, words apart: what a typed text and a suggestion are compared by. */
const words = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * A suggestion picked right after typing — "Fr" typed, "France" clicked —: a variable of its own
 * ({{country}}, next to the typed {{country_input}}), the click going to the suggestion of that
 * text. Found at stop_recording, the list was gone (it closes once a suggestion is picked): the
 * click stayed a click on "France", or on the first suggestion, whatever was typed on a replay.
 * Only when a word of the clicked text starts with what was typed: "Save" clicked after typing
 * a name is not a suggestion. Only the locators by its text are kept: one by its place, or by a
 * class all the suggestions share, picked another suggestion on another value, silently. True
 * when the step was made one.
 */
export function variabilizeSuggestion(steps, i, usedNames) {
  const step = steps[i];
  if (step.command !== 'click' || step.variable || step._skipVariable || !typedJustBefore(steps, i)) return false;
  let j = i - 1;
  while (j >= 0 && steps[j].command === 'wait') j--;
  const typedStep = steps[j];
  const typed = typedStep.variable?.defaultValue ?? typedStep.params?.value ?? '';
  const label = String(step.params?.text ?? (step.locators ?? []).find((l) => l.type === 'text' || l.type === 'aria')?.value ?? '').replace(/\s+/g, ' ').trim();
  const typedWords = words(typed);
  if (!label || typedWords.join(' ').length < 2 || label.length > 80) return false;
  const labelWords = words(label);
  // Each typed word starts a word of the suggestion, in order: "saint eti" → "Saint-Étienne".
  let at = 0;
  for (const w of typedWords) {
    const found = labelWords.findIndex((lw, k) => k >= at && lw.startsWith(w));
    if (found < 0) return false;
    at = found + 1;
  }
  const field = typedStep.variable?.name ?? null;
  const base = field ? (TYPED_SUFFIX.test(field) ? field.replace(TYPED_SUFFIX, '') : `${field}_choice`) : 'suggestion';
  const name = uniqueVarName(step._variableNameOverride || base, usedNames);
  const placeholder = `{{${name}}}`;
  step.params = { ...Object.fromEntries(Object.entries(step.params ?? {}).filter(([key]) => key !== 'selector')), text: placeholder };
  const byText = (step.locators ?? [])
    .filter((l) => String(l.value ?? '').replace(/\s+/g, ' ').trim() === label)
    .map((l) => ({ ...l, value: placeholder }));
  step.locators = byText.length ? byText : [{ type: 'text', value: placeholder }];
  // "Pick France among the suggestions" read so on a run that picked Italy.
  if (step.intent) step.intent = step.intent.split(label).join(placeholder);
  step.variable = { name, type: 'text', defaultValue: label, ...(field ? { suggestionOf: field } : {}), ...suggestionsOfField(typedStep) };
  return true;
}

/**
 * The field whose suggestions these are, as the element of the project they make (elements.js):
 * `{ field, fieldName }` — its test ID or its stable selector, and what a person reads on it.
 * One element for the suggestions of a field, in every test that types in it, whatever its
 * variable is named there ({{country}} in one, {{country_choice}} in another). Empty when the
 * field has nothing stable to be known by.
 */
export function suggestionsOfField(typedStep) {
  const locators = typedStep?.locators ?? [];
  const testid = locators.find((l) => l.type === 'testid' && l.value)?.value;
  const selector = typedStep?.params?.selector;
  const field = testid ? `testid ${JSON.stringify(testid)}`
    : typeof selector === 'string' && selector && !/\{\{/.test(selector) && !isFragileSelector(selector) && !isPositionalSelector(selector) ? `css ${selector}` : null;
  if (!field) return {};
  const fieldName = ['label', 'aria', 'placeholder'].map((type) => locators.find((l) => l.type === type && l.value)?.value).find(Boolean) ?? selector ?? testid;
  return { field, fieldName: String(fieldName).replace(/\s+/g, ' ').trim().slice(0, 40) };
}
