// A saved test changed with the agent, from its page: a conversation the test keeps, each message
// a run of the CLI agent that goes on in its session, all its runs working in one browser session.
// And what the agent lacked to change a saved test: read it (get_test), add a step to it
// (add_test_step), delete one (delete_test_step), rewrite its Gherkin (update_test_gherkin).
// The extension and the CLI are stand-ins; on a database of its own.
// Run with: node --test test/test-agent.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'test-agent-')), 'test.db');
process.env.IZITEST_ASSERT_TIMEOUT_MS = '0';
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { saveTest, loadTest, deleteTest } = await import('../lib/test-store.js');
const { testText, addTestStep, deleteTestStep, updateTestFeature } = await import('../lib/test-edit.js');
const { seedProjectStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { serializeTestToFeature } = await import('../lib/gherkin/serialize.js');
const { saveSecret } = await import('../lib/secrets.js');
const { registerBrowserTools } = await import('../lib/tools/browser.js');
const { registerTestTools } = await import('../lib/tools/test.js');
const { scopeToolsToSession } = await import('../lib/tools/session-scope.js');
const { resolveSession, dropConnection, setConnectionRun, keepRunSession, endRunSession, listSessions } = await import('../lib/session.js');
const {
  testAgent, testAgentBrief, testConversation, sendTestMessage, stopTestAgent, closeTestConversation, forgetTestConversation,
  closeIdleTestConversations, activityLine, TEST_AGENT_TOOLS,
} = await import('../lib/agent/test-chat.js');

const project = db.prepare("INSERT INTO projects (name, base_url) VALUES ('Shop', 'https://shop.test') RETURNING id").get().id;
seedProjectStepDefinitions(project);
const PASSWORD = 'S3cret-of-the-shop';
saveSecret(project, 'SHOP_PASSWORD', { value: PASSWORD, description: 'Password of the test account' });

const login = (name) => {
  saveTest({
    name,
    description: 'A customer logs in',
    variables: { email: { type: 'text', defaultValue: 'bob@shop.test', step: 2 } },
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test/login' }, intent: 'Open the login page', page: 'https://shop.test/login' },
      { command: 'fill', params: { selector: '#email', value: '{{email}}' }, intent: 'Type the email', variable: { name: 'email', type: 'text', defaultValue: 'bob@shop.test' }, locators: [{ type: 'css', value: '#email' }], page: 'https://shop.test/login' },
      { command: 'click', params: { selector: '#submit' }, intent: 'Log in', locators: [{ type: 'css', value: '#submit' }, { type: 'role', value: 'button', name: 'Log in' }], page: 'https://shop.test/login' },
      { command: 'assert', params: {}, intent: 'The page greets', assertion: { type: 'text_contains', selector: 'h1', expected: 'Welcome' }, page: 'https://shop.test/account' },
    ],
  });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
};

// ─── The tools to read and change a saved test ──────────────────────

