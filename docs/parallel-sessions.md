# Parallel sessions 🧵

Several agents can drive the browser **at the same time**, each in its own Chrome
window, without stepping on each other.

## The principle

**One MCP connection = one session = one window.**

A session has, all to itself:

| What is isolated | Why it matters |
|---|---|
| The working tab | Each command is pinned to the session's tab. A `click` without `tabId` can no longer land in another agent's window. |
| The ref map (`@eX`) | Agent B's `snapshot` no longer overwrites agent A's — which, otherwise, silently clicked the wrong element. |
| The recording in progress | Two agents can record two tests at the same time without their steps interleaving. |
| The action history (`act_N`) | `fix_test_step` only sees the actions of its own session. |

There is **nothing to do** to benefit from it: each agent that connects to the server
gets its session automatically, and its window opens at the first `navigate()`.

### `navigate()` first, always

A session **without a window refuses to act**. A `snapshot` or an `execute_js` before the
first `navigate()` fails with:

> This session has no window of its own yet, so there is no tab to act on. Call navigate()
> first — it opens one — or pass an explicit tabId to work in a tab that already exists.

There is deliberately **no fallback to the foreground tab**: that tab is either another
agent's work, or the page the user is reading. Handing it to an agent would disclose
what the user is looking at.

To act deliberately in an existing tab, pass an explicit `tabId`. `get_tabs()` lists
them with the **owner** of each:

| `owner` | Meaning |
|---|---|
| your session id | your working window |
| another session id | another agent is working there — do not touch it |
| `user` | one of the user's tabs — do not act on it unless you are asked to |

### Popups opened by a page

