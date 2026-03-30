// Chrome DevTools Protocol client via chrome.debugger API
// Manages debugger attachment lifecycle per tab

const attachedTabs = new Set<number>();

export async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Another debugger is already attached')) {
      attachedTabs.add(tabId);
      return;
    }
    throw new Error(`Failed to attach debugger to tab ${tabId}: ${message}`);
  }
}

export async function sendCdpCommand<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureDebuggerAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, method, params);
  return result as T;
}

export function detachDebugger(tabId: number): void {
  if (!attachedTabs.has(tabId)) return;
  chrome.debugger.detach({ tabId }).catch(() => {
    // Silently ignore detach errors (tab already closed, etc.)
  });
  attachedTabs.delete(tabId);
}

export function isDebuggerAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

// ─── Lifecycle Cleanup ──────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
  }
});
