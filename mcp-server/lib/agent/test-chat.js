// The conversation a test page opens with the agent about its test: repair it, change it, say
// what it does. The person asks, the agent does it with IziTest's tools in a browser the page
// shows live, and answers; then they ask again.
//
// - It is the test's: one conversation per test, kept with it (test_conversations), there again
//   when its window is opened again. "Start over" forgets it.
// - Each message is a run of the CLI agent set in Settings (Claude Code: `claude -p`, its MCP
//   config pointing at this server), which goes on in the CLI's own session (--resume): the
//   agent remembers what was said and done. Its runs all work in one browser session, kept while
//   the conversation's window is open (session.js keepRunSession): the page is where the
//   message before left it, and an action done then can still be named (fix_test_step).
// - The window closed, the agent's browser window is closed too; the conversation stays.
// - A secret's value is never kept nor sent: what is said goes through redact() (lib/secrets.js).

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';
import { db, parseJson } from '../db.js';
import { log } from '../logger.js';
import { writeAgentMcpConfig, dashboardToolName } from './cli-mcp.js';
import { cliModelArgs } from './cli-model.js';
import { keepRunSession, endRunSession } from '../session.js';
import { settleActions } from '../tools/session-scope.js';
import { followRun } from '../live.js';
import { followAsks, cancelAsksOfRun } from '../asks.js';
import { testText } from '../test-edit.js';
import { datasetLines } from '../datasets.js';
import { redact, secretLines } from '../secrets.js';
import { keywordsOf } from '../gherkin/language.js';
import { closeWindowOf } from '../run-windows.js';
import { HEADLESS_PROFILE, ensureHeadless, holdHeadless } from '../headless.js';

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3467;
// A conversation nobody wrote in for this long gives its browser window back.
const IDLE_MS = Number(process.env.IZITEST_TEST_CHAT_IDLE_MS ?? 30 * 60_000);
const MAX_MESSAGE = 8000;

// What the agent of a test works with: the browser, and the saved test. Not the tools that
// record another test, delete one, or list the tabs of the user's Chrome.
export const TEST_AGENT_TOOLS = [
  'navigate', 'click', 'fill', 'select', 'extract', 'screenshot', 'get_page_info', 'scroll', 'wait',
  'execute_js', 'keyboard', 'snapshot', 'upload_file', 'drag', 'capture_value', 'call_api', 'close_window',
  'get_test', 'get_test_as_gherkin', 'run_test', 'debug_action', 'fix_test_step', 'add_test_step', 'delete_test_step',
  'update_test_gherkin', 'add_assertion', 'set_step_optional', 'add_test_variable', 'save_test_rows', 'bind_dataset',
  'list_repairs', 'verify_repair', 'resolve_repair', 'play_business_step', 'get_project_context', 'ask_user',
];
// Claude Code's own tools the agent has no use for here: it works through IziTest's only.
const CLI_OWN_TOOLS = 'Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent';

// ─── The agent that can hold it ─────────────────────────────────────

function agentConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
  return (row && parseJson(row.value)) || { mode: 'cli', cli: { provider: 'claude', command: 'claude' } };
}

/**
 * Whether the agent set in Settings can hold a test's conversation: { available, reason? }.
 * It runs the test and changes its steps through IziTest's MCP tools, over several messages:
 * Claude Code, which the dashboard gives them to and which goes on in its own session.
 */
export function testAgent(config = agentConfig()) {
  if (config.mode === 'api') {
    return { available: false, reason: 'The agent of a test runs it and changes its steps with IziTest\'s tools, which the API agent does not have yet. Set the agent to CLI with Claude Code in Settings → AI agent.' };
  }
  const provider = config.cli?.provider || 'claude';
  if (provider !== 'claude') {
    return { available: false, reason: `The agent of a test works with Claude Code for now, not with ${provider}. Choose Claude Code in Settings → AI agent.` };
  }
  return { available: true };
}

// ─── The conversation, kept with its test ───────────────────────────

const testRow = (name) => db.prepare('SELECT id, name, project_id, updated_at FROM tests WHERE name = ?').get(name);