test('get_test: the test as it is, its steps numbered, its variables and its last run', () => {
  login('read me');
  const id = db.prepare("SELECT id FROM tests WHERE name = 'read me'").get().id;
  const text = testText('read me');
  assert.match(text, /^Test "read me" — project "Shop" \(project_id \d+\) — 4 steps/);
  assert.match(text, / {2}1\. navigate · "Open the login page" · url https:\/\/shop\.test\/login/);
  assert.match(text, / {2}2\. fill · "Type the email" · on .*#email.* · value "\{\{email\}\}" · variable \{\{email\}\}/);
  assert.match(text, / {2}4\. assert · "The page greets" · text_contains on h1 expects "Welcome"/);
  assert.match(text, /Variables:\n {2}\{\{email\}\} — text, default "bob@shop\.test"/);
  assert.match(text, /Last run: never run\./);

  const run = db.prepare("INSERT INTO test_executions (test_id, test_name, status) VALUES (?, 'read me', 'failed') RETURNING id").get(id).id;
  db.prepare("INSERT INTO execution_steps (execution_id, step_order, command, status, error) VALUES (?, 3, 'click', 'failed', 'Element not found: #submit')").run(run);
  assert.match(testText('read me'), /Last run: failed \(run #\d+, .*\) — step 3 \(click\) failed: Element not found: #submit/);
  assert.equal(testText('no such test'), null);
});

test('a step added in the middle and one deleted: the others move, the variables\' steps with them', () => {
  login('edit me');
  assert.deepEqual(addTestStep('edit me', 2, { command: 'click', params: { selector: '#cookies' }, intent: 'Accept the cookies', optional: true }), { order: 2, count: 5 });
  let saved = loadTest('edit me');
  assert.deepEqual(saved.steps.map((s) => s.intent), ['Open the login page', 'Accept the cookies', 'Type the email', 'Log in', 'The page greets']);
  assert.equal(saved.steps[1].optional, true);
  assert.equal(saved.variables.email.step, 3, 'told by the step that moved down');
  assert.deepEqual(addTestStep('edit me', undefined, { command: 'click', params: { selector: '#logout' }, intent: 'Log out' }), { order: 6, count: 6 }, 'at the end by default');
  assert.equal(addTestStep('no such test', 1, { command: 'click', params: {} }), null);

  assert.deepEqual(deleteTestStep('edit me', 2), { command: 'click', intent: 'Accept the cookies' });
  saved = loadTest('edit me');
  assert.deepEqual(saved.steps.map((s) => s.intent), ['Open the login page', 'Type the email', 'Log in', 'The page greets', 'Log out']);
  assert.equal(saved.variables.email.step, 2);
  assert.deepEqual(saved.steps[2].locators.map((l) => l.type), ['css', 'role'], 'the others are as they were');
  assert.equal(deleteTestStep('edit me', 9), null);
  assert.equal(deleteTestStep('no such test', 1), null);
});

test('its Gherkin rewritten: a phrase left as it was keeps its step, one that does not read is refused and nothing is saved', () => {
  login('reword me');
  const feature = serializeTestToFeature(loadTest('reword me'), project);
  const lines = feature.split('\n');
  const greets = lines.findIndex((line) => /Welcome/.test(line));
  assert.ok(greets > 0, feature);

  // The check goes: the three steps before it are as recorded.
  const without = lines.filter((_, i) => i !== greets).join('\n');
  assert.deepEqual(updateTestFeature('reword me', without), { step_count: 3, row_count: 0 });
  const saved = loadTest('reword me');
  assert.deepEqual(saved.steps.map((s) => s.command), ['navigate', 'fill', 'click']);
  assert.deepEqual(saved.steps[2].locators.map((l) => l.type), ['css', 'role'], 'the click keeps how its element is found');
  assert.equal(saved.steps[1].variable.name, 'email');

  const unread = updateTestFeature('reword me', `${without}\n    Then the moon is made of cheese\n`);
  assert.equal(unread.status, 422);
  assert.match(unread.error, /no step definition matches/);
  assert.equal(loadTest('reword me').steps.length, 3, 'nothing saved');
  assert.equal(updateTestFeature('no such test', without).status, 404);
});

test('the tools an agent has: the action it just did becomes a step at its place, a step is deleted, the test is read', async () => {
  login('by tools');
  const sendCommand = async (_profile, command, params) => {
    if (command === 'click') return { clicked: true, pageUrl: 'https://shop.test/login', target: { selector: params.selector, locators: [{ type: 'css', value: params.selector }] } };
    return {};
  };
  const connectionId = 'test-agent-tools';
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, { sendCommand, getProfiles: () => new Map() });
  registerTestTools(server, { sendCommand });
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
  try {
    const clicked = await call('click', { selector: '#remember-me', tabId: 7 });
    const actionId = /\((act_\d+)\)/.exec(clicked)?.[1];
    assert.ok(actionId, clicked);
    assert.match(await call('add_test_step', { test_name: 'by tools', action_id: actionId, step_order: 3, intent: 'Tick "Remember me"' }),
      /Step 3 of "by tools" added \(click: Tick "Remember me"\): the test has 5 steps\. The steps that were 3 to 4 are now 4 to 5\./);
    const added = loadTest('by tools').steps[2];
    assert.equal(added.intent, 'Tick "Remember me"');
    assert.deepEqual(added.params, { selector: '#remember-me' }, 'not the tab it was done in');
    assert.equal(added.page, 'shop.test/login', 'the page it was done on');

    assert.match(await call('get_test', { name: 'by tools' }), / {2}3\. click · "Tick "Remember me"" · on .*#remember-me/);
    assert.match(await call('add_test_step', { test_name: 'by tools', action_id: 'act_0' }), /Action ID "act_0" not found/);
    assert.match(await call('delete_test_step', { test_name: 'by tools', step_order: 3 }), /Step 3 of "by tools" deleted \(click: Tick "Remember me"\)/);
    assert.equal(loadTest('by tools').steps.length, 4);
    assert.match(await call('delete_test_step', { test_name: 'by tools', step_order: 12 }), /No step 12 in test "by tools"/);
    assert.match(await call('update_test_gherkin', { test_name: 'by tools', gherkin: 'Feature: x\n\n  Scenario: x\n    Then the moon is made of cheese\n' }), /^Not saved: .*no step definition matches/s);
    assert.match(await call('get_test', { name: 'nope' }), /Test "nope" not found/);
  } finally {
    await client.close();
    dropConnection(connectionId);
  }
});

test('a run that fails leaves the session on the page where it failed: the next action is done there', async () => {
  login('fails at 3');
  const sent = [];
  const sendCommand = async (_profile, command, params) => {
    sent.push([command, params?.tabId ?? null]);
    if (command !== 'replay_sequence') return {};
    return { results: params.steps.map((s, i) => (i < 2
      ? { step: i + 1, command: s.command, status: 'success', tabId: 31 }
      : { step: i + 1, command: s.command, status: 'failed', error: 'Element not found: #submit', tabId: 31 })).slice(0, 3) };
  };
  const connectionId = 'test-agent-failed-run';
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, { sendCommand, getProfiles: () => new Map() });
  registerTestTools(server, { sendCommand });
  unscope();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.equal(resolveSession(connectionId).lastTabId, undefined);
    const ran = (await client.callTool({ name: 'run_test', arguments: { name: 'fails at 3' } })).content[0].text;
    assert.match(ran, /TEST EXECUTION FAILED[\s\S]*Step number: 3\/4/);
    assert.equal(resolveSession(connectionId).lastTabId, 31, 'the page it failed on');
    sent.length = 0;
    await client.callTool({ name: 'click', arguments: { selector: '#sign-in' } });
    assert.deepEqual(sent.find(([command]) => command === 'click'), ['click', 31]);
  } finally {
    await client.close();
    dropConnection(connectionId);
  }
});

// ─── One browser session for a conversation ─────────────────────────

test('the connections opened for a run that keeps a session all work in it; one that ends leaves it', () => {
  const runId = 'run-0123456789ab';
  const kept = keepRunSession(runId, { label: 'test agent: x' });
  kept.adoptTab(42, 9);
  setConnectionRun('conn-1', runId);
  setConnectionRun('conn-2', runId);
  assert.equal(resolveSession('conn-1'), kept);
  const actionId = resolveSession('conn-1').putAction({ command: 'click', params: {} });
  assert.equal(dropConnection('conn-1'), null, 'not the connection\'s to end');
  assert.equal(resolveSession('conn-2'), kept, 'the next message\'s connection');
  assert.equal(resolveSession('conn-2').lastTabId, 42, 'the page is where the message before left it');
  assert.ok(resolveSession('conn-2').getAction(actionId), 'an action done then can still be named');
  assert.equal(kept.client.name, 'dashboard');
  // A connection opened for no run, or another, has its own.
  assert.notEqual(resolveSession('conn-3'), kept);
  dropConnection('conn-3');
  dropConnection('conn-2');
  assert.equal(endRunSession(runId), kept);
  assert.equal(listSessions().includes(kept), false);
  assert.notEqual(resolveSession('conn-2'), kept, 'over: a connection for that run gets a session of its own');
  dropConnection('conn-2');
  assert.equal(endRunSession(runId), null);
});

// ─── The conversation ───────────────────────────────────────────────

/**
 * Claude Code, as a stand-in: each run says what `script(args, n)` returns — stream-json events
 * — then exits; `hang: true` waits to be stopped. Its runs are kept in `runs` ({ args, prompt }).
 */
function fakeCli(script) {
  const runs = [];
  const spawnCli = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    const exit = (code) => { if (child.exitCode == null) { child.exitCode = code; child.emit('close', code); } };
    child.kill = () => { exit(143); };
    const prompt = args[args.indexOf('-p') + 1];
    const mcpConfig = args[args.indexOf('--mcp-config') + 1];
    runs.push({ command, args, prompt, mcp: JSON.parse(readFileSync(mcpConfig, 'utf8')), mcpConfig });
    const said = script(args, runs.length) ?? {};
    setImmediate(() => {
      for (const event of said.events ?? []) child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
      if (said.stderr) child.stderr.emit('data', Buffer.from(said.stderr));
      if (!said.hang) exit(said.code ?? 0);
    });
    return child;
  };
  return { spawnCli, runs };
}

