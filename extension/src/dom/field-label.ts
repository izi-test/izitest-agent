// A form field found by the label a person reads next to it: what a scenario written without
// seeing the page can name ("When I fill the field "Email" with …"), where it cannot know a
// CSS selector.
//
// Matched as the exported code finds it (mcp-server/lib/codegen/locators.js):
// getByLabel(label, { exact: true }) or getByPlaceholder(label, { exact: true }), the first
// that shows. So the names a field has are Playwright's: its aria-labelledby, else its
// aria-label, else its <label for> and the <label> around it — then its placeholder. In page
// order, the replay and the generated test take the same field when two have that name.

const FIELD = [
  'input:not([type="hidden"])', 'select', 'textarea', '[contenteditable=""]', '[contenteditable="true"]',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]', '[role="spinbutton"]', '[role="slider"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="listbox"]',
].join(',');

// Elements a <label> can name (see HTMLInputElement.labels).
const LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS']);

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * What a field is called, as Playwright's getByLabel reads it: the whole text of each label,
 * spaces collapsed — "Phone *" for <label><span>Phone</span> <em>*</em>, not "Phone".
 */
export function namesOf(field: Element): string[] {
  const ids = normalize(field.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
  const root = field.getRootNode() as Document | ShadowRoot;
  const labelledBy = ids.map((id) => root.getElementById?.(id) ?? field.ownerDocument.getElementById(id)).filter(Boolean) as Element[];
  if (labelledBy.length) return labelledBy.map((el) => normalize(el.textContent));

  const ariaLabel = normalize(field.getAttribute('aria-label'));
  if (ariaLabel) return [ariaLabel];

  const labels = LABELABLE.has(field.tagName) ? (field as HTMLInputElement).labels : null;
  return labels ? Array.from(labels).map((label) => normalize(label.textContent)) : [];
}

/** On the page for a person to see: a box, and not hidden by its style (Playwright's "visible"). */
function shows(el: Element): boolean {
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  const view = el.ownerDocument.defaultView;
  return view?.getComputedStyle(el).visibility !== 'hidden';
}

/**
 * The field labelled `wanted`, or with it as placeholder, in these documents: the first that
 * shows, else the first there is — a checkbox styled away has no box, and is clicked through
 * its label (see measureForClick).
 */
export function fieldByLabel(wanted: string, docs: Document[]): Element | null {
  const name = normalize(wanted);
  if (!name) return null;
  const fields: Element[] = [];
  for (const doc of docs) {
    for (const field of Array.from(doc.querySelectorAll(FIELD))) {
      if (namesOf(field).includes(name) || normalize(field.getAttribute('placeholder')) === name) fields.push(field);
    }
  }
  return fields.find(shows) ?? fields[0] ?? null;
}

/** The fields' names on these documents, for an error that says what there is instead. */
export function fieldNames(docs: Document[], max = 12): string[] {
  const names = new Set<string>();
  for (const doc of docs) {
    for (const field of Array.from(doc.querySelectorAll(FIELD))) {
      const name = namesOf(field)[0] ?? normalize(field.getAttribute('placeholder'));
      if (name && shows(field)) names.add(name);
      if (names.size >= max) return [...names];
    }
  }
  return [...names];
}
