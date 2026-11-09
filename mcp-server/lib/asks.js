// What an agent asks the person who started it, while it works: values a test needs and nobody
// gave — an account to log in with, a password, a code. The agent waits; the person answers in
// the dashboard, never in the agent's conversation, where the agent would read a password.
//
// - A field marked secret is kept in the project's secrets (lib/secrets.js): the agent gets its
//   reference, {{secret.NAME}}, to type, and IziTest types the value. Any other field's value
//   goes back to the agent.
// - A dashboard run shows the question beside its browser (followAsks); one from another
//   client (Claude Code) is shown by every page of the dashboard (GET /api/asks).
// - Unanswered after IZITEST_ASK_TIMEOUT_MS (15 min), or cancelled, the agent is told to stop.
//
// An MCP tool call has a time limit of its client's (60 s by default): ask_user waits
// IZITEST_ASK_WAIT_MS (45 s) at most, then tells the agent to call again with request_id.

import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { log } from './logger.js';
import { SECRET_NAME, saveSecret } from './secrets.js';

const MAX_FIELDS = 8;
// A question answered or given up is kept a while: the agent's next call reads its answer.
const KEPT_AFTER_MS = 10 * 60_000;

const asks = new Map();      // id → ask
const listeners = new Set(); // (event) → void, event { type: 'ask', ask } | { type: 'ask_done', id, status }

const timeoutMs = () => Number(process.env.IZITEST_ASK_TIMEOUT_MS ?? 15 * 60_000);
const waitMs = () => Number(process.env.IZITEST_ASK_WAIT_MS ?? 45_000);

export const ASK_USER_DESCRIPTION = [
  'Ask the person who started you for values the test needs and nobody gave: an account to log in with, a password, a code, an address.',
  'They answer in IziTest\'s dashboard, not in this conversation: never ask for such a value in your reply, never make one up.',
  'A field marked secret (a password, an API key, a token, a code) is kept in the project\'s secrets, and you get its reference,',
  '{{secret.NAME}}, to type where it goes: IziTest types the value, you never see it. Any other field\'s value comes back to you.',
  'Ask once, with every field you need, then wait: if they have not answered within the call, it says so — call ask_user again',
  'with request_id, doing nothing else meanwhile. If they do not give it, stop and say what the test needs.',
].join(' ');

export const ASK_FIELD_DESCRIPTION = {
  name: 'Its name: letters, digits and _ (TIIME_PASSWORD, email). A secret is kept in the project under it.',
  label: 'What the person is asked, in their words: "Password of the test account".',
  secret: 'true for a password, an API key, a token, a code: kept in the project\'s secrets, its value never shown to you.',
};

function emit(event) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* a listener gone */ }
  }
}

/** A question as the dashboard is shown it: never a value. */
export function describeAsk(ask) {
  return {
    id: ask.id,
    project_id: ask.projectId,
    project_name: ask.projectName,
    run_id: ask.runId,
    why: ask.why,
    fields: ask.fields.map(({ name, label, secret }) => ({ name, label, secret })),
    status: ask.status,
    created_at: new Date(ask.createdAt).toISOString(),
    expires_at: new Date(ask.expiresAt).toISOString(),
  };
}

/**
 * A new question: `why` (what it is for, shown to the person) and its `fields`
 * ({ name, label, secret }). `projectId`: where a secret is kept — needed when one is asked.
 * `runId`: the dashboard run asking, which shows it. Returns { ask } or { error }.
 */
export function createAsk({ projectId = null, runId = null, why, fields }) {
  const reason = typeof why === 'string' ? why.trim() : '';
  if (!reason) return { error: 'why is needed: say what the values are for ("To log in to Tiime as the test user")' };
  if (!Array.isArray(fields) || !fields.length) return { error: 'fields is needed: at least one { name, label, secret }' };
  if (fields.length > MAX_FIELDS) return { error: `At most ${MAX_FIELDS} fields at a time` };
  const seen = new Set();
  const asked = [];
  for (const field of fields) {
    const name = typeof field?.name === 'string' ? field.name.trim() : '';
    if (!SECRET_NAME.test(name)) return { error: `A field's name is letters, digits and _, not starting with a digit: "${name}" is not one` };
    if (seen.has(name)) return { error: `The field ${name} is asked twice` };
    seen.add(name);
    const label = typeof field.label === 'string' && field.label.trim() ? field.label.trim().slice(0, 200) : name;
    asked.push({ name, label, secret: field.secret === true });
  }
  let projectName = null;
  if (projectId != null) {
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
    if (!project) return { error: `No project ${projectId}` };
    projectName = project.name;
  }
  if (asked.some((field) => field.secret) && projectId == null) {
    return { error: 'A secret is kept in a project: pass project_id, or call start_recording with it first' };
  }

  const now = Date.now();
  const ask = {
    id: `ask-${randomBytes(6).toString('hex')}`,
    projectId, projectName, runId,
    why: reason.slice(0, 1000),
    fields: asked,
    status: 'pending',
    createdAt: now,
    expiresAt: now + timeoutMs(),
    answer: null,
    waiters: new Set(),
  };
  ask.timer = setTimeout(() => finish(ask, 'expired'), timeoutMs());
  ask.timer.unref?.();
  asks.set(ask.id, ask);
  log(`Ask ${ask.id}${runId ? ` (run ${runId})` : ''}: ${asked.map((f) => `${f.name}${f.secret ? ' (secret)' : ''}`).join(', ')} — ${ask.why}`);
  emit({ type: 'ask', ask: describeAsk(ask) });
  return { ask };
}

