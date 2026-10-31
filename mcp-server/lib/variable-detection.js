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

// Where a field's name is read, best first: what a person reads next to it (its label, its
// accessible name), then the name the form submits it under, then the placeholder last —
// a placeholder is an example value: "you@example.com" made {{youexamplecom}}.
const FIELD_NAME_SOURCES = [
  (l) => l.type === 'label' && l.value,
  (l) => l.type === 'aria' && l.value,
  (l) => l.type === 'attribute' && /\[name="([^"]+)"\]/.exec(l.value)?.[1],
  (l) => l.type === 'placeholder' && l.value,
];

/** A variable name for the field a step fills, from its recorded locators; null without one. */
export function deriveVarNameFromLocators(step) {
  const locators = step.locators || [];
  for (const source of FIELD_NAME_SOURCES) {
    for (const locator of locators) {
      const text = source(locator);
      const name = text ? slug(text) : '';
      if (name.length >= 2 && !/^\d/.test(name)) return name;
    }
  }
  return null;
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
