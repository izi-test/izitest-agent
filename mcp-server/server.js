#!/usr/bin/env node

// Browser Pilot — MCP Server + WebSocket Bridge
// Exposes browser control tools via MCP (stdio) for Claude
// Connects to Chrome extensions via WebSocket

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import { log } from './lib/logger.js';
import { startWebSocketServer, getProfiles, sendCommand, closeWebSocket } from './lib/websocket.js';
import { saveActionToHistory, getLastRefMap, setLastRefMap, getRecording } from './lib/tests.js';
import { registerBrowserTools } from './lib/tools/browser.js';
import { registerTestTools } from './lib/tools/test.js';
import { initDatabase } from './lib/db.js';
import { apiRouter } from './lib/api.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const ASSERTION_SCREENSHOTS_DIR = join(__dirname, 'data', 'assertion-screenshots');
const BASELINES_DIR = join(__dirname, 'data', 'baselines');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ─── Config ─────────────────────────────────────────────────────────

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT) : 3456;
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3457;
const USE_STDIO = process.argv.includes('--stdio');

// ─── Initialize Database & Start WebSocket Bridge ───────────────────

initDatabase();
startWebSocketServer(WS_PORT);

// ─── MCP Server Factory ─────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: 'browser-pilot',
    version: '1.0.0',
  });

  const deps = {
    sendCommand,
    getProfiles,
    saveActionToHistory,
    getLastRefMap,
    setLastRefMap,
    getRecording,
  };

  registerBrowserTools(server, deps);
  registerTestTools(server, deps);

  return server;
}

// ─── Start MCP Server (dual-mode: SSE HTTP or stdio) ───────────────

if (USE_STDIO) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server running on stdio');
} else {
  const activeSessions = new Map();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MCP_PORT}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
      const sessionServer = createMcpServer();
      const transport = new SSEServerTransport('/messages', res);
      activeSessions.set(transport.sessionId, transport);

      transport.onclose = () => {
        log(`SSE session closed: ${transport.sessionId}`);
        activeSessions.delete(transport.sessionId);
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
  });

  httpServer.listen(MCP_PORT, '127.0.0.1', () => {
    log(`MCP SSE server listening on http://127.0.0.1:${MCP_PORT}`);
    log(`  SSE endpoint:     http://127.0.0.1:${MCP_PORT}/sse`);
    log(`  Message endpoint: http://127.0.0.1:${MCP_PORT}/messages`);
    log(`  Health check:     http://127.0.0.1:${MCP_PORT}/health`);
  });
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
