# Configuration ⚙️

This document describes all the configuration options available for IziTest Agent.

---

## Environment variables

### Network ports

| Variable | Default | Description |
|----------|--------|-------------|
| `WS_PORT` | `3466` | WebSocket port for the communication with the Chrome extension |
| `MCP_PORT` | `3467` | HTTP/SSE port for the MCP server (non-stdio mode) |

**Example**:
```bash
export WS_PORT=3458
export MCP_PORT=3459
node mcp-server/server.js
```

### Access and security

| Variable | Default | Description |
|----------|--------|-------------|
| `MCP_HOST` | `127.0.0.1` | Interface the HTTP/SSE server listens on. An interface other than the loopback requires `IZITEST_TOKEN` |
| `IZITEST_TOKEN` | none | Token required on every route (`Authorization: Bearer …` or `?token=…`), except `/health` |
| `IZITEST_ALLOWED_ORIGINS` | none | Without a token: additional origins, separated by commas, whose pages can read the server's answers (e.g. a cockpit hosted elsewhere). Local pages always pass |

See [security.md](security.md).

### Secrets and the agent's questions

| Variable | Default | Description |
|----------|--------|-------------|
| `IZITEST_SECRET_KEY` | none | The key that encrypts the projects' secrets: 32 bytes in base64 (`openssl rand -base64 32`). Without it, `~/.izitest/secret.key`, created at the first secret |
| `IZITEST_SECRET_KEY_FILE` | `~/.izitest/secret.key` | Where to read or create this key (`IZITEST_HOME/secret.key` if `IZITEST_HOME` is set) |
| `IZITEST_SECRET_<NAME>` | none | Replaces the stored value of the secret `NAME`, in every project: a CI gives its own |
| `IZITEST_ASK_WAIT_MS` | `45000` | How long a call to `ask_user` waits for the answer before telling the agent to call again |
| `IZITEST_ASK_TIMEOUT_MS` | `900000` (15 min) | How long before an unanswered question is dropped, and the agent asked to stop |

See [mcp-tools.md](mcp-tools.md#secrets-what-a-test-types-without-anyone-reading-it).

### Headless browser and company network

| Variable | Default | Description |
|---|---|---|
| `IZITEST_CHROME_PATH` | none | A Chrome for Testing installed by hand (`chrome.exe`), when the download is blocked |
| `IZITEST_SYSTEM_CA` | on | `0`: do not add the system's certificates to Node's (Node 22.15 / 23.8 and later) |
| `NODE_EXTRA_CA_CERTS` | none | The company's root certificate (`.pem`), for an older Node behind a proxy that inspects HTTPS |

### Live view

| Variable | Default | Description |
|----------|--------|-------------|
| `IZITEST_LIVE` | on | `off` turns the live view off, with no way to turn it back on before a restart |
| `IZITEST_LIVE_RECORD` | on | `off` turns the continuous recording of sessions off, with no way to turn it back on before a restart |
| `IZITEST_LIVE_SESSION_MAX_FRAMES` | `300` | Stream frames kept per session (the most recent; action frames are all kept) |
| `IZITEST_LIVE_RECORD_INTERVAL_MS` | `1000` | With continuous recording off: the interval between two frames kept while a viewer is watching |
| `IZITEST_LIVE_MAX_FRAMES` | `20000` | Maximum number of frames kept (the oldest go first) |
| `IZITEST_LIVE_DIR` | `mcp-server/data/live` | Folder of the frames |

See [live-view.md](live-view.md).

---

## Claude Desktop configuration

### Path of the configuration file

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Minimal configuration

```json
{
  "mcpServers": {
    "izitest-agent": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/to/izitest-agent/mcp-server/server.js",
        "--stdio"
      ]
    }
  }
}
```

### Configuration with environment variables

```json
{
  "mcpServers": {
    "izitest-agent": {
      "command": "bash",
      "args": [
        "-c",
        "export WS_PORT=3458 && export MCP_PORT=3459 && node /path/to/izitest-agent/mcp-server/server.js --stdio"
      ]
    }
  }
}
```

---

## Operating modes

### stdio mode (recommended for Claude Desktop)

Communication over standard input/output. Uses no network port.

```bash
node server.js --stdio
```

**Advantages**:
- More secure (no port exposed)
- Starts on demand with Claude
- Recommended for Claude Desktop

### SSE mode (Server-Sent Events)

Standalone HTTP server with a web interface.

```bash
node server.js
```

**Available endpoints**:
- `http://127.0.0.1:3467/` - Web interface
- `http://127.0.0.1:3467/sse` - SSE endpoint for MCP
- `http://127.0.0.1:3467/messages` - MCP messages
- `http://127.0.0.1:3467/health` - Health check
- `http://127.0.0.1:3467/api/*` - REST API

**Advantages**:
- Visual web interface
- REST API for external integrations
- Lets you monitor the connected profiles

---

## Chrome extension configuration

### Popup settings

Click the IziTest Agent icon in Chrome to configure:

| Setting | Description |
|-----------|-------------|
| *Profile ID* | Unique identifier of the profile (e.g. `youtube-work`, `work-account`) |
| Server URL | URL of the WebSocket server (default: `ws://127.0.0.1:3466`) |

### Changing the WebSocket server URL

If you changed `WS_PORT`:
1. Click the IziTest Agent icon
2. Change the URL: `ws://127.0.0.1:YOUR_PORT`
3. Click *Save & Reconnect*

---

## Data folders

### Structure

```
izitest-agent/
├── mcp-server/
│   └── data/
│       ├── tests.db              # SQLite database
│       ├── baselines/            # VRT reference screenshots
│       └── assertion-screenshots/# Assertion screenshots
└── scripts/
    └── launch-profile.sh

~/.izitest/
└── profiles/
    ├── default/                  # Default profile
    ├── youtube-work/            # Custom profile
    └── ...
```

### Customizing the profiles folder

Edit `scripts/launch-profile.sh`:

```bash
PROFILES_DIR="/custom/path/profiles"
```

---

## Advanced options

### Character limit for snapshots

In `mcp-server/lib/tools/browser.js`:
- `MAX_SNAPSHOT_CHARS`: 30000 (by default)
- `MAX_MAPPING_CHARS`: 15000 (for screenshots)

### Command timeout

Browser commands have an implicit timeout of 10 seconds when waiting for elements.

---

## Claude Code configuration

### Add the MCP server

```bash
claude mcp add izitest-agent node /path/to/izitest-agent/mcp-server/server.js --stdio
```

### See the configured servers

```bash
claude mcp list
```

### Remove the server

```bash
claude mcp remove izitest-agent
```

---

## Summary of the configuration files

| File | Use |
|---------|-------|
| `claude_desktop_config.json` | Claude Desktop configuration |
| `scripts/launch-profile.sh` | Launching the Chrome profiles |
| `mcp-server/data/tests.db` | Tests database |
| `extension/dist/manifest.json` | The extension's manifest |
| `~/.izitest/profiles/*` | Chrome data of the profiles |

---
[< Previous: Architecture Details](architecture-details.md) | [Next: Security >](security.md)
