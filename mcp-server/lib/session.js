// Per-agent isolated state, so several agents can drive the browser at the same time.
//
// Everything that used to be a module global in recording.js lives here instead, one copy
// per session: the working tab, the snapshot ref map (@eX), the active recording and the
// action history. Two agents sharing those was the whole bug — agent B's snapshot
// overwrote agent A's refs, and both navigated into the same tab.
//
// A session is normally the MCP connection: each `/sse` connection gets its own, with no
// change to how tools are called. Agents that share one connection (Claude Code subagents
// all speak through their parent's) can split further by passing `session: "<name>"` to any
// tool, or by calling open_session() first.

import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from './logger.js';
import { resolveValues, valueContext } from './values.js';
import { datasetRows } from './datasets.js';
import { secretValue } from './secrets.js';

const sessions = new Map();      // session id → Session
const connectionDefaults = new Map(); // connection id → session id
const connectionClients = new Map(); // connection id → { name, version } the MCP client announced
// connection id → the dashboard run it was opened for (/sse?run=…): an agent the dashboard
// started, whose sessions the dashboard shows live (lib/live.js followRun).
const connectionRuns = new Map();

let sessionCounter = 0;

// An action history is per session, but ids must stay unique across all of them: an
// action_id travels back to the agent and comes in again through fix_test_step.
let actionCounter = 0;

const MAX_HISTORY = 100;

// The parameters of an action that may hold {{…}}: a URL, a value typed, a text, a selector, a key,
// what an assertion expects.
const LIVE_PARAMS = ['url', 'value', 'text', 'selector', 'key', 'label', 'target', 'expected'];

export class Session {
  constructor({ id, label, connectionId, runId = null }) {
    this.id = id;
    this.label = label || id;
    this.connectionId = connectionId;
    // The dashboard run this session works for, if a dashboard run started it.
    this.runId = runId;
    this.profile = undefined; // Chrome profile id this session drives, once it uses one
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();

    // The working tab this session navigates in. Every command is pinned to it, so a
    // command without an explicit tabId can no longer land in another session's window.
    this.lastTabId = undefined;
    this.windowId = undefined;

    // Last tool call, for the cockpit's live view: { tool, at, status, frameId? }.
    this.lastAction = null;
    this.lastFrameId = undefined;

    this.refMap = {};        // ref (@eX) → { selector, text, role, name }
    this.recording = null;   // { name, steps: [], startedAt }
    // The URL of the page the last action was done on, as the extension reported it: the
    // page the step recording that action keeps (lib/elements.js). Taken once.
    this.actionPageUrl = undefined;
    // The values kept so far (capture_value), the last API answer (call_api), and the computed
    // values ({{today}}, {{unique}}) of the session: what {{…}} in an action means live.
    this.resetValues();
    this.actionHistory = new Map();
  }

  /**
   * Stamp outgoing command params with this session's identity and working tab.
   *
   * Pinning the tab is what stops the cross-talk: without it the extension falls back to
   * the globally active tab, so a click meant for this session lands in whichever window
   * the user (or another agent) last focused.
   */
  scope(params = {}) {
    this.lastUsedAt = Date.now();
    // liveSessions lets the extension tell "another agent is working here" from "the owner
    // is long gone"; force is the caller's explicit opt-in to act in someone else's window.
    const scoped = {
      ...params,
      sessionId: this.id,
      liveSessions: liveSessionIds(),
      ...(currentCallOptions().force ? { force: true } : {}),
    };
    // newWindow means "deliberately start somewhere new" — pinning the old tab would
    // silently cancel it.
    if (scoped.newWindow) {
      delete scoped.tabId;
      return scoped;
    }
    if (scoped.tabId === undefined || scoped.tabId === null) {
      if (this.lastTabId !== undefined) scoped.tabId = this.lastTabId;
      else delete scoped.tabId;
    }
    return scoped;
  }

  /** The MCP client driving this session ("claude-code", "cursor", …), once it said so. */
  get client() {
    if (!this.connectionId) return { name: 'dashboard' };
    return connectionClients.get(this.connectionId) ?? null;
  }

  adoptTab(tabId, windowId) {
    if (tabId !== undefined && tabId !== null) this.lastTabId = tabId;
    if (windowId !== undefined && windowId !== null) this.windowId = windowId;
  }

  /**
   * Starts the session's values afresh: a new recording keeps its own. Recording a test of a
   * project, the values of its datasets ({{users[2].email}}) and its secrets
   * ({{secret.PASSWORD}}, typed, never told back); playing a dataset, the first row of it
   * ({{email}}). The project is the recording's, or the run's (`projectId` of a dashboard agent).
   */
  resetValues({ projectId = null, row = null } = {}) {
    this.kept = {};
    this.lastResponse = null;
    const project = () => projectId ?? this.projectId ?? null;
    this.values = valueContext({
      lookup: (name) => this.kept[name] ?? row?.[name],
      datasets: (name) => datasetRows(project())[name],
      secrets: (name) => (project() == null ? null : secretValue(project(), name)),
    });
  }

  /**
   * `params` with their {{…}} worked out as the session knows them, for an action done now —
   * the step recorded keeps them as written. Throws with what does not work out.
   */
  live(params) {
    const problems = [];
    const out = { ...params };
    for (const key of LIVE_PARAMS) {
      if (typeof out[key] !== 'string' || !out[key].includes('{{')) continue;
      const resolved = resolveValues(out[key], this.values);
      problems.push(...resolved.problems);
      out[key] = resolved.text;
    }
    if (problems.length) {
      // A secret is the project's: the recording names it, and one it lacks is asked for.
      const aboutSecrets = problems.some((problem) => problem.includes('{{secret.'));
      throw new Error(`Values that do not work out: ${problems.join('; ')}${aboutSecrets
        ? '. A secret is one of the project\'s (start_recording with project_id); one it lacks, ask the user for it with ask_user.'
        : ''}`);
    }
    return out;
  }