const conversationOf = (testId) => db.prepare('SELECT * FROM test_conversations WHERE test_id = ?').get(testId) ?? null;

function messagesOf(conversationId) {
  return db.prepare('SELECT id, role, content, activity, status, created_at FROM test_conversation_messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId).map((row) => ({ ...row, activity: parseJson(row.activity) ?? [] }));
}

function saveMessage(conversationId, role, content, { activity = null, status = null } = {}) {
  const row = db.prepare(
    'INSERT INTO test_conversation_messages (conversation_id, role, content, activity, status) VALUES (?, ?, ?, ?, ?) RETURNING id, role, content, activity, status, created_at'
  ).get(conversationId, role, redact(content), activity?.length ? JSON.stringify(redact(activity)) : null, status);
  db.prepare("UPDATE test_conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(conversationId);
  return { ...row, activity: parseJson(row.activity) ?? [] };
}

/**
 * What a test page shows of its conversation: whether the agent set can hold one, the messages
 * so far, and whether its browser session is open or the agent at work. Null: no such test.
 */
export function testConversation(testName) {
  const test = testRow(testName);
  if (!test) return null;
  const conversation = conversationOf(test.id);
  const open = live.get(test.id);
  return {
    agent: testAgent(),
    messages: conversation ? messagesOf(conversation.id) : [],
    // Its browser session, open since a message of this window: where it works, the tab to show.
    open: !!open,
    working: !!open?.child,
    headless: open ? open.session.profile === HEADLESS_PROFILE : null,
    tab_id: open?.session.lastTabId ?? null,
  };
}

/** Stop: the agent at work on a message is stopped, what it said so far kept as its answer. */
export function stopTestAgent(testName) {
  const test = testRow(testName);
  const entry = test && live.get(test.id);
  if (!entry?.child) return false;
  stopChild(entry);
  return true;
}

/** Start over: the conversation is forgotten, its browser session closed. False: no such test. */
export async function forgetTestConversation(testName, { sendCommand }) {
  const test = testRow(testName);
  if (!test) return false;
  await closeTestConversation(testName, { sendCommand });
  db.prepare('DELETE FROM test_conversations WHERE test_id = ?').run(test.id);
  return true;
}

// ─── Its browser session, while its window is open ──────────────────

// test id → { runId, session, release, child, lastUsedAt }
const live = new Map();

function openLive(test, { headless }) {
  const existing = live.get(test.id);
  if (existing) return existing;
  const runId = `run-${randomBytes(6).toString('hex')}`;
  const session = keepRunSession(runId, { label: `test agent: ${test.name}` });
  // Its project: where a secret asked with ask_user is kept, what {{secret.NAME}} means.
  session.projectId = test.project_id ?? null;
  session.resetValues({ projectId: session.projectId });
  // Out of sight, in the Chrome without windows: every command of the session goes there.
  let release = () => {};
  if (headless) {
    session.profile = HEADLESS_PROFILE;
    release = holdHeadless();
  }
  const entry = { testId: test.id, runId, session, release, child: null, lastUsedAt: Date.now() };
  live.set(test.id, entry);
  return entry;
}

/**
 * The conversation's window was closed: the agent is stopped if it works, the browser window
 * it worked in closed — once what it was doing there is over, a run cut short would be kept as
 * failed —, its session ended. The conversation itself stays. True when there was one open.
 */
export async function closeTestConversation(testName, { sendCommand }) {
  const test = testRow(testName);
  const entry = test && live.get(test.id);
  if (!entry) return false;
  live.delete(test.id);
  stopChild(entry);
  cancelAsksOfRun(entry.runId);
  const { session } = entry;
  try {
    await settleActions(session, 60_000);
    if (session.lastTabId !== undefined) {
      await closeWindowOf((_profile, ...rest) => sendCommand(session.profile, ...rest), session.lastTabId);
    }
  } finally {
    endRunSession(entry.runId);
    entry.release();
  }
  log(`[Test agent] conversation of test ${test.id} closed`);
  return true;
}

function stopChild(entry) {
  const child = entry.child;
  if (!child || child.exitCode != null) return;
  entry.stopped = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}

/** The conversations nobody wrote in for IDLE_MS give their browser window back. */
export async function closeIdleTestConversations({ sendCommand, now = Date.now(), idleMs = IDLE_MS } = {}) {
  for (const entry of [...live.values()]) {
    if (entry.child || now - entry.lastUsedAt < idleMs) continue;
    const test = db.prepare('SELECT name FROM tests WHERE id = ?').get(entry.testId);
    if (test) await closeTestConversation(test.name, { sendCommand }).catch((err) => log(`[Test agent] idle close failed: ${err.message}`));
    else { live.delete(entry.testId); endRunSession(entry.runId); entry.release(); }
  }
}

// ─── What the agent is told ─────────────────────────────────────────

/** The brief the agent starts a test's conversation with: the test, its app, what it may do. */
export function testAgentBrief(test) {
  const project = test.project_id ? db.prepare('SELECT id, name, base_url, context, language FROM projects WHERE id = ?').get(test.project_id) : null;
  const app = [];
  if (project) {
    app.push(`The app under test is the project "${project.name}" (project_id ${project.id}).`);
    app.push(`Its tests are written in ${keywordsOf(project.language).name}: a step's intent, a check's description and Gherkin are written in ${keywordsOf(project.language).name}.`);
    if (project.base_url) app.push(`It is at ${project.base_url}.`);
    if (project.context?.trim()) app.push('What to know about it:', project.context.trim());
    const datasets = datasetLines(project.id);
    if (datasets.length) app.push('Its datasets, tables of values to test with (rows numbered from 1; {{users[1].email}} is a value of one):', ...datasets);
    const secrets = secretLines(project.id);
    if (secrets.length) app.push('Its secrets (you are told their names, never their values):', ...secrets);
  } else {
    app.push('The test belongs to no project: it has no Gherkin, no secrets and no datasets.');
  }

  return redact(`You are IziTest's agent, working with a tester on ONE saved browser test, in a conversation: they ask, you do it with your tools and answer; they read your answer, then may ask again. They watch your browser live beside the conversation.

THE TEST, AS IT IS NOW
${testText(test.name)}

THE APP
${app.join('\n')}

WHAT YOU CAN DO
- Read the test: get_test (its steps, numbered, and its last run), get_test_as_gherkin (how it reads).
- See it run: run_test(name: "${test.name}"). It plays in its own window. When a step fails, that window stays on the page where it failed, and your next browser tool acts there.
- Repair a step that fails: on that page, snapshot, do that step by hand with the matching browser tool (a click for a click, a fill for a fill), then fix_test_step(test_name, step_order, action_id) with the action_id that tool returned, and go on with run_test(start_step: the next one). A repair a failed run proposed: list_repairs, verify_repair, resolve_repair.
- Change the test: add a step — bring the page where the step goes (run_test stops where it fails; or do the steps before by hand), do the action, then add_test_step(test_name, action_id, step_order, intent); delete a step — delete_test_step; add a check — add_assertion(test_name, step_order) on the page as it is at that step; a step the app needs only sometimes (a cookie banner) — set_step_optional; a value to vary — add_test_variable; a value in a phrase, the order of its phrases — update_test_gherkin.
- After a change, run the test whole once and say whether it passes.

RULES
1. This test only: never record another one, never delete it.
2. Read the test before changing it, and again after a step was added or deleted: the numbers move.
3. A test checks the app. Never remove or weaken a check to make a failing test pass. When the app itself is wrong — the page shows an error, or something else than what the test rightly expects — change nothing: say what the app does, and that it looks like a defect of the app to report.
4. When the request is clear ("repair it", "add a check that the total is shown"), do it without asking back. Ask first — one short question, then stop: their answer is the next message — only when the request reads two ways, or before deleting steps or changing what the test checks when they did not ask for it.
5. A password, a key or a code is never typed in plain and never asked in your answer. Type {{secret.NAME}} where one goes: IziTest types its value. One that is missing, or any value nobody gave (an account to log in with): ask_user — they answer in a form beside the conversation.
6. snapshot to find an element before acting on it. A ref (@e5) from an earlier message may be gone: snapshot again.
7. Answer in the language of their message, in a few plain sentences: what you did, what the test does now, whether it passes, what is left for them to decide. They are a tester, not a developer: no selector, no tool name, no JSON unless they ask. Name a step by its number and what it does.`);
}

/** What happened to the test since the agent last answered, told before the next message. */
function sinceLastAnswer(test, conversation) {
  const notes = [];
  if (conversation.seen_name && conversation.seen_name !== test.name) notes.push(`the test was renamed: it is now "${test.name}"`);
  if (conversation.seen_updated_at && conversation.seen_updated_at !== test.updated_at) notes.push('the test was changed in the dashboard since your last answer: read it again with get_test before acting');
  return notes.length ? `[IziTest: ${notes.join('; ')}.]\n\n` : '';
}

/** The conversation so far, for an agent that starts afresh (its CLI session is gone). */
function historyText(messages) {
  const lines = messages.slice(-20).map((m) => `${m.role === 'user' ? 'Tester' : 'You'}: ${m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content}`);
  return lines.length ? `\n\nTHE CONVERSATION SO FAR\n${lines.join('\n\n')}` : '';
}

// ─── What it does, in plain words ───────────────────────────────────

const short = (value, max = 90) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const stepOf = (input) => (input?.step_order ? ` ${input.step_order}` : '');
const said = (input) => short(input?.intent || input?.description || input?.phrase || input?.text || '');

const ACTIVITY = {
  get_test: () => 'Reads the test',
  get_test_as_gherkin: () => 'Reads the test\'s scenario',
  get_project_context: () => 'Reads the project',
  run_test: (i) => (i?.start_step ? `Runs the test from step ${i.start_step}` : 'Runs the test'),
  debug_action: () => 'Plays the next step',
  fix_test_step: (i) => `Repairs step${stepOf(i)}`,
  add_test_step: (i) => `Adds a step${i?.step_order ? ` at ${i.step_order}` : ' at the end'}${i?.intent ? `: ${short(i.intent)}` : ''}`,
  delete_test_step: (i) => `Deletes step${stepOf(i)}`,
  update_test_gherkin: () => 'Rewrites the scenario',
  add_assertion: (i) => `Adds a check${i?.description ? `: ${short(i.description)}` : ''}`,
  set_step_optional: (i) => (i?.optional === false ? `Makes step${stepOf(i)} required` : `Makes step${stepOf(i)} optional`),
  add_test_variable: (i) => `Adds the variable ${i?.name ? `{{${i.name}}}` : ''}`.trim(),
  save_test_rows: () => 'Saves the test\'s rows',
  bind_dataset: () => 'Binds the test to a dataset',
  list_repairs: () => 'Reads the repairs proposed',
  verify_repair: (i) => `Checks repair #${i?.repair_id ?? ''}`.trim(),
  resolve_repair: (i) => `${i?.decision === 'reject' ? 'Rejects' : 'Applies'} repair #${i?.repair_id ?? ''}`.trim(),
  play_business_step: (i) => `Plays: ${short(i?.phrase)}`,
  ask_user: () => 'Asks you for a value',
  navigate: (i) => `Opens ${short(i?.url, 70)}`,
  click: (i) => `Clicks${said(i) ? `: ${said(i)}` : ''}`,
  // Never the value typed: it may be a password.
  fill: (i) => `Types${i?.intent ? `: ${short(i.intent)}` : ''}`,
  select: (i) => `Picks an option${i?.intent ? `: ${short(i.intent)}` : ''}`,
  keyboard: (i) => `Presses ${short(i?.key, 20)}`,
  snapshot: () => 'Looks at the page',
  screenshot: () => 'Looks at the page',
  extract: () => 'Reads the page',
  get_page_info: () => 'Reads the page',
  execute_js: () => 'Reads the page',
  scroll: () => 'Scrolls',
  wait: () => 'Waits',
  upload_file: () => 'Chooses a file',
  drag: () => 'Drags an element',
  capture_value: (i) => `Keeps a value${i?.name ? ` as {{${i.name}}}` : ''}`,
  call_api: () => 'Calls the app\'s API',
  close_window: () => 'Closes its window',
};

/**
 * A line of what the agent does, for a tool it calls: what a tester reads, not the tool's name.
 * Null for a tool of the CLI's own (the search that loads its tools): nothing the tester follows.
 */
export function activityLine(tool, input) {
  const name = String(tool ?? '').split('__').pop();
  if (ACTIVITY[name]) return ACTIVITY[name](input ?? {});
  return String(tool ?? '').startsWith('mcp__') ? name : null;
}

// ─── A message, and the agent's answer ──────────────────────────────

/**
 * One message of a test's conversation: kept, sent to the agent, its answer streamed to `send`
 * as it works —
 *   { type: 'user', message }       the message as kept
 *   { type: 'live', tabId }         the tab it works in (LiveScreen)
 *   { type: 'activity', line }      what it does, a line per tool; `said`: what it said before
 *                                   acting, which stops being its answer
 *   { type: 'text', text }          what it says
 *   { type: 'ask', ask } / { type: 'ask_done', id }   a value it asks for (lib/asks.js)
 *   { type: 'done', status, message, changed }        its answer as kept; changed: the test is not as it was
 * — and resolves once it is over. `signal` aborted (the page went away, or Stop): the agent is
 * stopped, what it said so far kept. Throws { status, message } when it cannot start.
 */
export async function sendTestMessage(testName, text, { headless = false, send, signal, spawnCli = spawn } = {}) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const message = typeof text === 'string' ? text.trim() : '';
  if (!message) throw fail(400, 'message is required');
  if (message.length > MAX_MESSAGE) throw fail(400, `A message is ${MAX_MESSAGE} characters at most`);
  const test = testRow(testName);
  if (!test) throw fail(404, 'Test not found');
  const config = agentConfig();
  const agent = testAgent(config);
  if (!agent.available) throw fail(409, agent.reason);
  if (live.get(test.id)?.child) throw fail(409, 'The agent is still working on the message before: wait for its answer, or stop it');

  let conversation = conversationOf(test.id)
    ?? db.prepare('INSERT INTO test_conversations (test_id) VALUES (?) RETURNING *').get(test.id);
  const before = messagesOf(conversation.id);
  const emit = (event) => { try { send(redact(event)); } catch { /* the page went away */ } };
  emit({ type: 'user', message: saveMessage(conversation.id, 'user', message) });

  const entry = openLive(test, { headless });
  entry.lastUsedAt = Date.now();
  entry.stopped = false;
  if (entry.session.profile === HEADLESS_PROFILE) await ensureHeadless();

  const stopTab = followRun(entry.runId, (tabId) => emit({ type: 'live', tabId }));
  const stopAsks = followAsks(entry.runId, emit);
  const onAbort = () => stopChild(entry);
  signal?.addEventListener('abort', onAbort, { once: true });

  // What was typed goes to the agent with a secret's value put back as its reference.
  const asked = redact(message);
  let turn;
  try {
    const resumed = !!conversation.cli_session_id;
    turn = await cliTurn({
      prompt: resumed ? `${sinceLastAnswer(test, conversation)}${asked}` : `${testAgentBrief(test)}${historyText(before)}\n\nTHE TESTER'S MESSAGE\n${asked}`,
      resume: conversation.cli_session_id, config, entry, emit, spawnCli,
    });
    // Its CLI session is gone (another machine, cleaned up): started afresh, told what was said.
    if (resumed && turn.failed && !turn.text && !turn.activity.length && !entry.stopped && /session|conversation/i.test(turn.error ?? '')) {
      log(`[Test agent] the CLI session of test ${test.id} could not be resumed: starting afresh`);
      turn = await cliTurn({
        prompt: `${testAgentBrief(test)}${historyText(before)}\n\nTHE TESTER'S MESSAGE\n${asked}`,
        resume: null, config, entry, emit, spawnCli,
      });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stopTab();
    stopAsks();
    cancelAsksOfRun(entry.runId);
    entry.child = null;
    entry.lastUsedAt = Date.now();
  }

  const status = entry.stopped && !turn.finished ? 'stopped' : turn.failed ? 'error' : 'done';
  const content = turn.text || (status === 'stopped' ? '' : status === 'error' ? (turn.error || 'The agent stopped without an answer.') : 'Done.');
  // The test may have been renamed by nobody but the dashboard: read by its id.
  const after = db.prepare('SELECT name, updated_at FROM tests WHERE id = ?').get(test.id);
  db.prepare('UPDATE test_conversations SET cli_session_id = ?, seen_updated_at = ?, seen_name = ? WHERE id = ?')
    .run(turn.sessionId ?? (turn.failed ? null : conversation.cli_session_id), after?.updated_at ?? null, after?.name ?? null, conversation.id);
  const answer = saveMessage(conversation.id, 'assistant', content, { activity: turn.activity, status });
  log(`[Test agent] test ${test.id}: ${status}, ${turn.activity.length} action(s), ${content.length} chars`);
  emit({ type: 'done', status, message: answer, changed: !after || after.updated_at !== test.updated_at, ...(status === 'error' && turn.error ? { error: turn.error } : {}) });
  return { status, message: answer };
}

/** One run of Claude Code for a message: { text, activity, sessionId, failed, error }. */
function cliTurn({ prompt, resume, config, entry, emit, spawnCli }) {
  const cli = config.cli ?? {};
  const command = (cli.command || 'claude').trim().split(/\s+/)[0];
  const mcpConfig = writeAgentMcpConfig({ port: MCP_PORT, runId: entry.runId, prefix: 'bp-test-agent' });
  const args = [
    '-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--allowedTools', TEST_AGENT_TOOLS.map(dashboardToolName).join(','),
    '--disallowedTools', CLI_OWN_TOOLS,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    ...(resume ? ['--resume', resume] : []),
    ...cliModelArgs(cli),
  ];

  return new Promise((resolve) => {
    const turn = { text: '', activity: [], sessionId: null, failed: false, error: null, finished: false };
    let child;
    const end = () => {
      try { unlinkSync(mcpConfig); } catch { /* removed already */ }
      resolve(turn);
    };
    try {
      child = spawnCli(command, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      turn.failed = true;
      turn.error = `The agent did not start: ${err.message}`;
      return end();
    }
    entry.child = child;
    log(`[Test agent] ${command} started for run ${entry.runId}${resume ? ' (session resumed)' : ''}, prompt ${prompt.length} chars`);

    let buffer = '';
    let stderr = '';
    const read = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.session_id) turn.sessionId = event.session_id;
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            turn.text += (turn.text ? '\n\n' : '') + block.text.trim();
            emit({ type: 'text', text: block.text.trim() });
          } else if (block.type === 'tool_use') {
            const line = activityLine(block.name, block.input);
            if (line === null) continue;
            // What it said before acting was a word on what it does, not its answer: kept with
            // what it did. Its answer is what it says once it has nothing more to do.
            if (turn.text) {
              const aside = `“${short(redact(turn.text), 300)}”`;
              turn.activity.push(aside);
              turn.text = '';
              emit({ type: 'activity', line: aside, said: true });
            }
            turn.activity.push(redact(line));
            emit({ type: 'activity', line });
          }
        }
      } else if (event.type === 'result') {
        // It was done: a Stop that comes after its answer stops nothing.
        turn.finished = true;
        if (event.is_error) {
          turn.failed = true;
          turn.error = short(event.result ?? event.subtype ?? 'The agent failed', 400);
        } else if (typeof event.result === 'string' && event.result.trim() && !turn.text) {
          // Its answer, when no message carried it.
          turn.text = event.result.trim();
          emit({ type: 'text', text: turn.text });
        }
      }
    };
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) read(line);
    });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on('error', (err) => {
      turn.failed = true;
      turn.error = `The agent did not start: ${err.message}`;
      end();
    });
    child.on('close', (code) => {
      if (buffer.trim()) read(buffer);
      if (code !== 0 && !entry.stopped && !turn.finished) {
        turn.failed = true;
        turn.error ??= short(redact(stderr.trim().split('\n').pop() || `The agent exited with code ${code}`), 400);
      }
      end();
    });
  });
}
