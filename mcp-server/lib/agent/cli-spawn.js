// How the dashboard starts a CLI agent (claude, gemini, copilot, opencode), and stops it.
//
// On macOS and Linux the command is started as it is. On Windows a CLI installed with npm is a
// .cmd file — a few lines of batch that start node on the CLI's script — and Node starts no .cmd
// without a shell (spawn ENOENT). A shell is not the answer: what goes to the CLI is a prompt,
// with its quotes, its new lines and words read on the pages under test, and cmd.exe would take
// some of it for commands. So the .cmd is read, and what it starts is started directly: node on
// the script, the arguments passed as they are.
//
// Stopping is not the same either: Windows has no process group to signal, and kill() ends the
// CLI alone, leaving what it started (its MCP servers, a native binary) running.

import { spawn } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { win32 } from 'path';

const DISK = {
  isFile: (file) => { try { return statSync(file).isFile(); } catch { return false; } },
  read: (file) => readFileSync(file, 'utf8'),
};

// What Windows starts by itself, and what it only starts through cmd.exe.
const PROGRAMS = ['.com', '.exe'];
const BATCHES = ['.bat', '.cmd'];

/** A variable of the environment, whatever its case: Windows has Path, a copy of it may have PATH. */
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/**
 * Where Windows finds `command`: its full path, with the extension PATHEXT gives it (a .exe
 * before a .cmd of the same name, as in a terminal). Null when it is nowhere on the PATH.
 */
function findOnPath(command, { env, isFile }) {
  const known = [...PROGRAMS, ...BATCHES];
  const given = win32.extname(command).toLowerCase();
  const fromPathext = String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => known.includes(ext));
  const names = [...(known.includes(given) ? [command] : []), ...fromPathext.map((ext) => command + ext)];
  const folders = /[\\/]/.test(command)
    ? [''] // a path, not a name: looked for where it says
    : String(envValue(env, 'PATH') || '').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const folder of folders) {
    for (const name of names) {
      const file = folder ? win32.join(folder, name) : win32.resolve(name);
      if (isFile(file)) return file;
    }
  }
  return null;
}

// The line a shim ends with: … "%dp0%\node_modules\pkg\cli.js" %*  (npm), "%~dp0\..\pkg\cli.js" %*
// (pnpm, yarn, an older npm). What it starts is a path from the folder of the .cmd.
const SHIM_TARGET = /"%(?:~dp0|dp0%)[\\/]?([^"\r\n]+)"\s+%\*/gi;
// The first line of a script node runs: #!/usr/bin/env node, #!/usr/bin/env -S node --flag, #!/usr/bin/node
const NODE_SHEBANG = /^#!\s*(?:\S*[\\/]env\s+(?:-S\s+)?)?(?:\S*[\\/])?node(?:\.exe)?(?=\s|$)(.*)$/;

/**
 * What the .cmd of a CLI installed with npm, pnpm or yarn starts: { command, args } — node, the
 * options its script asks for, the script. Null when the file is not one of their shims.
 */
function readShim(file, { isFile, read, node }) {
  let text;
  try { text = read(file); } catch { return null; }
  const rel = [...text.matchAll(SHIM_TARGET)].at(-1)?.[1];
  if (!rel) return null;
  const folder = win32.dirname(file);
  const target = win32.join(folder, rel);
  if (!isFile(target)) return null;

  const ext = win32.extname(target).toLowerCase();
  if (PROGRAMS.includes(ext)) return { command: target, args: [] };
  let firstLine = '';
  try { firstLine = read(target).split(/\r?\n/, 1)[0]; } catch { /* a script nobody can read: node will say so */ }
  const shebang = NODE_SHEBANG.exec(firstLine);
  // A script of node: its first line says so, or it says nothing and the file is JavaScript.
  // One written for something else (sh, bun, python) is not started with node.
  if (!shebang && (firstLine.startsWith('#!') || !['.js', '.cjs', '.mjs'].includes(ext))) return null;
  // The node the shim itself would take: the one beside it, else the one of the PATH — here the
  // one this server runs on.
  const beside = win32.join(folder, 'node.exe');
  const options = (shebang?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  return { command: isFile(beside) ? beside : node, args: [...options, target] };
}

/**
 * What to start for `command`: { command, args } — args go before the CLI's own. Unchanged
 * everywhere but on Windows, and there for a .exe. Throws for a batch file that is not the shim
 * of an npm package: started through cmd.exe, it would not get the prompt as it is.
 */
export function resolveCli(command, { platform = process.platform, env = process.env, node = process.execPath, disk = DISK } = {}) {
  const unchanged = { command, args: [] };
  if (platform !== 'win32' || !command) return unchanged;
  const file = findOnPath(command, { env, isFile: disk.isFile });
  if (!file) return unchanged; // spawn says it is not found, as it does elsewhere
  if (!BATCHES.includes(win32.extname(file).toLowerCase())) return { command: file, args: [] };
  const started = readShim(file, { ...disk, node });
  if (started) return started;
  throw new Error(`"${command}" is a batch file (${file}) that IziTest cannot start with a prompt. `
    + 'Set the command to the .exe of the CLI, or install the CLI with npm.');
}

/**
 * Starts a CLI agent: child_process.spawn, with what Windows needs. `detached` (a process group
 * of its own, to stop the CLI with what it started) is for macOS and Linux only: Windows has no
 * group to signal, and a detached process there gets a console window of its own.
 */
export function spawnCliProcess(command, args = [], options = {}) {
  const cli = resolveCli(command, { env: options.env ?? process.env });
  return spawn(cli.command, [...cli.args, ...args], {
    ...options,
    windowsHide: true,
    detached: !!options.detached && process.platform !== 'win32',
  });
}

/**
 * Stops a CLI and what it started. macOS, Linux: the signal goes to its process group when it
 * leads one (started detached), else to the CLI. Windows: taskkill ends the tree.
 */
export function stopCliProcess(child, { platform = process.platform, env = process.env, run = spawn, signalGroup = (pid) => process.kill(-pid, 'SIGTERM') } = {}) {
  if (!child || child.exitCode != null) return;
  const alone = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
  if (!child.pid) return alone(); // it never started
  if (platform === 'win32') {
    const root = envValue(env, 'SYSTEMROOT');
    const taskkill = root ? win32.join(root, 'System32', 'taskkill.exe') : 'taskkill';
    try {
      run(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', alone);
    } catch { alone(); }
    return;
  }
  try { signalGroup(child.pid); } catch { alone(); }
}
