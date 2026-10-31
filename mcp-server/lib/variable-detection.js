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
  // A field filled by selector has no locators: its selector is all there is.
  const locators = step.locators?.length ? step.locators
    : step.params?.selector ? [{ type: 'css', value: step.params.selector }] : [];
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

// The variable type of what a step puts in a field.
const INPUT_TYPES = { fill: 'text', select: 'select' };

/**
 * Turn what a step typed (fill) or picked in a <select> into a {{variable}} of the test,
 * named after the field. A <select> was left out: its option stayed fixed, run_test could
 * not change it, and its Examples column was missing. False for any other step.
 */
export function variabilizeInput(step, index, usedNames) {
  const type = INPUT_TYPES[step.command];
  if (!type || !step.params?.value) return false;
  const name = uniqueVarName(deriveVarNameFromLocators(step) || `${step.command === 'select' ? 'select' : 'input'}_${index + 1}`, usedNames);
  step.variable = { name, type, defaultValue: step.params.value };
  step.params.value = `{{${name}}}`;
  return true;
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
