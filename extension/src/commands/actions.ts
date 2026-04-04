// Commands that perform actions via Puppeteer
import { getPage, detachBrowser } from '../puppeteer-client';
import { resolveTabId, waitForTabLoad, delay, ensureContentScript, SCROLL_SETTLE_DELAY_MS } from '../helpers';
import type {
  NavigateParams, ClickParams, FillParams,
  KeyboardParams, ScrollParams, KeyboardModifier
} from '../types';

const IS_MAC = navigator.userAgent.includes('Macintosh');
const CMD_KEY = IS_MAC ? 'Meta' : 'Control';

// CSS.escape() is unavailable in Service Worker context — replicate its behaviour for attribute values.
function escapeCssString(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

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
      // Text-based search: find visible element whose trimmed text matches
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Element;
        if (node.children.length === 0 && node.textContent?.trim() === searchText) { el = node; break; }
      }
      if (!el) {
        // Broader: any element whose direct text includes the search text
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
    // Zero-size element — JS dispatch click, re-querying fresh
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

  // Verify element exists via Puppeteer selector engine, then dispose immediately
  const elementHandle = await page.waitForSelector(finalSelector, { timeout: 5000 }).catch(() => null);
  if (!elementHandle) throw new Error(`Element not found: ${finalSelector}`);
  await elementHandle.dispose().catch(() => {});

  // Focus via page.evaluate + mouse (no handle = no stale context risk)
  const box = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : null;
  }, finalSelector);

  if (box) {
    await page.mouse.click(box.x, box.y);
  } else {
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.focus();
      el?.click();
    }, finalSelector);
  }
  await delay(50);

  if (shouldClear) {
    await page.keyboard.down(CMD_KEY);
    await page.keyboard.press('a');
    await page.keyboard.up(CMD_KEY);
    await page.keyboard.press('Backspace');
  }

  await page.keyboard.type(value);

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

// ─── Replay ────────────────────────────────────────────────────────

import { cmdExecuteJs, cmdWait } from './queries';
import type { ReplaySequenceParams, Locator, WorkflowStep } from '../types';
import type { ElementHandle, Page } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';

interface VariableResolve {
  parentSelector: string;
  itemXpath: string;
  selectionMode: 'by_index' | 'by_text';
  value: string;
}

interface ReplayStep extends WorkflowStep {
  variableResolve?: VariableResolve;
}

interface LocatingResult {
  locatorUsed: string;
  locatorValue: string;
  handle: ElementHandle<Element>;
  usedFallback: boolean;
}

type ElementCondition = 'any' | 'visible' | 'enabled';

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

