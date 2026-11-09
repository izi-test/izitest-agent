// Runs every browser/test tool inside its caller's session.
//
// Patches server.tool the same way bench.js does, so it stacks with it: each registered
// tool gains an optional `session` argument, and its handler runs inside the matching
// Session's async context. Handlers therefore never carry a session parameter around —
// they read it through currentSession() wherever they need it.

import { z } from 'zod';
import { runInSession } from '../session.js';

const FORCE_PARAM = z.boolean().optional().describe(
  'Act in a tab that belongs to ANOTHER session\'s working window. Refused by default: ' +
  'taking over another agent\'s tab moves the window to you, and that agent then loses it. ' +
  'Only pass true when you deliberately want that tab, knowing another agent may be using it.'
);

const SESSION_PARAM = z.string().optional().describe(
  'Name of an isolated browser session. Omit it and you get your own session automatically ' +
  '— one working window, separate from every other agent connected at the same time. ' +
  'Pass a name only when several agents share one MCP connection (e.g. parallel subagents): ' +
  'each picks a distinct name and gets its own window. Use the same name across calls to stay in it.'
);

// Read-only bookkeeping tools are not what anyone means by "the agent's last action".
const NOT_ACTIONS = new Set(['list_sessions', 'open_session', 'list_profiles', 'get_tabs']);

// Not waited for by stop_recording: what records nothing, and what waits for the user.
const NOT_WAITED_FOR = new Set([...NOT_ACTIONS, 'stop_recording', 'ask_user']);

/**
 * The tool calls of `session` still under way, settled — at most `ms`. stop_recording waits for
 * them: an action an agent sent in the same message as it was recorded after the test was
 * saved, and lost, though its answer said it went well.
 */
export async function settleActions(session, ms = 30_000) {
  const running = [...(session.inFlight ?? [])];
  if (!running.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(running),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  clearTimeout(timer);
}

/** Keep the session's last tool call for the cockpit (GET /live/sessions). */
async function trackLastAction(session, tool, run) {
  if (NOT_ACTIONS.has(tool)) return run();
  const action = { tool, at: new Date().toISOString(), status: 'running' };
  session.lastAction = action;
  const frameBefore = session.lastFrameId;
  try {
    const result = await run();
    action.status = result?.isError ? 'error' : 'ok';
    return result;
  } catch (err) {
    action.status = 'error';
    throw err;
  } finally {
    action.endedAt = new Date().toISOString();
    if (session.lastFrameId !== frameBefore) action.frameId = session.lastFrameId;
  }
}

/**
 * Patch `server` so tools registered next are session-scoped.
 * Returns a function that restores the previous `server.tool`.
 */
export function scopeToolsToSession(server, resolveSessionByName) {
  const previous = server.tool;
  const registerTool = previous.bind(server);

  server.tool = (...args) => {
    const handler = args[args.length - 1];
    if (typeof handler !== 'function') return registerTool(...args);

    // server.tool(name, description, shape, handler) — shape is optional in the SDK.
    const shapeIndex = args.length >= 4 ? args.length - 2 : -1;
    const shape = shapeIndex >= 0 ? args[shapeIndex] : null;
    if (shape && typeof shape === 'object' && !Array.isArray(shape) && !('session' in shape)) {
      // `force` only means anything for a tool that targets a tab.
      const extras = 'tabId' in shape ? { session: SESSION_PARAM, force: FORCE_PARAM } : { session: SESSION_PARAM };
      args[shapeIndex] = { ...shape, ...extras };
    }

    const toolName = args[0];
    args[args.length - 1] = (toolArgs, extra) => {
      const session = resolveSessionByName(toolArgs?.session);
      const call = runInSession(
        session,
        { force: toolArgs?.force === true },
        () => trackLastAction(session, toolName, () => handler(toolArgs, extra)),
      );
      if (!NOT_WAITED_FOR.has(toolName)) {
        session.inFlight ??= new Set();
        session.inFlight.add(call);
        call.finally(() => session.inFlight.delete(call)).catch(() => {});
      }
      return call;
    };

    return registerTool(...args);
  };

  return () => { server.tool = previous; };
}
