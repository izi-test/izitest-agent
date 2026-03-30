// Browser Pilot — Background Service Worker
// Connects to the bridge server via WebSocket and executes browser commands
// Actions use Chrome DevTools Protocol (CDP) for native input simulation

import { updateBadge } from './helpers';
import { cmdNavigate, cmdClick, cmdFill, cmdKeyboard, cmdScroll } from './commands/actions';
import {
  cmdSnapshot, cmdExtract, cmdGetPageInfo, cmdScreenshot,
  cmdGetTabs, cmdCloseTab, cmdWait, cmdExecuteJs, cmdGetCookies
} from './commands/queries';

// Importing cdp-client to register its lifecycle listeners
import './cdp-client';

const WS_URL = 'ws://127.0.0.1:3456';
const RECONNECT_DELAY_MS = 3000;

let websocket: WebSocket | null = null;
let profileId: string | null = null;
let isConnected = false;

// ─── Command Dispatcher ─────────────────────────────────────────────

type CommandHandler = (params: Record<string, unknown>) => Promise<unknown>;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  navigate:     (params) => cmdNavigate(params as unknown as Parameters<typeof cmdNavigate>[0]),
  click:        (params) => cmdClick(params as unknown as Parameters<typeof cmdClick>[0]),
  fill:         (params) => cmdFill(params as unknown as Parameters<typeof cmdFill>[0]),
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
};

async function executeCommand(command: string, params: Record<string, unknown>): Promise<unknown> {
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return handler(params);
}

// ─── WebSocket Connection ───────────────────────────────────────────

function connect(): void {
  if (websocket && websocket.readyState === WebSocket.OPEN) return;

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
        
        const startTime = performance.now();
        const result = await executeCommand(message.command, message.params);
        const duration = Math.round(performance.now() - startTime);
        
        console.log(`Result (${duration}ms):`, result);
        console.groupEnd();

        websocket!.send(JSON.stringify({
          type: 'result',
          id: message.id,
          result
        }));
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

  return true;
});

// ─── Init ───────────────────────────────────────────────────────────

connect();
