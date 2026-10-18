// IziTest Agent — Background Service Worker
// Connects to the bridge server via WebSocket and executes browser commands
// Actions use Chrome DevTools Protocol (CDP) for native input simulation

import { updateBadge, resolveTabId, ensureContentScript, captureTabScreenshot, delay, isExpectedRefusal, assertTabIsNotAnotherSessions, TOP_FRAME } from './helpers';
import { cmdNavigate, cmdClick, cmdFill, cmdSelect, cmdKeyboard, cmdScroll } from './commands/actions';
import { cmdReplaySequence } from './commands/replay';
import {
  cmdSnapshot, cmdExtract, cmdGetPageInfo, cmdScreenshot,
  cmdGetTabs, cmdCloseTab, cmdCloseWindow, cmdWait, cmdExecuteJs, cmdGetCookies
} from './commands/queries';
import { cmdNetworkRequests, cmdNetworkResponse, cmdNetworkSearch } from './commands/network';

import { restoreOwnedWindows } from './owned-windows';
import { cmdLiveCapture, cmdLiveStart, cmdLiveStop, cmdLiveStopAll, cmdLiveRecordStart, cmdLiveRecordStop, cmdLiveRecordList, setLiveSink } from './live';

// Importing puppeteer-client to register its lifecycle listeners
import { detachBrowser } from './puppeteer-client';

// ─── Content-Script Commands ────────────────────────────────────────

async function cmdDetectListContext(params: { selector?: string; text?: string; tabId?: number; sessionId?: string }): Promise<unknown> {
  const tabId = await resolveTabId(params.tabId, params.sessionId);
  await ensureContentScript(tabId);
  return new Promise((resolve, reject) => {
    const msg: Record<string, unknown> = { type: 'detect_list_context' };
    if (params.selector) msg.selector = params.selector;
    if (params.text) msg.text = params.text;
    chrome.tabs.sendMessage(tabId, msg, { frameId: TOP_FRAME }, (response) => {
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

// Screenshot of the page printed into the service worker console after each command.
// Off by default: captures are serialised and paced ~1.2s apart, and each one activates
// its tab, so with several sessions working at once they queue up behind each other —
// eight parallel navigates went from 0.8s each to 12-18s. Turn it on for one browser
// session with: chrome.storage.local.set({ debugScreenshots: true })
let debugScreenshots = false;
chrome.storage.local.get(['debugScreenshots'], (r) => { debugScreenshots = r.debugScreenshots === true; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.debugScreenshots) debugScreenshots = changes.debugScreenshots.newValue === true;
});

// ─── Command Dispatcher ─────────────────────────────────────────────

type CommandHandler = (params: Record<string, unknown>, onProgress?: (data: any) => void) => Promise<unknown>;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  navigate:     (params, onProgress) => cmdNavigate(params as unknown as Parameters<typeof cmdNavigate>[0], onProgress),
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
  close_window: (params) => cmdCloseWindow(params as unknown as Parameters<typeof cmdCloseWindow>[0]),
  wait:         (params) => cmdWait(params as unknown as Parameters<typeof cmdWait>[0]),
  execute_js:   (params) => cmdExecuteJs(params as unknown as Parameters<typeof cmdExecuteJs>[0]),
  get_cookies:  (params) => cmdGetCookies(params as unknown as Parameters<typeof cmdGetCookies>[0]),
  network_requests:(params) => cmdNetworkRequests(params as unknown as Parameters<typeof cmdNetworkRequests>[0]),
  network_response:(params) => cmdNetworkResponse(params as unknown as Parameters<typeof cmdNetworkResponse>[0]),
  network_search:(params) => cmdNetworkSearch(params as unknown as Parameters<typeof cmdNetworkSearch>[0]),
  replay_sequence:(params, onProgress)=> cmdReplaySequence(params as unknown as Parameters<typeof cmdReplaySequence>[0], onProgress),
  // Live view (cockpit): read-only, never scoped to a session — see live.ts.
  live_capture: (params) => cmdLiveCapture(params as unknown as Parameters<typeof cmdLiveCapture>[0]),
  live_start:   (params) => cmdLiveStart(params as unknown as Parameters<typeof cmdLiveStart>[0]),
  live_stop:    (params) => cmdLiveStop(params as unknown as Parameters<typeof cmdLiveStop>[0]),
  live_stop_all:()       => cmdLiveStopAll(),
  live_record_start:(params) => cmdLiveRecordStart(params as unknown as Parameters<typeof cmdLiveRecordStart>[0]),
  live_record_stop: (params) => cmdLiveRecordStop(params as unknown as Parameters<typeof cmdLiveRecordStop>[0]),
  live_record_list: ()       => cmdLiveRecordList(),
  detect_list_context:(params) => cmdDetectListContext(params as unknown as { selector?: string; text?: string; tabId?: number }),
};

function isAboutBlankError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('about:blank') && msg.includes('Cannot access contents');
}

async function executeCommand(command: string, params: Record<string, unknown>, onProgress?: (data: any) => void): Promise<unknown> {
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);

  // One gate for every command: an explicit tabId must not point into another agent's
  // working window. Checked here rather than in each command so nothing can forget it.
  if (typeof params.tabId === 'number') {
    await assertTabIsNotAnotherSessions(params.tabId, params.sessionId as string | undefined, {
      liveSessions: params.liveSessions as string[] | undefined,
      force: params.force === true,
    });
  }

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
          if (!debugScreenshots) return;
          try {
            // Nothing to show for commands that destroy what would be photographed, and
            // resolving a tab for them would fail anyway.
            const NO_DEBUG_SHOT = ['screenshot', 'snapshot', 'get_tabs', 'execute_js', 'close_window', 'close_tab',
              'live_capture', 'live_start', 'live_stop', 'live_stop_all', 'live_record_start', 'live_record_stop', 'live_record_list'];
            if (!NO_DEBUG_SHOT.includes(message.command)) {
              const debugTabId = message.params?.tabId as number | undefined;
              const resolvedDebugTabId = await resolveTabId(debugTabId, message.params?.sessionId as string | undefined);
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
          console.groupEnd();

          // Answer first. The debug screenshot is console decoration; awaiting it used to
          // hold the result back behind a serialised, paced capture queue, which is how a
          // navigate that had already finished still timed out after 30s.
          websocket!.send(JSON.stringify({
            type: 'result',
            id: message.id,
            result
          }));
          void captureDebugScreenshot(false);
        } catch (error) {
          void captureDebugScreenshot(true);
          throw error;
        }
      } else if (message.type === 'reload_extension') {
        // Pushed by the bridge after `npm run build` in extension/, so a rebuild lands in
        // Chrome without a trip to chrome://extensions. This kills the service worker
        // immediately: nothing after it runs, and any in-flight command is lost.
        console.log('[BrowserPilot] Reload requested by the bridge — restarting the extension');
        chrome.runtime.reload();
      } else if (message.type === 'restore_owned_windows') {
        // A reload wipes chrome.storage.session, so the server hands back the windows its
        // sessions are working in — otherwise close_window would refuse them and tab
        // resolution would stop being scoped to each session's window.
        const restored = await restoreOwnedWindows(message.windows ?? []);
        if (restored) console.log(`[BrowserPilot] Re-adopted ${restored} session window(s) after restart`);
      } else if (message.type === 'set_overlay_state') {
        const state = message.state;
        // In some cases we want to update state but not popup if it wasn't there
        // Actually, if we pass mode: 'success' or 'failed', we DO want to update existing overlay, but actually we WANT to show it if it wasn't there.
        // Wait, mode: 'success'/'failed' without updateOnly should use 'update_overlay' instead of 'show_overlay'?
        // 'show_overlay' will re-create it if it doesn't exist, which is fine!
        const msgType = state === null ? 'hide_overlay' : (state.updateOnly ? 'update_overlay' : 'show_overlay');
        
        const targetTabId = message.tabId;
        if (targetTabId) {
          chrome.tabs.sendMessage(targetTabId, { type: msgType, state }, { frameId: TOP_FRAME }).catch(() => {});
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: msgType, state }, { frameId: TOP_FRAME }).catch(() => {});
            }
          });
        }
      }
    } catch (error) {
      console.groupEnd();
      // Both are sent back to the agent; only a real malfunction belongs in the
      // extension's error list (chrome://extensions).
      if (isExpectedRefusal(error)) console.warn('[BrowserPilot]', (error as Error).message);
      else console.error('[BrowserPilot] Error:', error);
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

// Screencast frames, pushed as they come (no command id: a stream) — for viewers of a
// watched tab, and for the continuous recording of agent tabs.
const pushFrame = (type: string) => (tabId: number, frame: object) => {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type, tabId, ...frame }));
  }
};
setLiveSink(pushFrame('live_frame'), pushFrame('live_record'));

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
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'hide_overlay' }, { frameId: TOP_FRAME }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
  }

  return true;
});

