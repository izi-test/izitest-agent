// The card an element sits in, among cards alike — a product of a search's results —, when the
// element itself is no item of a list: an "Add" button six levels deep in its card, the "+" of a
// quantity only the card added to the cart shows. FindSimilarElements climbs six levels from the
// element and compares it with its look-alikes: on Auchan, the card was the seventh, and the "+"
// has no look-alike. Found again on a replay by the card's place (`itemXpath`, among the direct
// children of `parent`), then the element inside it (`withinXpath`).

export interface ListItem {
  parent: Element;
  item: Element;
  itemXpath: string;
  withinXpath: string;
  index: number;
  count: number;
}

const firstClass = (el: Element): string =>
  typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] ?? '' : '';

/** An XPath step for `el`'s tag and first class, the class matched whole ("card", not "card__title"). */
function stepOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = firstClass(el);
  return cls ? `${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : tag;
}

const childrenMatching = (parent: Element, step: string): Element[] => {
  const found = document.evaluate(`./${step}`, parent, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  return Array.from({ length: found.snapshotLength }, (_, i) => found.snapshotItem(i) as Element);
};

// What an item of a list is, by what it is or what it sits in: an article, a list item, a row —
// or any child of a grid, or of a row that wraps (a shop's cards). Not the sections of a page, one
// under the other: the Arena's "Search" button became "the seventh of its sections".
const ITEM_TAGS = new Set(['article', 'li', 'tr']);
const ITEM_ROLES = new Set(['listitem', 'row', 'article', 'gridcell', 'option']);
const LIST_TAGS = new Set(['ul', 'ol', 'tbody', 'table']);
const LIST_ROLES = new Set(['list', 'grid', 'feed', 'listbox', 'table', 'rowgroup']);
function looksLikeItem(node: Element, parent: Element): boolean {
  if (ITEM_TAGS.has(node.tagName.toLowerCase()) || ITEM_ROLES.has(node.getAttribute('role') ?? '')) return true;
  if (LIST_TAGS.has(parent.tagName.toLowerCase()) || LIST_ROLES.has(parent.getAttribute('role') ?? '')) return true;
  const style = getComputedStyle(parent);
  return style.display.includes('grid') || (style.display.includes('flex') && style.flexWrap.startsWith('wrap'));
}

/** Its children's tags and first classes: cards alike are built alike, whatever is deep inside. */
const shapeOf = (el: Element): string =>
  Array.from(el.children).slice(0, 8).map((c) => `${c.tagName}.${firstClass(c)}`).join(',');

/** The path from `item` down to `el`: each step its tag, its first class, its place among the same. */
function pathWithin(item: Element, el: Element): string {
  const steps: string[] = [];
  for (let node: Element | null = el; node && node !== item; node = node.parentElement) {
    const step = stepOf(node);
    const same = node.parentElement ? childrenMatching(node.parentElement, step) : [node];
    steps.unshift(same.length > 1 ? `${step}[${same.indexOf(node) + 1}]` : step);
  }
  return `./${steps.join('/')}`;
}

/**
 * The nearest ancestor of `el` that is one of at least 3 cards alike — siblings of its tag and
 * first class, built alike, items of a list (looksLikeItem) —, with what finds it and `el` in it
 * again. null: in no such card. The page's own frame is never one (body, html, a card without a
 * class).
 */
export function itemOf(el: Element, maxLevels = 10): ListItem | null {
  let node: Element | null = el.parentElement;
  for (let level = 0; node && level < maxLevels; level++, node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent || ['body', 'html'].includes(node.tagName.toLowerCase()) || !firstClass(node)) continue;
    const step = stepOf(node);
    const items = childrenMatching(parent, step);
    if (items.length < 3) continue;
    if (!looksLikeItem(node, parent)) continue;
    const shape = shapeOf(node);
    if (items.filter((other) => other !== node && shapeOf(other) === shape).length < 2) continue;
    return { parent, item: node, itemXpath: `./${step}`, withinXpath: pathWithin(node, el), index: items.indexOf(node), count: items.length };
  }
  return null;
}
