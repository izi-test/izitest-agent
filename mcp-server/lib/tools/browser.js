// Browser interaction MCP tools: navigate, click, fill, extract, screenshot, etc.

import { z } from 'zod';



export function registerBrowserTools(server, { sendCommand, getProfiles, saveActionToHistory, getLastRefMap, setLastRefMap, getRecording }) {

  // --- Tool: list_profiles ---
  server.tool(
    'list_profiles',
    'List all connected browser profiles',
    {},
    async () => {
      const list = [...getProfiles().keys()];
      return {
        content: [{
          type: 'text',
          text: list.length
            ? `Connected profiles: ${list.join(', ')}`
            : 'No profiles connected. Make sure Chrome is open with the IziTest Agent extension installed.'
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
      tabId: z.number().optional().describe('Tab ID to navigate in (creates new tab if omitted)'),
      intent: z.string().optional().describe('Functional description of this step (e.g. "Open the project settings page"). Recorded as step intent during test recording.')
    },
    async ({ url, profile, tabId, intent }) => {
      const result = await sendCommand(profile, 'navigate', { url, tabId });
      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      const actionId = saveActionToHistory('navigate', { url, tabId }, null, screenshotBase64, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      tabId: z.number().optional(),
      intent: z.string().optional().describe('Functional description of this step (e.g. "Submit the login form"). Recorded as step intent during test recording.')
    },
    async ({ profile, selector, text, ref, tabId, intent }) => {
      const result = await sendCommand(profile, 'click', { selector, text, ref, tabId });
      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      const actionId = saveActionToHistory('click', { selector, text, tabId }, ref, screenshotBase64, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Tool: fill ---
  server.tool(
    'fill',
    'Fill a text-based form field (input, textarea) with a value. For <select> dropdowns, use the "select" tool instead.',
    {
      selector: z.string().optional().describe('CSS selector of the input field'),
      value: z.string().describe('Value to fill in'),
      profile: z.string().optional(),
      tabId: z.number().optional(),
      ref: z.string().optional().describe('Reference from a previous snapshot to fill (e.g. @e5)'),
      clear: z.boolean().optional().describe('Clear the field before filling (default: true)'),
      intent: z.string().optional().describe('Functional description of this step (e.g. "Enter the project name"). Recorded as step intent during test recording.')
    },
    async ({ selector, value, profile, tabId, ref, clear, intent }) => {
      const result = await sendCommand(profile, 'fill', { selector, value, tabId, ref, clear });
      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      const actionId = saveActionToHistory('fill', { selector, value, tabId, clear }, ref, screenshotBase64, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Tool: select ---
  server.tool(
    'select',
    'Select an option from a native <select> dropdown. Matches by visible text (default) or option value. Do NOT use "fill" or "click" for <select> elements — use this tool.',
    {
      selector: z.string().optional().describe('CSS selector of the <select> element'),
      value: z.string().describe('The option to select: visible text (default) or option value'),
      profile: z.string().optional(),
      tabId: z.number().optional(),
      ref: z.string().optional().describe('Reference from a previous snapshot (e.g. @e5)'),
      matchBy: z.enum(['text', 'value']).optional().describe('Match option by visible "text" (default) or "value" attribute'),
      intent: z.string().optional().describe('Functional description of this step. Recorded as step intent during test recording.')
    },
    async ({ selector, value, profile, tabId, ref, matchBy, intent }) => {
      const result = await sendCommand(profile, 'select', { selector, value, tabId, ref, matchBy });
      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      const actionId = saveActionToHistory('select', { selector, value, tabId, matchBy }, ref, screenshotBase64, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
    [
      'Take a visual screenshot of the page. Expensive (large base64 image). Use ONLY as a fallback.',
      '',
      'WHEN TO USE:',
      '  * ONLY after snapshot() failed 2+ times to find the element you need.',
      '  * When you need to visually verify page state (e.g. layout, images, visual regression).',
      '  * When snapshot returns confusing structure and you need visual context to understand the page.',
      '',
      'DO NOT use screenshot as your first discovery tool. Use snapshot() instead — it is faster, cheaper, and sufficient in most cases.',
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional(),
      annotate: z.boolean().optional().default(true).describe('Draw bounding boxes and return DOM mapping alongside the image (default: true)'),
      purposeFilter: z.enum(['fill', 'click', 'read']).optional().describe('Restrict annotations: "fill" = only inputs, "click" = only buttons/links, "read" = all interactive'),
      searchText: z.string().optional().describe('Only annotate elements whose text contains this string (case-insensitive)')
    },
    async ({ profile, tabId, annotate, purposeFilter, searchText }) => {
      let mappingText = '';
      let refCount = 0;

      if (annotate) {
        const snapResult = await sendCommand(profile, 'snapshot', {
          tabId,
          interactiveOnly: true,
          compact: true,
          format: 'text',
          ...(purposeFilter && purposeFilter !== 'read' ? { purposeFilter } : {}),
          ...(searchText ? { searchText } : {})
        });
        mappingText = snapResult?.tree || '';
        refCount = snapResult?.refs ? Object.keys(snapResult.refs).length : 0;
        if (snapResult?.refs) setLastRefMap(snapResult.refs);
      }

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
          const MAX_MAPPING_CHARS = 15000;
          const filterLabel = purposeFilter ? ` [filter: ${purposeFilter}]` : '';
          const searchLabel = searchText ? ` [search: "${searchText}"]` : '';
          let truncationNote = '';

          if (mappingText.length > MAX_MAPPING_CHARS) {
            mappingText = mappingText.substring(0, MAX_MAPPING_CHARS) + '\n... (truncated)';
            truncationNote = `\n\nNOTE: Mapping was truncated (${refCount} elements). Use snapshot(searchText="...") to find specific elements.`;
          }

          content.push({
            type: 'text',
            text: [
              `\n### DOM Mapping${filterLabel}${searchLabel} — ${refCount} elements ###`,
              mappingText,
              truncationNote,
              '\n--- Identify the element you need and proceed with your next action (click, fill, etc.) immediately. Next time, prefer snapshot() over screenshot() — it is faster and cheaper. ---'
            ].join('\n')
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
      selector: z.string().optional().describe('Wait until this CSS selector appears (max 10s)'),
      intent: z.string().optional().describe('Functional description of this step. Recorded as step intent during test recording.')
    },
    async ({ profile, tabId, ms, selector, intent }) => {
      const result = await sendCommand(profile, 'wait', { ms, selector, tabId });
      const actionId = saveActionToHistory('wait', { ms, selector, tabId }, null, null, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      const actionId = saveActionToHistory('execute_js', { code, tabId });
      const textResponse = result !== undefined ? JSON.stringify(result, null, 2) : "Execution successful (no return value)";
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + textResponse }] };
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
      tabId: z.number().optional(),
      intent: z.string().optional().describe('Functional description of this step. Recorded as step intent during test recording.')
    },
    async ({ key, modifiers, profile, tabId, intent }) => {
      const result = await sendCommand(profile, 'keyboard', { key, modifiers, tabId });
      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      const actionId = saveActionToHistory('keyboard', { key, modifiers, tabId }, null, screenshotBase64, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
    [
      'Take a snapshot of the page DOM as an accessibility tree with unique Refs (@eX) for use in click/fill commands.',
      '',
      'ELEMENT DISCOVERY PROTOCOL — Follow this order when looking for an element:',
      '  STEP 1 (always start here): Call snapshot() WITH a purposeFilter matching your intent.',
      '             -> About to fill a form? Use purposeFilter="fill" (only inputs).',
      '             -> About to click something? Use purposeFilter="click" (only buttons/links).',
      '             -> Combine with searchText="label" to narrow further (e.g. searchText="email").',
      '             -> If you find the element in the output: use its @eX ref directly.',
      '  STEP 2 (if not found): Call snapshot() again with broader filters or searchText variations.',
      '             -> Try without purposeFilter, or with different searchText.',
      '             -> Try with includeHidden=true if the element might be in a hidden container.',
      '  STEP 3 (last resort): Call screenshot() for visual context.',
      '             -> ONLY if snapshot failed 2+ times to locate the element.',
      '             -> The screenshot is expensive (large base64 image, high token cost).',
      '',
      'FILTER STRATEGY (mandatory — always apply filters to keep output small):',
      '  1. purposeFilter — ALWAYS set this based on your next action:',
      '     * "fill"  — Only input fields (textbox, combobox, checkbox, radio, select). Use before filling.',
      '     * "click" — Only clickable elements (button, link, tab, menu item). Use before clicking.',
      '     * "read"  — Everything. Use ONLY to understand full page structure, never as a first call.',
      '  2. searchText — Grep elements by label/text (case-insensitive). Example: searchText="connexion".',
      '     Combine with purposeFilter for precise results (e.g. purposeFilter="fill", searchText="email").',
      '  3. includeHidden — Set to true only if steps 1-2 returned no results.',
      '     Surfaces elements inside containers with aria-hidden or opacity:0.',
      '     ALWAYS combine with searchText or purposeFilter to avoid massive output.',
      '',
      'compact is enabled by default. Output includes element count and size for efficiency tracking.',
      'IMPORTANT: Always start with snapshot, never with screenshot. Snapshot is fast and cheap.'
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional(),
      purposeFilter: z.enum(['fill', 'click', 'read']).optional().describe('REQUIRED: "fill" before filling inputs, "click" before clicking, "read" for full page'),
      searchText: z.string().optional().describe('Filter elements by text content (case-insensitive grep). Only returns refs matching this text.'),
      compact: z.boolean().optional().default(true).describe('Remove generic wrapper nodes (default: true)'),
      interactiveOnly: z.boolean().optional().describe('Only show interactive elements. Stricter than purposeFilter.'),
      maxDepth: z.number().optional().describe('Maximum DOM tree depth (default: 50)'),
      includeHidden: z.boolean().optional().describe('LAST RESORT. Include elements inside aria-hidden/opacity:0 containers (default: false). Always combine with searchText or purposeFilter.'),
      includeRects: z.boolean().optional().describe('Include bounding box [x,y,wxh] coordinates per element')
    },
    async ({ profile, tabId, interactiveOnly, compact, maxDepth, includeHidden, includeRects, purposeFilter, searchText }) => {
      const result = await sendCommand(profile, 'snapshot', {
        tabId, interactiveOnly, compact: compact ?? true, maxDepth, includeHidden, includeRects, purposeFilter, searchText, format: 'text'
      });

      if (!result || !result.tree) {
        return { content: [{ type: 'text', text: 'Snapshot failed -- no elements found' }] };
      }

      if (result.refs) {
        setLastRefMap(result.refs);
      }

      const refCount = result.refs ? Object.keys(result.refs).length : 0;
      const filterLabel = purposeFilter && purposeFilter !== 'read' ? ` [filter: ${purposeFilter}]` : '';
      const searchLabel = searchText ? ` [search: "${searchText}"]` : '';

      const MAX_SNAPSHOT_CHARS = 30000;
      let treeText = result.tree;
      let truncationNote = '';

      if (treeText.length > MAX_SNAPSHOT_CHARS) {
        treeText = treeText.substring(0, MAX_SNAPSHOT_CHARS) + '\n... (truncated)';
        truncationNote = `\n\nNOTE: Output truncated (${refCount} total elements, ${result.tree.length} chars). Use searchText or purposeFilter to narrow results.`;
      }

      const output = [
        `Page: ${result.title}`,
        `URL: ${result.url}`,
        `Elements: ${refCount} | Size: ${result.tree.length > 1000 ? (result.tree.length / 1000).toFixed(1) + 'k' : result.tree.length} chars${filterLabel}${searchLabel}`,
        '',
        treeText,
        truncationNote,
        '\n--- Identify the element you need and proceed with your next action immediately. ---'
      ];

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }
  );
}
