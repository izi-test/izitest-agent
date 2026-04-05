// Resolves list/box variable steps to a concrete element handle.
import { ensureContentScript } from '../helpers';
import type { WorkflowStep } from '../types';
import type { ElementHandle, Page } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';

export interface VariableResolve {
  parentSelector: string;
  itemXpath: string;
  selectionMode: 'by_index' | 'by_text';
  value: string;
}

export interface ReplayStep extends WorkflowStep {
  variableResolve?: VariableResolve;
}

export async function resolveVariableElement(
  page: Page,
  tabId: number,
  variableResolve: VariableResolve
): Promise<{ handle: ElementHandle<Element>; description: string } | null> {
  const { parentSelector, itemXpath, selectionMode, value } = variableResolve;

  try {
    await ensureContentScript(tabId);

    const result = await page.evaluate(
      (parentSel: string, xpath: string, mode: string, val: string) => {
        function findAndSelect(context: Element | Document, contextLabel: string):
          { x: number; y: number; text: string; index: number; count: number; via: string } | { error: string } {

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

            const rect = item.getBoundingClientRect();
            return {
              x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
              text: item.textContent?.trim().substring(0, 100) || '',
              index, count, via: contextLabel
            };
          } else {
            for (let i = 0; i < count; i++) {
              const item = xpathResult.snapshotItem(i) as Element;
              if (item && item.textContent?.trim().toLowerCase().includes(val.toLowerCase())) {
                const rect = item.getBoundingClientRect();
                return {
                  x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
                  text: item.textContent?.trim().substring(0, 100) || '',
                  index: i, count, via: contextLabel
                };
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
      parentSelector, itemXpath, selectionMode, value
    );

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
