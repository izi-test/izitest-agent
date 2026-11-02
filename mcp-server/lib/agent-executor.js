// Internal AI agent executor — calls LLM APIs directly via Vercel AI SDK
// Replaces the CLI-based agent for API mode: faster, cheaper, no subprocess

import { generateText, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { log } from './logger.js';
import { recordAction, selectParams } from './recording.js';
import { currentSession, runInSession, createAdHocSession, destroySession } from './session.js';

// The dashboard agent gets its own session like any other agent, so a run from the web UI
// and an agent on an MCP connection no longer share a window, refs or a recording.
const sess = () => currentSession();
const getRecording = () => sess().recording;
const setRecording = (value) => { sess().recording = value; };
// Refs outlive a snapshot (an element keeps its @eN while it stays on the page), so the
// map grows with each snapshot — a filtered one returns only some refs — and starts over
// when the extension reports a new page.
const setLastRefMap = (refs, freshPage) => { const s = sess(); s.refMap = freshPage ? refs : { ...s.refMap, ...refs }; };
// click/fill/select by ref return the element's locators, computed just before acting: keep
// them for the recorded step, out of what the model reads.
const learnTarget = (ref, result) => {
  if (!result?.target) return result;
  const { target, ...shown } = result;
  if (ref) setLastRefMap({ [String(ref).replace('@', '')]: target }, false);
  return shown;
};
const saveActionToHistory = (...args) => recordAction(sess(), ...args);
import { classifyWithLLM, detectListContext } from './classify.js';
import { uniqueVarName, listVariable, variabilizeInput } from './variable-detection.js';
import { linkAssertionToVariables } from './test-variable.js';
import { loadTest, saveTest } from './test-store.js';
import { linkRecorded } from './requirements.js';
import { evaluateAssertion } from './test-execute.js';

// ─── Provider factory (OpenRouter) ────────────────────────────────

function createModel(model, apiKey) {
  const client = createOpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
  });
  // Use .chat() to force Chat Completions API (OpenRouter doesn't support Responses API)
  return client.chat(model);
}

// ─── Helpers ──────────────────────────────────────────────────────

function cleanRecoverySteps(steps) {
  const cleaned = [...steps];
  const navigateUrls = new Map();
  const toRemove = new Set();
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].command === 'navigate' && cleaned[i].params.url) {
      const url = cleaned[i].params.url;
      if (navigateUrls.has(url)) {
        toRemove.add(i);
        if (i > 0 && cleaned[i - 1].command === 'wait') toRemove.add(i - 1);
        if (i + 1 < cleaned.length && cleaned[i + 1].command === 'wait') toRemove.add(i + 1);
      } else {
        navigateUrls.set(url, i);
      }
    }
  }
  const result = cleaned.filter((_, i) => !toRemove.has(i));
  while (result.length > 0 && result[result.length - 1].command === 'wait') result.pop();
  return result;
}

// ─── Tool result truncation ────────────────────────────────────────
// Prevents huge tool results (e.g. document.body.textContent on SPAs)
// from blowing the model's context window across multi-step runs.

const TOOL_RESULT_MAX_CHARS = 15000;

function truncateToolResult(str, hint) {
  if (typeof str !== 'string' || str.length <= TOOL_RESULT_MAX_CHARS) return str;
  const kept = str.substring(0, TOOL_RESULT_MAX_CHARS);
  const dropped = str.length - TOOL_RESULT_MAX_CHARS;
  return `${kept}\n\n... [truncated ${dropped} chars — ${hint}]`;
}

// Convert a thrown sendCommand error into a model-readable string result
// with an actionable recovery hint. The tool stays "successful" from the
// SDK's POV (no throw), so the agent can read the error and adapt instead
// of the whole run aborting.
function formatToolError(err, toolName) {
  const msg = err?.message || String(err);
  // Hallucinated tabId: the API agent tool schemas do not expose tabId,
  // but if something slips through we catch it here.
  if (/No tab with id/i.test(msg)) {
    return `Error: ${msg}\n\nHINT: Do NOT pass any numeric id parameter. This tool operates on the active browser tab automatically. Call it again with only the documented fields (no tabId).`;
  }
  // Stale ref: its element left the page (re-render, navigation). Refs survive a new
  // snapshot otherwise, so this means the page itself changed.
  if (/Stale ref/i.test(msg) || /Element not found:?\s*@e\d+/i.test(msg) || /Failed to resolve ref/i.test(msg)) {
    return `Error: ${msg}\n\nHINT: This @eX ref is stale — the element it named is no longer on the page. Call snapshot() again with purposeFilter and searchText to get fresh refs, then retry.`;
  }
  if (/Element not found/i.test(msg)) {
    return `Error: ${msg}\n\nHINT: The selector did not match. Try snapshot(purposeFilter="click"|"fill", searchText="...") to find the right element and use its @eX ref.`;
  }
  if (/timed out/i.test(msg)) {
    return `Error: ${msg}\n\nHINT: The element may not have appeared yet. Try wait(ms=1000) then snapshot() again, or check that a previous action actually navigated to the expected page.`;
  }
  return `Error in ${toolName}: ${msg}`;
}

