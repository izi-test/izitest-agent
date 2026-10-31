// Browser interaction MCP tools: navigate, click, fill, extract, screenshot, etc.

import { z } from 'zod';
import { evaluate, getOpenRouterKey } from '../jev.js';
import { runJevAct, formatReport, DEFAULT_MAX_STEPS, HARD_MAX_STEPS } from '../jev-act.js';
import { currentSession, listSessions, closeNamedSession, forgetTabsEverywhere } from '../session.js';

/** Session ids the extension should treat as still working (see CloseWindowParams). */
const liveSessionIds = () => listSessions().map((s) => s.id);
import { recordAction } from '../recording.js';
import { captureActionFrame, LIVE_ACTIONS } from '../live.js';

// How text is typed into fields. Default is per-character key events (human-like, slow:
// ~2 CDP round trips per character). IZITEST_TYPING=insert makes one-shot insertion
// the server default — much faster, but less human-like. Needs an extension build that
// knows the `typing` fill param; older builds ignore it and keep typing key by key.
const DEFAULT_TYPING = process.env.IZITEST_TYPING === 'insert' ? 'insert' : undefined;
const TYPING_PARAM = z.enum(['keys', 'insert']).optional()
  .describe('"keys" = one key event per character (human-like, slow). "insert" = whole value at once (fast, no per-character key events). Default: server setting.');


