// Commands that perform actions via Chrome DevTools Protocol (CDP)
// Uses Input.dispatchMouseEvent, Input.dispatchKeyEvent, Page.navigate
// for native browser-level input that bypasses synthetic DOM events

import { sendCdpCommand } from '../cdp-client';
import { resolveTabId, waitForTabLoad, delay, SCROLL_SETTLE_DELAY_MS } from '../helpers';
import type {
  NavigateParams, ClickParams, FillParams,
  KeyboardParams, ScrollParams, KeyboardModifier, KeyDefinition
} from '../types';

// ─── Platform Detection ─────────────────────────────────────────────
// On macOS, select-all is Cmd+A (Meta), on Windows/Linux it's Ctrl+A
const IS_MAC = navigator.userAgent.includes('Macintosh');
const SELECT_ALL_MODIFIER = IS_MAC ? 4 : 2;

// ─── Element Resolution ─────────────────────────────────────────────
// Uses executeScript to locate elements and get viewport coordinates,
// then CDP handles the actual input events

interface ResolvedElement {
  x: number;
  y: number;
  tag: string;
  text: string;
}

interface ResolvedElementError {
  error: string;
}

type ResolveResult = ResolvedElement | ResolvedElementError;

async function resolveElementCoordinates(
  tabId: number,
  selector?: string,
  text?: string,
  ref?: string
): Promise<ResolvedElement> {
  if (ref) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'resolve_ref', ref }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.success) return reject(new Error(response?.error || 'Failed to resolve ref: ' + ref));
        resolve(response.element);
      });
    });
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (
      selectorArg: string | null,
      textArg: string | null
    ) => {
      let element: Element | null = null;

      if (textArg) {
        const CLICKABLE_SELECTOR = [
          'a', 'button', '[role="button"]', '[role="link"]',
          '[role="tab"]', '[role="menuitem"]', 'input[type="submit"]', 'summary'
        ].join(', ');
        const candidates = document.querySelectorAll(CLICKABLE_SELECTOR);
        let bestMatch: Element | null = null;
        let bestLength = Infinity;

        for (const node of candidates) {
          const nodeText = node.textContent?.trim();
          if (nodeText && nodeText.includes(textArg) && nodeText.length < bestLength) {
            bestMatch = node;
            bestLength = nodeText.length;
          }
        }

        if (!bestMatch) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Element;
            const nodeText = node.textContent?.trim();
            if (nodeText && nodeText.includes(textArg) && nodeText.length < bestLength) {
              bestMatch = node;
              bestLength = nodeText.length;
            }
          }
        }
        element = bestMatch;
      } else if (selectorArg) {
        element = document.querySelector(selectorArg);
      }

      if (!element) return { error: 'Element not found' };

      // Check if already in viewport — skip scrollIntoView for dropdown/list items
      // that are already visible, to avoid displacing overlay containers
      let rect = element.getBoundingClientRect();
      const inViewport =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth;

      if (!inViewport) {
        (element as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 150));
        rect = element.getBoundingClientRect();
      }
      if (rect.width === 0 || rect.height === 0) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const childRect = (walker.currentNode as Element).getBoundingClientRect();
          if (childRect.width > 0 && childRect.height > 0) {
            rect = childRect;
            break;
          }
        }
      }

      return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        tag: element.tagName,
        text: element.textContent?.slice(0, 100) ?? ''
      };
    },
    args: [selector || null, text || null]
  });

  const result = results[0]?.result as ResolveResult;
  if (!result || 'error' in result) {
    throw new Error((result as ResolvedElementError)?.error || 'Element not found');
  }
  return result as ResolvedElement;
}

// ─── CDP Input Helpers ──────────────────────────────────────────────

async function cdpMouseClick(tabId: number, x: number, y: number): Promise<void> {
  // 1. Move the mouse first to trigger hover states
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y
  });
  
  // 2. Inject a visual ripple effect for debugging
  chrome.scripting.executeScript({
    target: { tabId },
    func: (clientX, clientY) => {
      const ripple = document.createElement('div');
      ripple.style.position = 'fixed';
      ripple.style.left = `${clientX - 10}px`;
      ripple.style.top = `${clientY - 10}px`;
      ripple.style.width = '20px';
      ripple.style.height = '20px';
      ripple.style.borderRadius = '50%';
      ripple.style.backgroundColor = 'rgba(239, 68, 68, 0.4)';
      ripple.style.border = '2px solid #ef4444';
      ripple.style.zIndex = '2147483647';
      ripple.style.pointerEvents = 'none';
      ripple.style.transition = 'all 0.5s ease-out';
      ripple.style.transform = 'scale(0.5)';
      
      document.documentElement.appendChild(ripple);
      
      requestAnimationFrame(() => {
        ripple.style.transform = 'scale(2)';
        ripple.style.opacity = '0';
      });
      setTimeout(() => ripple.remove(), 500);
    },
    args: [x, y]
  }).catch(() => {});

  // Wait for hover animations/JS to trigger
  await delay(150);

  // 3. Perform the actual click
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await delay(50);
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });
}

