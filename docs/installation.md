# Installation

IziTest Agent has three parts: a server (with its dashboard), a Chrome extension, and the agent
you connect to it.

## Prerequisites

- **Node.js 22.12 or newer** and **git**.
- **Google Chrome** (or Chromium).
- To have tests written by an agent: **Claude Code**, Claude Desktop or another MCP client. The
  dashboard's own agent can also be a model reached with an API key.
- For the [Dolibarr demo](../demo/dolibarr): **Docker**.

## 1. Install and build

```bash
git clone <repository-url> izitest-agent
cd izitest-agent
npm run setup
```

`npm run setup` installs the server's dependencies, builds the dashboard into
`mcp-server/public`, and builds the extension into `extension/dist`. Run it again after a
`git pull`.

## 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/dist` folder.

The extension connects to the server by itself as soon as it runs. Later builds
(`npm --prefix extension run build`) reload it in Chrome by themselves.

## 3. Start the server

```bash
npm start
```

The dashboard is at <http://127.0.0.1:3467>. The server keeps its data in
`mcp-server/data/izitest.db` (SQLite).

To keep it running in the background, start it with `npm --prefix mcp-server run ensure`: it
starts the server only if it is not already running, and several calls at once start only one.
A process manager such as PM2 works too:

```bash
pm2 start mcp-server/server.js --name izitest-agent
```

## 4. Connect your agent

The server speaks MCP over SSE at `http://127.0.0.1:3467/sse`. Several agents can be connected at
once, each in its own browser window ([parallel sessions](parallel-sessions.md)).

**Claude Code**, in the folder of the app you test (run it there once):

```bash
claude mcp add --transport sse -s local izitest-agent http://127.0.0.1:3467/sse -H "Authorization: Bearer $IZITEST_TOKEN"
```

- **With `IZITEST_TOKEN`** set on the server, every request must carry it: without the header,
  the server answers 403 and the agent has no IziTest tool. The shell puts the token's value in
  the command; `-s local` keeps it in your `~/.claude.json`, for that folder only, never in the
  app's repository.
- **Without a token** (a server on loopback only), drop the `-H …` part.
- `claude mcp list` says `✔ Connected` when it works. A Claude Code session loads its MCP servers
  when it starts: start a new one after adding it.
- This repository's [.mcp.json](../.mcp.json) sends `${IZITEST_TOKEN}` from the environment of
  the program that starts Claude Code. A terminal where it is exported has it. The Claude desktop
  app does not get your shell's variables, so there the header goes empty and the server refuses
  it: use the command above instead.

**Claude Desktop**: in `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), with the token's value in
place of `<token>` (or without `headers` when the server has none):

```json
{
  "mcpServers": {
    "izitest-agent": { "type": "sse", "url": "http://127.0.0.1:3467/sse", "headers": { "Authorization": "Bearer <token>" } }
  }
}
```

**First thing an agent does for a new app**: `list_projects(url)` finds the app's project,
`create_project(name, base_url)` makes it when there is none. Its tests, secrets and campaigns
belong to it. No agent needs the token for that, nor the REST API.

**The dashboard's agent** — the one behind *New test → AI Agent*, *Propose scenarios* and *Chat
with AI* — is chosen in *Settings*: a CLI it starts (Claude Code, Gemini, GitHub Copilot,
OpenCode) or a model through an API key.

## 5. Replay without windows (optional)

To run tests and campaigns out of sight, IziTest uses Chrome for Testing with its extension and
a profile of its own. Install it once from *Settings → Headless browser* (about 150 MB, in
`~/.izitest/browsers`); it then starts by itself when a run asks for it.

## Ports and environment

| Variable | Default | |
|---|---|---|
| `MCP_PORT` | `3467` | The server: MCP, the dashboard and its API |
| `WS_PORT` | `3466` | The bridge to the extension |
| `MCP_HOST` | `127.0.0.1` | Where the server listens |
| `IZITEST_TOKEN` | (none) | A token every request must carry; required as soon as `MCP_HOST` is not local ([security](security.md)) |

More in [configuration](configuration.md).

## Check that it works

```bash
curl http://127.0.0.1:3467/health
```

lists the connected Chrome profiles: one per Chrome where the extension runs. If it lists none,
see [troubleshooting](troubleshooting.md).

---
[< Introduction](introduction.md) | [Usage >](usage.md)