const says = (sessionId, ...blocks) => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  ...blocks.map((content) => ({ type: 'assistant', session_id: sessionId, message: { content } })),
  { type: 'result', session_id: sessionId, is_error: false, result: blocks.at(-1)?.findLast?.((b) => b.type === 'text')?.text ?? '' },
];
const noBrowser = async () => ({});

test('the agent that can hold it: Claude Code, not the API agent nor another CLI', () => {
  assert.deepEqual(testAgent({ mode: 'cli', cli: { provider: 'claude' } }), { available: true });
  assert.match(testAgent({ mode: 'api', api: {} }).reason, /API agent does not have yet.*Settings → AI agent/);
  assert.match(testAgent({ mode: 'cli', cli: { provider: 'gemini' } }).reason, /Claude Code for now, not with gemini/);
  // Its tools: the browser and the saved test — never another recording, a test deleted, the user's tabs.
  for (const name of ['get_test', 'run_test', 'fix_test_step', 'add_test_step', 'delete_test_step', 'update_test_gherkin', 'add_assertion', 'ask_user', 'snapshot']) assert.ok(TEST_AGENT_TOOLS.includes(name), name);
  for (const name of ['start_recording', 'stop_recording', 'delete_test', 'get_tabs', 'run_campaign']) assert.equal(TEST_AGENT_TOOLS.includes(name), false, name);
});