// ─── Context window compaction (sliding window) ────────────────────
// Strategy: preserve every message's structure (so tool_call_id pairing
// stays valid), but replace the `output` of OLD tool-result parts with a
// short stub. The agent keeps its trajectory memory (it remembers WHICH
// tools it called, in what order) while the bulky payloads of old results
// stop piling up in context.
//
// Two independent compaction rules are applied:
//   1. SLIDING WINDOW — only the last KEEP_RECENT_TOOL_RESULTS results are
//      kept in full. Everything older gets stubbed.
//   2. KEEP-LAST-ONLY — for tools whose output becomes stale the moment the
//      tool is called again (snapshot/screenshot/execute_js/extract), ONLY
//      the most recent call keeps its full output. This prevents the agent
//      from reusing stale @eX refs from an older snapshot (an element keeps its
//      ref, but one that left the page since does not).
//
// This runs via `prepareStep` BEFORE each model call, so the SDK's own
// history (to which tools append) is left intact; we only rewrite the copy
// sent to the model for that step.

const KEEP_RECENT_TOOL_RESULTS = 6;

// Tools whose output is invalidated by a newer call of the same tool.
// Only the most recent result should remain visible in the prompt.
const KEEP_LAST_ONLY_TOOLS = new Set(['snapshot', 'screenshot', 'execute_js', 'extract']);

function compactMessages(messages) {
  // Walk every tool-result part across the conversation, chronologically.
  // For each, record its (messageIndex, partIndex) and the toolName.
  const locations = []; // [{ key, toolName }]
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const part = msg.content[pi];
      if (part?.type === 'tool-result') {
        locations.push({ key: `${mi}:${pi}`, toolName: part.toolName });
      }
    }
  }

  const stubSet = new Set();
  const stubReasons = new Map(); // key -> "stale-snapshot" | "old"

  // Rule 1 — sliding window: stub everything older than the last N.
  if (locations.length > KEEP_RECENT_TOOL_RESULTS) {
    const cutoff = locations.length - KEEP_RECENT_TOOL_RESULTS;
    for (let i = 0; i < cutoff; i++) {
      stubSet.add(locations[i].key);
      stubReasons.set(locations[i].key, 'old');
    }
  }

  // Rule 2 — keep-last-only: for each tool in KEEP_LAST_ONLY_TOOLS, find the
  // most recent call and stub every earlier call of the same tool.
  const lastSeen = new Map(); // toolName -> last index in `locations`
  for (let i = 0; i < locations.length; i++) {
    if (KEEP_LAST_ONLY_TOOLS.has(locations[i].toolName)) {
      lastSeen.set(locations[i].toolName, i);
    }
  }
  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    if (!KEEP_LAST_ONLY_TOOLS.has(loc.toolName)) continue;
    if (lastSeen.get(loc.toolName) === i) continue; // this IS the last one
    stubSet.add(loc.key);
    if (!stubReasons.has(loc.key)) stubReasons.set(loc.key, 'stale');
  }

  if (stubSet.size === 0) return { messages, stubbed: 0 };

  let stubbed = 0;
  const compacted = messages.map((msg, mi) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const newContent = msg.content.map((part, pi) => {
      const key = `${mi}:${pi}`;
      if (part.type !== 'tool-result' || !stubSet.has(key)) return part;
      changed = true;
      stubbed++;
      const reason = stubReasons.get(key);
      const note = reason === 'stale'
        ? `[stale — a newer ${part.toolName} call has superseded this result; refs from here are no longer valid]`
        : `[compacted — older ${part.toolName} result dropped to save context]`;
      return {
        ...part,
        output: { type: 'text', value: note },
      };
    });
    return changed ? { ...msg, content: newContent } : msg;
  });

  return { messages: compacted, stubbed };
}

// ─── Loop detector ─────────────────────────────────────────────────
// Inspects the last N assistant tool-calls + their tool-results. If they
// are identical calls AND every one returned an error-shaped result,
// returns a nudge message to inject as a user message before the next
// model call. Returns null if no loop detected.

const LOOP_WINDOW = 3;

