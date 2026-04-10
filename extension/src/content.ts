// Browser Pilot — Content Script
// Injected into every page to enable deep DOM interaction

import { buildSnapshot, resolveRef, drawAnnotations, clearAnnotations, SnapshotOptions } from './dom/snapshot';
import FindSimilarElements from './utils/FindSimilarElements';

(() => {
  // Helper: build a stable CSS selector for an element (for serialization)
  function buildCssSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let seg = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === current!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          seg += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(seg);
      current = parent;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  chrome.runtime.onMessage.addListener((
    message: Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === 'ping') {
      sendResponse({ alive: true, url: window.location.href });
    }

    if (message.type === 'get_snapshot') {
      try {
        const options = (message.options || {}) as SnapshotOptions;
        const result = buildSnapshot(options);
        sendResponse({ success: true, result });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
    }

    if (message.type === 'resolve_ref') {
      resolveRef(message.ref as string)
        .then(result => {
          if (result) {
            sendResponse({ success: true, element: result });
          } else {
            sendResponse({ success: false, error: `Ref not found or invisible: ${message.ref}` });
          }
        })
        .catch(error => {
          sendResponse({ success: false, error: String(error) });
        });
    }

    if (message.type === 'draw_annotations') {
      try {
        drawAnnotations();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
    }

    if (message.type === 'clear_annotations') {
      try {
        clearAnnotations();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
    }

    if (message.type === 'show_overlay') {
      import('./dom/overlay').then(({ showOverlay }) => showOverlay(message.state as any));
      sendResponse({ success: true });
    }
    if (message.type === 'update_overlay') {
      import('./dom/overlay').then(({ updateOverlay }) => updateOverlay(message.state as any));
      sendResponse({ success: true });
    }
    if (message.type === 'hide_overlay') {
      import('./dom/overlay').then(({ hideOverlay }) => hideOverlay());
      sendResponse({ success: true });
    }

    if (message.type === 'detect_list_context') {
      try {
        let el: Element | null = null;
        if (message.selector) {
          el = document.querySelector(message.selector as string);
        } else if (message.text) {
          // Find element by visible text content
          const text = (message.text as string).trim();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const elem = node as Element;
            if (elem.children.length === 0 || elem.childNodes.length === 1) {
              if (elem.textContent?.trim() === text) { el = elem; break; }
            }
          }
        }
        if (!el) {
          sendResponse({ success: true, result: null });
          return true;
        }

        const maxLevels = 6;
        const listInfo = FindSimilarElements.getFrom(el, maxLevels);
        if (!listInfo) {
          sendResponse({ success: true, result: null });
          return true;
        }

        // Build a parent CSS selector for replay
        const parentSelector = buildCssSelector(listInfo.parent);

        // Gather text snippets from the similar items for LLM context
        const itemTexts: string[] = [];
        if (listInfo.childNodes) {
          listInfo.childNodes.slice(0, 5).forEach((node) => {
            const text = (node as Element).textContent?.trim().substring(0, 120) || '';
            if (text) itemTexts.push(text);
          });
        } else {
          // For type 'list', get items via xpath from the parent
          const xpathExpr = listInfo.elementXpath ? `.//${listInfo.elementXpath}` : '';
          if (xpathExpr && listInfo.parent) {
            const result = document.evaluate(
              xpathExpr, listInfo.parent, null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
            );
            for (let i = 0; i < Math.min(result.snapshotLength, 5); i++) {
              const node = result.snapshotItem(i);
              const text = (node as Element)?.textContent?.trim().substring(0, 120) || '';
              if (text) itemTexts.push(text);
            }
          }
        }

        // Get text of the selected element itself
        const selectedText = el.textContent?.trim().substring(0, 200) || '';

        sendResponse({
          success: true,
          result: {
            type: listInfo.type, // 'list' or 'box'
            parentSelector,
            itemXpath: listInfo.elementXpath || '',
            totalItems: listInfo.nbElements || 0,
            selectedIndex: listInfo.elementIndex ?? 0,
            selectedText,
            itemTexts, // for LLM context
          }
        });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
    }

    return true; // Keep message channel open for async sendResponse
  });
})();