A window that a page of the session opens itself (`window.open`, "Continue with
Google") **belongs to the session**. `click` returns its `newTabId`, with which you drive it,
and `get_tabs()` shows it with the same `owner`, plus an `openedFrom` field that gives the
working window it came from. Commands without `tabId` stay in the working window: they never
switch to the popup.

- `close_window({ tabId: <the popup's tab> })` closes **only the popup**.
- `close_window()` closes the working window **and the popups it opened**.

A popup opened from one of the user's windows stays the user's. After the extension is
reloaded, the server only restores the working windows: a popup still open becomes `user`
again and is closed by hand.

## The special case: several agents on a single connection

Subagents (`Task` in Claude Code, for example) all talk through their parent's MCP
connection. For them, "one connection = one session" is not enough: they would share
a single window.

Each subagent then picks a distinct session name and passes it on every call:

```js
open_session({ session: "recherche-A" })          // optional, informative
navigate({ url: "https://exemple.fr", session: "recherche-A" })
snapshot({ purposeFilter: "click", session: "recherche-A" })
click({ ref: "@e5", session: "recherche-A" })
close_session({ name: "recherche-A" })            // closes its window
```

Another subagent does the same with `session: "recherche-B"`: two windows, two sets of
refs, no interference.

### Session tools

| Tool | Role |
|---|---|
| `open_session` | Claims a session (or describes the one you are already in). |
| `list_sessions` | Lists the active sessions and the window of each — handy to check the isolation. |
| `close_session` | Closes a named session and its window. |

When an agent disconnects, its session's state is freed but **its window stays
open**: an SSE reconnection arrives with a new id, so closing automatically would
destroy a working window at the slightest network incident. It is `close_window` (or
`close_session` for a named session) that closes, explicitly, at the end of the
task. The server logs the windows left open. If the user has chosen so
(**Settings → Browser windows**), the window of a recording is also closed once
`stop_recording` has saved the test, and that of a successful `run_test` at the end of the run
(see [mcp-tools.md](mcp-tools.md), "The windows after a run or a recording").

## A single, shared server

IziTest Agent has only **one** WebSocket bridge to Chrome (port 3466) and **one** MCP endpoint
(port 3467). A second server cannot work: it refuses to start on a port already taken,
rather than kill the one that is running.

So agents never start the server directly. They go through:

```bash
node mcp-server/bin/ensure-server.js
```

which starts the server **only if it is not already there**, and which is safe when several
processes call it at the same instant: an exclusive lock names a single starter, the
others wait for `/health` to answer. The logs go to `mcp-server/data/server.log`.

In this repository, a `SessionStart` hook (`.claude/settings.json`) calls it automatically.

Clients then connect over SSE:

```json
{
  "mcpServers": {
    "izitest-agent": { "type": "sse", "url": "http://127.0.0.1:3467/sse" }
  }
}
```

> **The stdio mode (`server.js --stdio`) stays reserved for a single agent.** It starts its
> own WebSocket bridge, so two agents in stdio would fight over port 3466. For parallel
> work, it is SSE.

### `MCP_HOST` adds an interface, it does not remove one

The server **always** listens on loopback. `MCP_HOST` adds an extra interface
(LAN, Tailscale); it no longer replaces loopback.

Without that, `MCP_HOST=100.x.y.z` made the server unreachable from its own machine:
neither the dashboard, nor `.mcp.json`, nor the extension reload could reach it.
Adding loopback widens nothing — it is the default posture, reachable only from the
machine that already runs the piloted browser.

### With a token

As soon as `MCP_HOST` goes beyond the machine, `IZITEST_TOKEN` is mandatory, and it is
required **on both interfaces** (loopback included). Two local consequences:

- `.mcp.json` must carry the header — without ever writing the secret in the file:

  ```json
  "headers": { "Authorization": "Bearer ${IZITEST_TOKEN:-}" }
  ```

- `npm run build` in `extension/` reads the same token from the environment to be able to
  reload the extension.

So `IZITEST_TOKEN` must be exported in the shell where Claude Code and the builds
run — the same value as the one given to the server. Otherwise the build prints
"requires a token and IZITEST_TOKEN is not set in this shell" and the MCP tool
answers 403.

## Reloading the extension after a build

`npm run build` (and each rebuild of `npm run watch`) **reloads the extension in Chrome
by itself**: the server pushes the request down the WebSocket it already holds, and the
extension restarts itself through `chrome.runtime.reload()`. No more need to go through
`chrome://extensions`.

```bash
cd extension && npm run build
# → Build complete!
# → [IziTest] Extension reloaded in Chrome (1 profile).
```

The reload is **verified, not assumed**: a reloaded extension drops its socket and
registers again, and it is this new registration that the server waits for before answering.
An extension running a build from before this mechanism simply ignores the
message — the build says so, instead of announcing a success that did not happen.

> **Bootstrapping**: the very first reload after this feature arrives must be done
> **by hand** in `chrome://extensions`, since the loaded extension does not know the
> message yet. Once only; after that it reloads by itself.

If the server is not running, or no extension is connected, the build prints what to
do and **never fails**. `IZITEST_NO_RELOAD=1` disables the mechanism.

A restart of the extension empties `chrome.storage.session`, so it forgets which window
belongs to which session. The server, for its part, remembers: as soon as the extension
reconnects, it **assigns back** to it the windows of its sessions (`restore_owned_windows`).
Without that, `close_window` would refuse these windows and tab resolution would stop being
isolated after each rebuild.

> The reload cuts the WebSocket: a command in flight is lost. So avoid rebuilding
> while an agent is working.
>
> The endpoint that triggers all this, `POST /api/dev/reload-extension`, follows the same
> rules as the rest of `/api/`: loopback by default, token required as soon as `MCP_HOST`
> goes beyond the machine.

## Seeing what the extension says

The service worker's console is only visible by opening its DevTools by hand, which
leaves a test run blind to what the extension reports. So it sends to the server
everything that would land in the "Errors" list of `chrome://extensions`:

```bash
curl -X DELETE http://127.0.0.1:3467/api/dev/extension-errors   # before the run
curl        http://127.0.0.1:3467/api/dev/extension-errors      # after
```

A run can thus assert that it produced **no** extension error, instead of hoping
so. Entries of type `dead-tab` are benign rejections (a tab closed in the
meantime): they are reported here but kept out of Chrome's error list.

## What is *not* isolated

Sessions share **the same Chrome profile**, so the same cookies and the same
logins. Two sessions cannot be signed in to two different accounts of the same
site.

For that, you need real, separate Chrome profiles — see [multi-account.md](multi-account.md)
— and to pass `profile: "<id>"` in addition to `session`.

## Checking that it works

```bash
cd mcp-server && npm test   # isolation, 5 concurrent sessions, refusal of the foreground tab
cd extension  && npm test   # window registry under concurrency, tab resolution
```

In real conditions: start two agents, then ask one of them for `list_sessions()`.
Two lines with two different `window=`, and it works.
