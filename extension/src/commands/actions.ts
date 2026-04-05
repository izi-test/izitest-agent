// Direct browser action commands (navigate, click, fill, keyboard, scroll).
import { getPage } from '../puppeteer-client';
import { resolveTabId, waitForTabLoad, delay, ensureContentScript, SCROLL_SETTLE_DELAY_MS } from '../helpers';
import { CMD_KEY, MODIFIER_MAP, focusViaLocator, clearAndType } from './page-helpers';
import type { NavigateParams, ClickParams, FillParams, KeyboardParams, ScrollParams } from '../types';

// ─── Ref resolution (content script element map) ────────────────────

interface ResolvedElement {
  x: number;
  y: number;
  tag: string;
  text: string;
}

export async function resolveElementRef(tabId: number, ref: string): Promise<ResolvedElement> {
  await ensureContentScript(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'resolve_ref', ref }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.success) return reject(new Error(response?.error || 'Failed to resolve ref: ' + ref));
      resolve(response.element);
    });
  });
}

// ─── Commands ────────────────────────────────────────────────────────

export async function cmdNavigate({ url, tabId, newWindow }: NavigateParams) {
  let targetTabId: number;

  if (tabId) {
    targetTabId = tabId;
  } else if (newWindow) {
    const newWin = await chrome.windows.create({ url: 'about:blank' });
    targetTabId = newWin.tabs![0].id!;
  } else {
    const newTab = await chrome.tabs.create({ url: 'about:blank' });
    targetTabId = newTab.id!;
  }

  const page = await getPage(targetTabId);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForTabLoad(targetTabId);

  const updatedTab = await chrome.tabs.get(targetTabId);
  return { tabId: targetTabId, url: updatedTab.url, title: updatedTab.title };
}

export async function cmdClick({ selector, tabId, text, ref }: ClickParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);

  if (ref) {
    const element = await resolveElementRef(resolvedTabId, ref);
    await page.mouse.move(element.x, element.y);
    await delay(50);
    await page.mouse.down();
    await delay(50);
    await page.mouse.up();
    return { success: true, tag: element.tag, text: element.text };
  }

  const finalSelector = text ? `::-p-text(${text})` : selector;
  if (!finalSelector) throw new Error('Provide selector, text, or ref to click');

  const elementHandle = await page.waitForSelector(finalSelector, { timeout: 5000 }).catch(() => null);
  if (!elementHandle) throw new Error(`Element not found: ${finalSelector}`);
  await elementHandle.dispose().catch(() => {});

  // Use page.evaluate (Runtime.evaluate with current context) instead of
  // elementHandle.click() (Runtime.callFunctionOn with stale context ID).
  const isTextSelector = finalSelector.startsWith('::-p-text(');
  const textContent = isTextSelector
    ? finalSelector.slice('::-p-text('.length, -1)
    : null;

  const evalData = await page.evaluate((cssSelector: string | null, searchText: string | null) => {
    let el: Element | null = null;
    if (searchText !== null) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Element;
        if (node.children.length === 0 && node.textContent?.trim() === searchText) { el = node; break; }
      }
      if (!el) {
        el = [...document.querySelectorAll('button,a,input[type="submit"],input[type="button"]')]
          .find(e => e.textContent?.trim().includes(searchText)) ?? null;
      }
    } else if (cssSelector) {
      el = document.querySelector(cssSelector);
    }
    if (!el) return null;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: el.textContent?.slice(0, 100) || '',
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      hasBox: r.width > 0 && r.height > 0
    };
  }, isTextSelector ? null : finalSelector, textContent);

  if (!evalData) throw new Error(`Element not found after handle disposal: ${finalSelector}`);

  if (evalData.hasBox) {
    await page.mouse.click(evalData.x, evalData.y);
  } else {
    await page.evaluate((cssSelector: string | null, searchText: string | null) => {
      let el: Element | null = null;
      if (searchText) {
        el = [...document.querySelectorAll('button,a,input[type="submit"],input[type="button"]')]
          .find(e => e.textContent?.trim().includes(searchText)) ?? null;
      } else if (cssSelector) {
        el = document.querySelector(cssSelector);
      }
      (el as HTMLElement | null)?.click();
    }, isTextSelector ? null : finalSelector, textContent);
  }

  return { success: true, tag: evalData.tag, text: evalData.text };
}

export async function cmdFill({ selector, value, tabId, clear, ref }: FillParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);
  const shouldClear = clear ?? true;

  if (ref) {
    const element = await resolveElementRef(resolvedTabId, ref);
    await page.mouse.click(element.x, element.y);
    await clearAndType(page, value, shouldClear);
    return { success: true, selector: ref };
  }

  if (!selector) throw new Error('Provide selector or ref to fill');

  const elementHandle = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
  if (!elementHandle) throw new Error(`Element not found: ${selector}`);
  await elementHandle.dispose().catch(() => {});

  await focusViaLocator(page, 'css', selector);
  await delay(50);
  await clearAndType(page, value, shouldClear);

  return { success: true, selector };
}

export async function cmdKeyboard({ key, modifiers, tabId }: KeyboardParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);

  const mods = modifiers || [];
  for (const mod of mods) await page.keyboard.down(MODIFIER_MAP[mod]);
  await page.keyboard.press(key as any);
  for (const mod of [...mods].reverse()) await page.keyboard.up(MODIFIER_MAP[mod]);

  return { success: true, key };
}

export async function cmdScroll({ direction, amount, tabId, selector, ref }: ScrollParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);

  if (ref) {
    await resolveElementRef(resolvedTabId, ref);
    await delay(SCROLL_SETTLE_DELAY_MS);
    return { scrolledTo: ref };
  } else if (selector) {
    const handle = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
    if (handle) {
      await page.evaluate((el: Element) => el.scrollIntoView({ behavior: 'instant', block: 'center' }), handle);
      await handle.dispose();
    }
    return { scrolledTo: selector };
  }

  const scrollPixels = amount || 500;
  const deltaY = direction === 'up' ? -scrollPixels : scrollPixels;
  await page.mouse.wheel({ deltaY });

  return { scrolled: direction || 'down', pixels: scrollPixels };
}
