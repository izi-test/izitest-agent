// Serves the Test Arena (demo/test-arena), a single page full of what makes UI tests hard —
// look-alike fields, a drop zone, a drag-and-drop list, toggles, a multi-step form —, at
// http://127.0.0.1:8777/izitest-test.html. Nothing to install: Node's own HTTP server.
//
//   npm run arena           (from the root of the repository)
//   PORT=8800 npm run arena

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../demo/test-arena/', import.meta.url));
const PORT = Number(process.env.PORT) || 8777;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(ROOT, path === '/' ? 'izitest-test.html' : path));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Test Arena: http://127.0.0.1:${PORT}/izitest-test.html`);
});
