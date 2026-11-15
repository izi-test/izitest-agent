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

### The token (`IZITEST_TOKEN`)

IziTest does not give you a token: you make one up, and the server then refuses every request
that does not carry it (403).

- **The server stays on this machine** (`MCP_HOST` left at `127.0.0.1`): no token is needed.
  Skip this part, and drop `-H "Authorization: …"` from the commands below.
- **The server can be reached from another machine** (`MCP_HOST` set to a LAN, Tailscale or
  public address): a token is required; without one the server does not start.

1. Make a random value:

   ```bash
   openssl rand -hex 32
   ```

2. Keep it in your shell profile (`~/.zshrc` on macOS, `~/.bashrc` on Linux), the value in place
   of `<value>`, then open a new terminal:

   ```bash
   echo 'export IZITEST_TOKEN=<value>' >> ~/.zshrc
   ```

3. Start the server from that terminal, or restart it so that it reads the token:

   ```bash
   pm2 restart izitest-agent --update-env
   ```

Every client then sends the same value: `claude mcp add … -H "Authorization: Bearer
$IZITEST_TOKEN"` (next section) and `bin/campaign.js` read it from the shell; Claude Desktop needs
the value itself in its configuration. A CI job gets it as a secret of the pipeline.

To see the token the server runs with: `pm2 env <id> | grep IZITEST_TOKEN` (`pm2 list` gives the
id). To change it, do steps 1 to 3 again, then run `claude mcp add` again in each folder where
you ran it.

**The dashboard in a browser** asks for the token once: paste it in the sign-in page, and that
browser stays signed in for 30 days. It then holds a cookie derived from the token, not the token
itself; a new token signs every browser out. Each person who opens the dashboard needs the token,
so give it as you would a password.

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

A CLI works with the model set in *Settings → Model*, passed as `--model`. Left empty, the CLI
picks. For Claude Code, that is the model `/model`, its `settings.json` or `ANTHROPIC_MODEL` sets
on this machine, else the account's default. Claude Code takes an alias (`fable`, `opus`,
`sonnet`, `haiku`: the latest of that family) or a full name (`claude-opus-5-5`); OpenCode takes
`provider/model`. *Test* asks Claude Code one word and shows which model answered, or why it did
not (a model that does not exist, or that the account cannot use).

## 5. Replay without windows (optional)

To run tests and campaigns out of sight, IziTest uses Chrome for Testing with its extension and
a profile of its own. Install it once from *Settings → Headless browser*, or from a terminal on
Windows, macOS or Linux (about 150 MB, in `~/.izitest/browsers`); it then starts by itself when a
run asks for it:

```bash
npm run headless:install
```

It does not stay open on your computer for nothing: after 10 minutes without work (no run,
campaign or recording in it) it stops, and the next run that needs it starts it again, which
takes a few seconds. Change the delay in *Settings → Headless browser → Stop after* (0: it runs
until the server stops). It always stops with the server.

**Behind a company proxy** that inspects HTTPS (Zscaler, a PKI of the company), the download can
fail with `self-signed certificate in certificate chain`: Node does not trust the company's root.
- With Node 22.15 / 23.8 or later, IziTest trusts the system's certificates as well, by itself
  (`IZITEST_SYSTEM_CA=0` turns it off).
- Otherwise, give Node the company's root certificate (ask your IT for the `.pem` file):
  `NODE_EXTRA_CA_CERTS=C:\certs\company-root.pem` (on Windows, set it with `setx`, then open a new
  terminal and restart the server).
- Where the download is blocked altogether, unzip Chrome for Testing by hand from
  <https://googlechromelabs.github.io/chrome-for-testing/> and set `IZITEST_CHROME_PATH` to its
  `chrome.exe` (or `chrome`).

**Each test starts logged out** in this browser: what the app left there (cookies, storage) is
cleared before a test played from its first step, so that a session kept from the test before, or
from the agent recording it, cannot lead the app elsewhere (a login page answering "Access Denied"
to a user already logged in). Never in your own Chrome. Untick *Projects → Edit → Each test starts
logged out* for an app whose tests count on staying logged in from one to the next.

**When Chrome may not have extensions** (a company computer that blocks them), skip step 2 and
install this browser instead. With no Chrome with the extension connected, agents work in it:
they record tests there, and runs not asked headless go there too. Nothing shows a window;
follow the agents in the dashboard's *Live* page. Its cookies and logins are its own, so a test
of an app behind a login logs in itself. IziTest waits 30 s after your Chrome disconnects before
it does this, so a Chrome that restarts its extension keeps the agent's session. Check first that
your company allows a second browser: blocking extensions is often a security rule.

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