test('what the agent does, as a tester reads it: never a tool\'s name, never a value typed', () => {
  assert.equal(activityLine('mcp__izitest-dashboard__run_test', { name: 't', start_step: 4 }), 'Runs the test from step 4');
  assert.equal(activityLine('mcp__izitest-dashboard__fix_test_step', { step_order: 3 }), 'Repairs step 3');
  assert.equal(activityLine('mcp__izitest-dashboard__fill', { value: PASSWORD, intent: 'Type the password' }), 'Types: Type the password');
  assert.equal(activityLine('fill', { value: PASSWORD }), 'Types');
  assert.equal(activityLine('mcp__izitest-dashboard__snapshot', {}), 'Looks at the page');
  assert.equal(activityLine('mcp__izitest-dashboard__some_new_tool', {}), 'some_new_tool');
  assert.equal(activityLine('ToolSearch', { query: 'select:…' }), null, 'a tool of the CLI\'s own: nothing the tester follows');
});

test('a message, the agent\'s answer, then another: kept with the test, the second in the same CLI session and browser session', async () => {
  login('talk to me');
  assert.deepEqual(testConversation('talk to me'), { agent: { available: true }, messages: [], open: false, working: false, headless: null, tab_id: null });
  assert.equal(testConversation('no such test'), null);

  const { spawnCli, runs } = fakeCli((args, n) => (n === 1
    ? { events: says('cli-session-1',
      [{ type: 'tool_use', name: 'mcp__izitest-dashboard__run_test', input: { name: 'talk to me' } }],
      [{ type: 'tool_use', name: 'mcp__izitest-dashboard__fix_test_step', input: { step_order: 3 } }, { type: 'text', text: 'Step 3 is repaired: the test passes.' }]) }
    : { events: says('cli-session-1', [{ type: 'text', text: 'It checks the greeting.' }]) }));

  const events = [];
  const first = await sendTestMessage('talk to me', `  Repair it, the password is ${PASSWORD}  `, { send: (e) => events.push(e), spawnCli });
  assert.equal(first.status, 'done');
  assert.deepEqual(events.map((e) => e.type), ['user', 'activity', 'activity', 'text', 'done']);
  assert.deepEqual(events.filter((e) => e.type === 'activity').map((e) => e.line), ['Runs the test', 'Repairs step 3']);
  assert.equal(events.at(-1).message.content, 'Step 3 is repaired: the test passes.');
  assert.equal(events.at(-1).changed, false, 'the stand-in changed nothing');

  // What the CLI was started with: the brief and the message, IziTest's tools only, the run's MCP config.
  const [run] = runs;
  assert.match(run.prompt, /THE TEST, AS IT IS NOW\nTest "talk to me" — project "Shop"/);
  assert.match(run.prompt, / {2}3\. click · "Log in"/);
  assert.match(run.prompt, /It is at https:\/\/shop\.test\./);
  assert.match(run.prompt, /- SHOP_PASSWORD: Password of the test account/);
  assert.match(run.prompt, /THE TESTER'S MESSAGE\nRepair it, the password is \{\{secret\.SHOP_PASSWORD\}\}$/);
  assert.equal(run.prompt.includes(PASSWORD), false, 'a secret typed in a message never reaches the agent');
  assert.equal(run.args.includes('--resume'), false);
  assert.match(run.args[run.args.indexOf('--allowedTools') + 1], /mcp__izitest-dashboard__get_test,/);
  assert.match(run.args[run.args.indexOf('--disallowedTools') + 1], /Bash/);
  assert.match(run.mcp.mcpServers['izitest-dashboard'].url, /\/sse\?run=run-[0-9a-f]{12}$/);
  assert.equal(existsSync(run.mcpConfig), false, 'its MCP config, which holds the token, is removed');

  // Kept: the message with the reference, the answer with what was done.
  let kept = testConversation('talk to me');
  assert.deepEqual(kept.messages.map((m) => [m.role, m.content, m.activity, m.status]), [
    ['user', 'Repair it, the password is {{secret.SHOP_PASSWORD}}', [], null],
    ['assistant', 'Step 3 is repaired: the test passes.', ['Runs the test', 'Repairs step 3'], 'done'],
  ]);
  assert.equal(kept.open, true);
  assert.equal(kept.working, false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM test_conversation_messages').all()).includes(PASSWORD), false);
  const runId = /run=(run-[0-9a-f]{12})/.exec(run.mcp.mcpServers['izitest-dashboard'].url)[1];
  setConnectionRun('cli-1', runId);
  const session = resolveSession('cli-1');
  assert.equal(session.label, 'test agent: talk to me');
  assert.equal(session.projectId, project, 'where a secret it asks for is kept');
  session.adoptTab(77, 5);
  dropConnection('cli-1');

  // The second message: the CLI's session resumed, the same run — so the same browser session.
  await sendTestMessage('talk to me', 'What does it check?', { send: (e) => events.push(e), spawnCli });
  assert.equal(runs[1].prompt, 'What does it check?', 'the agent remembers the rest');
  assert.equal(runs[1].args[runs[1].args.indexOf('--resume') + 1], 'cli-session-1');
  assert.equal(runs[1].mcp.mcpServers['izitest-dashboard'].url.includes(runId), true);
  kept = testConversation('talk to me');
  assert.equal(kept.messages.length, 4);
  assert.equal(kept.tab_id, 77, 'the tab the page shows when its window opens again');

  // The test changed in the dashboard meanwhile: the agent is told before the next message.
  db.prepare("UPDATE tests SET updated_at = '2030-01-01T00:00:00.000Z' WHERE name = 'talk to me'").run();
  await sendTestMessage('talk to me', 'Go on', { send: () => {}, spawnCli });
  assert.match(runs[2].prompt, /^\[IziTest: the test was changed in the dashboard since your last answer: read it again with get_test before acting\.\]\n\nGo on$/);

  // Its window closed: the browser window it worked in is closed, the session over, the conversation kept.
  const sent = [];
  assert.equal(await closeTestConversation('talk to me', { sendCommand: async (profile, command, params) => { sent.push([command, params.tabId]); return { closed: true, tabIds: [77] }; } }), true);
  assert.deepEqual(sent, [['close_window', 77]]);
  assert.equal(listSessions().some((s) => s.runId === runId), false);
  assert.equal(testConversation('talk to me').open, false);
  assert.equal(testConversation('talk to me').messages.length, 6);
  assert.equal(await closeTestConversation('talk to me', { sendCommand: noBrowser }), false, 'nothing open');

  // Opened again: a new browser session, the same CLI session.
  await sendTestMessage('talk to me', 'And now?', { send: () => {}, spawnCli });
  assert.equal(runs[3].args[runs[3].args.indexOf('--resume') + 1], 'cli-session-1');
  assert.equal(runs[3].mcp.mcpServers['izitest-dashboard'].url.includes(runId), false);

  // Start over: forgotten, the next message starts from the brief.
  assert.equal(await forgetTestConversation('talk to me', { sendCommand: noBrowser }), true);
  assert.deepEqual(testConversation('talk to me').messages, []);
  await sendTestMessage('talk to me', 'Hello', { send: () => {}, spawnCli });
  assert.equal(runs[4].args.includes('--resume'), false);
  assert.match(runs[4].prompt, /THE TESTER'S MESSAGE\nHello$/);
  await closeTestConversation('talk to me', { sendCommand: noBrowser });
});

test('stopped while it works: what it said so far is its answer; a second message meanwhile is refused', async () => {
  login('stop me');
  const { spawnCli } = fakeCli(() => ({
    events: [{ type: 'system', subtype: 'init', session_id: 'cli-stop' }, { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'ToolSearch', input: {} }, { type: 'text', text: 'I run the test first.' }, { type: 'tool_use', name: 'mcp__izitest-dashboard__run_test', input: {} },
    ] } }],
    hang: true,
  }));
  const events = [];
  const turn = sendTestMessage('stop me', 'Run it', { send: (e) => events.push(e), spawnCli });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(testConversation('stop me').working, true);
  await assert.rejects(sendTestMessage('stop me', 'And this', { send: () => {}, spawnCli }), (err) => err.status === 409 && /still working/.test(err.message));
  assert.equal(stopTestAgent('stop me'), true);
  assert.equal((await turn).status, 'stopped');
  // What it said before acting is kept with what it did: it was not its answer.
  assert.deepEqual(events.at(-1).message.activity, ['“I run the test first.”', 'Runs the test']);
  assert.equal(events.at(-1).message.content, '');
  assert.deepEqual(events.filter((e) => e.type === 'activity').map((e) => !!e.said), [true, false]);
  assert.equal(testConversation('stop me').working, false);
  assert.equal(stopTestAgent('stop me'), false, 'nothing at work');

  // Stopped once it had answered: its answer is whole, nothing was cut short.
  const quick = fakeCli(() => ({ events: says('cli-stop', [{ type: 'text', text: 'It passes.' }]), hang: true }));
  const answered = sendTestMessage('stop me', 'Does it pass?', { send: () => {}, spawnCli: quick.spawnCli });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopTestAgent('stop me'), true);
  assert.deepEqual([(await answered).status, (await answered).message.content], ['done', 'It passes.']);

  // The page gone (its request aborted) stops it the same way.
  const gone = new AbortController();
  const second = sendTestMessage('stop me', 'Again', { send: () => {}, spawnCli, signal: gone.signal });
  await new Promise((resolve) => setTimeout(resolve, 30));
  gone.abort();
  assert.equal((await second).status, 'stopped');
  await closeTestConversation('stop me', { sendCommand: noBrowser });
});