// ─── Error reporting to the bridge ──────────────────────────────────
//
// The service worker's console is only visible by opening its DevTools by hand, which
// makes a test run blind to anything the extension logs. Everything that lands in
// chrome://extensions' error list is forwarded to the server instead, so a run can assert
// that it produced no extension errors (GET /api/dev/extension-errors).

/** A rejection that only means "the tab is already gone", from a tab we were driving. */
function isDeadTabRejection(message: string): boolean {
  // Puppeteer's ExtensionTransport.close() does `void chrome.debugger.detach(...)`, with
  // no handler: detaching from a tab the user closed by hand rejects, and Chrome reports
  // it as an uncaught error from inside the bundle. Closing through close_window detaches
  // first and never hits this; this covers the tabs closed outside our control.
  return /No tab with given id/.test(message);
}

function reportToBridge(kind: string, message: string, stack?: string): void {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: 'client_error', kind, message, stack, at: Date.now() }));
  }
}

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);

  if (isDeadTabRejection(message)) {
    // Not a fault: keep it out of the extension's error list, but still report it.
    event.preventDefault();
    reportToBridge('dead-tab', message);
    return;
  }

  reportToBridge('unhandledrejection', message, reason instanceof Error ? reason.stack : undefined);
});

self.addEventListener('error', (event: ErrorEvent) => {
  reportToBridge('error', event.message, event.error instanceof Error ? event.error.stack : undefined);
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
