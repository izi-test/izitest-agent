// Browser interaction MCP tools: navigate, click, fill, extract, screenshot, etc.

import { z } from 'zod';



export function registerBrowserTools(server, { sendCommand, getProfiles, saveActionToHistory, getLastRefMap, setLastRefMap }) {

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
      const actionId = saveActionToHistory('navigate', { url, tabId });
      return { content: [{ type: 'text', text: `Action executed successfully. To record this step in a workflow, use record_step passing action_id: "${actionId}".\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      const actionId = saveActionToHistory('click', { selector, text, tabId }, ref);
      return { content: [{ type: 'text', text: `Action executed successfully. To record this step in a workflow, use record_step passing action_id: "${actionId}".\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      const actionId = saveActionToHistory('fill', { selector, value, tabId, clear }, ref);
      return { content: [{ type: 'text', text: `Action executed successfully. To record this step in a workflow, use record_step passing action_id: "${actionId}".\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      'Take an annotated screenshot of the page. Returns the image + DOM mapping with @eX refs for all visible interactive elements.',
      '',
      'ELEMENT DISCOVERY PROTOCOL -- Follow this order when looking for an element:',
      '  STEP 1 (always start here): Call screenshot(). Captures ALL elements including hidden-but-visible ones (common in SPAs like Instagram/Twitter).',
      '             -> If you see the element in the image or mapping: use its @eX ref directly.',
      '  STEP 2 (fallback if not found): Call snapshot(includeHidden=true, purposeFilter=..., searchText=...).',
      '             -> Use purposeFilter="fill" for inputs, "click" for buttons/links.',
      '             -> Use searchText to narrow by element label/text.',
      '             -> This surfaces off-screen, collapsed, or dynamically loaded elements.',
      '',
      'Never call snapshot before trying screenshot first.'
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
          includeHidden: true,
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
              '\n--- ACTION REQUIRED: Do NOT describe the screenshot. Identify the element you need and proceed with your next action (click, fill, etc.) immediately. ---'
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
      selector: z.string().optional().describe('Wait until this CSS selector appears (max 10s)')
    },
    async ({ profile, tabId, ms, selector }) => {
      const result = await sendCommand(profile, 'wait', { ms, selector, tabId });
      const actionId = saveActionToHistory('wait', { ms, selector, tabId });
      return { content: [{ type: 'text', text: `Action executed successfully. To record this step in a workflow, use record_step passing action_id: "${actionId}".\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      return { content: [{ type: 'text', text: `Action executed successfully. To record this step in a workflow, use record_step passing action_id: "${actionId}".\n\nResult:\n` + textResponse }] };
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
      const actionId = saveActionToHistory('keyboard', { key, modifiers, tabId });
      return { content: [{ type: 'text', text: `Action executed successfully. To record this step in a workflow, use record_step passing action_id: "${actionId}".\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
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
      'WHEN TO USE THIS TOOL:',
      '  * Use this as STEP 2 of the element discovery protocol, only AFTER screenshot() did not find the element.',
      '  * Set includeHidden=true to surface off-screen, collapsed, or dynamically hidden elements.',
      '',
      'IMPORTANT -- Always set purposeFilter to minimize output size:',
      '  * purposeFilter="fill" -- Returns only input fields (textbox, combobox, checkbox, radio, select).',
      '  * purposeFilter="click" -- Returns only clickable elements (button, link, tab, menu item).',
      '  * purposeFilter="read" -- Returns everything (use only to understand full page structure).',
      '',
      'Use searchText to grep elements by label/text. Example: searchText="connexion" returns only refs containing that word.',
      '',
      'compact is enabled by default. Output includes element count and size for efficiency tracking.'
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional(),
      purposeFilter: z.enum(['fill', 'click', 'read']).optional().describe('REQUIRED: "fill" before filling inputs, "click" before clicking, "read" for full page'),
      searchText: z.string().optional().describe('Filter elements by text content (case-insensitive grep). Only returns refs matching this text.'),
      compact: z.boolean().optional().default(true).describe('Remove generic wrapper nodes (default: true)'),
      interactiveOnly: z.boolean().optional().describe('Only show interactive elements. Stricter than purposeFilter.'),
      maxDepth: z.number().optional().describe('Maximum DOM tree depth (default: 50)'),
      includeHidden: z.boolean().optional().describe('Include visually hidden elements (default: false)'),
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