function isErrorResult(part) {
  if (part?.type !== 'tool-result') return false;
  const out = part.output;
  if (!out) return false;
  if (out.type === 'error-text' || out.type === 'error-json') return true;
  // Tools in this file catch errors and return them as plain text starting
  // with "Error" — detect that shape too.
  if (out.type === 'text' && typeof out.value === 'string' && /^Error[:\s]/i.test(out.value)) return true;
  return false;
}

function detectLoop(messages) {
  // Collect tool-call + tool-result pairs chronologically.
  const calls = []; // [{ toolName, argsKey, errored }]
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'tool-call') {
          calls.push({
            toolName: part.toolName,
            argsKey: JSON.stringify(part.input || part.args || {}),
            errored: false,
            toolCallId: part.toolCallId,
          });
        }
      }
    } else if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'tool-result') {
          const match = calls.find(c => c.toolCallId === part.toolCallId);
          if (match) match.errored = isErrorResult(part);
        }
      }
    }
  }

  if (calls.length < LOOP_WINDOW) return null;
  const recent = calls.slice(-LOOP_WINDOW);
  const first = recent[0];
  const allSame = recent.every(c => c.toolName === first.toolName && c.argsKey === first.argsKey);
  const allErrored = recent.every(c => c.errored);
  if (!allSame || !allErrored) return null;

  return {
    toolName: first.toolName,
    argsKey: first.argsKey,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────

function buildTools(sendCommand) {
  return {
    navigate: tool({
      description: 'Navigate to a URL in the active browser tab.',
      inputSchema: z.object({
        url: z.string().describe('The URL to navigate to'),
        intent: z.string().optional().describe('Functional description of this step'),
      }),
      execute: async ({ url, intent }) => {
        try {
          // First navigate of the run opens this session's own window, rather than
          // hijacking whichever tab happens to be active (possibly another agent's).
          const isNewSession = sess().lastTabId === undefined;
          const result = await sendCommand(undefined, 'navigate', { url, newWindow: isNewSession });
          sess().adoptTab(result?.tabId, result?.windowId);
          let screenshotBase64 = null;
          if (getRecording()?.use_vrt) {
            try { const s = await sendCommand(undefined, 'screenshot', { annotate: false }); if (s?.dataUrl) screenshotBase64 = s.dataUrl; } catch(e) {}
          }
          saveActionToHistory('navigate', { url }, null, screenshotBase64, intent);
          return JSON.stringify(result);
        } catch (err) { return formatToolError(err, 'navigate'); }
      },
    }),

    click: tool({
      description: 'Click an element in the active tab by CSS selector, visible text, or @eX ref. Prefer @eX refs from the most recent snapshot.',
      inputSchema: z.object({
        selector: z.string().optional(),
        text: z.string().optional().describe('Visible text to find and click'),
        ref: z.string().optional().describe('Reference from the MOST RECENT snapshot (e.g. @e5). Refs from older snapshots are invalid.'),
        intent: z.string().optional(),
      }),
      execute: async ({ selector, text, ref, intent }) => {
        try {
          const result = learnTarget(ref, await sendCommand(undefined, 'click', { selector, text, ref }));
          let screenshotBase64 = null;
          if (getRecording()?.use_vrt) {
            try { const s = await sendCommand(undefined, 'screenshot', { annotate: false }); if (s?.dataUrl) screenshotBase64 = s.dataUrl; } catch(e) {}
          }
          saveActionToHistory('click', { selector, text }, ref, screenshotBase64, intent);
          return JSON.stringify(result);
        } catch (err) { return formatToolError(err, 'click'); }
      },
    }),

    fill: tool({
      description: 'Fill a text input/textarea in the active tab. For <select>, use "select" tool instead.',
      inputSchema: z.object({
        selector: z.string().optional(),
        value: z.string().describe('Value to fill in'),
        ref: z.string().optional().describe('Reference from the MOST RECENT snapshot (e.g. @e5). Refs from older snapshots are invalid.'),
        clear: z.boolean().optional().describe('Clear before filling (default: true)'),
        intent: z.string().optional(),
      }),
      execute: async ({ selector, value, ref, clear, intent }) => {
        try {
          const result = learnTarget(ref, await sendCommand(undefined, 'fill', { selector, value, ref, clear }));
          let screenshotBase64 = null;
          if (getRecording()?.use_vrt) {
            try { const s = await sendCommand(undefined, 'screenshot', { annotate: false }); if (s?.dataUrl) screenshotBase64 = s.dataUrl; } catch(e) {}
          }
          saveActionToHistory('fill', { selector, value, clear }, ref, screenshotBase64, intent);
          return JSON.stringify(result);
        } catch (err) { return formatToolError(err, 'fill'); }
      },
    }),

    select: tool({
      description: 'Select an option from a <select> dropdown in the active tab.',
      inputSchema: z.object({
        selector: z.string().optional(),
        value: z.string().describe('Option to select'),
        ref: z.string().optional().describe('Reference from the MOST RECENT snapshot (e.g. @e5). Refs from older snapshots are invalid.'),
        matchBy: z.enum(['text', 'value']).optional(),
        intent: z.string().optional(),
      }),
      execute: async ({ selector, value, ref, matchBy, intent }) => {
        try {
          const result = learnTarget(ref, await sendCommand(undefined, 'select', { selector, value, ref, matchBy }));
          let screenshotBase64 = null;
          if (getRecording()?.use_vrt) {
            try { const s = await sendCommand(undefined, 'screenshot', { annotate: false }); if (s?.dataUrl) screenshotBase64 = s.dataUrl; } catch(e) {}
          }
          saveActionToHistory('select', { selector, ...selectParams(result, value, matchBy) }, ref, screenshotBase64, intent);
          return JSON.stringify(result);
        } catch (err) { return formatToolError(err, 'select'); }
      },
    }),

    snapshot: tool({
      description: [
        'Take a snapshot of the page DOM as an accessibility tree with unique refs (@eX) for use in click/fill/select.',
        '',
        'ELEMENT DISCOVERY PROTOCOL — follow this order when looking for an element:',
        '  STEP 1 (always start here): Call snapshot() WITH a purposeFilter matching your intent.',
        '             -> About to fill a form? Use purposeFilter="fill" (only inputs).',
        '             -> About to click something? Use purposeFilter="click" (only clickable elements).',
        '             -> Combine with searchText="label" to narrow further (e.g. searchText="email").',
        '             -> If you find the element in the output: use its @eX ref directly.',
        '  STEP 2 (if not found): Call snapshot() again with broader filters or different searchText.',
        '             -> Try without purposeFilter, or with includeHidden=true.',
        '  STEP 3 (last resort): Call screenshot() for visual context. Expensive.',
        '',
        'FILTER STRATEGY (mandatory — always apply filters to keep output small):',
        '  1. purposeFilter — ALWAYS set this based on your next action:',
        '     * "fill"  — Only input fields (textbox, combobox, checkbox, radio, select). Use before filling.',
        '     * "click" — Only clickable elements (button, link, tab, menu item, cursor:pointer div/span). Use before clicking.',
        '     * "read"  — Everything. Use ONLY to understand full page structure, never as a first call.',
        '  2. searchText — Grep elements by label/text (case-insensitive). Example: searchText="connexion".',
        '     Combine with purposeFilter for precise results (e.g. purposeFilter="fill", searchText="email").',
        '  3. includeHidden — LAST RESORT only, always combine with searchText or purposeFilter.',
        '',
        'CRITICAL: @eX refs are valid ONLY until the next snapshot() call. A new snapshot INVALIDATES',
        'every ref from previous snapshots — always use refs from the MOST RECENT snapshot in your context.',
        'If a click/fill fails with "Element not found: @eX", call snapshot() again to get fresh refs.',
      ].join('\n'),
      inputSchema: z.object({
        purposeFilter: z.enum(['fill', 'click', 'read']).optional().describe('REQUIRED in almost every call: "fill" before filling inputs, "click" before clicking, "read" only for full page structure'),
        searchText: z.string().optional().describe('Filter elements by text content (case-insensitive). Strongly recommended when you know the label/text you are looking for.'),
        compact: z.boolean().optional().default(true),
        includeHidden: z.boolean().optional().describe('LAST RESORT. Always combine with searchText or purposeFilter to avoid massive output.'),
      }),
      execute: async ({ purposeFilter, searchText, compact, includeHidden }) => {
        try {
          const result = await sendCommand(undefined, 'snapshot', {
            compact: compact ?? true, format: 'text', purposeFilter, searchText, includeHidden
          });
          if (!result?.tree) return 'Snapshot failed — no elements found. Try different filters or searchText.';
          if (result.refs) setLastRefMap(result.refs, result.freshRefs);
          const refCount = result.refs ? Object.keys(result.refs).length : 0;
          const MAX = 25000;
          let tree = result.tree;
          if (tree.length > MAX) tree = tree.substring(0, MAX) + '\n... (truncated — use searchText to narrow)';
          const filterLabel = purposeFilter ? ` [filter: ${purposeFilter}]` : '';
          const searchLabel = searchText ? ` [search: "${searchText}"]` : '';
          return `Page: ${result.title}\nURL: ${result.url}\nElements: ${refCount}${filterLabel}${searchLabel}\n\n${tree}`;
        } catch (err) { return formatToolError(err, 'snapshot'); }
      },
    }),

    screenshot: tool({
      description: 'Take a visual screenshot of the active tab. EXPENSIVE — use ONLY after snapshot() failed 2+ times.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const snapResult = await sendCommand(undefined, 'snapshot', { interactiveOnly: true, compact: true, format: 'text' });
          if (snapResult?.refs) setLastRefMap(snapResult.refs, snapResult.freshRefs);
          await sendCommand(undefined, 'screenshot', { annotate: true });
          const refCount = snapResult?.refs ? Object.keys(snapResult.refs).length : 0;
          return `Screenshot taken. DOM mapping (${refCount} elements):\n${snapResult?.tree || '(no mapping)'}`;
        } catch (err) { return formatToolError(err, 'screenshot'); }
      },
    }),

    scroll: tool({
      description: 'Scroll the active tab.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down']).optional(),
        amount: z.number().optional().describe('Pixels (default: 500)'),
        selector: z.string().optional(),
      }),
      execute: async ({ direction, amount, selector }) => {
        try {
          return JSON.stringify(await sendCommand(undefined, 'scroll', { direction, amount, selector }));
        } catch (err) { return formatToolError(err, 'scroll'); }
      },
    }),

    wait: tool({
      description: 'Wait for a time or until an element appears in the active tab.',
      inputSchema: z.object({
        ms: z.number().optional(),
        selector: z.string().optional(),
        intent: z.string().optional(),
      }),
      execute: async ({ ms, selector, intent }) => {
        try {
          const result = await sendCommand(undefined, 'wait', { ms, selector });
          saveActionToHistory('wait', { ms, selector }, null, null, intent);
          return JSON.stringify(result);
        } catch (err) { return formatToolError(err, 'wait'); }
      },
    }),

    keyboard: tool({
      description: 'Send a keyboard event to the active element in the active tab.',
      inputSchema: z.object({
        key: z.string().describe('Key (e.g. "Enter", "Tab")'),
        modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional(),
        intent: z.string().optional(),
      }),
      execute: async ({ key, modifiers, intent }) => {
        try {
          const result = await sendCommand(undefined, 'keyboard', { key, modifiers });
          let screenshotBase64 = null;
          if (getRecording()?.use_vrt) {
            try { const s = await sendCommand(undefined, 'screenshot', { annotate: false }); if (s?.dataUrl) screenshotBase64 = s.dataUrl; } catch(e) {}
          }
          saveActionToHistory('keyboard', { key, modifiers }, null, screenshotBase64, intent);
          return JSON.stringify(result);
        } catch (err) { return formatToolError(err, 'keyboard'); }
      },
    }),

    extract: tool({
      description: 'Extract text/attributes from elements in the active tab.',
      inputSchema: z.object({
        selector: z.string(),
        attribute: z.string().optional(),
        multiple: z.boolean().optional(),
      }),
      execute: async ({ selector, attribute, multiple }) => {
        try {
          const raw = JSON.stringify(await sendCommand(undefined, 'extract', { selector, attribute, multiple }));
          return truncateToolResult(raw, 'extract — narrow your selector or set multiple=false');
        } catch (err) { return formatToolError(err, 'extract'); }
      },
    }),

    execute_js: tool({
      description: [
        'Execute JavaScript in the active tab. Return value is stringified and fed back to you.',
        'NEVER return document.body.textContent or large DOM dumps — use snapshot() for page content.',
        'Results over ~15k chars are truncated. Keep your JS focused: return only what you need.',
      ].join('\n'),
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => {
        try {
          const result = await sendCommand(undefined, 'execute_js', { code });
          saveActionToHistory('execute_js', { code });
          if (result === undefined) return 'Execution successful';
          return truncateToolResult(JSON.stringify(result), 'execute_js — return a smaller value from your JS (avoid document.body.textContent)');
        } catch (err) { return formatToolError(err, 'execute_js'); }
      },
    }),

    // ─── Recording tools ───────────────────────────────────────────

    start_recording: tool({
      description: 'Start recording a browser test. Actions are auto-recorded. Call stop_recording when done.',
      inputSchema: z.object({
        name: z.string(),
        description: z.string().optional(),
        use_vrt: z.boolean().optional(),
        viewport_width: z.number().optional(),
        viewport_height: z.number().optional(),
      }),
      execute: async ({ name, description, use_vrt, viewport_width, viewport_height }) => {
        const recording = getRecording();
        if (recording) {
          if (recording.name === name) return `Recording already in progress for "${name}".`;
          return `Already recording "${recording.name}". Stop it first.`;
        }
        const viewport = (viewport_width && viewport_height) ? { width: viewport_width, height: viewport_height } : null;
        // A run of the dashboard's "Create Test with AI" links its test to the request it was given.
        setRecording({ name, description: description || '', steps: [], startedAt: Date.now(), use_vrt: use_vrt || false, viewport, link: sess().requirementLink ?? null });
        log(`[Agent] Recording started: ${name}`);

        try {
          const navParams = { url: 'about:blank', newWindow: true };
          if (viewport) { navParams.viewportWidth = viewport.width; navParams.viewportHeight = viewport.height; }
          await sendCommand(undefined, 'navigate', navParams);
        } catch (err) {
          log(`[Agent] Failed to open new window: ${err.message}`);
        }

        import('./websocket.js').then(({ pushOverlayState }) => {
          pushOverlayState(null, { mode: 'recording', step: 0, stepName: 'Waiting for action...' });
        }).catch(() => {});

        return `Recording started for "${name}"${use_vrt ? ' (VRT enabled)' : ''}. Navigate to your target URL now.`;
      },
    }),

    stop_recording: tool({
      description: 'Stop recording and save the test. Variable detection runs automatically.',
      inputSchema: z.object({
        _: z.string().optional().describe('Unused — no parameters needed'),
      }),
      execute: async () => {
        const recording = getRecording();
        if (!recording) return 'No recording in progress.';

        import('./websocket.js').then(({ pushOverlayState }) => {
          pushOverlayState(null, null);
        }).catch(() => {});

        if (recording.steps.length === 0) {
          setRecording(null);
          return 'Recording cancelled — no steps were recorded.';
        }

        recording.steps = cleanRecoverySteps(recording.steps);
        log(`[Agent] Batch variable detection for ${recording.steps.length} steps...`);

        const usedVarNames = new Set();

        for (let i = 0; i < recording.steps.length; i++) {
          const step = recording.steps[i];
          if (step.variable) { usedVarNames.add(step.variable.name); continue; }

          if (variabilizeInput(step, i, usedVarNames)) continue;

          if (step.command === 'click') {
            const cssLocator = (step.locators || []).find(l => l.type === 'css');
            const selector = step.params.selector || (cssLocator && cssLocator.value);
            const clickText = step.params.text;
            if (selector || clickText) {
              try {
                const listContext = await detectListContext(sendCommand, { selector, text: clickText, tabId: step.params.tabId });
                if (listContext) {
                  const llmResult = await classifyWithLLM(listContext, step.intent);
                  if (llmResult.isList) {
                    const varName = uniqueVarName(llmResult.variableName, usedVarNames);
                    step.variable = listVariable(varName, listContext, llmResult);
                  }
                }
              } catch (err) {
                log(`[Agent] Variable detection failed for step ${i + 1}: ${err.message}`);
              }
            }
            continue;
          }
        }

        const variables = {};
        recording.steps.forEach((step, i) => {
          if (step.variable) {
            variables[step.variable.name] = {
              type: step.variable.type,
              defaultValue: step.variable.defaultValue || '',
              step: i + 1,
              description: step.intent || `${step.command} in step ${i + 1}`
            };
          }
        });

        const test = {
          name: recording.name, description: recording.description,
          createdAt: new Date(recording.startedAt).toISOString(),
          variables: Object.keys(variables).length > 0 ? variables : undefined,
          viewport: recording.viewport || null,
          steps: recording.steps
        };

        const testId = await saveTest(test);
        const stepCount = recording.steps.length;
        const varCount = Object.keys(variables).length;
        log(`[Agent] Recording saved: test id ${testId} (${stepCount} steps, ${varCount} variables)`);
        setRecording(null);

        let summary = `Test "${test.name}" saved with ${stepCount} steps (id: ${testId})`;
        summary += linkRecorded(recording);
        if (varCount > 0) {
          summary += `\n\n${varCount} variable(s) detected:\n`;
          for (const [name, info] of Object.entries(variables)) {
            summary += `  - {{${name}}} — ${info.type}, default: "${info.defaultValue}"\n`;
          }
        }
        return summary;
      },
    }),

    add_assertion: tool({
      description: 'Add an assertion to a saved test. Evaluates live first — only passes are saved.',
      inputSchema: z.object({
        test_name: z.string(),
        assertion_type: z.enum([
          'element_exists', 'element_not_exists', 'element_visible', 'element_hidden',
          'text_equals', 'text_contains', 'text_not_contains', 'attribute_equals',
          'url_equals', 'url_contains', 'title_equals', 'title_contains', 'element_count'
        ]),
        selector: z.string().optional(),
        expected: z.string().optional(),
        attribute: z.string().optional(),
        description: z.string().optional(),
        step_order: z.number().optional(),
      }),
      execute: async ({ test_name, assertion_type, selector, expected, attribute, description, step_order }) => {
        const assertion = { type: assertion_type };
        if (selector) assertion.selector = selector;
        if (expected !== undefined) assertion.expected = expected;
        if (attribute) assertion.attribute = attribute;

        const needsSelector = ['element_exists', 'element_not_exists', 'element_visible', 'element_hidden', 'text_equals', 'text_contains', 'text_not_contains', 'attribute_equals', 'element_count'];
        if (needsSelector.includes(assertion_type) && !selector) return `"${assertion_type}" requires a CSS selector.`;
        const needsExpected = ['text_equals', 'text_contains', 'text_not_contains', 'attribute_equals', 'url_equals', 'url_contains', 'title_equals', 'title_contains', 'element_count'];
        if (needsExpected.includes(assertion_type) && expected === undefined) return `"${assertion_type}" requires an expected value.`;
        if (assertion_type === 'attribute_equals' && !attribute) return '"attribute_equals" requires an attribute name.';

        const test = loadTest(test_name);
        if (!test) return `Test "${test_name}" not found.`;

        let result;
        try { result = await evaluateAssertion(sendCommand, assertion); }
        catch (err) { return `Assertion evaluation error: ${err.message}. NOT added.`; }

        if (!result.passed) {
          return `Assertion FAILED — NOT added.\n  Type: ${assertion_type}\n  Expected: ${result.expected}\n  Actual: ${result.actual}\nFix and try again.`;
        }

        // Checked against what the test typed: replayed with other values, it checks those.
        const { assertion: saved, linked, ambiguous } = linkAssertionToVariables(assertion, test.variables);
        const intentText = description || `Assert: ${assertion_type}${selector ? ` on ${selector}` : ''}${expected ? ` = "${expected}"` : ''}`;
        const newStep = { command: 'assert', params: {}, intent: intentText, assertion: saved };

        if (step_order && step_order > 0 && step_order <= test.steps.length + 1) {
          test.steps.splice(step_order - 1, 0, newStep);
        } else {
          test.steps.push(newStep);
        }

        saveTest(test);
        const link = (linked.length ? `\n  Linked to ${linked.map(n => `{{${n}}}`).join(', ')}: saved as "${saved.expected}".` : '') +
          ambiguous.map(({ name, value, found }) => `\n  Not linked to {{${name}}}: "${value}" is found ${found} times in the expected text.`).join('');
        return `Assertion PASSED and added at step ${step_order || test.steps.length}.\n  Expected: ${result.expected}\n  Actual: ${result.actual}${link}`;
      },
    }),
  };
}

