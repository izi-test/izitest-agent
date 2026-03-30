// Browser Pilot — Content Script
// Injected into every page to enable deep DOM interaction

import { buildSnapshot, resolveRef, drawAnnotations, clearAnnotations, SnapshotOptions } from './dom/snapshot';

(() => {
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

    return true; // Keep message channel open for async sendResponse
  });
})();