async function findElementWithLocators(
  page: Page,
  locators: Locator[],
  condition: ElementCondition = 'any'
): Promise<{ result: LocatingResult | null, errors: string[] }> {
  const LOCATOR_PRIORITY: Record<string, number> = {
    css: 0, testid: 0,
    attribute: 1, placeholder: 1,
    aria: 2, label: 2,
    xpath: 3,
    text: 4,
  };

  const sortedLocators = [...locators].sort((a, b) => {
    const priorityA = LOCATOR_PRIORITY[a.type] ?? 5;
    const priorityB = LOCATOR_PRIORITY[b.type] ?? 5;
    return priorityA - priorityB;
  });

  console.log(`  🕵️ Testing ${sortedLocators.length} locators in parallel [condition: ${condition}]...`);

  let hasWinner = false;

  const promises = sortedLocators.map(async (locator) => {
    let selector = '';
    if (locator.type === 'text') selector = `::-p-text(${locator.value})`;
    else if (locator.type === 'aria' || locator.type === 'label') selector = `aria/${locator.value}`;
    else if (locator.type === 'xpath') selector = `::-p-xpath(${locator.value})`;
    else if (locator.type === 'placeholder') selector = `[placeholder="${escapeCssString(locator.value)}"]`;
    else selector = locator.value; // css, testid, attribute

    const waitOptions = condition === 'visible'
      ? { timeout: 2000, visible: true }
      : { timeout: 2000 };

    try {
      let handle = await page.waitForSelector(selector, waitOptions).catch(() => null);
      let usedFallback = false;

      // Fallback: if visible condition failed, retry without it
      if (!handle && condition === 'visible') {
        handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
        if (handle) usedFallback = true;
      }

      if (!handle) {
        throw new Error(`${locator.type}="${locator.value}" (not found)`);
      }

      // Check enabled condition post-selection
      if (condition === 'enabled') {
        const enabled = await isElementEnabled(handle);
        if (!enabled) {
          await handle.dispose().catch(() => {});
          throw new Error(`${locator.type}="${locator.value}" (found but disabled/inert)`);
        }
      }

      // Handle race condition: if another locator already won, dispose this handle and fail
      if (hasWinner) {
        await handle.dispose().catch(() => {});
        throw new Error(`${locator.type}="${locator.value}" (lost the race)`);
      }

      hasWinner = true;
      console.log(`  ✅ Found element with locator ${locator.type}="${locator.value}"${usedFallback ? ' (fallback)' : ''}`);
      return { locatorUsed: locator.type, locatorValue: locator.value, handle, usedFallback };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(errorMessage);
    }
  });

  try {
    // Wait for the first successful locator
    const result = await Promise.any(promises);
    return { result, errors: [] }; // The winner has no errors to report
  } catch (aggregateError: any) {
    // All locators failed
    const errors = aggregateError instanceof AggregateError 
      ? aggregateError.errors.map((e: Error) => e.message)
      : [aggregateError.message || 'All locators failed unknown error'];
    return { result: null, errors };
  }
}

/**
 * Resolve a list/box variable to a specific element handle.
 * Uses XPath from the parent container to find items, then selects by index or text.
 */
