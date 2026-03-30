#!/usr/bin/env node

// Browser Pilot — MCP Server + WebSocket Bridge
// Exposes browser control tools via MCP (stdio) for Claude
// Connects to Chrome extensions via WebSocket

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { createRequire } from 'module';

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT) : 3456;

// ─── WebSocket Bridge ───────────────────────────────────────────────

const profiles = new Map(); // profileId → ws
const pendingCommands = new Map(); // commandId → { resolve, reject, timeout }
let commandCounter = 0;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws) => {
  let registeredProfileId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'register') {
        registeredProfileId = msg.profileId;
        profiles.set(msg.profileId, ws);
        log(`Profile registered: ${msg.profileId}`);
      }

      if (msg.type === 'result') {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingCommands.delete(msg.id);
          if (msg.error) {
            log(`[IN]  ❌ Error for ${msg.id}: ${msg.error}`);
            pending.reject(new Error(msg.error));
          } else {
            const resStr = JSON.stringify(msg.result);
            log(`[IN]  ✅ Success for ${msg.id}. Output: ${resStr ? resStr.substring(0, 100) + (resStr.length > 100 ? '...' : '') : 'none'}`);
            pending.resolve(msg.result);
          }
        }
      }
    } catch (err) {
      log(`WS parse error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    if (registeredProfileId) {
      profiles.delete(registeredProfileId);
      log(`Profile disconnected: ${registeredProfileId}`);
    }
  });
});

function sendCommand(profileId, command, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = profileId ? profiles.get(profileId) : profiles.values().next().value;
    if (!ws || ws.readyState !== 1) {
      reject(new Error(
        profileId
          ? `Profile "${profileId}" not connected. Connected profiles: ${[...profiles.keys()].join(', ') || 'none'}`
          : 'No browser profiles connected'
      ));
      return;
    }

    const id = `cmd-${++commandCounter}`;
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCommands.set(id, { resolve, reject, timeout });
    
    log(`[OUT] ➡️ ${command}`);
    log(`  Params: ${JSON.stringify(params).substring(0, 500)}`);
    
    ws.send(JSON.stringify({ type: 'command', id, command, params }));
  });
}

function log(msg) {
  process.stderr.write(`[BrowserPilot] ${msg}\n`);
}

log(`WebSocket bridge listening on port ${WS_PORT}`);

// ─── MCP Server ─────────────────────────────────────────────────────

const server = new McpServer({
  name: 'browser-pilot',
  version: '1.0.0',
});

// --- Tool: list_profiles ---
server.tool(
  'list_profiles',
  'List all connected browser profiles',
  {},
  async () => {
    const list = [...profiles.keys()];
    return {
      content: [{
        type: 'text',
        text: list.length
          ? `Connected profiles: ${list.join(', ')}`
          : 'No profiles connected. Make sure Chrome is open with the Browser Pilot extension installed.'
      }]
    };
  }
);

// --- Tool: navigate ---
server.tool(
  'navigate',
  'Navigate to a URL in the browser. Opens a new tab or updates an existing one.',
  {
    url: z.string().describe('The URL to navigate to'),
    profile: z.string().optional().describe('Profile ID (uses first available if omitted)'),
    tabId: z.number().optional().describe('Tab ID to navigate in (creates new tab if omitted)')
  },
  async ({ url, profile, tabId }) => {
    const result = await sendCommand(profile, 'navigate', { url, tabId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: click ---
server.tool(
  'click',
  'Click an element on the page by CSS selector or visible text content.',
  {
    profile: z.string().optional(),
    selector: z.string().optional().describe('CSS selector of the element to click'),
    text: z.string().optional().describe('Visible text content to find and click'),
    ref: z.string().optional().describe('Reference from a previous snapshot to click (e.g. @e5)'),
    tabId: z.number().optional()
  },
  async ({ profile, selector, text, ref, tabId }) => {
    const result = await sendCommand(profile, 'click', { selector, text, ref, tabId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: fill ---
server.tool(
  'fill',
  'Fill a form field (input, textarea, select) with a value.',
  {
    selector: z.string().optional().describe('CSS selector of the input field'),
    value: z.string().describe('Value to fill in'),
    profile: z.string().optional(),
    tabId: z.number().optional(),
    ref: z.string().optional().describe('Reference from a previous snapshot to fill (e.g. @e5)'),
    clear: z.boolean().optional().describe('Clear the field before filling (default: true)')
  },
  async ({ selector, value, profile, tabId, ref, clear }) => {
    const result = await sendCommand(profile, 'fill', { selector, value, tabId, ref, clear });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: extract ---
server.tool(
  'extract',
  'Extract text, attributes, or HTML from elements on the page.',
  {
    selector: z.string().describe('CSS selector of the element(s) to extract from'),
    profile: z.string().optional(),
    tabId: z.number().optional(),
    attribute: z.string().optional().describe('Specific attribute to extract (e.g. "href", "src")'),
    multiple: z.boolean().optional().describe('Extract from all matching elements (default: false)')
  },
  async ({ selector, profile, tabId, attribute, multiple }) => {
    const result = await sendCommand(profile, 'extract', { selector, tabId, attribute, multiple });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: screenshot ---
server.tool(
  'screenshot',
  'Take a screenshot of the currently visible browser tab. By default (annotate: true), it automatically generates a fresh DOM snapshot, draws red bounding boxes with Ref IDs (@eX) over interactive elements, takes the photo, and returns BOTH the image and the semantic DOM text mapping. This is the ultimate tool for visual page understanding and is highly recommended.',
  {
    profile: z.string().optional(),
    tabId: z.number().optional(),
    annotate: z.boolean().optional().default(true).describe('Generate a fresh snapshot, draw bounding boxes on the UI, and return the DOM mapping text alongside the image.')
  },
  async ({ profile, tabId, annotate }) => {
    let mappingText = "";
    
    // 1. If annotate is true, force a fresh DOM snapshot in Chrome to map @eX tags
    if (annotate) {
      const snapResult = await sendCommand(profile, 'snapshot', { 
        tabId, interactiveOnly: true, format: 'text' 
      });
      mappingText = snapResult?.tree || "";
    }

    // 2. Take the screenshot (the extension natively draws the boxes based on the snap map)
    const result = await sendCommand(profile, 'screenshot', { tabId, annotate });
    
    if (result.dataUrl) {
      const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
      const content = [];
      
      content.push({
        type: 'image',
        data: base64,
        mimeType: 'image/png'
      });

      if (mappingText) {
        content.push({
          type: 'text',
          text: `\n### DOM Snapshot Mapping ###\nHere is the mapping for the @eX references shown in the screenshot. Use the exact @eX ID when interacting:\n\n${mappingText}`
        });
      } else {
        content.push({
          type: 'text',
          text: 'Screenshot captured without DOM mapping.'
        });
      }
      
      return { content };
    }
    return { content: [{ type: 'text', text: 'Screenshot failed' }] };
  }
);

