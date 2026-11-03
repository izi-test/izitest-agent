// Names and shapes of the variables a recording detects at save time. Shared by the MCP
// recorder (tools/test.js) and the dashboard agent (agent-executor.js), which each had
// their own copy.

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
  if (!value) return false;
  const column = row && columnOf(row, value);
  if (column) {
    usedNames.add(column);
    step.variable = { name: column, type: input.type, defaultValue: row[column] };
    step.params[input.param] = `{{${column}}}`;
    return true;
  }
  const name = uniqueVarName(deriveVarNameFromLocators(step) || `${input.fallback}_${index + 1}`, usedNames);
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
