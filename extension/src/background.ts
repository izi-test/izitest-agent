// Browser Pilot — Background Service Worker
// Connects to the bridge server via WebSocket and executes browser commands
// Actions use Chrome DevTools Protocol (CDP) for native input simulation

import { updateBadge, resolveTabId, ensureContentScript, captureTabScreenshot, delay } from './helpers';
import { cmdNavigate, cmdClick, cmdFill, cmdSelect, cmdKeyboard, cmdScroll } from './commands/actions';
import { cmdReplaySequence } from './commands/replay';
import {
  cmdSnapshot, cmdExtract, cmdGetPageInfo, cmdScreenshot,
  cmdGetTabs, cmdCloseTab, cmdWait, cmdExecuteJs, cmdGetCookies
} from './commands/queries';

// Importing puppeteer-client to register its lifecycle listeners
import { detachBrowser } from './puppeteer-client';

// ─── Content-Script Commands ────────────────────────────────────────

async function cmdDetectListContext(params: { selector?: string; text?: string; tabId?: number }): Promise<unknown> {
  const tabId = await resolveTabId(params.tabId);
  await ensureContentScript(tabId);
  return new Promise((resolve, reject) => {
    const msg: Record<string, unknown> = { type: 'detect_list_context' };
    if (params.selector) msg.selector = params.selector;
    if (params.text) msg.text = params.text;
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.success) return reject(new Error(response?.error || 'detect_list_context failed'));
      resolve(response.result);
    });
  });
}

const WS_URL = 'ws://127.0.0.1:3456';
const RECONNECT_DELAY_MS = 1000;
const KEEPALIVE_ALARM = 'browser-pilot-keepalive';
const KEEPALIVE_INTERVAL_MIN = 0.4; // ~24 seconds, under the 30s MV3 limit

let websocket: WebSocket | null = null;
let profileId: string | null = null;
let isConnected = false;

// ─── Command Dispatcher ─────────────────────────────────────────────

type CommandHandler = (params: Record<string, unknown>, onProgress?: (data: any) => void) => Promise<unknown>;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  navigate:     (params) => cmdNavigate(params as unknown as Parameters<typeof cmdNavigate>[0]),
  click:        (params) => cmdClick(params as unknown as Parameters<typeof cmdClick>[0]),
  fill:         (params) => cmdFill(params as unknown as Parameters<typeof cmdFill>[0]),
  select:       (params) => cmdSelect(params as unknown as Parameters<typeof cmdSelect>[0]),
  keyboard:     (params) => cmdKeyboard(params as unknown as Parameters<typeof cmdKeyboard>[0]),
  scroll:       (params) => cmdScroll(params as unknown as Parameters<typeof cmdScroll>[0]),
  snapshot:     (params) => cmdSnapshot(params as unknown as Parameters<typeof cmdSnapshot>[0]),
  extract:      (params) => cmdExtract(params as unknown as Parameters<typeof cmdExtract>[0]),
  get_page_info:(params) => cmdGetPageInfo(params as unknown as Parameters<typeof cmdGetPageInfo>[0]),
  screenshot:   (params) => cmdScreenshot(params as unknown as Parameters<typeof cmdScreenshot>[0]),
  get_tabs:     ()       => cmdGetTabs(),
  close_tab:    (params) => cmdCloseTab(params as unknown as Parameters<typeof cmdCloseTab>[0]),
  wait:         (params) => cmdWait(params as unknown as Parameters<typeof cmdWait>[0]),
  execute_js:   (params) => cmdExecuteJs(params as unknown as Parameters<typeof cmdExecuteJs>[0]),
  get_cookies:  (params) => cmdGetCookies(params as unknown as Parameters<typeof cmdGetCookies>[0]),
  replay_sequence:(params, onProgress)=> cmdReplaySequence(params as unknown as Parameters<typeof cmdReplaySequence>[0], onProgress),
  detect_list_context:(params) => cmdDetectListContext(params as unknown as { selector?: string; text?: string; tabId?: number }),
};

function isAboutBlankError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('about:blank') && msg.includes('Cannot access contents');
}

async function executeCommand(command: string, params: Record<string, unknown>, onProgress?: (data: any) => void): Promise<unknown> {
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);

  try {
    return await handler(params, onProgress);
  } catch (error) {
    if (!isAboutBlankError(error)) throw error;

    // Tab got hijacked to about:blank (e.g., ad tracker iframe).
    // Evict the stale Puppeteer connection and retry once.
    const tabId = params.tabId as number | undefined;
    if (tabId) {
      console.warn(`[BrowserPilot] about:blank error on tab ${tabId}, evicting and retrying...`);
      detachBrowser(tabId);
      await delay(300);

      // Verify the tab still has a real URL before retrying
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && tab.url.startsWith('about:blank')) {
          throw new Error(
            `Tab ${tabId} is stuck on about:blank (likely hijacked by an ad/tracker). ` +
            `Navigate to the desired URL again to recover.`
          );
        }
      } catch (tabErr) {
        if (tabErr instanceof Error && tabErr.message.includes('stuck on about:blank')) throw tabErr;
        // Tab might have been removed — let the retry fail naturally
      }

      return handler(params, onProgress);
    }

    throw error;
  }
}

// ─── WebSocket Connection ───────────────────────────────────────────