async function resolveVariableElement(
  page: Page,
  tabId: number,
  variableResolve: VariableResolve
): Promise<{ handle: ElementHandle<Element>; description: string } | null> {
  const { parentSelector, itemXpath, selectionMode, value } = variableResolve;

  try {
    // Use the content script to resolve the list items in the DOM
    await ensureContentScript(tabId);

    const result = await page.evaluate(
      (parentSel: string, xpath: string, mode: string, val: string) => {
        // Helper: given a context node, find items via xpath and select by mode/value
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
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
              text: item.textContent?.trim().substring(0, 100) || '',
              index,
              count,
              via: contextLabel
            };
          } else {
            for (let i = 0; i < count; i++) {
              const item = xpathResult.snapshotItem(i) as Element;
              if (item && item.textContent?.trim().toLowerCase().includes(val.toLowerCase())) {
                const rect = item.getBoundingClientRect();
                return {
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2,
                  text: item.textContent?.trim().substring(0, 100) || '',
                  index: i,
                  count,
                  via: contextLabel
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

        // All strategies failed
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

    // Click on the coordinates found
    console.log(`  🎯 Variable resolved: item ${result.index}/${result.count} "${result.text}" (via ${result.via})`);

    // Move to coordinates and create a handle via elementFromPoint
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

export async function cmdReplaySequence({ steps, startIndex, newWindow }: ReplaySequenceParams, onProgress?: (data: any) => void) {
  const results: any[] = [];
  let currentTabId: number | undefined = undefined;
  const totalSteps = steps.length;
  const executionStartedAt = Date.now();

  console.log(`\n🎬 ════════════════════════════════════════════════════`);
  console.log(`🎬 REPLAY SEQUENCE STARTED — ${totalSteps} steps (starting at #${startIndex + 1})`);
  console.log(`🎬 ════════════════════════════════════════════════════\n`);

  // Mark steps before startIndex as skipped
  for (let s = 0; s < startIndex; s++) {
    results.push({ step: s + 1, command: steps[s].command, intent: steps[s].intent, status: 'skipped' });
  }

  let executionError: string | undefined;

  for (let i = startIndex; i < totalSteps; i++) {
    const step = steps[i] as ReplayStep;
    const baseParams = { ...step.params };
    const stepLabel = step.intent || step.command;
    const stepStartedAt = Date.now();
    
    console.log(`\n▶ Step ${i + 1}/${totalSteps}: [${step.command}] ${stepLabel}`);
    console.log(`  Params: ${JSON.stringify(baseParams)}`);

    onProgress?.({
      type: 'step_start',
      step: i + 1,
      command: step.command,
      intent: step.intent
    });

    if (currentTabId) {
      baseParams.tabId = currentTabId;
    } else {
      delete baseParams.tabId;
      if (newWindow) baseParams.newWindow = true;
    }

    try {
      // ─── Variable Resolution (list/box item selection) ───────
      let resolvedViaVariable = false;
      if (step.variableResolve && step.command === 'click') {
        console.log(`  🔀 Variable resolve: ${step.variableResolve.selectionMode}="${step.variableResolve.value}"`);
        
        const resolvedTabId = await resolveTabId(baseParams.tabId);
        const page = await getPage(resolvedTabId);
        currentTabId = resolvedTabId;

        const varResult = await resolveVariableElement(page, resolvedTabId, step.variableResolve);

        if (varResult) {
          try {
            console.log(`  🖱️ Clicking variable-resolved element...`);
            await varResult.handle.click();
            await varResult.handle.dispose();
            const stepFinishedAt = Date.now();
            console.log(`  ✅ Step ${i + 1} completed via variable resolve (${varResult.description})`);
            const stepResult = {
              step: i + 1, command: step.command, intent: step.intent, status: 'success',
              resolvedVia: 'variable', detail: varResult.description,
              startedAt: stepStartedAt, finishedAt: stepFinishedAt, durationMs: stepFinishedAt - stepStartedAt
            };
            results.push(stepResult);
            onProgress?.({ type: 'step_complete', stepResult });
            resolvedViaVariable = true;
          } catch (err) {
            await varResult.handle.dispose().catch(() => {});
            console.warn(`  ⚠️ Variable resolve click failed, falling back to locators: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          console.warn(`  ⚠️ Variable resolve returned null, falling back to locators`);
        }
      }

      if (resolvedViaVariable) {
        const delayMs = step.command === 'click' ? 150 : 50;
        console.log(`  ⏳ Waiting ${delayMs}ms...`);
        await delay(delayMs);
        continue;
      }

      const elementCommands = ['click', 'fill', 'scroll'];
      const hasLocators = step.locators && step.locators.length > 0 && elementCommands.includes(step.command);

      if (hasLocators) {
        console.log(`  Locators available: ${step.locators!.length} (${step.locators!.map((l: Locator) => l.type).join(', ')})`);

        const resolvedTabId = await resolveTabId(baseParams.tabId);
        currentTabId = resolvedTabId;

        const elementCondition: ElementCondition =
          step.command === 'click' ? 'visible' :
          step.command === 'fill'  ? 'enabled' :
          'any';

        const isStaleContextError = (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return msg.includes('Cannot find context') || msg.includes('detached') || msg.includes('destroyed');
        };

        const executeWithLocators = async (page: Page) => {
          const { result, errors } = await findElementWithLocators(page, step.locators!, elementCondition);
          if (!result) throw new Error(`All ${step.locators!.length} locators failed:\n${errors.join('\n')}`);

          const handle = result.handle;

          try {
            if (step.command === 'click') {
              // Dispose the handle immediately — any use of handle.evaluate() /
              // handle.click() goes through Runtime.callFunctionOn with the
              // context ID captured at waitForSelector time. If the SPA recreated
              // the execution context since then, that ID is stale and throws.
              // page.evaluate() uses Runtime.evaluate with the *current* frame
              // context (Puppeteer refreshes it on executionContextCreated events),
              // so it always hits the live context regardless of re-renders.
              await handle.dispose().catch(() => {});

              const winningType = result.locatorUsed;
              const winningValue = result.locatorValue;

              console.log(`  🖱️ Querying element position via page.evaluate (${winningType}="${winningValue}")...`);
              const box = await page.evaluate((type: string, value: string) => {
                let el: Element | null = null;
                if (type === 'xpath') {
                  const xResult = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                  el = xResult.singleNodeValue as Element | null;
                } else if (type === 'text') {
                  // Walk text nodes to find containing element
                  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                  while (walker.nextNode()) {
                    if (walker.currentNode.textContent?.includes(value)) {
                      el = walker.currentNode.parentElement;
                      break;
                    }
                  }
                } else if (type === 'aria' || type === 'label') {
                  el = document.querySelector(`[aria-label="${value}"]`) || document.querySelector(`[role][aria-label="${value}"]`);
                } else {
                  // css, testid, attribute, placeholder
                  el = document.querySelector(value);
                }
                if (!el) return null;
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0
                  ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
                  : null;
              }, winningType, winningValue);

              if (box) {
                console.log(`  🖱️ Clicking at (${Math.round(box.x)}, ${Math.round(box.y)}) via mouse...`);
                await page.mouse.click(box.x, box.y);
              } else {
                // Off-screen or zero-size element — JS dispatch click
                console.log(`  ↩️  No bounding box, dispatching JS click via page.evaluate`);
                await page.evaluate((type: string, value: string) => {
                  let el: Element | null = null;
                  if (type === 'xpath') {
                    const xResult = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    el = xResult.singleNodeValue as Element | null;
                  } else {
                    el = document.querySelector(value);
                  }
                  (el as HTMLElement | null)?.click();
                }, winningType, winningValue);
              }
            } else if (step.command === 'fill') {
              console.log(`  ⌨️ Filling with value: "${baseParams.value}"`);
              // Don't use handle at all — same stale context problem as click.
              // Use page.evaluate (Runtime.evaluate = current context) to focus,
              // then page.keyboard (Input.dispatchKeyEvent = no context needed).
              await handle.dispose().catch(() => {});

              const fillType = result.locatorUsed;
              const fillValue = result.locatorValue;

              // Focus the element via page.evaluate + mouse click for real focus
              const box = await page.evaluate((type: string, value: string) => {
                let el: Element | null = null;
                if (type === 'xpath') {
                  const xResult = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                  el = xResult.singleNodeValue as Element | null;
                } else if (type === 'aria' || type === 'label') {
                  el = document.querySelector(`[aria-label="${value}"]`) || document.querySelector(`[role][aria-label="${value}"]`);
                } else {
                  el = document.querySelector(value);
                }
                if (!el) return null;
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0
                  ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
                  : null;
              }, fillType, fillValue);

              if (box) {
                await page.mouse.click(box.x, box.y);
              } else {
                // Fallback: JS focus
                await page.evaluate((type: string, value: string) => {
                  let el: Element | null = null;
                  if (type === 'xpath') {
                    const xResult = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    el = xResult.singleNodeValue as Element | null;
                  } else {
                    el = document.querySelector(value);
                  }
                  (el as HTMLElement | null)?.focus();
                  (el as HTMLElement | null)?.click();
                }, fillType, fillValue);
              }
              await delay(50);

              const shouldClear = baseParams.clear ?? true;
              if (shouldClear) {
                await page.keyboard.down(CMD_KEY);
                await page.keyboard.press('a');
                await page.keyboard.up(CMD_KEY);
                await page.keyboard.press('Backspace');
              }
              await page.keyboard.type(String(baseParams.value));
            } else if (step.command === 'scroll') {
              console.log(`  📜 Scrolling to element...`);
              await page.evaluate((el: Element) => el.scrollIntoView({ behavior: 'instant', block: 'center' }), handle);
            }
          } finally {
            await handle.dispose().catch(() => {});
          }

          return result.locatorUsed;
        };

        // Attempt 1: normal
        let locatorUsed: string;
        let page = await getPage(resolvedTabId);
        try {
          locatorUsed = await executeWithLocators(page);
        } catch (firstErr) {
          if (!isStaleContextError(firstErr)) throw firstErr;

          // Stale context — evict cached page, reconnect, retry once
          console.log(`  ⚠️ Stale execution context on step ${i + 1}, evicting page cache and retrying...`);
          detachBrowser(resolvedTabId);
          await delay(300);
          page = await getPage(resolvedTabId);
          console.log(`  🔄 Retrying step ${i + 1} with fresh page connection...`);
          locatorUsed = await executeWithLocators(page);
        }

        const stepFinishedAt = Date.now();
        console.log(`  ✅ Step ${i + 1} completed successfully (via ${locatorUsed})`);
        const stepResult = {
          step: i + 1, command: step.command, intent: step.intent, status: 'success',
          locator: locatorUsed,
          startedAt: stepStartedAt, finishedAt: stepFinishedAt, durationMs: stepFinishedAt - stepStartedAt
        };
        results.push(stepResult);
        onProgress?.({ type: 'step_complete', stepResult });
      } else {
        console.log(`  No locators — dispatching command directly`);
        let res: any;
        if (step.command === 'navigate') res = await cmdNavigate(baseParams as any);
        else if (step.command === 'keyboard') res = await cmdKeyboard(baseParams as any);
        else if (step.command === 'click') res = await cmdClick(baseParams as any);
        else if (step.command === 'fill') res = await cmdFill(baseParams as any);
        else if (step.command === 'scroll') res = await cmdScroll(baseParams as any);
        else if (step.command === 'execute_js') res = await cmdExecuteJs(baseParams as any);
        else if (step.command === 'wait') res = await cmdWait(baseParams as any);
        else throw new Error(`Unsupported command in sequence: ${step.command}`);

        if (res && res.tabId) currentTabId = res.tabId;
        const stepFinishedAt = Date.now();
        console.log(`  ✅ Step ${i + 1} completed successfully`);
        const stepResult = {
          step: i + 1, command: step.command, intent: step.intent, status: 'success',
          startedAt: stepStartedAt, finishedAt: stepFinishedAt, durationMs: stepFinishedAt - stepStartedAt
        };
        results.push(stepResult);
        onProgress?.({ type: 'step_complete', stepResult });
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const stepFinishedAt = Date.now();
      console.error(`  🚨 Step ${i + 1} FAILED: ${errorMessage}`);
      const failedStepResult = {
        step: i + 1, command: step.command, intent: step.intent, status: 'failed',
        error: errorMessage,
        startedAt: stepStartedAt, finishedAt: stepFinishedAt, durationMs: stepFinishedAt - stepStartedAt
      };
      results.push(failedStepResult);
      onProgress?.({ type: 'step_complete', stepResult: failedStepResult });
      
      executionError = `Step ${i + 1}/${totalSteps} (${step.intent || step.command}) failed: ${errorMessage}`;

      // Mark remaining steps as skipped
      for (let s = i + 1; s < totalSteps; s++) {
        const skippedResult = { step: s + 1, command: steps[s].command, intent: steps[s].intent, status: 'skipped' };
        results.push(skippedResult);
        onProgress?.({ type: 'step_complete', stepResult: skippedResult });
      }
      break;
    }

    const delayMs = step.command === 'navigate' ? 300 : step.command === 'click' ? 150 : 50;
    console.log(`  ⏳ Waiting ${delayMs}ms...`);
    await delay(delayMs);
  }

  const executionFinishedAt = Date.now();
  const executionDurationMs = executionFinishedAt - executionStartedAt;
  const executionSuccess = !executionError;

  console.log(`\n🎬 ════════════════════════════════════════════════════`);
  console.log(`🎬 REPLAY SEQUENCE ${executionSuccess ? 'COMPLETED' : 'FAILED'} — ${results.filter(r => r.status === 'success').length}/${totalSteps} steps in ${executionDurationMs}ms`);
  console.log(`🎬 ════════════════════════════════════════════════════\n`);

  if (!executionSuccess) {
    throw Object.assign(new Error(executionError!), {
      results,
      startedAt: executionStartedAt,
      finishedAt: executionFinishedAt,
      durationMs: executionDurationMs
    });
  }

  return {
    success: true,
    startedAt: executionStartedAt,
    finishedAt: executionFinishedAt,
    durationMs: executionDurationMs,
    results
  };
}

