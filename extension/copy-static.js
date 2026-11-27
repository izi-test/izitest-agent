// What the extension needs in dist beside the two bundles esbuild writes: its manifest, the
// popup, the icons and axe-core. With --clean, dist is removed instead.
//
// In Node, not in shell: `rm -rf`, `mkdir -p` and `cp` do not exist in cmd.exe, which is what
// npm runs a script with on Windows.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const FILES = ['manifest.json', 'popup.html', 'popup.js', 'node_modules/axe-core/axe.min.js'];
const FOLDERS = ['icons'];

function clean() {
  // Windows can hold a file a moment longer (an antivirus reading it): a few tries, not a failure.
  fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function copy() {
  fs.mkdirSync(DIST, { recursive: true });
  for (const file of FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIST, path.basename(file)));
  }
  for (const folder of FOLDERS) {
    fs.cpSync(path.join(ROOT, folder), path.join(DIST, folder), { recursive: true });
  }
}

try {
  if (process.argv.includes('--clean')) clean();
  else copy();
} catch (err) {
  console.error(`[IziTest] ${process.argv.includes('--clean') ? 'Cleaning' : 'Copying to'} dist failed: ${err.message}`);
  process.exit(1);
}
