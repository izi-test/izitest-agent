// Locator engine: finds elements via multiple selector strategies in parallel.
import { escapeCssString } from './page-helpers';
import type { Locator } from '../types';
import type { ElementHandle, Page } from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';

export interface LocatingResult {
  locatorUsed: string;
  locatorValue: string;
  handle: ElementHandle<Element>;
  usedFallback: boolean;
}

export type ElementCondition = 'any' | 'visible' | 'enabled';

const LOCATOR_PRIORITY: Record<string, number> = {
  css: 0, testid: 0,
  attribute: 1, placeholder: 1,
  role: 2, aria: 2, label: 2,
  xpath: 3,
  text: 4,
};

export function locatorToPuppeteerSelector(locator: Locator): string {
  if (locator.type === 'text') return `::-p-text(${locator.value})`;
  // Read as CSS, the role alone ("button") would find the page's first button.
  if (locator.type === 'role') return `aria/${locator.name ?? ''}[role="${escapeCssString(locator.value)}"]`;
  if (locator.type === 'aria' || locator.type === 'label') return `aria/${locator.value}`;
  if (locator.type === 'xpath') return `::-p-xpath(${locator.value})`;
  if (locator.type === 'placeholder') return `[placeholder="${escapeCssString(locator.value)}"]`;
  return locator.value; // css, testid, attribute
}

async function isElementEnabled(handle: ElementHandle<Element>): Promise<boolean> {
  return handle.evaluate((el) => {
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if ((el as HTMLButtonElement).disabled) return false;
    }
    const style = window.getComputedStyle(el);
    return style.pointerEvents !== 'none';
  });
}

/** A role locator recorded with where it is: inside its scope, or the nth of its kind. */
async function findPlaced(page: Page, locator: Locator, selector: string, options: { timeout: number; visible?: boolean }): Promise<ElementHandle<Element> | null> {
  if (locator.scope) {
    const scopeSelector = locator.scope.testid ? `[data-testid="${escapeCssString(locator.scope.testid)}"]` : locator.scope.css!;
    const scope = await page.waitForSelector(scopeSelector, { timeout: options.timeout });
    if (!scope) return null;
    try {
      return await scope.waitForSelector(selector, options);
    } finally {
      await scope.dispose().catch(() => {});
    }
  }
  const first = await page.waitForSelector(selector, options);
  if (!first) return null;
  await first.dispose().catch(() => {});
  const all = await page.$$(selector);
  const chosen = all[locator.nth!] ?? null;
  await Promise.all(all.filter((h) => h !== chosen).map((h) => h.dispose().catch(() => {})));
  return chosen;
}

export async function findElementWithLocators(
  page: Page,
  locators: Locator[],
  condition: ElementCondition = 'any'
): Promise<{ result: LocatingResult | null, errors: string[] }> {
  // A role and name the page has more than once was recorded with where it is (scope, nth):
  // the same name read alone (aria, text, label) finds the first of them — racing, it could
  // win and click the login form's "Clear" for the contact form's.
  const placed = locators.find((l) => l.type === 'role' && (l.scope || l.nth != null));
  const usable = placed
    ? locators.filter((l) => !(['aria', 'text', 'label'].includes(l.type) && l.value === placed.name))
    : locators;
  const sortedLocators = [...usable].sort((a, b) =>
    (LOCATOR_PRIORITY[a.type] ?? 5) - (LOCATOR_PRIORITY[b.type] ?? 5)
  );

  console.log(`  🕵️ Testing ${sortedLocators.length} locators in parallel [condition: ${condition}]...`);

  let hasWinner = false;

  const promises = sortedLocators.map(async (locator) => {
    const selector = locatorToPuppeteerSelector(locator);
    const waitOptions = condition === 'visible'
      ? { timeout: 2000, visible: true }
      : { timeout: 2000 };

    try {
      const find = (options: typeof waitOptions | { timeout: number }) => locator.type === 'role' && (locator.scope || locator.nth != null)
        ? findPlaced(page, locator, selector, options)
        : page.waitForSelector(selector, options);
      let handle = await find(waitOptions).catch(() => null);
      let usedFallback = false;

      if (!handle && condition === 'visible') {
        handle = await find({ timeout: 800 }).catch(() => null);
        if (handle) usedFallback = true;
      }

      if (!handle) {
        throw new Error(`${locator.type}="${locator.value}" (not found)`);
      }

      if (condition === 'enabled') {
        const enabled = await isElementEnabled(handle);
        if (!enabled) {
          await handle.dispose().catch(() => {});
          throw new Error(`${locator.type}="${locator.value}" (found but disabled/inert)`);
        }
      }

      if (hasWinner) {
        await handle.dispose().catch(() => {});
        throw new Error(`${locator.type}="${locator.value}" (lost the race)`);
      }

      hasWinner = true;
      console.log(`  ✅ Found element with locator ${locator.type}="${locator.value}"${usedFallback ? ' (fallback)' : ''}`);
      return { locatorUsed: locator.type, locatorValue: locator.value, handle, usedFallback };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  try {
    const result = await Promise.any(promises);
    return { result, errors: [] };
  } catch (aggregateError: any) {
    const errors = aggregateError instanceof AggregateError
      ? aggregateError.errors.map((e: Error) => e.message)
      : [aggregateError.message || 'All locators failed unknown error'];
    return { result: null, errors };
  }
}
