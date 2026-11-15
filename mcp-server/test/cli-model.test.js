// Unit tests for the model a CLI agent the dashboard starts works with (lib/agent/cli-model.js):
// passed as --model when one is set, nothing when the CLI picks; a name that would read as an
// option refused; what a Claude Code run said of its model read. On a database of their own.
// Run with: node --test test/cli-model.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'cli-model-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { cliModel, cliModelArgs, isModelName, readModelCheck } = await import('../lib/agent/cli-model.js');
const { cliInvocation, agentName } = await import('../lib/agent/complete.js');

test('a model set goes as --model; none, the CLI picks', () => {
  assert.deepEqual(cliModelArgs({ provider: 'claude', model: 'opus' }), ['--model', 'opus']);
  assert.deepEqual(cliModelArgs({ provider: 'claude', model: '  claude-opus-5-5[1m] ' }), ['--model', 'claude-opus-5-5[1m]']);
  assert.deepEqual(cliModelArgs({ provider: 'opencode', model: 'anthropic/claude-sonnet-4-5' }), ['--model', 'anthropic/claude-sonnet-4-5']);
  assert.deepEqual(cliModelArgs({ provider: 'claude' }), []);
  assert.deepEqual(cliModelArgs({ provider: 'claude', model: '   ' }), []);
  assert.deepEqual(cliModelArgs(undefined), []);
});

test('a name the CLI would read as an option, or with spaces, is not a model', () => {
  for (const bad of ['--dangerously-skip-permissions', '-p', 'opus --verbose', 'a;b', 'x$(y)']) {
    assert.equal(isModelName(bad), false, bad);
    assert.equal(cliModel({ model: bad }), null, bad);
  }
  for (const good of ['fable', 'sonnet', 'claude-fable-5-2', 'gpt-5.4', 'auto', 'openrouter/anthropic/claude-haiku-4.5', 'claude-opus-5-5[1m]']) {
    assert.equal(isModelName(good), true, good);
  }
});

test('the one-answer command line carries the model, whatever the CLI', () => {
  const claude = cliInvocation({ provider: 'claude', command: 'claude', model: 'sonnet' }, 'S', 'P');
  assert.deepEqual(claude.args.slice(-2), ['--model', 'sonnet']);
  assert.ok(!cliInvocation({ provider: 'claude' }, 'S', 'P').args.includes('--model'));
  assert.deepEqual(cliInvocation({ provider: 'opencode', model: 'anthropic/claude-sonnet-4-5' }, 'S', 'P').args, ['run', 'S\n\n---\n\nP', '--model', 'anthropic/claude-sonnet-4-5']);
  assert.deepEqual(cliInvocation({ provider: 'copilot', model: 'auto' }, 'S', 'P').args, ['-p', 'S\n\n---\n\nP', '--model', 'auto']);
});

test('who answers names the model when one is set', () => {
  assert.equal(agentName({ mode: 'cli', cli: { provider: 'claude' } }), 'claude');
  assert.equal(agentName({ mode: 'cli', cli: { provider: 'claude', model: 'opus' } }), 'claude (opus)');
  assert.equal(agentName({ mode: 'api', api: { model: 'anthropic/claude-sonnet-4-6' } }), 'anthropic/claude-sonnet-4-6');
});

test("a Claude Code run tells the model it started with, and why it did not answer", () => {
  const init = (model) => JSON.stringify({ type: 'system', subtype: 'init', model });
  const ok = [init('claude-opus-5-5'), JSON.stringify({ type: 'assistant' }), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })].join('\n');
  assert.deepEqual(readModelCheck(ok), { model: 'claude-opus-5-5', error: null });

  const refused = [init('bogus-model-x'), '[claude-code:unrecognized_model] {"model":"bogus-model-x"}',
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (bogus-model-x)." })].join('\n');
  assert.deepEqual(readModelCheck(refused), { model: 'bogus-model-x', error: "There's an issue with the selected model (bogus-model-x)." });

  assert.deepEqual(readModelCheck(init('claude-fable-5-2')), { model: 'claude-fable-5-2', error: 'Claude Code gave no answer' });
  assert.deepEqual(readModelCheck(''), { model: null, error: 'Claude Code gave no answer' });
});

test.after(() => db.close());
