// Unit tests for how the dashboard starts a CLI agent and stops it (lib/agent/cli-spawn.js): on
// Windows the .cmd of a CLI installed with npm is read and node started on its script, a .exe is
// started as it is, a batch file that is not a shim is refused, and the tree is stopped with
// taskkill. The Windows cases run everywhere, on a disk made up; the last two start a real shim,
// on Windows only.
// Run with: node --test test/cli-spawn.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCli, spawnCliProcess, stopCliProcess } from '../lib/agent/cli-spawn.js';

// ─── A Windows made up ──────────────────────────────────────────────

/** A disk: { 'C:\\path': 'content' }. Paths are compared without their case, as Windows does. */
function disk(files) {
  const byPath = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  const read = (file) => {
    if (!byPath.has(file.toLowerCase())) throw new Error(`ENOENT: ${file}`);
    return byPath.get(file.toLowerCase());
  };
  return { isFile: (file) => byPath.has(file.toLowerCase()), read };
}

/** The .cmd npm 10 and 11 write for a package's bin (`rel`: its script, from the folder of the .cmd). */
const npmShim = (rel) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, '',
].join('\r\n');

/** The one pnpm, yarn and an older npm write: the script named twice, from %~dp0. */
const olderShim = (rel) => [
  '@SETLOCAL', '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*`, ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node  "%~dp0\\${rel}" %*`, ')', '',
].join('\r\n');

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM = 'C:\\Users\\ana\\AppData\\Roaming\\npm';
const LOCAL_BIN = 'C:\\Users\\ana\\.local\\bin';
const ENV = { Path: `C:\\Windows\\System32;${LOCAL_BIN};"${NPM}";;C:\\Program Files\\nodejs`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' };
const windows = (files, more = {}) => ({ platform: 'win32', env: ENV, node: NODE, disk: disk(files), ...more });
const SCRIPT = '#!/usr/bin/env node\nconsole.log("hi");\n';

// ─── What is started ────────────────────────────────────────────────

test('on macOS and Linux the command is started as it is, the disk not even read', () => {
  const untouched = { isFile: () => { throw new Error('read'); }, read: () => { throw new Error('read'); } };
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(resolveCli('claude', { platform, disk: untouched }), { command: 'claude', args: [] });
    assert.deepEqual(resolveCli('/opt/homebrew/bin/gemini', { platform, disk: untouched }), { command: '/opt/homebrew/bin/gemini', args: [] });
  }
});

test('on Windows, a CLI installed with npm: node on the script its .cmd starts, never the .cmd', () => {
  const script = `${NPM}\\node_modules\\@google\\gemini-cli\\dist\\index.js`;
  const files = { [`${NPM}\\gemini.cmd`]: npmShim('node_modules\\@google\\gemini-cli\\dist\\index.js'), [`${NPM}\\gemini`]: '#!/bin/sh\n', [script]: SCRIPT };
  assert.deepEqual(resolveCli('gemini', windows(files)), { command: NODE, args: [script] });
  assert.deepEqual(resolveCli('gemini.cmd', windows(files)), { command: NODE, args: [script] }, 'named with its extension');
  assert.deepEqual(resolveCli(`${NPM}\\gemini.cmd`, windows(files)), { command: NODE, args: [script] }, 'named with its path');
  assert.deepEqual(resolveCli(`${NPM}/gemini`, windows(files)), { command: NODE, args: [script] }, 'a path without the extension');
  assert.deepEqual(resolveCli('gemini', windows(files, { env: { PATH: NPM } })), { command: NODE, args: [script] }, 'PATH in capitals, no PATHEXT');
});

test('the node beside the shim is the one taken; the options of the script go to node', () => {
  const script = `${NPM}\\node_modules\\@github\\copilot\\index.js`;
  const files = {
    [`${NPM}\\copilot.cmd`]: npmShim('node_modules\\@github\\copilot\\index.js'),
    [`${NPM}\\node.exe`]: '',
    [script]: '#!/usr/bin/env -S node --no-warnings --max-old-space-size=4096\r\nimport "./app.js";\r\n',
  };
  assert.deepEqual(resolveCli('copilot', windows(files)), { command: `${NPM}\\node.exe`, args: ['--no-warnings', '--max-old-space-size=4096', script] });
});