// ─── System prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a browser automation agent. You control a real browser through tools.
You MUST use tools to accomplish tasks — never just describe what you would do.
Keep calling tools until the entire task is complete. Do NOT stop after a single tool call.

RULES:
1. Use snapshot() FIRST to discover elements — never screenshot as first step.
2. ALWAYS call snapshot with purposeFilter ("fill" | "click") and, when you know the label, a searchText. Unfiltered snapshots waste context.
3. Use @eX refs from the MOST RECENT snapshot only. Every new snapshot invalidates all previous refs — do NOT reuse @eX refs that came from an earlier snapshot in this conversation.
4. After navigating or after any action that may change the DOM (click that opens a modal, fill that triggers validation, scroll that loads new items), re-snapshot before interacting again.
5. When recording, pass "intent" on each action to describe the step functionally.
6. If a click/fill fails with "Element not found: @eX" or "stale ref", call snapshot() again with purposeFilter+searchText to get fresh refs, then retry.
7. If element not found, broaden snapshot filters before falling back to screenshot.
8. Keep responses concise — focus on actions, not explanations.
9. After each tool result, immediately call the next tool. Never stop mid-task.
10. NEVER use execute_js to dump large DOM content (document.body.textContent, innerHTML of big containers, full page data). Use snapshot() for page content.`;

// ─── Agent executor ────────────────────────────────────────────────

/**
 * Run the dashboard's agent on `prompt`. `options.requirementLink` ({ requirement, caseId,
 * criterion }): the test it records is linked to that requirement.
 */
export async function runAgent(config, prompt, sendCommand, onProgress, signal, options = {}) {
  const session = createAdHocSession('dashboard-agent');
  session.requirementLink = options.requirementLink ?? null;
  try {
    return await runInSession(session, {}, () =>
      runAgentInSession(config, prompt, sendCommand, onProgress, signal, session));
  } finally {
    destroySession(session.id);
  }
}

async function runAgentInSession(config, prompt, rawSendCommand, onProgress, signal, session) {
  const { model: modelName, apiKey } = config;
  // Pin every command to this run's own window, exactly like the MCP tools do.
  const sendCommand = (profile, command, params, ...rest) =>
    rawSendCommand(profile, command, session.scope(params), ...rest);

  log(`[Agent] Starting: ${modelName}`);
  onProgress({ type: 'chunk', text: `Using ${modelName}\n\n` });

  const model = createModel(modelName, apiKey);

  // Per-step timing: browser time is measured around sendCommand, and whatever
  // is left of the step's wall time is the LLM round trip (+ SDK overhead).
  // Parallel tool calls overlap, so llmMs is clamped at 0.
  const timing = { runStartedAt: Date.now(), stepStartedAt: Date.now(), stepBrowserMs: 0, browserMs: 0, llmMs: 0 };
  const timedSendCommand = async (...args) => {
    const startedAt = Date.now();
    try { return await sendCommand(...args); }
    finally { timing.stepBrowserMs += Date.now() - startedAt; }
  };
  const tools = buildTools(timedSendCommand);

  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      stopWhen: stepCountIs(200),
      abortSignal: signal,
      prepareStep: ({ messages, stepNumber }) => {
        let working = messages;
        let changed = false;

        // Loop detection: nudge the agent if it's stuck.
        const loop = detectLoop(working);
        if (loop) {
          log(`[Agent] Step ${stepNumber} LOOP DETECTED: ${loop.toolName}(${loop.argsKey.substring(0, 120)}) repeated ${LOOP_WINDOW}× with errors`);
          working = [
            ...working,
            {
              role: 'user',
              content: [{
                type: 'text',
                text: `LOOP DETECTED: you have called ${loop.toolName} with the same arguments ${LOOP_WINDOW} times in a row and each call failed with the same error. Stop retrying. Change your approach completely:\n- Do NOT pass the same arguments again.\n- Re-read the most recent error message carefully.\n- For snapshot errors, try without any numeric ID params — the tool operates on the active tab automatically.\n- For "Element not found", call snapshot(purposeFilter, searchText) with different values, or try a CSS selector instead of an @eX ref.\n- If truly stuck, produce a final text response explaining what blocked you instead of calling more tools.`,
              }],
            },
          ];
          changed = true;
        }

        const { messages: compacted, stubbed } = compactMessages(working);
        if (stubbed > 0) {
          const before = JSON.stringify(working).length;
          const after = JSON.stringify(compacted).length;
          log(`[Agent] Step ${stepNumber} compaction: stubbed ${stubbed} old tool result(s), ${before} → ${after} chars`);
          working = compacted;
          changed = true;
        }

        return changed ? { messages: working } : {};
      },
      onStepFinish: (step) => {
        const { text, toolCalls, toolResults, finishReason, stepNumber } = step;
        const stepMs = Date.now() - timing.stepStartedAt;
        const stepLlmMs = Math.max(0, stepMs - timing.stepBrowserMs);
        timing.browserMs += timing.stepBrowserMs;
        timing.llmMs += stepLlmMs;
        log(`[Agent] Step ${stepNumber} finished: finishReason=${finishReason}, toolCalls=${toolCalls?.length || 0}, toolResults=${toolResults?.length || 0}, textLen=${text?.length || 0}, total=${stepMs}ms (llm≈${stepLlmMs}ms, browser=${timing.stepBrowserMs}ms)`);
        timing.stepStartedAt = Date.now();
        timing.stepBrowserMs = 0;
        if (text) {
          onProgress({ type: 'chunk', text: text + '\n' });
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            onProgress({ type: 'tool_call', tool: tc.toolName, input: tc.args });
            log(`[Agent] Tool: ${tc.toolName}(${JSON.stringify(tc.args).substring(0, 300)})`);
          }
        }
        if (toolResults) {
          for (const tr of toolResults) {
            const preview = typeof tr.result === 'string' ? tr.result.substring(0, 200) : JSON.stringify(tr.result).substring(0, 200);
            log(`[Agent] Tool result (${tr.toolName}): ${preview}`);
            onProgress({ type: 'chunk', text: `  → ${preview}${preview.length >= 200 ? '...' : ''}\n` });
          }
        }
      },
    });

    if (result.text) {
      onProgress({ type: 'chunk', text: '\n' + result.text });
    }

    log(`[Agent] Done: ${result.steps?.length || 0} steps, ${result.usage?.totalTokens || '?'} tokens, ${Date.now() - timing.runStartedAt}ms (llm≈${timing.llmMs}ms, browser=${timing.browserMs}ms)`);
    onProgress({ type: 'done', exitCode: 0, output: result.text || '' });

  } catch (err) {
    if (err.name === 'AbortError') {
      log('[Agent] Aborted by user');
      onProgress({ type: 'done', exitCode: 1, output: 'Stopped by user' });
      return;
    }
    log(`[Agent] Error: ${err.message}`);
    onProgress({ type: 'error', error: err.message });
    onProgress({ type: 'done', exitCode: 1, output: err.message });
  }
}
