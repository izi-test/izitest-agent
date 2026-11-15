// Resolves list/box variable steps to a concrete element handle.
import { ensureContentScript } from '../helpers';
import type { WorkflowStep } from '../types';
import type { ElementHandle, Page } from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';

export interface VariableResolve {
  parentSelector: string;
  itemXpath: string;
  selectionMode: 'by_index' | 'by_text';
  value: string;
  /** The element inside the item picked — the "Add" button of the second product's card. */
  withinXpath?: string;
}

export interface ReplayStep extends WorkflowStep {
  variableResolve?: VariableResolve;
}

// How long the item, or the element inside it, is waited for: the "+" of a quantity shows once
// the "Add" before it has been answered, the results once the search has.
const RESOLVE_WAIT_MS = 10_000;
const RESOLVE_POLL_MS = 250;

export async function resolveVariableElement(
  page: Page,
  tabId: number,
  variableResolve: VariableResolve,
  { waitMs = RESOLVE_WAIT_MS }: { waitMs?: number } = {}
): Promise<{ handle: ElementHandle<Element>; description: string } | null> {
  const { parentSelector, itemXpath, selectionMode, value, withinXpath = '' } = variableResolve;

  try {
    await ensureContentScript(tabId);

    const until = Date.now() + waitMs;
    const attempt = () => page.evaluate(
      (parentSel: string, xpath: string, mode: string, val: string, within: string) => {
        type Found = { x: number; y: number; text: string; index: number; count: number; via: string };
        // The item picked, or the element inside it (`within`), brought into view: its centre is clicked.
        function target(item: Element, index: number, count: number, via: string): Found | { error: string } {
          let el: Element | null = item;
          if (within) {
            const inside = document.evaluate(within, item, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            el = inside.singleNodeValue as Element | null;
            if (!el) return { error: `Nothing at "${within}" in item ${index} of ${count} (${via})` };
          }
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
            text: item.textContent?.trim().replace(/\s+/g, ' ').substring(0, 100) || '',
            index, count, via,
          };
        }

        function findAndSelect(context: Element | Document, contextLabel: string): Found | { error: string } {

          const xpathExpr = xpath.startsWith('.') ? xpath : `.//${xpath}`;
          const xpathResult = document.evaluate(
            xpathExpr, context, null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
          );

          const count = xpathResult.snapshotLength;
          if (count === 0) return { error: `No items found with xpath "${xpath}" in ${contextLabel}` };

          if (mode === 'by_index') {
            const index = parseInt(val, 10);
            if (isNaN(index) || index < 0 || index >= count) {
              return { error: `Index ${val} out of range (0-${count - 1}) in ${contextLabel}` };
            }
            const item = xpathResult.snapshotItem(index) as Element;
            if (!item) return { error: `Item at index ${index} is null` };
            return target(item, index, count, contextLabel);
          } else {
            for (let i = 0; i < count; i++) {
              const item = xpathResult.snapshotItem(i) as Element;
              if (item && item.textContent?.trim().toLowerCase().includes(val.toLowerCase())) {
                return target(item, i, count, contextLabel);
              }
            }
            return { error: `No item with text containing "${val}" found (${count} items in ${contextLabel})` };
          }
        }

        // Strategy 1: Try exact parentSelector
        const parent = document.querySelector(parentSel);
        if (parent) {
          const res = findAndSelect(parent, 'parent');
          if (!('error' in res)) return res;
        }

        // Strategy 2: Try progressively shorter parentSelector (trim from the left)
        const parts = parentSel.split(' > ');
        for (let trim = 1; trim < Math.min(parts.length - 1, 4); trim++) {
          const shorter = parts.slice(trim).join(' > ');
          const candidate = document.querySelector(shorter);
          if (candidate) {
            const res = findAndSelect(candidate, `trimmed-parent(${trim})`);
            if (!('error' in res)) return res;
          }
        }

        // Strategy 3: Search the entire document as last resort
        const globalRes = findAndSelect(document, 'document-global');
        if (!('error' in globalRes)) return globalRes;

        const errors = [];
        if (!parent) errors.push(`Parent "${parentSel}" not found`);
        errors.push(globalRes.error);
        return { error: errors.join('; ') };
      },
      parentSelector, itemXpath, selectionMode, value, withinXpath
    );
    let result = await attempt();
    while ('error' in result && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, RESOLVE_POLL_MS));
      result = await attempt();
    }

    if ('error' in result) {
      console.error(`  ❌ Variable resolve failed: ${result.error}`);
      return null;
    }

    console.log(`  🎯 Variable resolved: item ${result.index}/${result.count} "${result.text}" (via ${result.via})`);

    await page.mouse.move(result.x, result.y);
    const handle = await page.evaluateHandle(
      (x: number, y: number) => document.elementFromPoint(x, y),
      result.x, result.y
    );

    if (!handle) return null;

    return {
      handle: handle as ElementHandle<Element>,
      description: `${selectionMode}=${value} (item ${result.index}/${result.count}: "${result.text}" via ${result.via})`
    };
  } catch (err) {
    console.error(`  ❌ Variable resolve error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
