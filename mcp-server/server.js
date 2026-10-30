#!/usr/bin/env node

// IziTest Agent — MCP Server + WebSocket Bridge
// Exposes browser control tools via MCP (stdio) for Claude
// Connects to Chrome extensions via WebSocket

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from 'http';
import { timingSafeEqual } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import { log } from './lib/logger.js';
import { startWebSocketServer, getProfiles, sendCommand, closeWebSocket, sendToProfile, onProfileRegistered } from './lib/websocket.js';
import { resolveSession, dropConnection, listSessions, setConnectionClient } from './lib/session.js';
import { initLive, liveRouter } from './lib/live.js';
import { scopeToolsToSession } from './lib/tools/session-scope.js';
import { registerBrowserTools } from './lib/tools/browser.js';
import { registerTestTools } from './lib/tools/test.js';
import { instrumentTools, registerBenchTools } from './lib/bench.js';
import { registerAgentTools } from './lib/agent/mcp-adapter.js';
import { initDatabase } from './lib/db.js';
import { apiRouter } from './lib/api.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const ASSERTION_SCREENSHOTS_DIR = join(__dirname, 'data', 'assertion-screenshots');
const BASELINES_DIR = join(__dirname, 'data', 'baselines');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ─── Config ─────────────────────────────────────────────────────────

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT) : 3466;
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3467;
// Ce serveur pilote le Chrome de l'utilisateur, avec ses sessions déjà connectées :
// l'ouvrir au-delà de la machine revient à confier ses comptes à qui peut l'atteindre.
// D'où le défaut loopback, et le refus de démarrer sur une autre interface sans jeton.
const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';
const MCP_TOKEN = process.env.IZITEST_TOKEN || '';
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const WILDCARD = ['0.0.0.0', '::', ''];

// Loopback is always served, on top of whatever MCP_HOST adds.
// Binding only a LAN/Tailscale address (MCP_HOST=100.x.y.z) left nothing on this machine
// able to reach the server — not the dashboard, not .mcp.json, not the extension reload —
// while adding loopback widens nothing: it is the default posture, reachable only from the
// machine that already runs the piloted browser.
const HOSTS = LOOPBACK.includes(MCP_HOST) || WILDCARD.includes(MCP_HOST)
  ? [MCP_HOST]
  : [MCP_HOST, '127.0.0.1'];

if (!LOOPBACK.includes(MCP_HOST) && !MCP_TOKEN) {
  console.error(`[server] Refus de démarrer : MCP_HOST=${MCP_HOST} expose le serveur hors de cette machine ` +
    `sans IZITEST_TOKEN. Définis un jeton, ou garde MCP_HOST=127.0.0.1.`);
  process.exit(1);
}