// --- Tool: get_tabs ---
server.tool(
  'get_tabs',
  'List all open tabs in the browser.',
  {
    profile: z.string().optional()
  },
  async ({ profile }) => {
    const result = await sendCommand(profile, 'get_tabs', {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: get_page_info ---
server.tool(
  'get_page_info',
  'Get detailed information about the current page: title, URL, number of forms, links, inputs, buttons.',
  {
    profile: z.string().optional(),
    tabId: z.number().optional()
  },
  async ({ profile, tabId }) => {
    const result = await sendCommand(profile, 'get_page_info', { tabId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: scroll ---
server.tool(
  'scroll',
  'Scroll the page up/down or to a specific element.',
  {
    profile: z.string().optional(),
    tabId: z.number().optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.union([z.number(), z.string().transform(Number)]).optional().describe('Pixels to scroll (default: 500)'),
    selector: z.string().optional().describe('CSS selector to scroll to')
  },
  async ({ profile, tabId, direction, amount, selector }) => {
    const result = await sendCommand(profile, 'scroll', { direction, amount, selector, tabId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: wait ---
server.tool(
  'wait',
  'Wait for a specified time or until an element appears on the page.',
  {
    profile: z.string().optional(),
    tabId: z.number().optional(),
    ms: z.number().optional().describe('Milliseconds to wait'),
    selector: z.string().optional().describe('Wait until this CSS selector appears (max 10s)')
  },
  async ({ profile, tabId, ms, selector }) => {
    const result = await sendCommand(profile, 'wait', { ms, selector, tabId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: execute_js ---
server.tool(
  'execute_js',
  'Execute arbitrary JavaScript code in the active tab. Use for advanced interactions.',
  {
    code: z.string().describe('JavaScript code to execute in the page context'),
    profile: z.string().optional(),
    tabId: z.number().optional()
  },
  async ({ code, profile, tabId }) => {
    const result = await sendCommand(profile, 'execute_js', { code, tabId });
    const textResponse = result !== undefined ? JSON.stringify(result, null, 2) : "Execution successful (no return value)";
    return { content: [{ type: 'text', text: textResponse }] };
  }
);

// --- Tool: keyboard ---
server.tool(
  'keyboard',
  'Send a keyboard event (key press) to the active element.',
  {
    key: z.string().describe('Key to press (e.g. "Enter", "Tab", "Escape", "a")'),
    modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional(),
    profile: z.string().optional(),
    tabId: z.number().optional()
  },
  async ({ key, modifiers, profile, tabId }) => {
    const result = await sendCommand(profile, 'keyboard', { key, modifiers, tabId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: get_cookies ---
server.tool(
  'get_cookies',
  'Get cookies for a URL or domain. Useful to check authentication state.',
  {
    url: z.string().optional(),
    domain: z.string().optional(),
    profile: z.string().optional()
  },
  async ({ url, domain, profile }) => {
    const result = await sendCommand(profile, 'get_cookies', { url, domain });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) || "null" }] };
  }
);

// --- Tool: snapshot ---
server.tool(
  'snapshot',
  'Take a snapshot of the page building an accessibility tree. Returns a structured tree with unique Refs (@eX) that can be used in click/fill commands. Use this to understand what is on the page before interacting.',
  {
    profile: z.string().optional(),
    tabId: z.number().optional(),
    interactiveOnly: z.boolean().optional().describe('Only include interactive elements (links, buttons, inputs) in the snapshot'),
    compact: z.boolean().optional().describe('Compact generic wrappers to reduce the size of the snapshot'),
    maxDepth: z.number().optional().describe('Maximum depth of the DOM tree (default: 50)'),
    includeHidden: z.boolean().optional().describe('Include visually hidden elements (default: false)'),
    includeRects: z.boolean().optional().describe('Include bounding box coordinates [x, y, width x height] in the text snapshot')
  },
  async ({ profile, tabId, interactiveOnly, compact, maxDepth, includeHidden, includeRects }) => {
    const result = await sendCommand(profile, 'snapshot', { 
      tabId, interactiveOnly, compact, maxDepth, includeHidden, includeRects, format: 'text' 
    });
    
    if (!result || !result.tree) {
      return { content: [{ type: 'text', text: 'Snapshot failed — no elements found' }] };
    }

    const output = [
      `Page: ${result.title}`,
      `URL: ${result.url}`,
      `Timestamp: ${new Date(result.timestamp).toISOString()}`,
      '',
      result.tree
    ];

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ─── Start MCP Server ──────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP server running on stdio');
