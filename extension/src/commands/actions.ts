// Commands that perform actions via Puppeteer
import { getPage } from '../puppeteer-client';
import { resolveTabId, waitForTabLoad, delay, ensureContentScript, SCROLL_SETTLE_DELAY_MS } from '../helpers';
import type {
  NavigateParams, ClickParams, FillParams,
  KeyboardParams, ScrollParams, KeyboardModifier
} from '../types';

const IS_MAC = navigator.userAgent.includes('Macintosh');
const CMD_KEY = IS_MAC ? 'Meta' : 'Control';

// ─── Element Resolution ─────────────────────────────────────────────

interface ResolvedElement {
  x: number;
  y: number;
  tag: string;
  text: string;
}

// Keep the ref resolver, as it talks to the content script map
async function resolveElementRef(tabId: number, ref: string): Promise<ResolvedElement> {
  await ensureContentScript(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'resolve_ref', ref }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.success) return reject(new Error(response?.error || 'Failed to resolve ref: ' + ref));
      resolve(response.element);
    });
  });
}

// ─── Commands ───────────────────────────────────────────────────────

export async function cmdNavigate({ url, tabId }: NavigateParams) {
  let targetTabId: number;

  if (tabId) {
    targetTabId = tabId;
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
    // Move and click coordinates visually simulating user interaction
    await page.mouse.move(element.x, element.y);
    await delay(50);
    await page.mouse.down();
    await delay(50);
    await page.mouse.up();
    
    return { success: true, tag: element.tag, text: element.text };
  }

  // Use explicit selector or text
  const finalSelector = text ? `::-p-text(${text})` : selector;
  if (!finalSelector) throw new Error('Provide selector, text, or ref to click');

  const elementHandle = await page.$(finalSelector);
  if (!elementHandle) throw new Error(`Element not found: ${finalSelector}`);

  // Auto-scrolls and clicks
  await elementHandle.click();
  
  // Try to grab some metadata to return
  const evalData = await page.evaluate((el: Element) => ({ tag: el.tagName, text: el.textContent?.slice(0, 100) || '' }), elementHandle);
  await elementHandle.dispose();

  return { success: true, tag: evalData.tag, text: evalData.text };
}

export async function cmdFill({ selector, value, tabId, clear, ref }: FillParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);
  const shouldClear = clear ?? true;

  if (ref) {
    const element = await resolveElementRef(resolvedTabId, ref);
    await page.mouse.click(element.x, element.y);
    
    if (shouldClear) {
      await page.keyboard.down(CMD_KEY);
      await page.keyboard.press('a');
      await page.keyboard.up(CMD_KEY);
      await page.keyboard.press('Backspace');
    }
    await page.keyboard.type(value);
    return { success: true, selector: ref };
  }

  const finalSelector = selector;
  if (!finalSelector) throw new Error('Provide selector or ref to fill');

  const elementHandle = await page.$(finalSelector);
  if (!elementHandle) throw new Error(`Element not found: ${finalSelector}`);

  await elementHandle.click();
  
  if (shouldClear) {
    await page.keyboard.down(CMD_KEY);
    await page.keyboard.press('a');
    await page.keyboard.up(CMD_KEY);
    await page.keyboard.press('Backspace');
  }

  await elementHandle.type(value);
  await elementHandle.dispose();

  return { success: true, selector: finalSelector };
}

export async function cmdKeyboard({ key, modifiers, tabId }: KeyboardParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const page = await getPage(resolvedTabId);

  const mods = modifiers || [];
  if (mods.includes('alt')) await page.keyboard.down('Alt');
  if (mods.includes('ctrl')) await page.keyboard.down('Control');
  if (mods.includes('meta')) await page.keyboard.down('Meta');
  if (mods.includes('shift')) await page.keyboard.down('Shift');

  // Convert key naming if necessary, but puppeteer supports most JS key names
  await page.keyboard.press(key as any);

  if (mods.includes('shift')) await page.keyboard.up('Shift');
  if (mods.includes('meta')) await page.keyboard.up('Meta');
  if (mods.includes('ctrl')) await page.keyboard.up('Control');
  if (mods.includes('alt')) await page.keyboard.up('Alt');

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
    const handle = await page.$(selector);
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