test('a CLI session that is gone: the agent starts afresh, told what was said; a failure is told, not hidden', async () => {
  login('lost session');
  const { spawnCli, runs } = fakeCli((args, n) => {
    if (n === 1) return { events: says('cli-old', [{ type: 'text', text: 'It logs a customer in.' }]) };
    if (n === 2) return { stderr: 'No conversation found with session ID: cli-old\n', code: 1 };
    if (n === 3) return { events: says('cli-new', [{ type: 'text', text: 'Here again.' }]) };
    return { events: [{ type: 'system', subtype: 'init', session_id: 'cli-new' }, { type: 'result', session_id: 'cli-new', is_error: true, result: 'Credit balance is too low' }], code: 1 };
  });
  await sendTestMessage('lost session', 'What is it?', { send: () => {}, spawnCli });
  const again = await sendTestMessage('lost session', 'And then?', { send: () => {}, spawnCli });
  assert.equal(again.status, 'done');
  assert.equal(again.message.content, 'Here again.');
  assert.equal(runs[1].args.includes('--resume'), true);
  assert.equal(runs[2].args.includes('--resume'), false);
  assert.match(runs[2].prompt, /THE CONVERSATION SO FAR\nTester: What is it\?\n\nYou: It logs a customer in\.\n\nTHE TESTER'S MESSAGE\nAnd then\?$/);

  const events = [];
  const failed = await sendTestMessage('lost session', 'Once more', { send: (e) => events.push(e), spawnCli });
  assert.equal(failed.status, 'error');
  assert.equal(failed.message.content, 'Credit balance is too low');
  assert.equal(runs.length, 4, 'not run again: its session was there');
  assert.equal(events.at(-1).error, 'Credit balance is too low');
  await closeTestConversation('lost session', { sendCommand: noBrowser });
});

test('what cannot start says why; a conversation nobody writes in gives its window back; it goes with its test', async () => {
  login('edge cases');
  const { spawnCli } = fakeCli(() => ({ events: says('cli-edge', [{ type: 'text', text: 'Yes.' }]) }));
  await assert.rejects(sendTestMessage('edge cases', '   ', { send: () => {}, spawnCli }), (err) => err.status === 400);
  await assert.rejects(sendTestMessage('no such test', 'Hi', { send: () => {}, spawnCli }), (err) => err.status === 404);
  db.prepare("INSERT INTO settings (key, value) VALUES ('agent', ?)").run(JSON.stringify({ mode: 'api', api: { model: 'x', apiKey: 'k' } }));
  await assert.rejects(sendTestMessage('edge cases', 'Hi', { send: () => {}, spawnCli }), (err) => err.status === 409 && /Settings → AI agent/.test(err.message));
  assert.equal(testConversation('edge cases').agent.available, false);
  db.prepare("DELETE FROM settings WHERE key = 'agent'").run();

  await sendTestMessage('edge cases', 'Hi', { send: () => {}, spawnCli });
  assert.equal(testConversation('edge cases').open, true);
  await closeIdleTestConversations({ sendCommand: noBrowser, idleMs: 60_000 });
  assert.equal(testConversation('edge cases').open, true, 'written in a moment ago');
  await closeIdleTestConversations({ sendCommand: noBrowser, now: Date.now() + 120_000, idleMs: 60_000 });
  assert.equal(testConversation('edge cases').open, false);

  // The brief never tells a secret's value, whatever the test holds.
  assert.equal(testAgentBrief({ name: 'edge cases', project_id: project }).includes(PASSWORD), false);
  deleteTest('edge cases');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_conversation_messages').get().n > 0, true, 'those of the other tests');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM test_conversations c JOIN tests t ON t.id = c.test_id WHERE t.name = 'edge cases'").get().n, 0);
});
