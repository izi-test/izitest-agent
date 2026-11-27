# Troubleshooting 🔧

This guide helps you solve common problems with IziTest Agent.

**On Windows**: where a command differs, its Windows form follows, for Command Prompt.
For PowerShell, see [the commands that differ](installation.md#commands-that-differ). The
errors of the installation itself are in
[When something fails](installation.md#when-something-fails).

---

## Connection problems

### "No profiles connected"

**Symptom**: Claude answers that no profile is connected.

**Possible causes**:

0. **Chrome may not have extensions** (a company computer)
   - Install IziTest's headless browser: *Settings → Headless browser → Install*
   - With no Chrome with the extension, agents work in it; follow them in the *Live* page

1. **The Chrome extension is not installed**
   - Check that the extension is loaded in `chrome://extensions/`
   - Turn on *Developer mode* (top right)
   - Click *Load unpacked* and choose the `extension/dist` folder
   - In Edge, the same address leads to `edge://extensions/`. *Developer mode* is at the bottom of
     the menu on the left, behind ☰ when the window is narrow. *Load unpacked* is on the
     *Developer options* line that then appears: in a narrow window, it is the first of its
     three icons, without its name
   - In Edge, without developer mode, the extension is there but turned off (*To use this
     extension, turn on developer mode.*)

2. **The extension is not connected to the server**
   - Click the IziTest Agent icon in Chrome's toolbar
   - Check that the status reads *Online* (green)
   - If it reads *Offline*, click *Save & Reconnect*, in the *Connection* tab

3. **The WebSocket server is not running**
   - Check that nothing uses port 3466:
   ```bash
   lsof -i :3466
   ```
   On Windows (the number that ends the line is the number of the process that holds it):
   ```bat
   netstat -ano | findstr LISTENING | findstr :3466
   ```
   - If it is taken, stop what holds it: often another IziTest server (see
     [Full reset](#full-reset)). Changing `WS_PORT` alone does not help: the extension connects
     to port 3466 (see
     [Changing the WebSocket server URL](configuration.md#changing-the-websocket-server-url))

4. **Firewall / antivirus**
   - Make sure localhost (127.0.0.1) is not blocked
   - Ports 3466 and 3467 must be reachable locally

---

## MCP errors

### "MCP server not found" / Claude does not see the tools

**Symptom**: The IziTest Agent tools do not appear in Claude.

**Solutions**:

Claude reaches the server in one of two ways. Check the one you set up.

**Claude connects to a server that is already running** (SSE), as in
[installation, step 4](installation.md#4-connect-your-agent):

- **The server must be running**: `curl http://127.0.0.1:3467/health` answers when it is. If it
  does not, start it (`npm start`)
- **The address** Claude is given is `http://127.0.0.1:3467/sse`
- **The token**: when the server has one (`IZITEST_TOKEN`), Claude must send it in the header
  `Authorization: Bearer <token>`. Without it, the server answers 403 and Claude has no IziTest
  tool

**Claude Desktop starts the server itself** (stdio). No other IziTest server may be running
then: the one Claude Desktop starts says `Port 3466 is already in use` and stops.

1. **Check the Claude Desktop configuration**:
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
   > **Important**: The `--stdio` flag is required!

   > **On Windows**: in this file, write the path with `/`
   > (`"C:/izitest-agent/mcp-server/server.js"`) or with each `\` doubled
   > (`"C:\\izitest-agent\\mcp-server\\server.js"`). With single `\`, the file is no longer
   > valid JSON.

2. **Restart Claude Desktop** after changing the config

3. **Check the permissions**:
   ```bash
   ls -la /path/to/izitest-agent/mcp-server/server.js
   ```
   On Windows (the file must be listed):
   ```bat
   dir C:\path\to\izitest-agent\mcp-server\server.js
   ```

4. **Test the server by hand**:
   ```bash
   cd mcp-server
   node server.js --stdio
   ```
   You should see the server start without an error.

### `self-signed certificate in certificate chain` when installing the headless browser

The company's network inspects HTTPS with its own certificate. With Node 22.15 / 23.8 or later,
IziTest trusts the system's certificates. Otherwise: `NODE_EXTRA_CA_CERTS` pointing to the
company's root certificate, or a Chrome for Testing unzipped by hand and
`IZITEST_CHROME_PATH` ([installation](installation.md#5-replay-without-windows-optional)).

### A click that "succeeds" and does nothing, then the next step fails

The application showed the button before it could respond to it. The replay now waits until it can
be clicked (nothing over it, not moving, enabled) and clicks once more if the first click changed
nothing. A link that runs over two lines (a long name in a table) is clicked in the middle of its
first line: the middle of its box fell between the two, on the cell around it.
If the step still fails with "Not clicked: … covered by …", raise the project's wait for an element.

### "Concurrent Sessions Exceeded"

The application limits the number of sessions open per account, and clearing the cookies does not
close a session on the server's side. End each test that logs in with a logout: a business step
("I log out of …") or steps whose intent says so ("Se déconnecter", "Log out").
When the test fails before it, the replay plays it anyway, in the test's tab, after the
diagnosis: the report shows these steps played after the failure, and the verdict stays a failure.

### "Access Denied" on the login page at replay

The application refuses the login page to someone who already has a session. In the headless
browser, each test starts logged out: check that *Projects → Edit → Each test starts logged out* is
ticked. In your Chrome, nothing is cleared: log out of the application before the replay.

### "Command failed" / Actions do not work

**Symptom**: Commands such as `navigate` or `click` fail.

**Checks**:

1. **Is the browser open?** IziTest Agent controls an existing Chrome instance
2. **Is the right profile selected?** Use `list_profiles` to check
3. **Is the page loaded?** Wait for the page to load before interacting

---

## Problems with elements

### "Element not found"

**Symptom**: Claude does not find an element that seems visible.

**Solutions**:

1. **Use the discovery protocol**:
   - Always start with a `snapshot()` and a `purposeFilter` (`"click"`, `"fill"`): it lists the
     elements with their `@eX` references. A `screenshot()` is the last resort, after two
     snapshots did not find the element
   - Use the `@eX` references rather than CSS selectors

2. **Wait for the page to load**:
   ```
   "Wait for .my-element to appear"
   ```

3. **Check the iframes**: IziTest Agent reaches the elements of iframes, those of another site
   (cross-origin) included: `snapshot`, `click`, `fill`, `select`, `extract` and `wait` work
   there. The content of an invisible iframe, or of one the extension cannot be injected into,
   is not in the snapshot: the limits are in [Iframes](iframes.md)

4. **Dynamic elements**: Use `snapshot(includeHidden=true)` for dropdown menus, modals, etc.

### Clicks do not work

**Symptom**: The click seems to succeed but nothing happens.

**Causes**:
- The element may be covered by an overlay
- The element needs a specific click (double click, right click)
- It is a custom element (React, Vue) that needs a specific event

**Solutions**:
```javascript
// Use execute_js for a precise click
"Run this JavaScript: document.querySelector('.my-button').dispatchEvent(new MouseEvent('click', {bubbles: true}))"
```

---

## Problems with recorded tests

### "Test not found"

**Symptom**: A saved test cannot be loaded.

**Checks**:

A test is found by its exact name, whatever its project. `list_tests` gives the names of the
saved tests: compare.

```bash
# Check the database
ls -la mcp-server/data/
```

The SQLite database should exist: it is `izitest.db`, and it holds every project, test,
requirement and campaign. If it is corrupted, do not delete it. Stop the server, which keeps it
open, then set it aside with its files `izitest.db-wal` and `izitest.db-shm`:
```bash
mkdir mcp-server/data/old
mv mcp-server/data/izitest.db* mcp-server/data/old/
```

On Windows, `dir mcp-server\data` lists the folder. The database is `izitest.db`, with its files
`izitest.db-wal` and `izitest.db-shm`. To start again from an empty database, stop the server first:
while it runs, Windows refuses to touch it ("… being used by another process"). Then set
these files aside:

```bat
mkdir mcp-server\data\old
move mcp-server\data\izitest.db* mcp-server\data\old
```

At the next start, the server creates a new database. Your projects and your tests stay in `old`.

### The test fails at a specific step

**Symptom**: A test used to work but fails now.

**Common causes**:
- The structure of the site has changed
- A popup/cookie banner blocks the interaction
- The site loads more slowly

**Solutions**:
1. If the error says "not found within 10 s" and the page takes time to load, raise the
   project's wait for an element: *Projects → Edit → Wait for an element* (10 s by default, up to
   120 s)
2. On the test's page, *Ask the agent*: "this test fails, repair it". The agent runs the test
   again, redoes the step where it stopped, records it and confirms by replaying it
3. With your own agent: `fix_test_step` to update the failing step
4. Add a `wait` step before the step that fails
5. Use `add_assertion` to check the state before going on

### *Ask the agent* answers "works with Claude Code for now"

**Symptom**: on a test's page, the *Ask the agent* window shows a message instead of the
conversation, and the input area is greyed out.

**Cause**: a test's conversation needs an agent that keeps IziTest's tools from one message to
the next. Today that is Claude Code. The API agent and the other CLIs (Copilot, Gemini,
opencode) cannot do it yet.

**Solution**: *Settings → AI agent → CLI*, provider *Claude Code*.

### A test's agent "no longer remembers"

**Symptom**: in a test's conversation, the agent reads the test again from the start instead of
going on.

**Cause**: each message resumes Claude Code's session. If it was cleaned up (or if the
server runs on another machine), the agent starts again from the test as it is and from the
conversation's history. Nothing that was changed in the test is lost.

### "Cannot find context with specified id" in a check

**Symptom**: a check right after a click that changes the page fails with
`Error: Protocol error (Runtime.evaluate): {"code":-32000,"message":"Cannot find context with specified id"}`.

**Cause**: the connection kept for the tab still pointed to the previous page. Since this
version, `execute_js` (which checks use too) reconnects to the page and runs the read again,
as the replay's actions already do. Rebuild the extension
(`npm --prefix extension run build`) and, when running headless, restart the headless Chrome.

### A step without locators fails right away ("Element not found", "is covered")

A step recorded with only a selector or a text, without locators, now waits like the others: up
to the project's wait (10 s by default), as long as its element is not there yet or a loading
overlay covers it. If it still fails after that wait, its selector matches nothing on the page:
fix the step (`fix_test_step`, or choose one of the project's elements in the step editor).

### A click on a menu link "succeeds" but the page does not change

On a page that is still being drawn, the first click can be lost while the DOM is still
moving. For a link to another page, the replay now counts only the opening of that page as the
click's effect. Without it, it clicks once more.

If the step still goes through "variable", the click was recorded as the choice of a list
item (a `list_item` variable). That path does not make these checks. For a menu, it is not a
piece of the test's data: remove the variable from the step so that it is played by its
locators. Recordings made since this version no longer make a variable of a click in a menu, a
tab bar or a side menu: only older tests have them.

### A click goes to another element that has the same text

A step's locators all look at the same time. A text ("chocolat") can be on the page before the
element wanted (the list of suggestions not open yet). Now, a less precise locator found
first waits up to 1 s for a more precise locator (CSS, test ID, attribute, accessible name) still
looking, and that one is taken if it comes. The report says which locator the step was found by
("via css", "via text"): a click "via text" on a step that has a precise selector deserves a
look.

### A click "succeeds" but nothing opens, one run in two

The click's step is green, and it is the next one that fails: the window, the menu or the form
the click was to open is not there ("not found within 10 s"). In the run's video, the page is
still being drawn when the click is made (empty images, the cart still waiting).

The click came right after an action that opened this page: the button was shown, but the page's
scripts had not run yet, and nothing was listening to it. The replay now waits for the page to have
finished loading before it acts (up to 15 s), then clicks once more when a click had no effect at
all. If the problem persists, the page wires its buttons after it has loaded: add, right
before the click, a check of an element that appears only once the page is ready (the test's
*Steps* tab) — the replay waits there until it is shown.

### A check at the end of the test fails though it passed when recording

The checks are all at the end of the test, after several actions. While recording, the agent gave
each page the time to load; at replay, the actions follow one another, and an action can
interrupt the loading that the one before started (a tab clicked right after another). The
failure's screenshot shows the page as it was.

Put each check right after the action whose result it checks (the test's *Steps* tab, the
*Move up* / *Move down* buttons): at replay, it waits there for what it checks to appear before
the next action. Agents now do so while recording.

---

## Performance problems

### Commands are slow

**Causes**:
- Too many tabs open
- Chrome is overloaded
- The website is slow

**Optimizations**:
- Close the tabs you do not need
- Narrow the snapshot to reduce the size of the data: `snapshot(purposeFilter="click")` or
  `snapshot(purposeFilter="fill")` keeps only what can be clicked or filled in, and `searchText`
  only the elements whose text matches. `compact` is already on by default
- Limit the depth with `maxDepth` in snapshot

---

## Advanced diagnostics

### Check the state of the system

```bash
# 1. Check the server
curl http://127.0.0.1:3467/health

# 2. Check the connected profiles
# In Claude: "List the connected profiles"

# 3. Check the logs
# In the mcp-server folder, look at the errors in the console
```

On Windows, in PowerShell, type `curl.exe` in place of `curl`. A server started in the
background (`npm --prefix mcp-server run ensure`) has no console: its messages are in
`mcp-server\data\server.log`.

### Debug mode

There is no debug mode to turn on, and the server reads no `DEBUG` variable: it always writes
what it does, the commands sent to the browser (`[OUT]`) and their answers (`[IN]`) included. To
see the communications in real time, look at:

- the console the server runs in, when it was started with `npm start`
- `mcp-server/data/server.log` (on Windows, `mcp-server\data\server.log`), when it was started
  in the background with `npm --prefix mcp-server run ensure`
- `curl http://127.0.0.1:3467/health` for the server's state: it answers with the connected
  profiles and how long the server has been running

### Full reset

If everything seems stuck:

```bash
# 1. Quit Claude Desktop

# 2. Kill the running processes
killall "Google Chrome"
pkill -f "izitest-agent"

# 3. Check the ports
lsof -i :3466,3467

# 4. Restart Chrome with the profile
./scripts/launch-profile.sh default

# 5. Reinstall the extension if needed

# 6. Restart Claude Desktop
```

On Windows, steps 2 to 4 are done this way, from IziTest's folder:

- **Close the tests' browser.** This command closes every Chrome window, yours
  included. For Edge, write `msedge.exe`.

  ```bat
  taskkill /IM chrome.exe /F
  ```

- **Stop the server.** The first command shows what listens on its two ports. The number
  that ends the line goes in place of `<number>` in the second. Run again afterwards, the
  first must no longer show anything.

  ```bat
  netstat -ano | findstr LISTENING | findstr ":3466 :3467"
  taskkill /PID <number> /T /F
  ```

- **Restart the browser with the profile.** The command starts Chrome, or Edge where Chrome
  is not installed.

  ```bat
  powershell -ExecutionPolicy Bypass -File scripts\launch-profile.ps1 default
  ```

---

## Getting help

If the problem persists:

1. **Collect the information**:
   - Chrome's version (`chrome://version`)
   - The output of `curl http://127.0.0.1:3467/health`
   - The exact error messages

2. **Check the logs**:
   - Claude Desktop's console (Help > Toggle Developer Tools)
   - The Chrome browser's console (F12)
   - The console of the extension's service worker (`chrome://extensions/` > Service Worker)
   - In Edge, the same addresses lead to `edge://version` and `edge://extensions/`, where the
     service worker's link reads *service worker*

3. **Test with the minimum**:
   - A single profile
   - A single simple page (e.g. example.com)
   - A single command (`navigate`)

---
[< Previous: Security](security.md) | [Next: Usage >](usage.md)