  /** Keeps the page an action was done on, from its result (`pageUrl`). */
  notePage(result) {
    if (typeof result?.pageUrl === 'string') this.actionPageUrl = result.pageUrl;
  }

  /** The page the last action was done on, once: the next action reports its own. */
  takePage() {
    const url = this.actionPageUrl;
    this.actionPageUrl = undefined;
    return url;
  }

  forgetTabs(tabIds) {
    if (tabIds.includes(this.lastTabId)) {
      this.lastTabId = undefined;
      this.windowId = undefined;
    }
  }

  getAction(id) {
    return this.actionHistory.get(id);
  }

  putAction(entry) {
    const id = `act_${++actionCounter}`;
    this.actionHistory.set(id, entry);
    if (this.actionHistory.size > MAX_HISTORY) {
      this.actionHistory.delete(this.actionHistory.keys().next().value);
    }
    return id;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      tabId: this.lastTabId ?? null,
      windowId: this.windowId ?? null,
      client: this.client?.name ?? null,
      recording: this.recording?.name ?? null,
      createdAt: new Date(this.createdAt).toISOString(),
    };
  }
}

/**
 * The session a tool call belongs to. `name` is the optional `session` tool argument:
 * without it the caller gets its connection's own session, created on first use.
 */
export function resolveSession(connectionId, name) {
  if (name) {
    const id = `s:${name}`;
    let session = sessions.get(id);
    if (!session) {
      session = new Session({ id, label: name, connectionId, runId: connectionRuns.get(connectionId) ?? null });
      sessions.set(id, session);
      log(`Session created: ${id} (named, connection ${connectionId})`);
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  const existingId = connectionDefaults.get(connectionId);
  const existing = existingId && sessions.get(existingId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const id = `c:${connectionId}`;
  const session = new Session({ id, label: `connection ${++sessionCounter}`, connectionId, runId: connectionRuns.get(connectionId) ?? null });
  sessions.set(id, session);
  connectionDefaults.set(connectionId, id);
  log(`Session created: ${id} (default for connection ${connectionId})`);
  return session;
}

// ─── Ambient current session ───────────────────────────────────────
//
// A tool handler runs inside its session's context, so everything it calls downstream
// (jev-act, the recorder, nested sendCommand) sees the right session without threading an
// argument through every signature. AsyncLocalStorage follows awaits, so concurrent tool
// calls from different agents each keep their own store.

const activeSession = new AsyncLocalStorage();
const activeCallOptions = new AsyncLocalStorage();

export function runInSession(session, options, fn) {
  return activeSession.run(session, () => activeCallOptions.run(options ?? {}, fn));
}

/** Options of the tool call currently running (currently just `force`). */
export function currentCallOptions() {
  return activeCallOptions.getStore() ?? {};
}

/** The session of the tool call currently running. */
export function currentSession() {
  const session = activeSession.getStore();
  if (!session) throw new Error('No active IziTest Agent session in this context');
  return session;
}

/** Same, but for code also reachable outside a tool call (the dashboard's own routes). */
export function currentSessionOrNull() {
  return activeSession.getStore() ?? null;
}

/**
 * A session that belongs to no MCP connection — the dashboard's autonomous agent run.
 * The caller owns its lifetime and must destroySession() it when the run ends.
 */
export function createAdHocSession(label, { runId = null } = {}) {
  const id = `a:${label}-${++sessionCounter}`;
  const session = new Session({ id, label, connectionId: null, runId });
  sessions.set(id, session);
  log(`Session created: ${id} (ad hoc)`);
  return session;
}

export function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  sessions.delete(id);
  log(`Session closed: ${id}`);
  return session;
}

export function listSessions() {
  return [...sessions.values()];
}

/** Drop a session by name (the `session` argument), not by internal id. */
export function closeNamedSession(name) {
  const session = sessions.get(`s:${name}`);
  if (!session) return null;
  sessions.delete(session.id);
  log(`Session closed: ${session.id}`);
  return session;
}

/**
 * An MCP connection went away. Its default session goes with it; named sessions outlive it
 * on purpose — a subagent's window should survive its parent reconnecting.
 */
export function dropConnection(connectionId) {
  const id = connectionDefaults.get(connectionId);
  connectionDefaults.delete(connectionId);
  connectionClients.delete(connectionId);
  connectionRuns.delete(connectionId);
  const session = id && sessions.get(id);
  if (!session) return null;
  sessions.delete(id);
  log(`Session closed: ${id} (connection ended)`);
  return session;
}

/** What the MCP client announced at initialize (clientInfo). */
export function setConnectionClient(connectionId, info) {
  if (info?.name) connectionClients.set(connectionId, { name: info.name, ...(info.version ? { version: info.version } : {}) });
}

/** The MCP connection was opened for this dashboard run: the sessions it makes are the run's. */
export function setConnectionRun(connectionId, runId) {
  if (runId) connectionRuns.set(connectionId, runId);
}

/** The sessions working for a dashboard run, the one used last first. */
export function sessionsOfRun(runId) {
  return [...sessions.values()].filter((s) => s.runId === runId).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Ids of every session the server still considers alive. */
export function liveSessionIds() {
  return [...sessions.keys()];
}

/** After a window closed: drop that tab from every session still pointing at it. */
export function forgetTabsEverywhere(tabIds) {
  for (const session of sessions.values()) session.forgetTabs(tabIds);
}