function connect(): void {
  if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) return;

  websocket = new WebSocket(WS_URL);

  websocket.onopen = () => {
    isConnected = true;
    chrome.storage.local.get(['profileId'], (result) => {
      profileId = result.profileId || `profile-${Date.now()}`;
      chrome.storage.local.set({ profileId });
      websocket!.send(JSON.stringify({
        type: 'register',
        profileId,
        userAgent: navigator.userAgent
      }));
    });
    updateBadge('ON', '#10b981');
    console.log('[BrowserPilot] Connected to bridge');
  };

  websocket.onmessage = async (event: MessageEvent) => {
    let messageId: string | undefined;
    try {
      const message = JSON.parse(event.data);
      messageId = message.id;

      if (message.type === 'command') {
        console.group(`[BrowserPilot] ⚡ Command: ${message.command}`);
        console.log('Params:', message.params);
        
        const captureDebugScreenshot = async (isError: boolean) => {
          try {
            if (!['screenshot', 'snapshot', 'get_tabs', 'execute_js'].includes(message.command)) {
              const debugTabId = message.params?.tabId as number | undefined;
              const resolvedDebugTabId = await resolveTabId(debugTabId);
              const dataUrl = await captureTabScreenshot(resolvedDebugTabId, { format: 'jpeg', quality: 60 });
              console.log(
                '%c ',
                `font-size: 1px; padding: 150px 250px; background-size: contain; background-repeat: no-repeat; background-position: center; border: 3px solid ${isError ? '#ef4444' : '#10b981'}; background-image: url('${dataUrl}')`
              );
            }
          } catch (e) {
            // ignore UI errors if no tab is visible
          }
        };

        const startTime = performance.now();
        try {
          const onProgress = (data: any) => {
            if (websocket?.readyState === WebSocket.OPEN) {
              websocket.send(JSON.stringify({
                type: 'progress',
                id: message.id,
                data
              }));
            }
          };

          const result = await executeCommand(message.command, message.params, onProgress);
          const duration = Math.round(performance.now() - startTime);
          console.log(`Result (${duration}ms):`, result);
          await captureDebugScreenshot(false);
          console.groupEnd();

          websocket!.send(JSON.stringify({
            type: 'result',
            id: message.id,
            result
          }));
        } catch (error) {
          await captureDebugScreenshot(true);
          throw error;
        }
      } else if (message.type === 'set_overlay_state') {
        const state = message.state;
        // In some cases we want to update state but not popup if it wasn't there
        // Actually, if we pass mode: 'success' or 'failed', we DO want to update existing overlay, but actually we WANT to show it if it wasn't there.
        // Wait, mode: 'success'/'failed' without updateOnly should use 'update_overlay' instead of 'show_overlay'?
        // 'show_overlay' will re-create it if it doesn't exist, which is fine!
        const msgType = state === null ? 'hide_overlay' : (state.updateOnly ? 'update_overlay' : 'show_overlay');
        
        const targetTabId = message.tabId;
        if (targetTabId) {
          chrome.tabs.sendMessage(targetTabId, { type: msgType, state }).catch(() => {});
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: msgType, state }).catch(() => {});
            }
          });
        }
      }
    } catch (error) {
      console.groupEnd();
      console.error('[BrowserPilot] Error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (websocket?.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: 'result',
          id: messageId,
          error: errorMessage
        }));
      }
    }
  };

  websocket.onclose = () => {
    isConnected = false;
    updateBadge('OFF', '#ef4444');
    console.log('[BrowserPilot] Disconnected, reconnecting...');
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  websocket.onerror = () => {
    websocket?.close();
  };
}

// ─── Popup Message Handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((
  message: Record<string, unknown>,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => {
  if (message.type === 'getStatus') {
    sendResponse({ connected: isConnected, profileId });
  }

  if (message.type === 'setProfileId') {
    profileId = message.profileId as string;
    chrome.storage.local.set({ profileId });
    if (websocket?.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'register', profileId }));
    }
    sendResponse({ ok: true });
  }

  if (message.type === 'reconnect') {
    websocket?.close();
    setTimeout(connect, 100);
    sendResponse({ ok: true });
  }

  // Debug panel: execute commands locally from the popup without WebSocket
  if (message.type === 'executeLocal') {
    const { command, params } = message as { command: string; params: Record<string, unknown>; type: string };
    executeCommand(command, params)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
  }

  if (message.type === 'stop_automation') {
    if (message.mode === 'recording') {
      if (websocket?.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: 'stop_recording_signal' }));
      }
    } else if (message.mode === 'playing') {
      import('./commands/replay').then(({ abortSequence }) => {
        abortSequence();
      });
    }
    // Also broadcast hide_overlay to all tabs as a fallback
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'hide_overlay' }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
  }

  return true;
});

// ─── MV3 Keepalive ──────────────────────────────────────────────────
// Chrome MV3 terminates service workers after ~30s of inactivity.
// A periodic alarm wakes the worker and a WS ping keeps the connection alive.

function startKeepalive(): void {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Re-establish connection if it dropped while the worker was asleep
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      connect();
    } else {
      // Send a lightweight ping to keep the socket active
      websocket.send(JSON.stringify({ type: 'ping' }));
    }
  }
});

// ─── Init ───────────────────────────────────────────────────────────

connect();
startKeepalive();