// Comparaison à durée constante : une comparaison ordinaire laisse deviner le jeton
// caractère par caractère en mesurant le temps de réponse.
function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(MCP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Le jeton porté par l'en-tête Authorization, ou par ?token= — les clients MCP ne
 *  savent pas tous envoyer d'en-tête. Rien n'est exigé quand aucun jeton n'est défini. */
function authorized(req, url) {
  if (!MCP_TOKEN) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return tokenOk(bearer) || tokenOk(url.searchParams.get('token'));
}
const USE_STDIO = process.argv.includes('--stdio');

// ─── Initialize Database & Start WebSocket Bridge ───────────────────

initDatabase();
startWebSocketServer(WS_PORT);
initLive();

// An extension that just restarted (a rebuild reload, or Chrome waking the service worker)
// has lost chrome.storage.session, so it no longer knows which windows belong to which
// session. The server still does — hand them back, or close_window would refuse them and
// tab resolution would stop being scoped per session.
onProfileRegistered((profileId) => {
  const windows = listSessions()
    .filter((session) => session.windowId !== undefined || session.lastTabId !== undefined)
    .map((session) => ({ windowId: session.windowId, tabId: session.lastTabId, sessionId: session.id }));
  if (windows.length) {
    sendToProfile(profileId, { type: 'restore_owned_windows', windows });
    log(`Handed ${windows.length} session window(s) back to ${profileId}`);
  }
});

// ─── MCP Server Factory ─────────────────────────────────────────────

/**
 * One MCP server per client connection. `connectionId` identifies that connection: tools
 * resolve it to a Session (its own working window, refs and recording), so two agents
 * connected at the same time never touch each other's state. An agent that needs to split
 * further — Claude Code subagents all share their parent's connection — passes
 * `session: "<name>"` to any tool, or calls open_session() first.
 */
function createMcpServer(connectionId) {
  const server = new McpServer({
    name: 'izitest-agent',
    version: '1.0.0',
  });

  const deps = { sendCommand, getProfiles };

  // Must come first: only tools registered after this are timed (see lib/bench.js).
  instrumentTools(server);

  // Browser and test tools act on a browser window, so they are session-scoped. Agent and
  // bench tools are not: they carry no per-window state.
  const unscope = scopeToolsToSession(server, (name) => resolveSession(connectionId, name));
  registerBrowserTools(server, deps);
  registerTestTools(server, deps);
  unscope();

  registerAgentTools(server);
  registerBenchTools(server);

  // Which client this is ("claude-code", "cursor", …), for the cockpit's live view.
  server.server.oninitialized = () => setConnectionClient(connectionId, server.server.getClientVersion());

  return server;
}

// ─── Start MCP Server (dual-mode: SSE HTTP or stdio) ───────────────

if (USE_STDIO) {
  const server = createMcpServer('stdio');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server running on stdio');
} else {
  const activeSessions = new Map();

  const handleRequest = async (req, res) => {
    const url = new URL(req.url, `http://${MCP_HOST}:${MCP_PORT}`);

    // Sans jeton, le serveur est local et garde son CORS ouvert (interface web incluse).
    // Avec jeton, il est joignable à distance : une page visitée par le Chrome piloté
    // ne doit pas pouvoir lui parler au nom de l'utilisateur.
    // Live view is the exception for GET: the cockpit runs on another origin, every route
    // still wants the token, and a GET there changes nothing.
    // (OPTIONS too: the preflight of a GET that sends the token as an Authorization header.)
    const liveRead = ['GET', 'OPTIONS'].includes(req.method) && url.pathname.startsWith('/live/');
    res.setHeader('Access-Control-Allow-Origin', MCP_TOKEN && !liveRead ? 'null' : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // `/health` reste ouvert : c'est la sonde des outils et du tableau de bord, et il
    // ne révèle que l'état du serveur et les noms de profils. `/messages` l'est aussi
    // quand il porte l'identifiant d'une session vivante : le transport SSE impose ce
    // chemin sans jeton, et cet identifiant n'a été remis qu'à un client authentifié.
    const openPath = url.pathname === '/health'
      || (url.pathname === '/messages' && activeSessions.has(url.searchParams.get('sessionId')));
    if (!openPath && !authorized(req, url)) {
      log(`Requête refusée (jeton absent ou invalide) depuis ${req.socket.remoteAddress} sur ${url.pathname}`);
      // 403 et non 401 : un 401 fait croire aux clients MCP que le serveur veut un
      // OAuth, et ils partent en enregistrement dynamique au lieu de dire « refusé ».
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Jeton manquant ou invalide' }));
      return;
    }

    // ── Live view (cockpit): same token as everything else ──
    if (url.pathname.startsWith('/live/')) {
      await liveRouter(req, res, url);
      return;
    }

    // ── API routes ──
    if (url.pathname.startsWith('/api/')) {
      await apiRouter(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/assertion-screenshots/')) {
      const relativePath = normalize(url.pathname.replace('/assertion-screenshots/', '')).replace(/^\/+/, '');
      const filePath = join(ASSERTION_SCREENSHOTS_DIR, relativePath);

      if (!filePath.startsWith(ASSERTION_SCREENSHOTS_DIR)) {
        res.writeHead(400);
        res.end('Invalid path');
        return;
      }

      try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/data/baselines/')) {
      const relativePath = normalize(url.pathname.replace('/data/baselines/', '')).replace(/^\/+/, '');
      const filePath = join(BASELINES_DIR, relativePath);

      if (!filePath.startsWith(BASELINES_DIR)) {
        res.writeHead(400);
        res.end('Invalid path');
        return;
      }

      try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // ── Static files (frontend) ──
    if (req.method === 'GET' && !['/health', '/sse', '/messages'].includes(url.pathname)) {
      let fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      let filePath = join(PUBLIC_DIR, fileName);

      try {
        await stat(filePath);
      } catch {
        // Fallback for SPA routing
        fileName = 'index.html';
        filePath = join(PUBLIC_DIR, fileName);
      }

      try {
        const content = await readFile(filePath);
        const ext = extname(fileName);
        const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        // Fallback if index.html itself is missing
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        profiles: [...getProfiles().keys()],
        uptime: process.uptime()
      }));
      return;
    }

    if (url.pathname === '/sse') {
      log(`New SSE connection from ${req.socket.remoteAddress}`);
      const transport = new SSEServerTransport('/messages', res);
      const connectionId = transport.sessionId;
      const sessionServer = createMcpServer(connectionId);
      activeSessions.set(connectionId, transport);

      transport.onclose = () => {
        log(`SSE session closed: ${connectionId}`);
        activeSessions.delete(connectionId);
        // Free the session state, but leave its window alone: a reconnect comes back as a
        // new connection, so closing here would tear down a working window on any
        // transient drop. Closing stays the agent's explicit close_window call.
        const ended = dropConnection(connectionId);
        if (ended?.lastTabId !== undefined) {
          log(`Session ${ended.id} ended with window still open (tab ${ended.lastTabId}) — close it by hand or with close_window.`);
        }
      };

      await sessionServer.connect(transport);
      return;
    }

    if (url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const transport = activeSessions.get(sessionId);

      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown or expired session' }));
        return;
      }

      let body = '';
      for await (const chunk of req) body += chunk;

      try {
        await transport.handlePostMessage(req, res, body);
      } catch (err) {
        log(`Message handling error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  };

  const httpServer = createServer(handleRequest);

  for (const host of HOSTS) {
    const listener = host === MCP_HOST ? httpServer : createServer(handleRequest);
    listener.on('error', (err) => {
      log(`HTTP listener on ${host}:${MCP_PORT} failed: ${err.message}`);
      if (host === MCP_HOST) process.exit(1); // the configured interface is not optional
    });
    listener.listen(MCP_PORT, host, () => {
      log(`MCP SSE server listening on http://${host}:${MCP_PORT}` +
          (MCP_TOKEN ? ' (jeton requis)' : ''));
      log(`  SSE endpoint:     http://${host}:${MCP_PORT}/sse`);
      log(`  Message endpoint: http://${host}:${MCP_PORT}/messages`);
      log(`  Health check:     http://${host}:${MCP_PORT}/health`);
    });
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────

function cleanup() {
  log('Shutting down server...');
  closeWebSocket();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
if (USE_STDIO) process.stdin.on('close', cleanup);