test('a shim of pnpm, yarn or an older npm is read the same; a script without extension by its first line', () => {
  const pnpm = 'C:\\Users\\ana\\AppData\\Local\\pnpm';
  const script = `${pnpm}\\global\\5\\node_modules\\opencode-ai\\bin\\opencode`;
  const files = { [`${pnpm}\\opencode.cmd`]: olderShim('global\\5\\node_modules\\opencode-ai\\bin\\opencode'), [script]: '#!/usr/bin/node\n' };
  assert.deepEqual(resolveCli('opencode', windows(files, { env: { Path: pnpm } })), { command: NODE, args: [script] });

  const up = { [`${pnpm}\\bin\\tool.cmd`]: olderShim('..\\store\\tool\\cli.mjs'), [`${pnpm}\\store\\tool\\cli.mjs`]: 'export {};\n' };
  assert.deepEqual(resolveCli('tool', windows(up, { env: { Path: `${pnpm}\\bin` } })), { command: NODE, args: [`${pnpm}\\store\\tool\\cli.mjs`] }, 'a path that goes up, a script with no first line of its own');
});

test('a .exe is started as it is, and comes before a .cmd of the same name', () => {
  const files = {
    [`${LOCAL_BIN}\\claude.exe`]: '',
    [`${NPM}\\claude.cmd`]: npmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'),
    [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: SCRIPT,
  };
  assert.deepEqual(resolveCli('claude', windows(files)), { command: `${LOCAL_BIN}\\claude.exe`, args: [] }, 'the first folder of the PATH wins');

  const both = { [`${NPM}\\copilot.cmd`]: npmShim('node_modules\\x\\cli.js'), [`${NPM}\\copilot.exe`]: '', [`${NPM}\\node_modules\\x\\cli.js`]: SCRIPT };
  assert.deepEqual(resolveCli('copilot', windows(both)), { command: `${NPM}\\copilot.exe`, args: [] }, 'in one folder, the order of PATHEXT');

  const native = { [`${NPM}\\opencode.cmd`]: npmShim('node_modules\\opencode-windows-arm64\\bin\\opencode.exe'), [`${NPM}\\node_modules\\opencode-windows-arm64\\bin\\opencode.exe`]: '' };
  assert.deepEqual(resolveCli('opencode', windows(native)), { command: `${NPM}\\node_modules\\opencode-windows-arm64\\bin\\opencode.exe`, args: [] }, 'a shim that starts a program: the program');
});

test('a batch file that is not the shim of a node script is refused, with what to do', () => {
  const refused = (files, command = 'agent') => assert.throws(() => resolveCli(command, windows(files)), (err) => {
    assert.match(err.message, /batch file/);
    assert.match(err.message, /agent\.(cmd|bat)/, 'which file');
    assert.match(err.message, /\.exe of the CLI, or install the CLI with npm/);
    return true;
  });
  refused({ [`${NPM}\\agent.cmd`]: '@echo off\r\nset KEY=1\r\nclaude %*\r\n' });
  refused({ [`${NPM}\\agent.bat`]: '@echo off\r\nclaude -p %1\r\n' });
  refused({ [`${NPM}\\agent.cmd`]: npmShim('node_modules\\agent\\run.sh'), [`${NPM}\\node_modules\\agent\\run.sh`]: '#!/bin/sh\nexec agent "$@"\n' });
  refused({ [`${NPM}\\agent.cmd`]: npmShim('node_modules\\agent\\cli.js'), [`${NPM}\\node_modules\\agent\\cli.js`]: '#!/usr/bin/env bun\n' });
  refused({ [`${NPM}\\agent.cmd`]: npmShim('node_modules\\agent\\gone.js') });
});

test('a command that is nowhere is left to spawn, which says it is not found', () => {
  assert.deepEqual(resolveCli('claude', windows({})), { command: 'claude', args: [] });
  assert.deepEqual(resolveCli('claude', windows({ [`${NPM}\\claude.ps1`]: '', [`${NPM}\\claude`]: '#!/bin/sh\n' })), { command: 'claude', args: [] }, 'a .ps1 and a sh script are not what Windows starts');
  assert.deepEqual(resolveCli('', windows({})), { command: '', args: [] });
});

// ─── Stopping ───────────────────────────────────────────────────────

/** A child process as stopCliProcess sees it; `killed` counts its kill(). */
function childOf(pid, exitCode = null) {
  const child = { pid, exitCode, killed: 0, kill: () => { child.killed++; } };
  return child;
}

test('stopped on Windows: taskkill ends the CLI and what it started', () => {
  const ran = [];
  const run = (command, args, options) => { ran.push({ command, args, options }); return new EventEmitter(); };
  stopCliProcess(childOf(4242), { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
  assert.deepEqual(ran, [{ command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '4242', '/T', '/F'], options: { stdio: 'ignore', windowsHide: true } }]);

  const child = childOf(4243);
  const failing = new EventEmitter();
  stopCliProcess(child, { platform: 'win32', env: {}, run: (command) => { ran.push({ command }); return failing; } });
  assert.equal(ran.at(-1).command, 'taskkill', 'no SystemRoot: the one of the PATH');
  failing.emit('error', new Error('ENOENT'));
  assert.equal(child.killed, 1, 'taskkill did not start: the CLI at least');

  const thrown = childOf(4244);
  stopCliProcess(thrown, { platform: 'win32', env: {}, run: () => { throw new Error('EPERM'); } });
  assert.equal(thrown.killed, 1);
});

test('stopped on macOS and Linux: its process group when it leads one, else the CLI alone', () => {
  const signalled = [];
  const leader = childOf(500);
  stopCliProcess(leader, { platform: 'linux', signalGroup: (pid) => signalled.push(pid), run: () => assert.fail('no taskkill here') });
  assert.deepEqual([signalled, leader.killed], [[500], 0]);

  const member = childOf(501);
  stopCliProcess(member, { platform: 'darwin', signalGroup: () => { throw new Error('ESRCH'); } });
  assert.equal(member.killed, 1);
});

test('nothing to stop: a CLI that ended, none at all; one that never started is told so', () => {
  const ended = childOf(600, 0);
  const none = () => assert.fail('nothing to signal');
  stopCliProcess(ended, { platform: 'linux', signalGroup: none });
  stopCliProcess(ended, { platform: 'win32', run: none });
  stopCliProcess(null, { platform: 'win32', run: none });
  assert.equal(ended.killed, 0);

  const neverStarted = childOf(undefined);
  stopCliProcess(neverStarted, { platform: 'win32', run: none });
  assert.equal(neverStarted.killed, 1);
});

// ─── A real shim, on Windows ────────────────────────────────────────

const windowsOnly = process.platform === 'win32' ? false : 'a real .cmd: Windows only';

/** A folder with the .cmd of a CLI "echo-agent" as npm writes it, and an environment with it on the PATH. */
function installedCli() {
  const folder = mkdtempSync(join(tmpdir(), 'izitest-cli-'));
  mkdirSync(join(folder, 'node_modules', 'echo-agent'), { recursive: true });
  writeFileSync(join(folder, 'echo-agent.cmd'), npmShim('node_modules\\echo-agent\\cli.js'));
  writeFileSync(join(folder, 'node_modules', 'echo-agent', 'cli.js'), [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    'const args = process.argv.slice(2);',
    "if (args[0] !== '--wait') { console.log(JSON.stringify(args)); process.exit(0); }",
    "const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(JSON.stringify({ cli: process.pid, started: started.pid }));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [pathKey]: `${folder};${process.env[pathKey] ?? ''}` };
}

const firstLine = (child) => new Promise((resolve, reject) => {
  let out = '';
  child.on('error', reject);
  child.stdout.on('data', (data) => { out += data; if (out.includes('\n')) resolve(out.split('\n')[0]); });
  child.on('close', () => resolve(out));
});

test('a CLI installed with npm gets its arguments as they are: quotes, new lines, what cmd.exe would run', { skip: windowsOnly }, async () => {
  const env = installedCli();
  const prompt = 'Say "hi" & echo %PATH% > out.txt | more ^ <in> (x) !y!\nA second line, with \'quotes\' and an é.\r\n\tAnd a third.';
  const args = ['-p', prompt, '--tools', '', '--allowedTools', 'a,b c', '--model', 'opus[1m]'];
  const child = spawnCliProcess('echo-agent', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  assert.deepEqual(JSON.parse(await firstLine(child)), args);
});

test('stopping it ends what it started too', { skip: windowsOnly }, async () => {
  const child = spawnCliProcess('echo-agent', ['--wait'], { env: installedCli(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const { cli, started } = JSON.parse(await firstLine(child));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.deepEqual([cli, alive(cli), alive(started)], [child.pid, true, true], 'the CLI is node itself, not a cmd.exe around it');
  stopCliProcess(child);
  for (let tries = 0; tries < 50 && (alive(cli) || alive(started)); tries++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([alive(cli), alive(started)], [false, false]);
});