function finish(ask, status, answer = null) {
  if (ask.status !== 'pending') return;
  ask.status = status;
  ask.answer = answer;
  clearTimeout(ask.timer);
  for (const wake of ask.waiters) wake();
  ask.waiters.clear();
  log(`Ask ${ask.id}: ${status}`);
  emit({ type: 'ask_done', id: ask.id, status });
  setTimeout(() => asks.delete(ask.id), KEPT_AFTER_MS).unref?.();
}

/** The questions waiting for an answer, oldest first. */
export function pendingAsks() {
  return [...asks.values()].filter((ask) => ask.status === 'pending').map(describeAsk);
}

/**
 * The person's answer: `values`, { name: value } for every field. A secret field is saved in
 * the project's secrets (its label as its description). Returns { ok } or { error }.
 */
export function answerAsk(id, values) {
  const ask = asks.get(id);
  if (!ask) return { error: `No question ${id}: it was answered, or has expired` };
  if (ask.status !== 'pending') return { error: `The question ${id} is ${ask.status} already` };
  const missing = ask.fields.filter((field) => typeof values?.[field.name] !== 'string' || !values[field.name].trim());
  if (missing.length) return { error: `Still to give: ${missing.map((field) => field.label).join(', ')}` };
  const plain = {};
  const secrets = [];
  for (const field of ask.fields) {
    if (!field.secret) {
      plain[field.name] = values[field.name].trim();
      continue;
    }
    const saved = saveSecret(ask.projectId, field.name, { value: values[field.name], description: field.label });
    if (saved?.error) return { error: saved.error };
    secrets.push(field.name);
  }
  finish(ask, 'answered', { values: plain, secrets });
  return { ok: true };
}

/** The person declines, or the run asking is over. */
export function cancelAsk(id) {
  const ask = asks.get(id);
  if (!ask) return { error: `No question ${id}` };
  finish(ask, 'cancelled');
  return { ok: true };
}

/** Every question of a dashboard run still waiting: the run is over. */
export function cancelAsksOfRun(runId) {
  if (!runId) return;
  for (const ask of asks.values()) if (ask.runId === runId) finish(ask, 'cancelled');
}

/** The question, once answered or given up, or after `ms` still waiting. */
function settled(ask, ms) {
  if (ask.status !== 'pending' || ms <= 0) return Promise.resolve(ask);
  return new Promise((resolve) => {
    const wake = () => { clearTimeout(timer); ask.waiters.delete(wake); resolve(ask); };
    const timer = setTimeout(wake, ms);
    ask.waiters.add(wake);
  });
}

/** What the agent is told of its question. */
function answerText(ask) {
  if (ask.status === 'answered') {
    const lines = ['The user answered.'];
    for (const name of ask.answer.secrets) {
      lines.push(`- ${name}: kept in the project's secrets. Type {{secret.${name}}} where it goes: IziTest types its value, you never see it.`);
    }
    for (const [name, value] of Object.entries(ask.answer.values)) lines.push(`- ${name}: ${value}`);
    return lines.join('\n');
  }
  if (ask.status === 'pending') {
    return `The user has not answered yet: the question waits in IziTest's dashboard. Call ask_user again with request_id "${ask.id}" to keep waiting (until ${new Date(ask.expiresAt).toISOString()}); do nothing else meanwhile.`;
  }
  const why = ask.status === 'expired' ? 'Nobody answered in time' : 'The user did not give these values';
  return `${why}. Stop here: close the recording window with close_window, save nothing, and end with one sentence that says what the test needs.`;
}

/**
 * ask_user, for an MCP tool and the dashboard's own agent alike: a new question, or
 * (`request_id`) one asked before, waited for `wait` ms at most. `session`: whose recording
 * gives the project, and whose run shows the question. Returns { text, isError, id, status }.
 */
export async function askUser({ why, fields, project_id, request_id } = {}, { session = null, wait = waitMs() } = {}) {
  let ask;
  if (request_id) {
    ask = asks.get(String(request_id));
    if (!ask) return { text: `No question ${request_id}: it has expired. Ask again if you still need the values.`, isError: true };
  } else {
    const projectId = project_id ?? session?.recording?.projectId ?? session?.projectId ?? null;
    const created = createAsk({ projectId, runId: session?.runId ?? null, why, fields });
    if (created.error) return { text: created.error, isError: true };
    ask = created.ask;
  }
  await settled(ask, wait);
  return { text: answerText(ask), isError: ask.status === 'cancelled' || ask.status === 'expired', id: ask.id, status: ask.status };
}

/**
 * Tells `send` the questions of a dashboard run, as they are asked and settled: those already
 * waiting first. Returns what stops it.
 */
export function followAsks(runId, send) {
  for (const ask of asks.values()) {
    if (ask.runId === runId && ask.status === 'pending') send({ type: 'ask', ask: describeAsk(ask) });
  }
  const listener = (event) => {
    const ask = event.type === 'ask' ? event.ask : asks.get(event.id);
    if ((event.type === 'ask' ? ask.run_id : ask?.runId) === runId) send(event);
  };
  listeners.add(listener);
  return () => listeners.delete(listener);
}
