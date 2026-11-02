// IziTest Agent — Content Script
// Injected into every page to enable deep DOM interaction

import { buildSnapshot, resolveRef, refProblem, describeRef, drawAnnotations, clearAnnotations, SnapshotOptions, locateElement, elementByText, selectOption, setInputValue, setInputFiles, noFieldLabelled } from './dom/snapshot';
import FindSimilarElements from './utils/FindSimilarElements';
import { announceToParent, listenForHops } from './dom/frame-hop';
import type { FileData } from './dom/file-input';

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

  listenForHops();

  chrome.runtime.onMessage.addListener((
    message: Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === 'ping') {
      sendResponse({ alive: true, url: window.location.href });
    }

    if (message.type === 'announce_to_parent') {
      const point = typeof message.x === 'number' && typeof message.y === 'number'
        ? { x: message.x as number, y: message.y as number } : undefined;
      sendResponse({ sent: announceToParent(message.token as string, point, message.uncover === true) });
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

    if (message.type === 'describe_ref') {
      try {
        sendResponse({ success: true, info: describeRef(message.ref as string) });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
    }

    if (message.type === 'resolve_ref') {
      const problem = refProblem(message.ref as string);
      if (problem) {
        sendResponse({ success: false, error: problem, stale: true });
        return true;
      }
      resolveRef(message.ref as string, { uncover: message.uncover === true })
        .then(result => {
          if (result) {
            sendResponse({ success: true, element: result });
          } else {
            sendResponse({
              success: false,
              error: `Ref ${message.ref} is on the page but not visible now (hidden, collapsed, or zero-sized). ` +
                'Open whatever contains it first, then retry.',
            });
          }
        })
        .catch(error => {
          sendResponse({ success: false, error: String(error) });
        });
    }

    if (message.type === 'locate_element') {
      locateElement(
        { selector: message.selector as string | undefined, text: message.text as string | undefined, label: message.label as string | undefined },
        { uncover: message.uncover === true }
      )
        .then(result => {
          if (result) sendResponse({ success: true, element: result });
          else if (message.label) sendResponse({ success: false, error: noFieldLabelled(message.label as string) });
          else sendResponse({ success: false, error: `Element not found: ${message.selector || message.text}` });
        })
        .catch(error => sendResponse({ success: false, error: String(error) }));
    }

    if (message.type === 'select_option') {
      sendResponse(selectOption(
        { ref: message.ref as string | undefined, selector: message.selector as string | undefined, label: message.label as string | undefined },
        message.value as string,
        (message.matchBy as 'text' | 'value' | undefined) ?? 'text'
      ));
    }

    if (message.type === 'set_input_value') {
      sendResponse(setInputValue(
        { ref: message.ref as string | undefined, selector: message.selector as string | undefined, label: message.label as string | undefined },
        message.value as string
      ));
    }

    if (message.type === 'set_input_files') {
      sendResponse(setInputFiles(
        { ref: message.ref as string | undefined, selector: message.selector as string | undefined, label: message.label as string | undefined },
        message.files as FileData[]
      ));
    }

    if (message.type === 'draw_annotations') {
      try {
        const refs = drawAnnotations({
          banner: message.banner as boolean | undefined,
          extraRefs: message.frameRefs as number | undefined,
        });
        sendResponse({ success: true, refs });
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
          // The element the click by text went to (see elementByText), not the first with that text.
          el = elementByText((message.text as string).trim(), [document]);
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