function buildModifierFlags(modifiers?: KeyboardModifier[]): number {
  if (!modifiers) return 0;
  let flags = 0;
  if (modifiers.includes('alt')) flags |= 1;
  if (modifiers.includes('ctrl')) flags |= 2;
  if (modifiers.includes('meta')) flags |= 4;
  if (modifiers.includes('shift')) flags |= 8;
  return flags;
}

const SPECIAL_KEYS: Record<string, Omit<KeyDefinition, 'key'>> = {
  'Enter':      { code: 'Enter', keyCode: 13 },
  'Tab':        { code: 'Tab', keyCode: 9 },
  'Escape':     { code: 'Escape', keyCode: 27 },
  'Backspace':  { code: 'Backspace', keyCode: 8 },
  'Delete':     { code: 'Delete', keyCode: 46 },
  'ArrowUp':    { code: 'ArrowUp', keyCode: 38 },
  'ArrowDown':  { code: 'ArrowDown', keyCode: 40 },
  'ArrowLeft':  { code: 'ArrowLeft', keyCode: 37 },
  'ArrowRight': { code: 'ArrowRight', keyCode: 39 },
  'Home':       { code: 'Home', keyCode: 36 },
  'End':        { code: 'End', keyCode: 35 },
  'PageUp':     { code: 'PageUp', keyCode: 33 },
  'PageDown':   { code: 'PageDown', keyCode: 34 },
  ' ':          { code: 'Space', keyCode: 32 },
};

function getKeyDefinition(key: string): KeyDefinition {
  const special = SPECIAL_KEYS[key];
  if (special) return { key, ...special };

  if (key.length === 1) {
    const upperChar = key.toUpperCase();
    const code = key >= 'a' && key <= 'z' ? `Key${upperChar}`
               : key >= 'A' && key <= 'Z' ? `Key${key}`
               : key >= '0' && key <= '9' ? `Digit${key}`
               : '';
    return { key, code, keyCode: upperChar.charCodeAt(0), text: key };
  }

  return { key, code: key, keyCode: 0 };
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

  await sendCdpCommand(targetTabId, 'Page.navigate', { url });
  await waitForTabLoad(targetTabId);

  const updatedTab = await chrome.tabs.get(targetTabId);
  return { tabId: targetTabId, url: updatedTab.url, title: updatedTab.title };
}

export async function cmdClick({ selector, tabId, text, ref }: ClickParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const element = await resolveElementCoordinates(resolvedTabId, selector, text, ref);

  // Wait for scrollIntoView to settle before clicking
  await delay(SCROLL_SETTLE_DELAY_MS);
  await cdpMouseClick(resolvedTabId, element.x, element.y);

  return { success: true, tag: element.tag, text: element.text };
}

export async function cmdFill({ selector, value, tabId, clear, ref }: FillParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const element = await resolveElementCoordinates(resolvedTabId, selector, undefined, ref);

  await delay(SCROLL_SETTLE_DELAY_MS);

  // Native click to focus the input
  await cdpMouseClick(resolvedTabId, element.x, element.y);
  await delay(50);

  // Clear existing content if requested (default: true)
  const shouldClear = clear ?? true;
  if (shouldClear) {
    // Select all (Cmd+A on Mac, Ctrl+A on others)
    await sendCdpCommand(resolvedTabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: SELECT_ALL_MODIFIER, windowsVirtualKeyCode: 65
    });
    await sendCdpCommand(resolvedTabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
      modifiers: SELECT_ALL_MODIFIER, windowsVirtualKeyCode: 65
    });
    // Delete selected text
    await sendCdpCommand(resolvedTabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8
    });
    await sendCdpCommand(resolvedTabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8
    });
  }

  // Insert text via CDP — goes through the browser's native input pipeline
  await sendCdpCommand(resolvedTabId, 'Input.insertText', { text: value });

  const usedSelector = selector || ref;
  return { success: true, selector: usedSelector };
}

export async function cmdKeyboard({ key, modifiers, tabId }: KeyboardParams) {
  const resolvedTabId = await resolveTabId(tabId);
  const modifierFlags = buildModifierFlags(modifiers);
  const keyDef = getKeyDefinition(key);

  const baseParams = {
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    modifiers: modifierFlags,
  };

  await sendCdpCommand(resolvedTabId, 'Input.dispatchKeyEvent', {
    ...baseParams,
    type: 'keyDown',
    ...(keyDef.text ? { text: keyDef.text } : {}),
  });
  await sendCdpCommand(resolvedTabId, 'Input.dispatchKeyEvent', {
    ...baseParams,
    type: 'keyUp',
  });

  return { success: true, key };
}

export async function cmdScroll({ direction, amount, tabId, selector, ref }: ScrollParams) {
  const resolvedTabId = await resolveTabId(tabId);

  // Scroll to a specific element via DOM
  if (selector || ref) {
    await resolveElementCoordinates(resolvedTabId, selector, undefined, ref);
    await delay(SCROLL_SETTLE_DELAY_MS);
    return { scrolledTo: selector || ref };
  }

  // Scroll the viewport via CDP mouseWheel event
  const scrollPixels = amount || 500;
  const deltaY = direction === 'up' ? -scrollPixels : scrollPixels;

  await sendCdpCommand(resolvedTabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 400,
    y: 300,
    deltaX: 0,
    deltaY,
  });

  return { scrolled: direction || 'down', pixels: scrollPixels };
}
