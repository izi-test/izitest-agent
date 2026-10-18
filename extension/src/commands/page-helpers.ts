// Puppeteer-side helpers for element interaction.
// page.evaluate callbacks are serialized — _find() is re-declared inline in each one.
import type { Page } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';

export const IS_MAC = navigator.userAgent.includes('Macintosh');
export const CMD_KEY = IS_MAC ? 'Meta' : 'Control';

import type { KeyboardModifier, TypingMode } from '../types';
export const MODIFIER_MAP: Record<KeyboardModifier, string> = {
  alt: 'Alt', ctrl: 'Control', meta: 'Meta', shift: 'Shift'
};

// CSS.escape() is unavailable in Service Worker context.
export function escapeCssString(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

export function isStaleContextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Cannot find context') || msg.includes('detached') || msg.includes('destroyed');
}

// ─── In-page element finder (inlined in every page.evaluate) ────────
//
// page.evaluate serializes the callback — it cannot close over outer-scope
// functions. Each evaluate that needs element resolution re-declares _find.
// The canonical implementation lives here as documentation only.
//
// function _find(type, value): Element | null {
//   if (type === 'xpath')          → document.evaluate(value, ...)
//   if (type === 'text')           → TreeWalker text search
//   if (type === 'aria'|'label')   → [aria-label="..."]
//   else (css/testid/attr/ph)      → document.querySelector(value)
// }

export async function queryElementBox(page: Page, locatorType: string, locatorValue: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((type: string, value: string) => {
    function _find(t: string, v: string): Element | null {
      if (t === 'xpath') {
        const xr = document.evaluate(v, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return xr.singleNodeValue as Element | null;
      }
      if (t === 'text') {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) { if (w.currentNode.textContent?.includes(v)) return w.currentNode.parentElement; }
        return null;
      }
      if (t === 'aria' || t === 'label') {
        return document.querySelector(`[aria-label="${v}"]`) || document.querySelector(`[role][aria-label="${v}"]`);
      }
      return document.querySelector(v);
    }
    const el = _find(type, value);
    if (!el) return null;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : null;
  }, locatorType, locatorValue);
}

export async function jsDispatchClick(page: Page, locatorType: string, locatorValue: string): Promise<void> {
  await page.evaluate((type: string, value: string) => {
    function _find(t: string, v: string): Element | null {
      if (t === 'xpath') {
        const xr = document.evaluate(v, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return xr.singleNodeValue as Element | null;
      }
      if (t === 'text') {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) { if (w.currentNode.textContent?.includes(v)) return w.currentNode.parentElement; }
        return null;
      }
      if (t === 'aria' || t === 'label') {
        return document.querySelector(`[aria-label="${v}"]`) || document.querySelector(`[role][aria-label="${v}"]`);
      }
      return document.querySelector(v);
    }
    ((_find(type, value)) as HTMLElement | null)?.click();
  }, locatorType, locatorValue);
}

export async function jsFocusAndClick(page: Page, locatorType: string, locatorValue: string): Promise<void> {
  await page.evaluate((type: string, value: string) => {
    function _find(t: string, v: string): Element | null {
      if (t === 'xpath') {
        const xr = document.evaluate(v, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return xr.singleNodeValue as Element | null;
      }
      if (t === 'text') {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) { if (w.currentNode.textContent?.includes(v)) return w.currentNode.parentElement; }
        return null;
      }
      if (t === 'aria' || t === 'label') {
        return document.querySelector(`[aria-label="${v}"]`) || document.querySelector(`[role][aria-label="${v}"]`);
      }
      return document.querySelector(v);
    }
    const el = _find(type, value) as HTMLElement | null;
    el?.focus();
    el?.click();
  }, locatorType, locatorValue);
}

/** Mouse-click at element center, fallback to JS click if no bounding box. */
export async function clickViaLocator(page: Page, locatorType: string, locatorValue: string): Promise<void> {
  const box = await queryElementBox(page, locatorType, locatorValue);
  if (box) {
    console.log(`  🖱️ Clicking at (${Math.round(box.x)}, ${Math.round(box.y)}) via mouse...`);
    await page.mouse.click(box.x, box.y);
  } else {
    console.log(`  ↩️  No bounding box, dispatching JS click via page.evaluate`);
    await jsDispatchClick(page, locatorType, locatorValue);
  }
}

/**
 * Click a toggle element (checkbox/radio/switch) using handle.evaluate(el.click()).
 * This avoids the double-toggle caused by pointer event bubbling in custom
 * component wrappers (Radix, Spark, etc.) when using page.mouse.click().
 * handle.evaluate uses Runtime.callFunctionOn with the element's RemoteObjectId,
 * which is the exact equivalent of typing el.click() in DevTools console.
 */
export async function clickToggleViaHandle(handle: ElementHandle<Element>): Promise<void> {
  await handle.evaluate((el) => {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    (el as HTMLElement).click();
  });
}

/** Mouse-click to focus element, fallback to JS focus+click if no bounding box. */
export async function focusViaLocator(page: Page, locatorType: string, locatorValue: string): Promise<void> {
  const box = await queryElementBox(page, locatorType, locatorValue);
  if (box) {
    await page.mouse.click(box.x, box.y);
  } else {
    await jsFocusAndClick(page, locatorType, locatorValue);
  }
}

export async function clearAndType(page: Page, value: string, clear = true, typing: TypingMode = 'keys'): Promise<void> {
  if (clear) {
    // Select-all is named explicitly as an editing command. On macOS a Cmd+A sent through
    // CDP is only a key event — Chrome does not turn it into "select all" — so the field kept
    // its text and Backspace removed one character: "4242" then "x9" became "424x9", and
    // fill still answered success.
    await page.keyboard.down(CMD_KEY);
    await page.keyboard.press('a', { commands: ['SelectAll'] });
    await page.keyboard.up(CMD_KEY);
    await page.keyboard.press('Backspace');
  }
  if (typing === 'insert') {
    await page.keyboard.sendCharacter(value); // single Input.insertText
  } else {
    await page.keyboard.type(value);
  }
}