export function registerBrowserTools(server, { sendCommand: dispatch, getProfiles }) {

  // Every tool below runs inside its caller's Session (see tools/session-scope.js). These
  // shims read and write that session's state only, which is what lets several agents
  // drive the browser at once — and sendCommand pins each command to the session's own
  // tab, so a call without an explicit tabId can no longer land in another agent's window.
  const sess = () => currentSession();
  // navigate/click/fill/select/keyboard also leave a frame of the tab once it has settled
  // (live view, lib/live.js): its frameId comes back in the result — or, when the action
  // failed, at the end of the error — so the cockpit sees every step. act's own steps go
  // through here too.
  const sendCommand = async (profile, command, params, ...rest) => {
    const session = sess();
    if (profile) session.profile = profile;
    const scoped = session.scope(params);
    if (!LIVE_ACTIONS.has(command)) return dispatch(profile, command, scoped, ...rest);
    const frameOf = (tabId) => captureActionFrame({ profile, tabId: tabId ?? scoped.tabId ?? session.lastTabId, action: command, session, dispatch });
    let result;
    try {
      result = await dispatch(profile, command, scoped, ...rest);
    } catch (err) {
      const frameId = await frameOf();
      if (frameId && err instanceof Error) err.message += ` (frameId: ${frameId})`;
      throw err;
    }
    const frameId = await frameOf(result?.tabId);
    return frameId && result && typeof result === 'object' && !Array.isArray(result) ? { ...result, frameId } : result;
  };
  const saveActionToHistory = (...args) => recordAction(sess(), ...args);
  // Refs outlive a snapshot (an element keeps its @eN while it stays on the page), so the
  // map grows with each snapshot — a filtered one returns only some refs — and starts over
  // when the extension reports a new page.
  // click/fill/select by ref send back the element's locators, computed just before acting
  // (a snapshot of a very large page leaves them out). Record them under the ref, so the
  // action is saved with them, and keep them out of the reply the agent reads.
  const learnTarget = (ref, result) => {
    if (!result?.target) return result;
    const { target, ...shown } = result;
    if (ref) {
      const s = sess();
      const key = String(ref).replace('@', '');
      s.refMap = { ...s.refMap, [key]: { ...s.refMap?.[key], ...target } };
    }
    return shown;
  };
  const setLastRefMap = (refs, freshPage) => { const s = sess(); s.refMap = freshPage ? refs : { ...s.refMap, ...refs }; };
  const getRecording = () => sess().recording;
  const getLastTabId = () => sess().lastTabId;
  const setLastTabId = (_profile, tabId, windowId) => sess().adoptTab(tabId, windowId);
  const forgetTabs = (tabIds) => forgetTabsEverywhere(tabIds);

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

  // --- Tool: open_session ---
  server.tool(
    'open_session',
    [
      'Claim an isolated browser session: its own working window, its own snapshot refs, its own recording.',
      '',
      'You normally do NOT need this — every MCP connection already gets one session automatically,',
      'and parallel agents on separate connections never collide.',
      '',
      'Call it when several agents share ONE connection — typically parallel subagents spawned from the',
      'same conversation. Each subagent calls open_session with a DISTINCT name, then passes that same',
      'name as `session` on every later call (navigate, click, fill, snapshot, ...). Without it they would',
      'share one window and overwrite each other\'s refs.',
      '',
      'Called with no name, it just reports the session you are already in.',
    ].join('\n'),
    {},
    async () => {
      const s = sess();
      const named = s.id.startsWith('s:');
      const lines = [
        `Session "${s.label}" (id: ${s.id}).`,
        `Working tab: ${s.lastTabId ?? 'none yet — the next navigate() opens a new window'}.`,
        named
          ? `Pass session: "${s.label}" on every later call to stay in this window.`
          : 'This is your connection\'s own session — nothing to pass, it is used by default.',
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // --- Tool: list_sessions ---
  server.tool(
    'list_sessions',
    'List the browser sessions currently open on this server, with the window each one drives. Useful to check that parallel agents really are in separate windows.',
    {},
    async () => {
      const all = listSessions().map((s) => s.describe());
      if (!all.length) return { content: [{ type: 'text', text: 'No active sessions.' }] };
      const lines = all.map((s) =>
        `  ${s.id}  label="${s.label}"  tab=${s.tabId ?? '-'}  window=${s.windowId ?? '-'}` +
        (s.recording ? `  recording="${s.recording}"` : ''));
      return { content: [{ type: 'text', text: `${all.length} active session(s):\n${lines.join('\n')}` }] };
    }
  );

  // --- Tool: close_session ---
  server.tool(
    'close_session',
    'Close a named session opened with open_session: closes its working window and frees its state. Only needed for named sessions — a connection\'s own session is cleaned up when the agent disconnects.',
    {
      name: z.string().describe('The session name passed to open_session'),
      profile: z.string().optional(),
    },
    async ({ name, profile }) => {
      const closed = closeNamedSession(name);
      if (!closed) return { content: [{ type: 'text', text: `No session named "${name}".` }] };
      if (closed.lastTabId === undefined) {
        return { content: [{ type: 'text', text: `Session "${name}" closed (it had no window open).` }] };
      }
      try {
        const result = await dispatch(profile, 'close_window',
          { tabId: closed.lastTabId, sessionId: closed.id, liveSessions: liveSessionIds() }, 10000);
        forgetTabsEverywhere(result?.tabIds?.length ? result.tabIds : [closed.lastTabId]);
        return { content: [{ type: 'text', text: result?.closed
          ? `Session "${name}" closed, along with its working window.`
          : `Session "${name}" closed. Its window was left open (${result?.reason ?? 'not owned by IziTest Agent'}).` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Session "${name}" closed, but its window could not be: ${err.message}` }] };
      }
    }
  );

  // --- Tool: navigate ---
  server.tool(
    'navigate',
    'Navigate to a URL in the browser. Opens a new window on the first call of a session (instead of hijacking the user\'s active tab); subsequent calls without tabId reuse that same window. Pass tabId explicitly to target a specific tab. When the task is done, call close_window to close that window.',
    {
      url: z.string().describe('The URL to navigate to'),
      profile: z.string().optional().describe('Profile ID (uses first available if omitted)'),
      tabId: z.number().optional().describe('Tab ID to navigate in. If omitted, reuses the last tab opened by this tool, or opens a new window if none yet.'),
      intent: z.string().optional().describe('Functional description of this step (e.g. "Open the project settings page"). Recorded as step intent during test recording.')
    },
    async ({ url, profile, tabId, intent }) => {
      let effectiveTabId = tabId;
      const isNewSession = !effectiveTabId && !getLastTabId(profile);
      if (!effectiveTabId) effectiveTabId = getLastTabId(profile);

      // Claim the window the moment the extension creates it. A slow page could push
      // navigate past the command timeout; without this the session would own a window it
      // does not know about, and close_window would answer "nothing to close".
      const claimWindow = (progress) => {
        if (progress?.phase === 'window-created') sess().adoptTab(progress.tabId, progress.windowId);
      };

      let result;
      try {
        result = await sendCommand(profile, 'navigate', { url, tabId: effectiveTabId, newWindow: isNewSession }, 30000, claimWindow);
      } catch (err) {
        if (effectiveTabId && !tabId) {
          // Reused tab is stale (e.g. closed by the user) — fall back to a fresh window
          result = await sendCommand(profile, 'navigate', { url, newWindow: true }, 30000, claimWindow);
        } else {
          throw err;
        }
      }
      if (result?.tabId) setLastTabId(profile, result.tabId, result.windowId);

      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId: result?.tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      const actionId = saveActionToHistory('navigate', { url, tabId: result?.tabId }, null, screenshotBase64, intent);
      return { content: [{ type: 'text', text: `Action executed successfully (${actionId}).\n\nResult:\n` + JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Tool: click ---
  server.tool(
    'click',
    [
      'Click an element on the page by snapshot ref (@eX, preferred), CSS selector or visible text.',
      'The click is checked before it is sent: if something else is on top of the element at that point',
      '(cookie banner, sticky header, modal, loading overlay), the tool refuses with "Not clicked: … covered by <…>"',
      'and names the blocker — dismiss it (snapshot can find its button), then retry. It never reports success',
      'for a click that would have landed on something else.',
      'If the click opens a tab (target=_blank, window.open), the result includes newTabId and newWindowId.',
      'The result lists in `changes` what the click did: navigation, a dialog/menu/banner that appeared or went away',
      '(with its buttons), an element that expanded — in iframes too. Read it before reaching for a screenshot.',
    ].join('\n'),
    {
      profile: z.string().optional(),
      selector: z.string().optional().describe('CSS selector of the element to click'),
      text: z.string().optional().describe('Visible text content to find and click'),
      ref: z.string().optional().describe('Reference from a previous snapshot to click (e.g. @e5)'),
      tabId: z.number().optional(),
      checked: z.boolean().optional().describe('For a checkbox, radio or switch (or its label): the state wanted. Not clicked when it is already in that state. Without it, the click toggles, and the result says the state it left (`checked`).'),
      intent: z.string().optional().describe('Functional description of this step (e.g. "Submit the login form"). Recorded as step intent during test recording.')
    },
    async ({ profile, selector, text, ref, tabId, checked, intent }) => {
      const result = learnTarget(ref, await sendCommand(profile, 'click', { selector, text, ref, tabId, checked }));
      let screenshotBase64 = null;
      if (getRecording()?.use_vrt) {
        try {
          const snap = await sendCommand(profile, 'screenshot', { tabId, annotate: false });
          if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
        } catch(e) {}
      }
      // A checkbox is recorded with the state the click left it in: replay and generated code
      // set that state, where replaying a click would toggle it whatever it was.
      // A box styled away was clicked through its label: generated code goes there too.
      const state = {
        ...(typeof result?.checked === 'boolean' ? { checked: result.checked } : {}),
        ...(result?.viaLabel ? { viaLabel: true } : {}),
        ...(result?.labelFor ? { labelFor: result.labelFor } : {}),
      };
      // Chrome's role and accessible name for what was clicked: what getByRole matches, where
      // the name the snapshot computes can differ (hidden text, a title over the content).
      // Found more than once on the page, it comes with where it is (scope or nth).
      const { role, name, scope, nth } = result?.accessible ?? {};
      const roleLocator = role && name && name.length < 100
        ? [{ type: 'role', value: role, name, ...(scope ? { scope } : {}), ...(Number.isInteger(nth) ? { nth } : {}) }]
        : [];
      const actionId = saveActionToHistory('click', { selector, text, tabId, ...state }, ref, screenshotBase64, intent, roleLocator);
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
      typing: TYPING_PARAM,
      intent: z.string().optional().describe('Functional description of this step (e.g. "Enter the project name"). Recorded as step intent during test recording.')
    },
    async ({ selector, value, profile, tabId, ref, clear, typing, intent }) => {
      const result = learnTarget(ref, await sendCommand(profile, 'fill', { selector, value, tabId, ref, clear, typing: typing ?? DEFAULT_TYPING }));
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
      const result = learnTarget(ref, await sendCommand(profile, 'select', { selector, value, tabId, ref, matchBy }));
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

  // --- Tool: act (Jev fast path) ---
  server.tool(
    'act',
    [
      'FAST PATH for ONE visible form or ONE widget — delegates it to Jev, a ~300ms decision model inside this server, which reads the page, picks each action and executes it.',
      'Jev picks well among what is ON the page; it does NOT plan. Measured on real sites:',
      '  WORKS (use it): a form whose fields are visible (login, contact, checkout step) · one widget ("open the Location filter, type the city, pick the suggestion") · one obvious click ("dismiss the cookie banner", "click Show results").',
      '  FAILS (do not use it): a whole journey in one goal ("run a search: buy, house, city, 3 bedrooms, show results") · home pages whose search UI is hidden behind menus or modals · pages with several hundred controls · anything needing judgment about page text.',
      '  For a site search, a deep-link results URL is faster and more reliable than driving the search UI.',
      'If act hands back twice on the same page, stop using it there: continue with snapshot + click/fill.',
      '',
      'HOW TO CALL IT:',
      '  - goal: ONE step a person would do without thinking, about 1-4 actions, stated as an outcome. Split journeys into one act per widget. Call navigate() first.',
      '  - inputs: EVERY value that must be typed or selected, keyed by what the field is (e.g. {"email": "a@b.c", "password": "..."}).',
      '    For a radio button or checkbox, the value is the option\'s visible label (e.g. {"pizza size": "Medium"}): it gets ticked, never typed.',
      '    Jev cannot invent text: a value missing from inputs will never be typed. Values go to the browser only — Jev sees the keys, never the values.',
      '',
      'WHAT YOU GET BACK — the executed actions with probabilities, the final page, and a status:',
      '  DONE — verify the outcome yourself if it matters (Jev only sees the URL, title and interactive elements).',
      '  HANDED BACK / BLOCKED / ERROR — Jev stopped instead of guessing. Candidate @eX refs are included when relevant:',
      '    finish by hand with click/fill, or call act again with a narrower goal.',
      '',
      'Actions are recorded as test steps exactly like click/fill when a recording is active.',
      'Forms inside iframes (cross-origin ones included) work like forms on the page.',
      'NOT suited for: reading or extracting content, canvas UIs, tasks that need judgment about page text.'
    ].join('\n'),
    {
      goal: z.string().describe('ONE form or ONE widget, about 1-4 actions, stated as an outcome (e.g. "Log in", "In the Location filter, type the city and pick the Antony (92160) suggestion"). Not a whole journey.'),
      inputs: z.record(z.string()).optional().describe('Values to type/select, keyed by field meaning, e.g. {"email": "a@b.c", "password": "...", "size": "Medium"}. Required for anything that must be typed or chosen; for a radio/checkbox give the option label.'),
      max_steps: z.number().int().min(1).max(HARD_MAX_STEPS).optional().describe(`Action budget before handing back (default: ${DEFAULT_MAX_STEPS})`),
      typing: TYPING_PARAM,
      profile: z.string().optional(),
      tabId: z.number().optional()
    },
    async ({ goal, inputs, max_steps, typing, profile, tabId }) => {
      const apiKey = await getOpenRouterKey();
      if (!apiKey) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'act is unavailable: no OpenRouter API key found (set OPENROUTER_API_KEY, or save a key in Settings → API mode). Use snapshot + click/fill instead.' }]
        };
      }

      const report = await runJevAct(
        { sendCommand, saveActionToHistory, setLastRefMap, getRecording, evaluate: (state, questions) => evaluate(apiKey, state, questions) },
        { goal, inputs, maxSteps: max_steps, profile, tabId, typing: typing ?? DEFAULT_TYPING }
      );
      // The page as act leaves it: its last step may have been a look, not an action.
      report.frameId = await captureActionFrame({ profile, tabId: tabId ?? sess().lastTabId, action: 'act', session: sess(), dispatch });
      return { content: [{ type: 'text', text: formatReport(report) }] };
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
      purposeFilter: z.enum(['fill', 'click', 'read']).optional().describe('Restrict annotations: "fill" = only inputs, "click" = only clickable elements, "read" = all interactive'),
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
        // Counted in the tree, which is what the agent reads: `refs` has no entry for an
        // [iframe] line, so a page with iframes announced fewer elements than it listed.
        refCount = (mappingText.match(/^\s*@e\d+/gm) ?? []).length;
        if (snapResult?.refs) setLastRefMap(snapResult.refs, snapResult.freshRefs);
      }

      // JPEG: this image is read by a model, not diffed. A PNG was ~360 KB of base64 per call —
      // ten of them blew an agent runtime's 8 MiB output limit. (VRT paths still get PNG.)
      const result = await sendCommand(profile, 'screenshot', { tabId, annotate, format: 'jpeg', quality: 60 });

      if (result.dataUrl) {
        // Read the real type back: an older extension build ignores `format` and returns PNG.
        const match = result.dataUrl.match(/^data:(image\/[a-z]+);base64,/);
        const base64 = result.dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
        const content = [];

        content.push({
          type: 'image',
          data: base64,
          mimeType: match ? match[1] : 'image/png'
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
    [
      'List all open tabs in the browser. Each tab carries its window and its "owner":',
      '  your own session id — your working window,',
      '  another session id — another agent is working there: do not touch it,',
      '  "user" — one of the user\'s own tabs: do not act on it unless asked to.',
      'Use it to find a tabId to pass explicitly; without one, commands stay in your own window.',
    ].join('\n'),
    {
      profile: z.string().optional()
    },
    async ({ profile }) => {
      const result = await sendCommand(profile, 'get_tabs', {});
      const s = sess();
      const header = `Your session: ${s.id}` +
        (s.lastTabId !== undefined ? ` (working tab ${s.lastTabId})` : ' (no window yet — call navigate first)');
      return { content: [{ type: 'text', text: `${header}\n\n` + (JSON.stringify(result, null, 2) || 'null') }] };
    }
  );

  // --- Tool: close_window ---
  server.tool(
    'close_window',
    [
      'Close the working window IziTest Agent opened for this task, with every tab in it. Call it ONCE, at the very end, after the last page has been read.',
      'Safe by design: it only closes a window IziTest Agent itself opened (navigate opens one per session). A window holding the user\'s own tabs is never closed — the call is refused instead, and nothing happens.',
      'Without tabId it closes the window of the tab the last navigate() used, with any popup windows its pages opened (e.g. a "Sign in with Google" popup). The next navigate() opens a fresh window.',
      'With the tabId of such a popup (click returns it as newTabId), it closes only that popup.',
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional().describe('Any tab of the working window. Default: the tab the last navigate() used.')
    },
    async ({ profile, tabId }) => {
      const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] });

      const target = tabId ?? getLastTabId();
      if (!target) return text('Nothing to close: no working window was opened by navigate() in this session.');

      let result;
      try {
        result = await sendCommand(profile, 'close_window', { tabId: target, liveSessions: liveSessionIds() });
      } catch (err) {
        if (/Unknown command: close_window/.test(err.message)) {
          return text('close_window needs a newer build of the IziTest Agent extension (rebuild it and reload it in chrome://extensions). Nothing was closed.', true);
        }
        throw err;
      }

      if (result?.closed) {
        forgetTabs(result.tabIds?.length ? result.tabIds : [target]);
        const n = result.tabIds?.length ?? 1;
        const tabs = `${n} tab${n > 1 ? 's' : ''}`;
        if (result.isPopup) return text(`Closed the popup window (${tabs}). Your working window is still open.`);
        const popups = result.popupsClosed
          ? `, including ${result.popupsClosed} popup window${result.popupsClosed > 1 ? 's' : ''} its pages had opened`
          : '';
        return text(`Closed the working window (${tabs}${popups}). The next navigate() will open a new one.`);
      }
      if (result?.reason === 'gone') {
        forgetTabs([target]);
        return text(`Nothing to close: tab ${target} no longer exists (its window was already closed).`);
      }
      if (result?.reason === 'other_session') {
        return text(
          `Not closed: tab ${target} is in the working window of session ${result.owner} — another agent is using it. ` +
          'Nothing was closed. Close your own window instead, or let that session close its own.',
          true
        );
      }
      return text(
        `Not closed: tab ${target} is in a window IziTest Agent has no ownership record for (${result?.tabCount ?? '?'} tab(s)) — ` +
        'either one of the user\'s own windows, or a working window whose record was lost (the extension was reloaded, ' +
        'or it is running a build from before window ownership was tracked per session). Nothing was closed; tell the user it is still open.',
        true
      );
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
    'Execute arbitrary JavaScript code in the active tab. Use for advanced interactions. Pass `frame` to run it inside an iframe (cross-origin ones included). While a test is recording, the code is recorded as a step and runs again on every replay: to only read the page (a value, a text), use extract or snapshot, which are not recorded.',
    {
      code: z.string().describe('JavaScript code to execute in the page context'),
      profile: z.string().optional(),
      tabId: z.number().optional(),
      frame: z.string().optional().describe('Run inside this iframe instead of the page: the @eN ref of its [iframe] line in a snapshot, or a piece of its URL (the src shown on that line).')
    },
    async ({ code, profile, tabId, frame }) => {
      const result = await sendCommand(profile, 'execute_js', { code, tabId, frame });
      const actionId = saveActionToHistory('execute_js', { code, tabId, ...(frame ? { frame } : {}) });
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
      'Iframes are included — same-origin and cross-origin (cookie banners, payment fields, embedded widgets): their content',
      'appears indented under their "[iframe]" line, and their @eX refs work with click/fill/select like any other.',
      'Refs are stable: an element keeps its @eX across snapshots (whatever the filter) for as long as it stays on the page.',
      'A ref whose element has since left the page is refused as "Stale ref" — take a new snapshot then.',
      '',
      'ELEMENT DISCOVERY PROTOCOL — Follow this order when looking for an element:',
      '  STEP 1 (always start here): Call snapshot() WITH a purposeFilter matching your intent.',
      '             -> About to fill a form? Use purposeFilter="fill" (only inputs).',
      '             -> About to click something? Use purposeFilter="click" (only clickable elements).',
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
      '     * "click" — Only clickable elements (button, link, tab, menu item, cursor:pointer div/span). Use before clicking.',
      '     * "read"  — Everything. Use ONLY to understand full page structure, never as a first call.',
      '  2. searchText — Grep elements by label/text (case-insensitive). Example: searchText="connexion".',
      '     It searches every interactive element whatever the purposeFilter (a menu built on a checkbox is still found).',
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
        const why = searchText
          ? `Nothing on the page matches searchText "${searchText}". Try another word, or drop searchText.`
          : 'The page shows no elements and no text: it is blank or still loading. wait() then snapshot again.';
        return { content: [{ type: 'text', text: `Snapshot found nothing. ${why}` }] };
      }

      if (result.refs) {
        setLastRefMap(result.refs, result.freshRefs);
      }

      // Counted in the tree: `refs` has no entry for an [iframe] line.
      const refCount = (result.tree?.match(/^\s*@e\d+/gm) ?? []).length;
      const filterLabel = purposeFilter && purposeFilter !== 'read' ? ` [filter: ${purposeFilter}]` : '';
      const searchLabel = searchText ? ` [search: "${searchText}"]` : '';

      const MAX_SNAPSHOT_CHARS = 30000;
      let treeText = result.tree;
      let truncationNote = '';

      if (treeText.length > MAX_SNAPSHOT_CHARS) {
        treeText = treeText.substring(0, MAX_SNAPSHOT_CHARS) + '\n... (truncated)';
        // Up front, before 30k characters of tree: an agent reads the top, and a note at the
        // bottom came after it had already taken the partial tree for the whole page.
        truncationNote = `TRUNCATED: only the first ${MAX_SNAPSHOT_CHARS / 1000}k of ${(result.tree.length / 1000).toFixed(0)}k chars are shown ` +
          `(the rest of the page is missing below). Narrow it: searchText="<words of the element>"` +
          `${purposeFilter && purposeFilter !== 'read' ? '' : ', purposeFilter="click" or "fill"'}.`;
      }

      const output = [
        `Page: ${result.title}`,
        `URL: ${result.url}`,
        `Elements: ${refCount} | Size: ${result.tree.length > 1000 ? (result.tree.length / 1000).toFixed(1) + 'k' : result.tree.length} chars${filterLabel}${searchLabel}`,
        ...(truncationNote ? [truncationNote] : []),
        '',
        treeText,
        '\n--- Identify the element you need and proceed with your next action immediately. ---'
      ];

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }
  );

  // --- Tool: network_requests ---
  server.tool(
    'network_requests',
    [
      'List network requests (XHR, fetch, documents, images, etc.) captured on the page since it was loaded.',
      'Returns compact metadata only (no bodies) — use network_response to fetch a specific response body,',
      'or network_search to search across several matching requests at once (recommended when the URL alone',
      'does not uniquely identify the request you need, e.g. GraphQL calls that all hit the same endpoint).',
      'Capture starts automatically once the page has been navigated to via the navigate tool.'
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional(),
      textFilter: z.string().optional().describe('Case-insensitive substring filter applied to the request URL (e.g. "/api/users")'),
      method: z.string().optional().describe('Filter by HTTP method (e.g. "GET", "POST")'),
      resourceType: z.string().optional().describe('Filter by resource type (e.g. "xhr", "fetch", "document", "image")'),
      requestBodyFilter: z.string().optional().describe('Case-insensitive substring filter applied to the POST body (e.g. a GraphQL operationName) — use this to tell apart requests sharing the same URL'),
      limit: z.number().optional().describe('Max number of requests to return, most recent first (default: 50)')
    },
    async ({ profile, tabId, textFilter, method, resourceType, requestBodyFilter, limit }) => {
      const result = await sendCommand(profile, 'network_requests', { tabId, textFilter, method, resourceType, requestBodyFilter, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Tool: network_response ---
  server.tool(
    'network_response',
    [
      'Fetch the body of a specific network request previously listed by network_requests (using its "id").',
      'For JSON responses, pass jsonPath to run a JSONPath-Plus query and receive only the matching data',
      '— this avoids sending the entire (potentially huge) response back to you.',
      'Without jsonPath, the raw body is returned, truncated to maxLength characters.',
      '',
      'JSONPath examples: "$.data.items[*].id", "$..email", "$.results[0]"'
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional(),
      id: z.string().describe('Request id returned by network_requests (e.g. "net-12")'),
      jsonPath: z.string().optional().describe('JSONPath-Plus expression to extract specific data from a JSON response body'),
      maxLength: z.number().optional().describe('Max characters of the raw body to return when jsonPath is not used (default: 5000)')
    },
    async ({ profile, tabId, id, jsonPath, maxLength }) => {
      const result = await sendCommand(profile, 'network_response', { tabId, id, jsonPath, maxLength });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Tool: network_search ---
  server.tool(
    'network_search',
    [
      'Search across ALL network requests matching a filter, in one call, and return only the ones whose',
      'response body actually matches — instead of checking each candidate one by one with network_response.',
      '',
      'USE THIS WHEN: several captured requests share a similar or identical URL but return different data',
      '(typical of GraphQL, where every operation is POSTed to the same /graphql endpoint). Narrow down with',
      'textFilter/method/resourceType/requestBodyFilter first, then provide jsonPath or bodyContains to find',
      'which of the matching requests actually holds the data you need.',
      '',
      'Provide EITHER jsonPath (structured search in JSON responses, e.g. "$..email") OR bodyContains',
      '(plain substring search, works on any response, returns a text snippet around the match).',
      'requestBodyFilter filters by the POST payload (e.g. a GraphQL operationName) to disambiguate requests',
      'that hit the same URL.'
    ].join('\n'),
    {
      profile: z.string().optional(),
      tabId: z.number().optional(),
      textFilter: z.string().optional().describe('Case-insensitive substring filter applied to the request URL'),
      method: z.string().optional().describe('Filter by HTTP method (e.g. "GET", "POST")'),
      resourceType: z.string().optional().describe('Filter by resource type (e.g. "xhr", "fetch")'),
      requestBodyFilter: z.string().optional().describe('Case-insensitive substring filter applied to the POST body (e.g. a GraphQL operationName)'),
      jsonPath: z.string().optional().describe('JSONPath-Plus expression — only requests with a non-empty match are returned, along with the matched data'),
      bodyContains: z.string().optional().describe('Plain-text substring to search for in each response body — only matching requests are returned, with a snippet'),
      limit: z.number().optional().describe('Max number of filtered requests to scan, most recent first (default: 30)'),
      maxMatches: z.number().optional().describe('Stop after finding this many matches (default: 10)')
    },
    async ({ profile, tabId, textFilter, method, resourceType, requestBodyFilter, jsonPath, bodyContains, limit, maxMatches }) => {
      const result = await sendCommand(profile, 'network_search', { tabId, textFilter, method, resourceType, requestBodyFilter, jsonPath, bodyContains, limit, maxMatches });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}
