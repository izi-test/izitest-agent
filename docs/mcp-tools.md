# MCP Tools Reference 🛠️

IziTest Agent exposes two main categories of tools via the Model Context Protocol (MCP): **Browser Interaction** and **Test Automation (Recording/Replay)**.

## 1. Browser Interaction Tools

These tools are used for direct, real-time control of the browser.

| Tool | Description | Key Parameters |
| :--- | :--- | :--- |
| `list_profiles` | Lists all connected Chrome profiles. | - |
| `navigate` | Navigates to a URL. | `url`, `profile`, `tabId` |
| `snapshot` | Scans the DOM and returns interactive elements with UIDs (@eX). | `purposeFilter` (fill/click/read), `searchText` |
| `screenshot` | Takes an annotated screenshot with DOM mapping. | `annotate`, `purposeFilter`, `searchText` |
| `click` | Clicks an element. On a checkbox, radio or switch (or its label), returns the state it left (`checked`); with `checked`, sets that state and does not click when it is already so. | `ref` (@eX), `selector`, `text`, `checked` |
| `fill` | Fills an input/textarea/contenteditable. A date, time, colour or range input gets its value set instead of typed (see below). | `ref` (@eX), `selector`, `value`, `clear` |
| `upload_file` | Gives files to a file input, as picking them in the file dialog would. The ref may be the input — often hidden — or its drop zone, label or "Upload" button (see below). | `files` (paths), `ref` (@eX), `selector` |
| `drag` | Drags an element and drops it on another, with the mouse: a sortable list, a card to another column. Works with `draggable="true"` (HTML5) and with pages that follow the mouse (see below). | `ref` / `selector`, `targetRef` / `target`, `position` (center, top, bottom, left, right) |
| `explore_app` | Explores a site on its own and reports its bugs (console errors, failed requests, broken links, accessibility), each with a test that reproduces it (see below). | `url`, `max_pages`, `interact`, `checks` |
| `check_page` | Runs the same checks on the page you are on; nothing is saved. | `checks`, `since_seconds` |
| `list_bugs` | Lists the bugs, worst first, each with the test that reproduces it: those a test run met (a failure diagnosed `non_conformity` or `app_regression`) and those `explore_app` found. | `status`, `project_id` |
| `extract` | Retrieves content (text, attributes) from the page. `attribute: "value"` on a field reads what it holds now. | `selector`, `attribute`, `multiple` |
| `get_tabs` | Lists all open tabs in the browser. | `profile` |
| `get_page_info` | Detailed info (title, URL, element counts). | `tabId`, `profile` |
| `scroll` | Scrolls the page or moves to an element. | `direction`, `amount`, `selector` |
| `wait` | Pauses for a duration or until an element appears: as long as the project waits for an element (10 s by default), or `timeout` (ms, from 1 s to 5 min, rounded up to whole seconds) for what takes longer — an export built, a report computed. It then answers `found: false`. Its own `timeout` is kept with the step and replayed; without one, the replay waits as long as the project says then. One of `ms` and `selector` is needed: a `wait` with neither is refused, not recorded. In a replayed test, a wait whose element never appears fails its step: before, the replay went on, and the test failed further on, on another page, for the wrong reason. | `ms`, `selector`, `timeout` |
| `execute_js` | Runs arbitrary JavaScript in the page context. Recorded as a step while a test records — to only read the page, use `extract` or `snapshot`, which are not. | `code` |
| `keyboard` | Sends a key press event. | `key`, `modifiers` |
| `get_cookies` | Retrieves cookies for a URL/domain. | `url`, `domain` |

#### Special fields

- **Date, time, colour, slider** (`date`, `time`, `datetime-local`, `month`, `week`, `color`,
  `range`): `fill` sets their value from the page, then sends `input` and `change`, as Playwright
  does. Typing did not work: the date stayed empty (its segments follow the order of the browser's
  language), the colour opened the system's picker, the slider went where the click landed. The
  expected format is HTML's: `1990-05-12`, `09:30`, `#ff5500`, a number on a step of the slider. A
  value the field would refuse (`12/05/1990`, `85` with a step of 10) is refused with the expected
  format, and the field keeps its value.
- **Editable text** (`contenteditable`): listed as `[textbox]` by the snapshot, with its text in
  `value="…"`, and filled like a field.
- **Clearing before typing**: all the text is selected, and typing replaces it. Backspace is now
  used only for an empty value: on an empty tag field, it used to delete the last tag.
- **Name of a field**: a field's value is its name only for a button (`<input type="submit">`).
  A colour, a slider, a prefilled field with no label are no longer named `#6c5ce7` or `60`, which
  changed at the first `fill`.
- **Uploading files** (`upload_file`): the files are read on IziTest Agent's machine (absolute
  paths, or relative to its working folder; 25 MB at most per step), then set in the
  `<input type="file">` from the page, which receives `input` and `change` as after the file
  dialog. Chrome's own way (`DOM.setFileInputFiles`) is not taken: it is refused to an extension
  that does not have access to file URLs, which is off by default. The ref may be the input
  — often hidden, absent from the snapshot — or what surrounds it: the drop zone that contains it,
  its `<label>`, or the "Upload" button placed beside it (the only file input of the nearest
  ancestor that has one). The recorded step is that of the input itself (`#avatar-input`), on
  which the generated code sets the files. A drop zone with no input at all is not handled.
  Once recorded, a file becomes a variable of type `file` (`{{avatar}}`), which `run_test` can
  change; in Playwright, `page.setInputFiles('#avatar-input', …)`, preceded by a `// FIXME`
  when the path is that of the machine that recorded — to copy into the project; in Gherkin,
  `When I upload "<avatar>" to "#avatar-input"` (a single file: several have no phrase).
  An assertion on the name shown (`✓ avatar.png`) stays literal: only the path is variable.
- **Drag and drop** (`drag`): the mouse presses the element, goes to the target in several
  moves, and releases. A page that follows the mouse (SortableJS in fallback mode, dnd-kit, jQuery UI)
  needs nothing else. A `draggable="true"` element starts Chrome's drag and drop, which mouse
  events sent through CDP never finish: it is intercepted (`Input.setInterceptDrags`) and carried
  through to the drop by `Input.dispatchDragEvent` — the page receives Chrome's `dragenter`,
  `dragover`, `drop` and `dragend`, `dataTransfer` included, as with Playwright's `dragTo`. The
  result says which one was used (`drag: "native"` or `"mouse"`) and, in `changes`, whether the
  dragged element moved. `position` is the place on the target where it is dropped: its centre, or
  a quarter of the way in from its top, its bottom, its left or its right — in a vertical list,
  `top` puts it before the target, `bottom` after. Both must fit on screen together: `drag` does
  not scroll the page while it holds the element.
  The snapshot lists what can be dragged, named by its text:
  `[generic] "⠿ Cost Efficiency #5" [draggable]`, or `[cursor=grab]` for a page that follows the
  mouse (also with `purposeFilter: "click"`). An element nothing names (no test ID, no id, no name)
  is recorded by its `data-id`, `data-value` or `data-key` if it is the only one to have it —
  `div[data-value="cost"]` — rather than by its position, which sorting changes. The target is kept
  with its own locators (`params.targetLocators`), which the replay tries like those of the dragged
  element. In Playwright, `await page.locator(…).dragTo(page.locator(…))`, with `targetPosition`
  computed on the target's box for an edge; in Gherkin, `When I drag "…" to "…"` and
  `When I drag "…" to the top of "…"`.
- **Click by text** (`click({ text })`): the text aimed at is first that of a visible control —
  "Sign in" is the button, not the form's heading just above it, which came earlier in the page
  and took the click (and the list detection at the end of the recording made a "list item" of
  it). On export, such a click goes to the recorded role and name (`getByRole`), otherwise to the
  text (`getByText`) — it used to come out as `page.click('')`; in Gherkin,
  `When I click on the text "…"`.
- **Field named by its label** (Gherkin, no selector): `When I fill the field "Email" with "…"`,
  `When I select "…" in the field "Subject"`, `When I check the field "Remember me"` and
  `When I uncheck the field "…"` give `fill`, `select` and `click` a `label` instead of a
  `selector`: a scenario written without having seen the page (`design_tests`) can name a field.
  The extension looks for it as Playwright's `getByLabel(…, { exact: true })` does: its
  `aria-labelledby`, otherwise its `aria-label`, otherwise its `<label for>` or the `<label>`
  around it — the label's whole text, spaces collapsed, case included (`Phone *` for
  `<label><span>Phone</span> <em>*</em>`) —, or lastly its `placeholder`. It takes the first one
  that is visible, in page order (same-origin iframes included): on the Test Arena, "Email" is the
  login's field, not that of the contact form further down. A checkbox the page draws itself (the
  input invisible, with no size) is clicked by its label. A field not shown yet is waited for 5 s;
  a label that cannot be found fails, citing the fields present:
  `No field labelled "Courriel" (…). Fields on the page: "Email", "Password", …`. What is typed
  becomes a variable named after the label (`{{email}}`).
  The export is described further down (*Fields named by their label on export*).
- **Checkbox or radio in `display: none`** behind a visible label (the stars of a rating): listed
  and handled through its label, with its value when its name does not say it:
  `[radio] "★" value="4" [unchecked]`.

### Recommended Workflow: The Element Discovery Protocol
To ensure high reliability, follow this sequence when interacting with elements:
1.  **Step 1**: Use `screenshot()`. It's the most robust way to find elements, even in complex SPAs.
2.  **Step 2**: If the element isn't in the mapping, use `snapshot(includeHidden=true, purposeFilter="...")`. Use `searchText` to narrow down the results.

---

## 2. Test Automation Tools (Recording & Replay)

These tools allow you to record sequences of actions and replay them autonomously.

| Tool | Description |
| :--- | :--- |
| `list_projects` | Lists the projects (id, name, base URL, language of their tests, number of tests). With `url`, only those of that app: its URL starts with their base URL, or shares its origin. The first call for a new app. |
| `create_project` | Creates a project: `name` (unique), `base_url`, `language` (`en`, `fr`), `description`, `context`, `project_type`. A name taken answers with the project that has it; another project of the same app is pointed out. Its id is the `project_id` of the tools below. |
| `start_recording` | Starts recording a new test. All subsequent browser actions are auto-recorded. `project_id`: the project the test is saved in, whose datasets it reads while recording (`{{users[1].email}}`); with `dataset`, it plays one — `{{email}}` types its row 1, and the test is bound to it (see Datasets). With `scenario` (a Gherkin feature, as written), the test is recorded phrase by phrase: the answer numbers the phrases and says how to do each (see "A test written in Gherkin first"). |
| `start_phrase` | Recording a scenario (`start_recording` with `scenario`): before the actions of each phrase, its `number` (and the `phrase`, shown to the user). The steps recorded until the next call are that phrase's: a new phrase becomes a business step of the project made of them at `stop_recording`. |
| `record_step` | Optional: steps record themselves. Names the variable of the step an action recorded (`action_id`, `variable_name`: what a fill typed becomes `{{email}}` instead of a name taken from its field), keeps its value fixed (`skip_variable`), changes its intent, makes it optional (`optional`), removes it (`remove`: an `execute_js` that only looked at the page, an action done by mistake), or says how a click found in a list is meant (`pick`: `none`, `by_place`, `by_text` — the click's result says what it was taken as). |
| `stop_recording` | Stops the recording and saves the test. Performs batch variable detection. It first waits for the actions still under way (up to 30 s), so one sent in the same message is recorded. A last `wait` for an element is kept: it checks what the test did (before, every wait at the end was dropped as an artifact). One of a time only, at the end, is not, and the answer says what was not kept. When the user chose so (**Settings → Browser windows**), the window the test was recorded in is closed once it is saved, and the answer says so. |
| `list_tests` | Lists all saved tests, their variables, and how many rows each plays. |
| `run_test` | Executes a saved test autonomously in the browser. Supports variable overrides. A test with rows (its own, or those of the dataset it is bound to) plays every row, a run each, and says how each did; `row` plays one (see Test data: the rows of a test). A failure is diagnosed on the spot, with a repair proposed when the test broke (see below). |
| `save_test_rows` | Saves the rows of a test — the table of its Data tab: a row per run, a value per variable by its name; `rows: []` removes them (see Test data: the rows of a test). |
| `save_requirement` | Saves a requirement — from a request, written by hand, or an issue of a tool (a Jira story) — with its acceptance criteria (see below). |
| `import_requirements` | Imports requirements from a file — CSV, TSV, Excel, a Jira CSV export, JSON, Markdown, Word `.docx`, a Postman collection, an OpenAPI document —, a dry run first (see below). Any other document (a PDF, an email, notes): the agent reads it and passes its requirements as Markdown `content`. |
| `import_from_connector` | Reads requirements from a tool set in the dashboard (a connector: Jira, GitHub Issues) — a query, their keys, or again (`sync`) —, a dry run first (see below). |
| `send_coverage` | Tells a tool where each requirement imported from it stands — a campaign's, or those of their keys — as IziTest's comment on it (Jira), updated after; a dry run first (see below). |
| `design_tests` | Lays out how to design a requirement's tests: its criteria, its cases, the app, the project's Gherkin phrases, and the method — review, what is left unsaid, scenarios by test technique (see below). |
| `plan_tests` | Plans a requirement's test cases: per criterion, nominal, alternative, error, boundary — with their technique, priority and scenario in Gherkin; says which scenarios are ready and which have steps to record. |
| `link_test` | Links a saved test to a requirement: to a planned case, a criterion, or the whole requirement. |
| `get_requirement` / `list_requirements` | A requirement with its criteria, cases, tests and coverage; or all of them with their coverage. |
| `list_repairs` | Lists the repairs proposed for failed runs, and where each stands. |
| `verify_repair` | Replays the test with a proposed repair made, without saving it. |
| `resolve_repair` | Applies a repair to the saved test, or rejects it — on the user's word. With `all_uses: true`, the other steps acting on the same element get the new locators too. |
| `run_campaign` | Replays a project's tests, a requirement's, a list, or those a change needs (`changed_files`), together, for a version of the app, and answers with the report (see below). |
| `plan_regression` | The tests of a project a change needs — its changed files, the routes it touches, the requirements its commit names —, each with why, and those left out with why; nothing is run (see below). |
| `get_campaign` / `list_campaigns` / `stop_campaign` | A campaign's report; the campaigns, newest first; stop one that runs. |
| `send_results` | Sends a campaign's results to a tool (a connector: Xray, a Test Execution, each test linked to the stories it covers); a dry run first (see below). |
| `add_assertion` | Adds a check (e.g., "element exists", "text does not contain") to a test. While the test is recorded, the check is recorded as the next step, right after the action whose result it checks (see below); on a saved test, it goes at the end or at `step_order`. A value the test typed in it is saved as its `{{variable}}`. `tabId` checks it in another tab, e.g. the one `run_test` ended on. On a test linked to a requirement, `non_conformity: true` saves the requirement's expected value even though the page does not show it. |
| `set_step_optional` | Makes a step of a saved test optional (a cookie banner, a popup only shown sometimes): when it fails on a replay, its failure is told and the test goes on. `optional: false` makes it required again (see below). |
| `fix_test_step` | Updates a failed step with data from a manual action. |
| `get_test` | Reads a saved test as it is now: its steps, numbered (what each does, on what, with which value), its variables, the rows it plays, how its last run went and the repairs proposed. The numbers are the ones the tools below take (see below). |
| `add_test_step` | Adds a step to a saved test: the browser action just done (`action_id`), put at `step_order` — the steps from there move down. Without `step_order`, at the end. |
| `delete_test_step` | Deletes a step of a saved test; the steps after it move up by one. |
| `update_test_gherkin` | Rewrites a saved test from its Gherkin, edited: a phrase left as it was keeps its step as recorded, a new one must read as a phrase of the project — one that does not is refused, and nothing is saved. |
| `delete_test` | Removes a saved test from the database. |
| `add_retroactive_vrt` | Adds a visual regression test assertion retroactively using a recorded baseline. |
| `get_test_as_code` | Returns a saved test as Playwright code to commit in the project under test (see below). |
| `create_business_step` | Groups a run of steps of a recorded test into one business Gherkin step (see below). |
| `add_test_variable` | Turns a recorded value (e.g. a city inside a URL) into a `{{variable}}` of the test (see below). On a step already holding a variable recording made (`{{input_9}}`), renames it everywhere the test uses it and gives it `default_value`. |

### Checking while recording

During a recording, `add_assertion` with the name of the test being recorded checks the page as it
is at that moment and records the check as the **next step**, right after the action whose result
it checks. On replay, a check waits in its place for what it checks to appear (up to the project's
wait for an element) before the next action.

Checked all at the end, the checks were made on the last page, and the replay chained the actions
without waiting for what each one brings: on a record page with tabs, a second tab clicked 0.4 s
after the first kept the first from loading, and the check of its content, at the end of the test,
failed. The agents' instructions (MCP and dashboard) therefore ask them to check each result right
after its action.

- **`step_order`** is not used during the recording: the check goes after the last action.
- **What the test typed** and the check expects ("Welcome Bernadette") is linked to its
  variable at `stop_recording` ("Welcome {{first_name}}"), as on a saved test.
- **On a test already saved**, `add_assertion` checks the page as it is now: give a `step_order`
  only if the page shown is the one that step sees.

### Video of a run

Every run is recorded on video; the video is kept if the test fails, or with
`run_test(…, record_video: true)` / `run_campaign(…, record_video: true)`. `run_test` says when a
video was kept; it is watched in the dashboard (the test's *Runs* tab, *Video* button), with the
steps beside it. See [the live view](live-view.md#the-video-of-a-run).

### Optional steps

An **optional** step may not be done at every run: a cookie banner or a popup that only shows
sometimes, a guided tour to close. When it fails on a replay, its failure is told (the step is
marked *skipped*, with its error) and the test goes on: it passes if the rest passes. It waits for
its element like any step (the project's wait, 10 s by default).

- **In the dashboard**: the ◌ button on the step's row (*Steps* tab), which then shows the
  *optional* label. It works for a check too.
- **During a recording**: `record_step(action_id, optional: true)` on the action just done.
- **On a saved test**: `set_step_optional(test_name, step_order)`.
- `run_test` and the run report say which optional steps were not done.
- **An optional check** that does not hold is not counted as a failure. Never make optional a
  step the test checks: a failure there must fail the test.
- **In exported Playwright**, the step is in a `try { … } catch {}`.

### Changing a saved test

A saved test is changed without recording it again, from any connected agent — and from the
dashboard, in the test's conversation (*Ask the agent*, below).

- **Read it**: `get_test(name)` gives its numbered steps (what each does, on which element, with
  which value, its variable, whether it is optional), its variables, the rows it plays, its last
  run (the failed step and its error) and the repairs proposed. Read it again after each step
  added or deleted: the numbers move.
- **Add a step**: do the action in the browser, on the page as the steps before leave it, then
  `add_test_step(test_name, action_id, step_order, intent)`. The step keeps what the action
  learned about its element (selector, locators, page). Without `step_order`, it goes at the end;
  `optional: true` for a step the app does not always need.
- **Delete a step**: `delete_test_step(test_name, step_order)`. Never a check, to make a failing
  test pass.
- **Replace a failing step**: `fix_test_step`, as before.
- **Rewrite its scenario**: `get_test_as_gherkin`, change its phrases (a value in quotes, their
  order, a phrase removed, one added), then `update_test_gherkin(test_name, gherkin)` with the
  whole scenario. This is what the *Gherkin* tab does: an unchanged phrase keeps its step as it was
  recorded, a new one must be a phrase of the project. The test must belong to a project.

**After `run_test`, the session resumes on the page where the run stopped**: where the step
failed, to repair it on the spot; where the test ended, if its window stays open, to add a check
there. The next action (`snapshot`, `click`…) has no tab to name. Before, the run's window was not
the session's: the agent was answered "no window of its own", opened the application again and
repaired the step on a page the steps before had not prepared.

### A test's conversation with the agent (dashboard)

On a test's page, *Ask the agent* opens a window: on the left the agent's browser, live; on the
right the conversation. There you ask it to repair the test, to change it, to say what it checks
(`lib/agent/test-chat.js`).

- **One conversation per test**, kept with it (`test_conversations`,
  `test_conversation_messages`): opened again, it is there. *Start over* forgets it; it is
  deleted with the test.
- **Each message is a run of Claude Code** (`claude -p`, `stream-json` output), which goes on in
  its own session (`--resume`): the agent remembers what was said and done. The first message
  carries the brief: the test as it is (`get_test`), its project (URL, context, datasets, names of
  the secrets), what the agent can do and its rules. If the CLI's session is gone, the agent
  starts again from the brief and the history.
- **A single browser session** for the whole conversation, as long as its window is open: each
  run of the CLI connects with the conversation's identifier (`/sse?run=…`) and works in the same
  session (`keepRunSession`, `lib/session.js`) — same window, same refs, same actions, which a
  later message can still name (`fix_test_step`, `add_test_step`).
- **Its tools**: the browser and the test (`get_test`, `run_test`, `fix_test_step`,
  `add_test_step`, `delete_test_step`, `update_test_gherkin`, `add_assertion`,
  `set_step_optional`, `add_test_variable`, the repairs, `ask_user`…). Neither
  `start_recording`, nor `delete_test`, nor `get_tabs`, nor Claude Code's own tools (Bash,
  files, web).
- **What the window shows**: what the agent does, a line per action, in plain words
  ("Runs the test", "Repairs step 5") — never a value typed; what it says before acting joins
  this list, and its answer is what it says at the end.
- **Stop the agent** stops it; what it has already changed stays. **Closing the window** closes
  the agent's browser window (once the run under way is over, so that it is not kept as failed);
  with no message for 30 minutes, it is given back the same way
  (`IZITEST_TEST_CHAT_IDLE_MS`).
- **Without a window** when *Headless* is checked: the whole session works in the headless
  browser, and you follow it in the conversation's window.
- **Secrets**: a message and an answer go through `redact()` before being kept or sent; a
  password is asked for with `ask_user`, never in the conversation.
- **Agent**: Claude Code (the *CLI* setting). The API agent and the other CLIs do not have these
  tools over several messages: the window says so, and nothing is started.

### Playwright export: `get_test_as_code`

Returns a saved test as Playwright files, to commit in the project under test. They run with
Playwright alone, without the extension or an LLM, in CI as well as locally.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `test_name` | string | Name of the test (required) |
| `framework` | string | `playwright-plain` (default): a `tests/<name>.spec.js`, run by `npx playwright test`. `playwright-cucumber`: a standalone project (`.feature`, step definitions, World, `cucumber.js` and its own `package.json`); the test must belong to a project |

Nothing is written to disk: the files come back as text (a heading with the path, then the
code), and the agent writes them itself. The `playwright-cucumber` project goes in a folder of its
own (e.g. `e2e/`), never over the repository's `package.json`. The dashboard serves the same code
at `GET /api/tests/:name/codegen?framework=…`.

#### Identifiers generated at each load

IziTest's replay tries all the locators recorded for a step; the Playwright code keeps only one.
A selector built on an identifier the page generates at each load (a UUID in an `id` or a `for`,
React's `:r1:`, CSS-in-JS classes) would break there on the first run; a positional selector
(`#login-form > div:nth-of-type(3) > button:nth-of-type(1)`) holds as long as the layout does not
move. In `playwright-plain`, each step therefore takes the first solid locator, in this order:

1. the recorded selector, if it holds nothing generated and no position (the code is then the
   same as before);
2. a `data-testid`, then another CSS locator of the same kind — not `input[name="interests"]` for
   a checkbox of a group: all the boxes share it;
3. the role and the accessible name that **Chrome** gives the element, read at the click in its
   accessibility tree: `page.getByRole('button', { name, exact: true })` — the "Sign in" button,
   not the heading that says it too. This is exactly what `getByRole` compares, where the name the
   snapshot computes may differ (hidden text, a `title` that comes before the content). For a
   click recorded before, the role deduced from the tag (button, link, dropdown list, heading) and
   the snapshot's name.
   A role and a name present several times on the page (the "Clear" of the login form and that of
   the contact form) are recorded with where they are: the nearest ancestor that holds only one
   (a `data-testid`, or a hand-written id), otherwise their rank —
   `page.getByTestId('login-form').getByRole('button', { name: 'Clear', exact: true })`, or
   `….nth(1)`. Alone, `getByRole` failed on Playwright's strict mode. IziTest's replay also
   looks inside this ancestor, and no longer runs in parallel the same name read alone (`aria`,
   text), which could win the race and click the other button;
4. for a `<label>`: `page.locator('label', { hasText: … })`, the label itself (styled
   checkboxes often hide the real `<input>`);
5. for a field (`input`, `select`, `textarea`, or a step that types): `page.getByLabel(…)`;
6. `page.getByPlaceholder(…)`, then `page.getByText(…, { exact: true })` when the visible text
   is the accessible name;
7. the positional selector, for want of anything better.

With no stable alternative, the original selector stays, preceded by a `// FIXME` comment.

In `playwright-cucumber`, the same choice applies to business steps (below) and to generic steps:
the exported `.feature` gives them the target chosen, as a Playwright selector that
`page.locator()` accepts as it is:

```gherkin
When I click on 'role=button[name="Sign in"s]'
And I click on '[data-testid="login-form"] >> role=button[name="Clear"s]'
And I check 'label:has-text("Jardin")'
And I uncheck 'label:has(input[name="darkMode"])'
And I fill 'internal:label="E-mail"i' with "bob@corp"
And I select "Pro — 25 members ($29/mo)" in "#ws-plan"
```

The dashboard's *Gherkin* tab, for its part, names the elements (below) instead of giving their
selector; a step with no element keeps the recorded selector. An argument that contains double
quotes is written between single quotes.

A wait of a time alone ("I wait 4 seconds") says how the test runs, not what it does: it is not a
phrase of the *Gherkin* tab, nor of `get_test_as_gherkin`. It stays in the test (*Steps* tab),
replayed, and goes with the phrase before it — the first one, at the start of the test: a saved
Gherkin keeps it, even if that phrase is reworded, and removes it with that phrase. The Cucumber
export, which plays its phrases, shows them. A wait for an element stays a phrase, which names it.

### The language of a project's tests

Each project has a language, `en` or `fr`, chosen when it is created (*Tests written in*, by
default the browser's) and changeable afterwards: it is the language of its tests, not that of the
dashboard.

- Its Gherkin is written in that language: in French, the feature starts with `# language: fr` and
  its keywords are `Fonctionnalité`, `Scénario`, `Soit`, `Quand`, `Alors`, `Et`, which Cucumber
  reads natively. The parser reads the keywords of both languages.
- So are its built-in phrases: `je suis sur {string}`, `je clique sur {string}`,
  `je remplis {string} avec {string}`, `{string} contient {string}`… the same commands, arguments
  in the same order. A project switched to French gets the French phrases and keeps the English
  ones: its tests read in French, and what was written in English can still be read.
- The Cucumber export follows: a feature in French (`Plan du scénario`, `Exemples`), and
  `default.steps.js` with the French phrases.
- Everything the AI writes for the project is in its language: the business steps it proposes, the
  scenarios of `design_tests` (titles and steps; the review of the criteria stays in the
  requirement's language), the intents of the steps it records, the Gherkin of the chat.
  `get_project_context` returns the language (`language`) and the phrases of that language.

### The elements of a project

Each step that acts on an element of the page (`click`, `fill`, `select`, `upload`, `drag`, and
`wait` when it waits for an element), and each assertion that checks an element by its selector,
keeps the page it was done on: the host and the path, without the query or the fragment, each part
of the path that holds a digit (an identifier, a slug with an identifier) replaced by `*` —
`notes.test/notes/*` for note 42 as for note 43. The extension returns the page's URL with the
result of each action (`pageUrl`), and an assertion reads that of the page it is checked on
(`add_assertion`). A step recorded before has no page: it gets one at the next run of its test in
which it succeeds.

The element a step acts on is known by an **exact key**, never by resemblance: its page, then its
role and its accessible name (with the container that sets it apart when the page has several,
`button "Delete" in testid "note-3"`), failing that its `data-testid`, the label of a field
(`field "E-mail"`), or a stable CSS selector — that of an assertion (`css #result-profile`). The
"Save" button of the notes page and that of the profile page are two elements, even with the same
selector; the same "Save" recorded by two tests is only one. A step that has only its position to
tell it apart, or whose list item is picked by a variable, has no element.

**An element recorded in several ways is only one.** The country field of the Test Arena was three
elements: one test had it by its selector (`css #country-input`), another by its accessible name
(`field "Start typing..."`), a check by its placeholder
(`css input[placeholder="Start typing..."]`). Two steps of the same page that share what tells the
element apart for sure act on the same element: its `id` (the selector `#country-input`, a CSS or
XPath locator by id), its `data-testid`, and for a field typed in or chosen — or read by a selector
that names it so — its `name` attribute or its placeholder. Their elements are merged under the
name the user gave one of them; otherwise under the one a person reads (role, label) rather than a
selector. An element known until then by a selector alone takes that name as soon as a step gives
it. Never merged:
- two elements a person reads under two names: the "Next" and the "Finish" of a wizard may share
  an id;
- the checkboxes or the radio buttons of a group: their `name` is the group's, and a click gives none;
- an element told apart by its container or its position (a "Delete" button per row);
- an `id` generated at each load.

All the keys and marks of an element are kept (the `element_keys` table): a step recorded later
finds it by any of them. At startup, the server registers the elements of all the steps, which
merges those recorded before.

**One fix, every use.** Each step keeps its own copy of how to find its element (selector,
locators): the replay, without AI, and the Playwright export read the step alone. When one changes,
the other steps of the project that act on the same element get the same, on confirmation:
- a repair that finds the element another way (`relocate`) says which other steps act on it, test
  by test (`run_test`, `list_repairs`, `verify_repair`);
  `resolve_repair(repair_id, decision="apply", all_uses=true)` gives them the new locators too.
  Called again with `all_uses=true` on a repair already applied, it fixes those that still find it
  the old way;
- `fix_test_step(…, all_uses=true)` does the same for a step the agent fixed by hand;
- in the dashboard, the repair (the test's *Runs* tab) shows
  "“Start typing...” is also used by 3 steps in 2 tests", the list of these steps, and the
  *Apply the repair to them too* box, checked: the button becomes *Apply to 4 steps*. The step
  editor shows the same list with the *Give them this step's selector and locators too* box,
  unchecked: a step edited by hand may aim at another element.

Each step keeps what it does: its command, its value, what its assertion checks. An assertion gets
the selector; an action gets the selector and the locators — or, coming from an assertion that has
no locators, the selector alone. The `relocate` repairs of these steps that are still open are
replaced (`superseded`). Applied to its step alone, a repair still keeps the element: its new key
is added to the element's own, its name does not change. A step with no page (recorded before steps
kept theirs) is not counted: it gets one at its next successful run.

Each element has a name, unique in its project whatever the case ("save" is the "Save" of another
page), taken from what a person reads on it: its role and its accessible name, its label, the text
of the button or link clicked ("Accept all cookies"; not a price nor the item of a list picked by a
variable), its placeholder, its test ID — without the character of an icon font that a site draws
in front of it ("Me connecter", not " Me connecter", which showed as a space). An element
nothing names — a check has only its selector — gets words drawn from the part of the selector that
designates it, never the selector itself: `#shop-cart-total` → "Shop cart total",
`[data-testid=flash-message]` → "Flash message", `button[aria-label="Empty the cart"]` →
"Empty the cart". A name already taken gets its page ("Save (profile)").

**The agent names the elements nothing names.** Those found by a selector or a test ID alone, or
named like another one with their page added, are named by the agent from what the tests do with
them (the intent of each step, what an assertion checks): "Total du panier",
"Message de confirmation", in the project's language. It is given the names of the project's other
elements, with their page, and gives each a name of its own: an element that looks like one of
another page is named by what sets it apart ("Rechercher un produit", "Rechercher un utilisateur"),
never the same name with a number. A name it gives that is taken all the same gets its page; an answer that
is not a name (a selector, an id) is ignored. A name the user gave is never changed; a name given
by the agent stays when a later step reads a label on the element, and the agent is not asked for
it again (the `agent_named` column). The agent does it:
- at the end of each recording (`stop_recording`, from MCP as from the dashboard's agent), for the
  elements of the saved test, in the background: the answer to the recording agent does not wait;
- on the *Elements* page, for all those of the project: "N elements have no name on the page…",
  *Name them* button; each bears *no name on the page* in the list.

The *Gherkin* tab says this name in place of the selector:

```gherkin
When I fill "E-mail" with "{{email}}"
And I click on "Sign in"
```

and reads it back as the element: a phrase that names an element of the project, where a selector
goes, acts on it, with the selector, the locators and the page of the last recording that touched
it. This is also true of a scenario written by hand (`create_test_from_gherkin`) and of an assertion
(`Then "Profile result" should contain "Saved"`). A name no element bears stays a selector.

The agent that writes Gherkin knows these names: `get_project_context` lists the project's elements
(`elements`: name, page, what they are), the method of `design_tests` gives them page by page with
the phrases, and so does the dashboard's chat. A scenario designed for a requirement can therefore
name the elements already recorded instead of guessing a selector.

The dashboard's *Elements* page lists the project's elements, page by page, with the tests that use
them, and under each the other keys it was recorded under ("also css #country-input · …"; the
search reads them too). An element is renamed there (its new name reads in the Gherkin of all its
tests, and it keeps it if it is merged); an element no step uses any more is deleted there. The
steps of a test show the name of their element.

| Route | Role |
| :--- | :--- |
| `GET /api/projects/:id/elements` | The project's elements, with their page, what they are, and the steps that use them; `to_name`: the ids of those nothing names |
| `POST /api/projects/:id/elements/name` | The agent names the elements nothing names (`to_name` of `GET …/elements`): `{ changed: [{ id, from, to }], left }`; 502 if the agent does not answer |
| `PATCH /api/elements/:id` | Renames an element (`{ name }`); 409 if another element of the project has that name, whatever the case |
| `DELETE /api/elements/:id` | Deletes an element no step uses; 409 otherwise |

### Business steps: `create_business_step`

Groups a run of steps of a recorded test into a single business phrase in Gherkin, instead of one
technical step per click:

```gherkin
# before
When I click on "div.moreFilterBtn"
And I click on "label[for=\"…uuid…\"]"
And I click on "#seeAllResults"
# after
When je ne garde que les maisons avec jardin
```

The step definition is built from the recorded steps themselves, selectors and locators included:
nothing has to be retyped. The Cucumber export of this test, and of any test that holds the same
steps, shows the phrase, and `features/steps/composite.steps.js` holds the Playwright actions (with
the stable locators above). Written by hand in another scenario, the phrase works too.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `project_id` | number | Project of the step definition. A test without a project is attached to it |
| `test_name` | string | Recorded test |
| `from_step`, `to_step` | number | Steps to group, numbered from 1, both ends included |
| `keyword` | string | `Given`, `When` or `Then` |
| `pattern` | string | The phrase, as a Cucumber expression. `( )` and `/` have a meaning in it (optional text, alternatives): avoid them |
| `args` | array | One per parameter of the phrase (`{string}`, `{int}`…), in order. `{ step, param }` takes the whole recorded value, `{ step, param, value }` only that part, `{ variable }` a variable of the test (see below) |

A parameterized example: the city and the budget, taken from the URL of step 1.

```javascript
create_business_step({
  project_id: 2, test_name: "recherche_bienici", from_step: 1, to_step: 1, keyword: "Given",
  pattern: "je cherche une maison à vendre à {string} pour {int} euros maximum",
  args: [{ step: 1, param: "url", value: "antony-92160" }, { step: 1, param: "url", value: "500000" }]
})
// → Given je cherche une maison à vendre à "antony-92160" pour 500000 euros maximum
```

With the same selectors and parameters, a step definition of the project goes before a default
step definition (`I am on {string}`). Replayed from Gherkin (`create_test_from_gherkin`), a
business step gives back its steps with their locators.

The sub-steps of a business step keep their page. When the recording it is compared with has its
page too, each sub-step must act on the same element (same key, see "The elements of a project"),
whatever the selectors: the same clicks on another page are not the business step, even with the
same selectors.

Without a page on one side, a business step is also recognized in another recording of the same
steps, even when a selector differs there because it is weak: an identifier generated at each load
(two recordings of Bien'ici give two different `label[for="<uuid>"]`) or a position. The element
is then recognized by what the two recordings have in common: the same `data-testid`, the same
stable CSS locator, or the same tag with the same accessible name (`label` "Jardin"). Two stable
selectors that differ stay two elements, and the `name` attribute of a checked box, shared by its
whole group, does not count. The other parameters (checked state, value typed…) must still match.
A business step created without locators (before `create_business_step`) still requires the exact
selector.

A wait of a time only ("I wait 4 seconds") is part of no business step: it is not kept when one is
created, and it is ignored when a business step is recognized in a test, between its sub-steps as
at the end. A test that waits 4 s after logging in still reads with the login business step.

#### Playing a business step: `play_business_step`

While recording, the agent plays a business step of the project in a single call, instead of doing
its clicks again: `play_business_step({ phrase: 'je me connecte au portail avec l\'identifiant "{{secret.PORTAL_USERNAME}}"
et le mot de passe "{{secret.PORTAL_PASSWORD}}"' })`. Its steps are played in the browser with their
locators and the project's wait for an element, then recorded, linked to it: the test reads as the
phrase, without depending on recognition. Each `{string}` takes its value in double quotes; a secret
is written `{{secret.NAME}}`, and the test keeps the reference. `start_recording` lists the
project's business steps.

While recording, each step of a business step waits for its element **8 s at most**, not the
project's wait (30 s on a slow site): the page is already there, and a missing element is told
within a few seconds. Replays keep the project's wait.

An item picked in a list **by its place** ("the first result") stays so in the business step made
of that click: it picks the item at that place, on a replay as when the agent plays it, not the one
that was clicked while recording. It is recognized in a test that picked another product at the
same place.

**A step that fails partway.** The answer says which one, and what was already done stays done:
the actions played before it are recorded. A business step that only checks ("I am logged in",
played to find out) and whose check does not hold records nothing: a check changes nothing on the
page. A login done in the browser is therefore no longer missing from the test, which would
otherwise fail once replayed logged out. When it fails at its very first step, nothing is done or
recorded: the answer says to go first where it starts (a form to open).

**A step needed only sometimes** (the verification code a site asks for only on a new device, a
banner): `play_business_step(phrase, optional_step: 4)` makes it **optional in the business step
of the library**. Every test that uses it does it when the page asks for it, and goes on when it
does not. Called right after the failure on that step, it goes on from there: what was done (the
e-mail, the password) is not done again, the missing step is not tried again, and the test gets the
whole business step, linked to it, with that step optional. The answer to the failure suggests it
to the agent. A step recorded as optional stays so when it goes into a business step
(`create_business_step`).

#### In the dashboard

*Add step* offers two choices:
- **A business step**: a business step of the project, with its values, inserted at the step you
  want (at the end by default). The test reads as its phrase. `POST /api/tests/:name/steps/business` `{ phrase, step_order }`;
  the list: `GET /api/projects/:id/business-steps`.
- **An action**: for a click, a fill, a choice in a list, a hover, a scroll or a wait,
  *Element of the project* lists the project's elements, page by page, with a search. Choosing one
  fills in the selector, the locators and the intent, which you can still change. For a wait, it is
  a wait for the element, not for a time; **Wait at most** gives it its own time, in seconds
  (empty: the project's wait).

### Business steps proposed by the AI

After the AI creates a test, the agent set in *Settings* proposes its business steps, in the
background; the test's *Gherkin* tab shows them, and the *Propose business steps* button asks for
them for any test of a project. Nothing is created without the user's agreement: each proposal is
accepted, with its phrase as the user left it, or dismissed.

The agent reads the test step by step, by the names of its elements, with its variables and the
business steps the project already has; what a business step already groups shows as that business
step and is not proposed again. It proposes runs of 2 to 12 consecutive steps that together do one
thing a user means ("I save my profile with the name {string} …"), in the language of the project's
business steps, each value that changes from one scenario to the next as a parameter. Each proposal
is checked before it is shown: it does not cut a phrase, overlaps neither another proposal nor a
business step, its phrase is new and has no `( )` or `/`, and each variable of the grouped steps
has its parameter. It says how the test will read, the phrases it replaces, and the other tests of
the project that will read with it (the same steps, on the same elements).

| Route | Role |
| :--- | :--- |
| `GET /api/tests/:name/business-steps` | The proposals kept for the test, or that they are under way (`status`: `none`, `running`, `ready`, `failed`) |
| `POST /api/tests/:name/business-steps/propose` | Asks the agent for them, in the background (202); only one request at a time |
| `POST /api/tests/:name/business-steps/:id/accept` | Creates the business step (`{ pattern }`: the edited phrase); 422 if it does not fit |
| `DELETE /api/tests/:name/business-steps/:id` | Dismisses a proposal; without `:id`, all of them |

### Variable Support
When saving a test (via `stop_recording`), IziTest Agent automatically identifies variables (e.g., input values or list selections). You can override these during `run_test`:

```javascript
run_test("my_test", { variables: { "user_email": "new@example.com" } })
```

An input variable takes the name of its field: its label ("Workspace name" → `workspace_name`),
else the name the form sends (`displayName` → `display_name`), else its id
(`#inline-title` → `inline_title`, not a generated id like `#r1`), the placeholder last. An
accessible name that is only the placeholder (a field without a label) counts as the placeholder:
the field `name="country"` with the placeholder "Start typing..." gives `{{country}}`.

An option chosen in a `<select>` (the `select` tool) becomes a variable too, of type `select`,
named the same way: `{{plan}}`. The step keeps the option's `value` (`pro`), what the form sends,
not its label (`Pro — 25 members ($29/mo)`): an assertion on the value sent (`"plan": "pro"`)
links to it by itself, and a label reworded or translated still replays. In
Playwright: ``selectOption('#ws-plan', `${VARS.plan}`)``; in Gherkin: `I select "<plan>" in "#ws-plan"`.
A `select` by text (a Gherkin phrase read back) tries the options' `value` before a partial match
of the label, like Playwright's `selectOption`.

A click becomes a list variable when the element clicked is one of several similar elements. An
LLM decides (an OpenRouter key, else the `copilot` CLI); with no LLM available, a cautious rule
takes over:

- no list for fewer than 3 elements, for an element without text (a bare switch, an icon), or for
  action buttons side by side ("Save" / "Discard" / "Delete");
- elements with distinct labels (criteria, categories) are picked **by text**, without the count
  at the end: `Jardin (44)` becomes `Jardin`, which finds `Jardin (62)` elsewhere;
- the same button or link repeated ("Add to cart" on each product) is picked by position.

The list is read **when the click is made**, on its page: read at `stop_recording`, on the last
page only (the cart), the results of a search were no longer there, and "the second result" stayed
the click on its product's name. A click that could not be read is read again at
`stop_recording`, as before.

**An element in a card.** An element may look like no other, or sit too deep for the elements like
it to be found. That is the case of the "Ajouter" button of a product card, six levels below its
card at Auchan, or of the "+" of a quantity, which only the card added to the cart shows. It is
then attached to **its card**: its closest ancestor that has at least 3 elements like it, with the
same tag and first class, built the same way. That ancestor must also be a list item: `article`,
`li`, `tr`, a list role, or the child of a grid or of a row that wraps. The sections of a page, one
below the other, are not.

The variable keeps the card's place (`itemXpath`, among the direct children of the list) and the
element's path inside the card (`withinXpath`). Later clicks on the same card share the variable:
"Ajouter" then "+" twice on the 2nd result give a single `{{product}}`, and `product=2` moves all
three to the 3rd card. On a replay, the card and the element are waited for up to 10 s: the "+"
only appears once the addition has been taken into account. The Test Arena has a section 7 (search
and cart) that reproduces this case.

**The agent validates.** The code can be wrong: the Test Arena's "Search" button had been taken
for "the 7th section of the page". The agent that records knows what it meant to do. Right after
a click found in a list, the click's result tells it: "List: taken as item 2 of 8 of a
list ("Whole milk 1L 1,15 €", …) — this element of that item, the same item as step 6". If it
does not agree, it answers with `record_step(action_id, pick)`:
- `none`: not an item of a list, the click stays a click on this element;
- `by_place`: the item at that place ("the second result");
- `by_text`: the item with that label ("the category Garden").

Its answer goes before the classifier's at `stop_recording`, and before the rule for menus. If it
says nothing, nothing changes. The dashboard's agent in API mode gets the same feedback, and
answers with `pick_list_item(pick)`, which applies to the last click.

When the element clicked carries the name of the item picked ("Ajouter le produit : Lait demi-écrémé UHT
à une liste", the same button of the other cards saying "Ajouter le produit : … à une liste"), the
click's result also gives that name, and how to keep it right away for a later step that will name
it (checking it in the list, removing it): "Its name here: "Lait demi-écrémé UHT" … capture_value(name:
"item_name", ref: the one you clicked, what: "attribute", attribute: "aria-label", pattern: …)". The name
is what its label says that the labels of the other items do not: at the click, the server reads
the label of the clicked element in each card (`pickedLabel`, `otherLabels`, and where it comes
from: `aria-label`, `title`, `alt` or the text).

A click in a **menu, a tab bar or a side menu** is never a variable: it is where the test goes,
not a value it varies. The page says so (an element in a `nav`, a `role="tab"`, `tablist`, `menu`,
`menubar`, `menuitem`, or a `data-testid` that contains "menu" or "nav"), or the list is in the
page's header (`header`, `role="banner"`) or its links carry a navigation name
(`navigation-header__link`, `navbar`…), else the LLM says so (it classifies it `menu_item`). Auchan's
cart link, among the 4 links of its header, had become `{{product}}`, "the first of them": on a
replay, its logo, which led back to the home page. **Cards** are never a menu, wherever they are:
an `article`, or an element whose class speaks of a product, a card or a tile (`product`, `card`,
`tile`). Auchan draws its products — those a brand sponsors above the results too — in a `<nav>`:
"the second result" was taken for a link of the menu, and recorded as it was, without a variable.
The rule also holds when it is the page that reports the `<nav>` around the cards, and for a card
found around its button (`./article…`); only the LLM, if it classifies them `menu_item`, still
makes a menu of them. As a variable, a tab was replayed by its label, "Runs7" with its counter,
which changes at the next run; it is now a click with its locators. A list of choices is never
taken for a menu: options (`role="option"`, `listbox`, "autocomplete" or "suggest" classes), or a
list clicked right after typing, even in the header's `nav`.

**A suggestion picked after typing** becomes a variable of its own: "Fr" typed in the country
field (`{{country_input}}`), "France" picked among its suggestions (`{{country}}`). The click goes
to the suggestion with that text: its locators by position ("the first suggestion") are removed;
they picked another one, silently, with another value. An attribute that ends with that text gives
a targeted selector, ignoring case: `a[aria-label$=": {{text_choice}}" i]` for "Suggestion de mot
clé 1/2: chocolat" (the position, which changes with the value, is not kept), and "Bananas" finds
the suggestion "bananas". With such a selector, the text alone is not kept: it can be anywhere on
the page ("Bananas" in the heading "Bananas Selections" above Walmart's suggestions, clicked
instead of them).
Repaired by hand (`fix_test_step`), the step keeps its variable, as a fill keeps its own. A check
of what was picked ("France" in the field) is linked to `{{country}}`. To replay with Italy, change
both: `run_test(…, { variables: { "country_input": "Ital", "country": "Italy" } })`, or two columns
of a dataset. A suggestion that is not offered for what is typed fails the step, which says so
("Spain" not found after "S"). It is a suggestion when each word typed starts a word of the clicked
element ("saint eti" → "Saint-Étienne"): a "Save" button clicked after typing a name is not one.
As the list is closed when the recording stops, this is the only way to find it. A wait or a check
placed between the typing and the pick (the agent checks that the suggestion shows) does not
prevent it, and the label taken is its text ("chocolat"), not its accessible name ("Suggestion de
mot clé 1/2: chocolat").

**The checks around the suggestion follow it**: where they quote it in a selector
(`a[href="/recherche?text={{text_choice}}"]`) and in what they expect, ignoring case — a search
term, which the page writes its own way ("Chocolat" in the title, "Bananes Prix Bas" for
"banane"). In a URL, the suggestion is the value of a parameter, or its beginning:
`/search?q=laptop` for "laptop computers" becomes `/search?q={{search_choice}}`, read on the
decoded URL (`laptop+computers` → "laptop computers"). A check marked `ignoreCase` compares that
way, on a replay as in exported Playwright (`{ ignoreCase: true }`, or a `/…/i` expression).

Its plural too, in a text that must contain it: the title "Chocolats pas cher" expected after
"chocolat" becomes `{{text_choice}}`, which "Chocolats" contains, and which "Votre recherche
banane" contains for "banane". Never another word made from it ("Chocolaterie"), nor a text that
must be equal (`title_equals`). A parameter alone (`redirect_keywords=chocolat`) becomes the
suggestion alone: its name says how the site took that particular value. Auchan sends a word it
knows to its aisle (`/…/ca-n0507?redirect_keywords=chocolat`), and any other to its search
(`/recherche?text=banane`). A path with it (`/search?q={{search_choice}}`) stays whole.

What no variable follows is a result that belongs to one value: a Kinder product checked after
"chocolat" is not in the results of "banane". The instructions of the agent that records
(`start_recording`, and the dashboard's agent) ask it to act on and check, after a value typed or
picked, what holds for any value:
- check the value itself in the title, a heading or the URL, and a list of results shown (its
  container, a count), never one particular result;
- take a result by its place ("the second result") in the list of results itself — not in a block
  a brand sponsors above or beside it, which changes from one visit to the next —, not by a name
  only it has (the product's name in an `aria-label`); a name the next steps need is kept first
  with `capture_value`, then used as `{{name}}`;
- check a computed amount with an expression: the price kept, then `{{price * 3 | 0,00}}`;
- remove at the end what the test added (a cart, data it created), so that the next run starts
  from the same state;
- look at the page with `snapshot` or `extract`, not with an `execute_js` that would be replayed;
  an `execute_js` that only looked is removed with `record_step(action_id, remove: true)`.

#### Declaring a variable: `add_test_variable`

Detection only covers what is typed (`fill`) or picked in a list: a city or a budget in a URL
stays hard-coded. `add_test_variable` replaces a recorded value, or a part of it, with `{{name}}`;
the recorded value becomes its default value.

```javascript
add_test_variable({ test_name: "recherche_bienici", step: 1, param: "url", value: "antony-92160", name: "ville" })
add_test_variable({ test_name: "recherche_bienici", step: 1, param: "url", value: "500000", name: "budget" })
// step 1: https://www.bienici.com/recherche/achat/{{ville}}/maisonvilla?prix-max={{budget}}
```

The variable then shows everywhere:

- **Dashboard**: the *Data* tab;
- **`run_test`**: `run_test("recherche_bienici", { variables: { ville: "massy-91300", budget: "600000" } })`;
- **`playwright-plain`**: `VARS.ville`, `VARS.budget`;
- **Business step**: `args: [{ variable: "ville" }, { variable: "budget" }]` makes them the
  parameters of the phrase. Every variable of the grouped steps must have one: otherwise the
  generated code would type `{{ville}}` as it is;
- **Cucumber export**: a `Scenario Outline`, with `<ville>` in the steps and an `Examples` row of
  the default values, to be completed with other rows for other datasets:

```gherkin
Scenario Outline: recherche_bienici
  Given je cherche une maison à vendre à "<ville>" pour <budget> euros maximum
  When je ne garde que les maisons avec jardin

  Examples:
    | ville        | budget |
    | antony-92160 | 500000 |
```

In the dashboard's *Gherkin* tab, the phrase keeps `"{{ville}}"` and `{{budget}}`, and is saved as
it is, even where the phrase expects an `{int}`.

#### Assertions and variables

An assertion that checks a value typed in the test must follow that value: replayed with another
e-mail, the test must check that e-mail, not the one of the recording. `add_assertion` does it by
itself: any value of an input variable (`text` or `select`, at least 2 characters) found in
`expected` is replaced there by its variable, and the answer says so:

```
Linked to {{email}}: saved as ""email": "{{email}}"", so a replay with other values checks those values.
```

The value is looked for whole, never in the middle of a word: "Fra", typed so that the
autocomplete offers "France", does not link `"country": "France"`. On the tab of a replay (the
`tabId` returned by `run_test`), the values typed by that replay are the ones looked for, not those
of the recording: replayed with `date_of_birth: "1985-11-30"`, `"dob": "1985-11-30"` becomes
`"dob": "{{date_of_birth}}"`.

A 2-character value is linked only if it is a number or a code (`25`, `FR`, `XL`) — a short
lowercase word (`on`, `in`) is found in any sentence — and only if it appears once: otherwise, the
answer says so (`Not linked to {{volume}}: "25" is found 2 times…`).

For an assertion added before, `add_test_variable` with the name of an existing variable reuses it
(without `value`, or with its default value):

```javascript
add_test_variable({ test_name: "izi_login", step: 7, param: "expected", name: "email" })
// "email": "jane.doe@example.com"  →  "email": "{{email}}"
```

On a replay, a value containing a quote or a backslash (`Pa"ss\word`) is taken as it is. In the
`Examples` of an exported Scenario Outline, a value that contains the quote surrounding its column
in a step (`d'abord` in `'"reason": "<reason>"'`) is escaped there (`d\\'abord`): otherwise the
string closed in the middle of the value, and the step was left without a definition.

#### Saving from the Gherkin tab

A phrase does not say everything about a step: not its locators, nor its intent, nor its list
variable, nor what only the recording knows (a box clicked through its label, a VRT screenshot).
Saving the feature therefore compares the edited phrases with those of the test:

- an **unchanged** phrase keeps its steps as they are — including a step no phrase describes
  (`execute_js`, a visual check), which was not saved at all until now;
- a **changed** phrase is read back; if its command and its target (selector, URL) have not
  changed, it keeps the locators, the intent and the list variable of the step it replaces (an
  input variable, as long as its `{{name}}` is still in it);
- an **added** phrase is read back, a **deleted** phrase goes away; the others do not move.

Only the changed or added phrases must match a step definition: an error quotes their line.

#### An assertion is checked at its place

An assertion followed by other actions is checked where it is in the test, on the page the steps
before it led to. A test can thus check an employee's page, then move on to a manager's and check
it too.

- The browser plays the steps up to the assertion, the server checks it, then the rest goes on in
  the same tab.
- An assertion that fails at its place stops the run there: what follows relied on what it
  checked. It is the failed step of the report and of the triage.
- The assertions placed after the last action are all checked on the last page, and each one is
  reported, as before.
- Debug mode checks them at their place too, step by step.

Before, all the assertions were checked after the last action: a check placed before a change of
page read the wrong page, and failed.

#### An assertion waits for what it checks

During a run, an assertion is read again until it passes, for as long as the project's wait for an
element (10 s by default, see below), like Playwright's `expect`. This is useful when the page is
still on its way to what the assertion checks: a form sent with Enter whose next page is loading, a
message shown when a request answers.

- A page that cannot be read during that time, because it is being replaced, is read again too.
- Once the time is up, the assertion fails with what it read last.
- A screenshot comparison (VRT) and an oracle are read only once.
- `IZITEST_ASSERT_TIMEOUT_MS`, when set, replaces this time for every project; `0` reads only
  once.

#### The wait for an element

On a replay, each step waits for its element (the button, the field…) to show before it acts, up
to the project's wait for an element: **10 s by default**. The wait stops as soon as the element is
there, so a test that passes takes no longer. A step that does not find its element fails with
"not found within 10 s".

**A click waits until its element can receive it**, as in Playwright: visible, enabled (neither
`disabled` nor `aria-disabled`), still (the same position twice in a row) and on top of everything
(what is at the middle of the element is the element, something inside it or its label, not a
loading overlay). Otherwise the step fails with the reason: "Not clicked: the element stayed
covered by <div.loading-bg> within 10 s".

**An action waits until its page has finished loading.** A click, a fill, a choice in a list:
before acting, the replay waits until the element's document has loaded (`readyState` `complete`:
its scripts have run, those it added while loading too), then looks the element up again, the page
having drawn itself meanwhile. An item picked by its place in a list ("the second result") waits
the same way, before the list is read. A page that has loaded costs nothing. At Auchan, the "add to
a list" click went off as soon as the button was drawn on the results page the click before had
just opened: its scripts had not run, nothing listened to the button, and the next step failed one
run in two.

The wait lasts 15 s at most, like that of a `navigate`. Past that time (a resource that never
answers), the step is played anyway, its result says so ("the page was still loading after 15 s"),
and that page is no longer waited for at the following steps. The agent's clicks, fills and choices
(`click`, `fill`, `select`) wait the same way: a click made on the page a click had just opened was
lost ("no visible change").

**A click with no effect is made once more.** After a click, the replay watches the page for one
second: a change of the page, a navigation or a request is enough. If none of that happens, the
page was not listening yet (an application that shows its buttons before wiring their actions to
them): the replay clicks again, if the element is still there and ready. The step's result says so
("clicked twice"). An item picked by its place is watched and clicked again the same way. A page
still loading changes by itself (its images, its cart): that is why the replay waits for it first;
otherwise those changes passed for the click's effect.

**Wait for an element, not for a time.** A wait in ms recorded right before a step that waits by
itself (a click, a fill, a wait for an element, a check) is not kept in the test: `stop_recording`
says so. The `wait` tool reminds the agent of it.

**A wait longer than the others has its own time.** A wait for an element (`wait` with
`selector`) also waits as long as the project's wait for an element. What it waits for may take
longer than the element of any other step: an export being built, a report computed, a batch job.
Rather than lengthening the wait of the whole project, you give it its own, from 1 s to 5 min, in
whole seconds:
- in Gherkin: `When I wait for "the report link" up to 90 seconds`, in French
  `Quand j'attends "le lien du rapport" jusqu'à 90 secondes`;
- in the dashboard: the wait step, *Edit*, **Wait at most** (in seconds; empty: the project's
  wait);
- by the agent: `wait` with `timeout` in ms (`90000`), kept with the recorded step.

The time is stored in the step (`params.timeout`, in ms) and replayed as it is; a wait without a
time of its own follows the project's at the time of the replay. The whole replay gets that time on
top of its 120 s; otherwise a long wait cut it off before it finished. The Playwright export writes
it `waitFor({ timeout: 90000 })`. Before, a wait for an element always lasted 10 s, whatever the
project's wait, and nothing allowed waiting longer.

The wait for an element is set per project, from 1 to 120 s:
- in the dashboard: *Projects → Edit → Wait for an element* (empty: the default);
- by the agent: `update_project_context` with `element_timeout_ms` (`null` goes back to the default);
  `clean_start: false` there also turns off the clearing of cookies before each test (see the
  installation guide);
- through the API: `PUT /api/projects/:id` with `element_timeout_ms`.

It applies to assertions too. Raise it when tests fail on a page still loading: a slow test
server, a company laptop, the headless browser. The agent's actions while it records always wait
2 s: it reads the answer and looks at the page right away.

#### Assertion types on export

Each assertion type replays, exports to Playwright and has its Gherkin phrase:

| Type | Playwright | Gherkin |
| :--- | :--- | :--- |
| `text_contains` / `text_not_contains` | `toContainText` / `not.toContainText` | `"…" should contain "…"` / `should not contain`; without a selector, `I should see "…"` |
| `text_equals` | `toHaveText` | `"…" should have text "…"` |
| `attribute_equals` | `toHaveAttribute`; `toHaveValue` for `value` | `the "href" of "…" should be "…"` |
| `element_count` | `toHaveCount` | `"…" should match 2 elements` |
| `element_exists` / `element_not_exists` | `.first().toBeAttached()` / `toHaveCount(0)` | `"…" should exist` / `I should not see "…"` |
| `element_visible` / `element_hidden` | `toBeVisible` / `toBeHidden` | `"…" should be visible` / `should be hidden` |
| `url_equals` / `url_contains` | `toHaveURL` | `the URL should be "…"` / `should contain` |
| `title_equals` / `title_contains` | `toHaveTitle` | `the title should be "…"` / `should contain` |
| `no_console_errors` | errors collected from the start of the test, then `expect(…).toEqual([])` | `the page should log no error containing "…"` |
| `no_failed_requests` | responses ≥ 400 and failed requests collected, then `toEqual([])` | `no request to "…" should fail` |
| `link_ok` | `page.request.get(href)`, status < 400 | `the link "…" should work` |
| `no_a11y_violations` | `@axe-core/playwright`: `new AxeBuilder({ page }).withRules([…])` | `the page should not break the accessibility rule "…"` |

Without a selector (`I should see "…"`), `text_contains` checks the whole text of the page, in
`body`, on a replay as in the export; when it fails, it gives an excerpt of it rather than the
whole page.

For `attribute_equals`, the `value` attribute of a field is what it holds when it is checked, as
`toHaveValue` reads it: the HTML attribute is only the starting value (absent from a field the
test filled).

#### Fields named by their label on export

The phrases that name a field by its label (see *Special fields*) replay and export without a
selector:

| Gherkin | Step | Playwright |
| :--- | :--- | :--- |
| `When I fill the field "Email" with "…"` | `fill { label, value }` | `page.getByLabel('Email', { exact: true }).or(page.getByPlaceholder('Email', { exact: true })).locator('visible=true').first().fill(…)` |
| `When I select "…" in the field "Subject"` | `select { value, label }` | the same target, `.selectOption(…)` |
| `When I check the field "Remember me"` / `I uncheck the field "…"` | `click { label, checked }` | `page.locator('label:text-is("Remember me")').or(page.getByLabel('Remember me', { exact: true })).locator('visible=true').first().check()` / `.uncheck()` |

The code finds the field the replay finds: by its label or its placeholder, the first visible
one. `getByLabel` alone failed on Playwright's strict mode as soon as two fields have the same
label (the Test Arena's login and its contact form each have an "Email"), and on a hidden
duplicate (the search field of the mobile menu). A box goes through its `<label>` when the page
draws it itself: `check()` on the invisible input waits until the timeout, and on the label,
Playwright reads the state of the box it names. In `playwright-cucumber`, the `.feature` keeps the
phrases as they are and `default.steps.js` defines them with two functions that do the same thing,
`field()` and `box()`. A step recorded with a selector keeps it: the label is only used by a step
that has nothing else.

#### Checkboxes

A click on a checkbox, a radio button or a switch (`role="switch"`), or on its `<label>`, is
recorded with the state it left it in: `{ "selector": "…", "checked": true }`. Replaying a plain
click would toggle the box whatever its state: a box already checked at the start (a remembered
preference, a box checked by default) would end up unchecked, and the test would pass anyway.
With the recorded state:

- **`run_test`** does not click if the box is already in the wanted state ("already checked: not
  clicked" in the step's result);
- **`playwright-plain`** and business steps generate `.check()` or `.uncheck()`, which leave the
  box in the wanted state, label included: `page.locator('label', { hasText: 'Jardin' }).check()`;
- **Gherkin**: `When I check "…"`, `When I uncheck "…"`; without a selector, by the box's label:
  `When I check the field "Remember me"`, `When I uncheck the field "…"`;
- **Variable**: `add_test_variable({ test_name, step, param: "checked", name: "jardin" })` makes
  the state a variable (`"true"` or `"false"`): `When I set "…" checked to "{{jardin}}"` in the
  *Gherkin* tab, `setChecked(…)` in the generated code.

A switch drawn in CSS often hides the real box (`opacity: 0`, no size) behind its `<label>`, with
its text beside it (`<label class="toggle"><input …></label> Dark mode`). The snapshot lists it
anyway, named by that text (`[checkbox] "Dark mode" [checked]`); a click on its ref goes to the
label, the result reports it (`viaLabel`) and the generated code goes through it too:
`page.locator('label', { has: page.locator('input[name="darkMode"]') }).uncheck()`. A `<label for>`
apart from the box is noted too (`labelFor`, the box's id): the code then aims at that label,
`page.check('label[for="notif"]')`, or at the label by its text if the id is generated.

A checked box is often part of a group too (the criteria of a search): variable detection then
makes it a list variable, which picks *which* box; the state stays the recorded one.

### Computed values

A variable, or a step, can hold an expression between `{{ }}`, computed by the server at each run
(`lib/values.js`), once only: the date typed at step 3 is the one the assertion of step 9 checks, and
the value used is saved with the run.

| Written | Gives (on 3 November 2026, project in French) |
| :--- | :--- |
| `{{today}}`, `{{tomorrow}}`, `{{yesterday}}` | `2026-11-03`, `2026-11-04`, `2026-11-02` |
| `{{today + 3 days \| dd/MM/yyyy}}` | `06/11/2026` (also `jours`, `weeks`/`semaines`, `months`/`mois`, `years`/`ans`) |
| `{{tomorrow \| EEEE d MMMM}}` | `mercredi 4 novembre` (names in the language of the project's tests) |
| `{{now \| HH:mm}}`, `{{now + 30 minutes}}` | `14:05`, `2026-11-03 14:35` |
| `user-{{unique}}@example.com` | `user-lk7lajgdr@example.com` (the same token throughout the run) |
| `{{uuid}}`, `{{timestamp}}`, `{{random(1000, 9999)}}` | a UUID, the time in ms, an integer between the bounds |
| `{{round(price * 1.2, 2)}}`, `{{price * qty \| 0,00}}` | a calculation with other variables, formatted |

A number is read as the page writes it: a price kept by `capture_value` ("6,42 €", "€19.26",
"1 234,56 €", "$1,234.56", "12 %") can be used in a calculation. The decimal separator is the last of
`.` and `,` when both are there; a comma alone is one ("6,42"), except before three digits in English
("1,234" is 1234). Spaces count only between groups of three digits ("06 12 34 56 78" is not a
number). The total of 3 times a product at "6,42 €" is checked with `text_contains`
`{{price * 3 | 0,00}}`, that is "19,26".

A variable can use others (`{{price * quantity}}`). A `{{name}}` that is not a variable stays as it
is, as before; an expression that cannot be computed (`{{today + 3 dayz}}`) stops the run before the
browser, saying which one and why. A value passed to `run_test` can be an expression too.

- **In the *Data* tab**, a value with an expression shows what it would give now, or the error
  (`POST /api/values/preview`).
- **`add_test_variable`** takes `default_value`: the variable is then worth the expression instead of
  the recorded value (`user-{{unique}}@example.com` for a sign-up that can be replayed).
- **The agent that records** is asked to do so for a date or a value that must change at each
  run.
- **The exported code** computes the values with the same file: `tests/izitest-values.js` for
  Playwright, `features/support/values.js` for Cucumber, where each step resolves its arguments
  (`this.values(...)`) and the columns of the Outline keep the expression.


### Datasets

A project has datasets (`lib/datasets.js`): tables of values, uploaded from a CSV (`,` `;` or tab), a
JSON list or the first sheet of an Excel `.xlsx`, their first row naming the columns. Each column
becomes a variable name (`E-mail` → `e_mail`), each value a text; the dataset's name is the file's
(`users.csv` → `users`), and a file of the same name replaces it. 2,000 rows at most, 5 MB.

- **A test bound to a dataset** (*Data* tab, or `bind_dataset`) plays one row per run: its columns
  are variables of the run, over the test's default values (a value passed to the run comes
  first). Started (*Run*, `run_test`), it plays every row one after the other; only one if it is
  chosen (*Rows* in the *Run options*, `run_test(row)`); each run notes which one, and its values.
  Bound to a dataset, a test plays the dataset's rows, not its own (see Test data below): its own are
  kept for when it is unbound.
- **A campaign** plays every row of a bound test, each on its own: `login [row 2]` in the results,
  the JUnit and HTML reports, the regressions. A requirement sees its test fail if one row fails.
  *Run every row as a campaign* in the *Run options* starts the campaign of that test alone.
- **An expression** reads a value of one of the project's datasets: `{{users[2].email}}`, rows
  numbered from 1, in any test.
- **The export** takes the datasets used with it: in Playwright, a test per row
  (`for … of DATASETS['users']`); in Cucumber, an `Examples` line per row of the dataset, and
  `features/support/datasets.js` for the expressions.
- **The AI agent that creates a test** (*Create test with AI*) gets the project's datasets in its
  instructions: columns, number of rows, first row (the value of a password, key or code column is
  shown as `(hidden)`). It takes a value from a dataset rather than making one up.
  For one value, it types `{{users[1].email}}`. For a test to play with each row ("for each user"),
  it passes `project_id` and `dataset: "users"` to `start_recording` and types `{{email}}`,
  `{{password}}`. The chat agent, for its part, writes them in the Gherkin, then binds the test with
  `bind_dataset`.
- **While recording**, `start_recording(project_id)` lets the project's datasets be read:
  `{{users[2].email}}` types the value of row 2. With `dataset`, `{{email}}` types that of row 1 of the
  dataset; the answer of `start_recording` says what to type, or lists the project's datasets without
  `dataset`.
- **At `stop_recording`**, the test is put in the project and bound to the dataset played. A value of
  row 1, written `{{email}}` or typed as it is (3 characters or more), becomes the variable of its
  column, its default value that of row 1. Another field with the same name as a column gets another
  name (`name_2`), so that the row does not replace it.
- **`add_assertion` on a bound test** also links the expected value to the dataset's columns, even
  those not typed: "Welcome Bob", Bob being the `name` of row 1, is kept as "Welcome {{name}}" and
  checks "Ann" on row 2. A column named in the expected value, linked this way or written `{{name}}`
  by the agent, becomes a variable of the test (value of row 1): unbound from the dataset, the test
  still checks row 1.

| Route or tool | Role |
| :--- | :--- |
| `GET /api/projects/:id/datasets` | The project's datasets: columns, number of rows, bound tests |
| `POST /api/projects/:id/datasets` | Uploads a file (`filename`, `content` as text or `content_base64` for an Excel) or rows (`name`, `rows`) |
| `GET /api/datasets/:id`, `DELETE /api/datasets/:id` | A dataset with its rows; its deletion (the bound tests then play once only) |
| `PUT /api/tests/:name/dataset` | Binds a test to a dataset (`{ dataset: id or name }`) or unbinds it (`null`) |
| `PUT /api/tests/:name/rows` | The rows of the test's own (`{ rows: [{ variable: value }] }`, `[]` for none) — see Test data below |
| `save_dataset`, `bind_dataset` | The same, for an agent (CSV as text or rows); `get_project_context` lists the datasets, with their first row (a password masked) |
| `start_recording(project_id, dataset)` | Records a test that plays a dataset: `{{email}}` types row 1, the test is bound to the dataset at `stop_recording` |

### Test data: the rows of a test

A test can keep rows of its own, typed in a table in its **Data** tab (**Test data**): a column per
variable of the test, a row per run. **Add a row** starts one from the variables' defaults; a row can
be duplicated or deleted; **Save rows** keeps them with the test (`tests.data_rows`). A cell left
greyed has no value of its own and plays the variable's default; a cell emptied is typed empty. A cell
may compute its value (`{{today + 3 days | dd/MM/yyyy}}`, `{{qty * 2}}`, with the row's other values)
or type a secret of the project (`{{secret.NAME}}`). A column holding a password, a key or a code is
masked in the table.

Why rows of the test's own rather than a dataset of the project: the columns are the test's variables,
the rows go with the test (renamed, deleted), they take no name among the project's datasets
(`{{users[2].email}}`), and editing them changes no other test. They are played exactly as a dataset's
rows are (`rowsOfTest` in `lib/datasets.js`): a test bound to a dataset plays the dataset's rows, its
own are kept for when it is unbound.

- **Run** (dashboard, `run_test`) plays every row, one after the other, a run each; the live window
  shows the row being played and how each one did (« 2 of 2 rows passed »). A failed row does not stop
  the next. **Rows** in the Run options plays only one; debug or `start_step` play one row (the first
  unless `row` says). Headless, each row's window is closed after it; in a window, a row that passed
  leaves its window to the next one, a failed one stays open.
- **Each run says the row it played**: its number and its values as played (`data_row`,
  `data_values`) — in the Runs tab (« Row 2 — Bob, Martin », all the values once opened), the Recent
  runs, `run_test`'s answer. A password's value is kept `(hidden)`, a secret by its reference
  (`{{secret.PW}}`), never its value.
- **How the test last did** counts every row it plays now, each by its last run (`lib/test-status.js`):
  one row failing, the test failed — even when its latest run, on another row, passed. The test list,
  the test's page (« Failed · row 1 of 2 failed »), the coverage of its requirements and the regression
  plan read it so. Played again alone and passing, the failed row turns the test green.
- **A campaign** plays each row as one of its runs (`izi_contact_rows [row 2]`); its report shows each
  row's values, and the JUnit report has them as `data_row` and `data_values` properties.
- **Gherkin**: with two rows or more, the test's Gherkin (Gherkin tab, `get_test_as_gherkin`) is a
  `Scenario Outline` (`Plan du scénario` in French): `<email>` in its steps, an `Examples` line per row
  — the steps' variables first, then the rows' other columns; a value a row does not give is the
  default; a password shows `(hidden)`. With one row or none, it stays a `Scenario`. Saved from the
  Gherkin tab, the `Examples` are the test's rows (a cell left `(hidden)` keeps its value; a new column
  becomes a variable of the test); an Outline turned back into a `Scenario` removes its rows. Bound to a
  dataset, the `Examples` are the dataset's rows: changed in Datasets, not there.
  `create_test_from_gherkin` with a `Scenario Outline` creates the test with its `Examples` as rows.
- **The export**: `playwright-plain` writes a test per row; `playwright-cucumber` an `Examples` line
  per row.
- **An agent**: `save_test_rows(test_name, rows)` saves them (a column is a variable of the test);
  `add_test_variable` renaming a variable renames its column.

| Route or tool | Role |
| :--- | :--- |
| `GET /api/tests/:name` | `rows` (its own), `played_rows` (what a run plays: `source` `test` or `dataset`, `row_count`, `row_labels`) |
| `PUT /api/tests/:name/rows` | Saves its rows: `{ rows: [{ first_name: "Ann" }, …] }`; a column that is no variable of the test is refused |
| `POST /api/tests/:name/execute` | Without `row`: every row, streamed as `rows_started`, then `row_started` and `execution_completed` / `execution_error` (with `row`) per row, then `rows_completed` |
| `GET /api/tests/:name/executions`, `GET /api/executions/:id` | Each run with `data_row` and `data_values` |
| `GET /api/tests/:name/last-run` | How it last did, every row counted: `{ status, started_at, rows: { total, played, failed } }`; `GET /api/tests` gives `last_status` the same way, with `last_rows` |
| `save_test_rows` | The same, for an agent |

### Secrets: what a test types without anyone reading it

**A password typed in plain during a recording** becomes a secret of the project: in a
`type="password"` field, the value is kept under the field's name (`MOT_DE_PASSE`, then
`MOT_DE_PASSE_2` for another value) and the test keeps `{{secret.MOT_DE_PASSE}}`. The agent is
told so. Without `project_id` at `start_recording`, it is told that the password stays in plain.

A password, an API key, a token: a project keeps them in its secrets (`lib/secrets.js`), and a test
writes them `{{secret.NAME}}`. IziTest types the value; nobody reads it back, neither the agent that
records the test nor the dashboard.

- **Where**: *Projects → Edit → Secrets*. A name (`TIIME_PASSWORD`: letters, digits, `_`), a value,
  and what it is for (the agent reads this description). Once saved, a value can be replaced; it is
  never shown again.
- **Kept encrypted** (AES-256-GCM), with a key of the machine outside the database:
  `IZITEST_SECRET_KEY`, or `~/.izitest/secret.key`, created with the first secret (readable by the
  user alone). A database copied to another machine gives none of them away.
- **Typed at the last moment**, by the server, just before the extension types: during the
  recording (`start_recording` with `project_id`) as at each run. The test keeps the
  reference: at `stop_recording`, it becomes the default value of a variable
  (`{{password}}` = `{{secret.TIIME_PASSWORD}}`). A column of a dataset can hold one
  (a password per user).
- **Given only to what acts.** At a run, the value only goes into what the browser uses to act:
  what a step types, looks for (`params`, `locators`) or checks (`assertion`).
  **A step's label keeps the reference**, whether the secret is written in it
  (`I log in with the password "{{secret.TIIME_PASSWORD}}"`) or gets there through a
  variable (`{{password}}`): the label is what the run's bar shows in the tested page — and so
  in the run's video — and what the run keeps (`execution_steps.intent`). The label's other
  values (a variable, `{{today}}`) are computed in it as before. A secret is typed as it is:
  nothing is computed with it (`{{secret.PIN * 2}}` is refused before the browser opens); what
  surrounds it is written outside the braces (`{{secret.PREFIX}}-x`).
- **Never sent back.** Wherever a value would leave the server, its reference replaces it
  (`redact`): each tool's answer to an agent (a page that shows what was typed, an error),
  the logs, the variables, the errors, the locator used and the diagnosis kept of a run
  (and the repairs, the bug that come out of it), the error of the bar at the end of a run, what the
  dashboard receives of it, what a connector sends (a campaign's results, a bug).
  A value of fewer than 4 characters is not caught this way — a step's label, for its part, never
  receives it.
- **What sees it all the same**: the tested page, where it is typed (a password field masks it,
  an email field shows it, the video too), and the console of the extension in the browser that plays
  the test, which writes the parameters of each command — it is kept nowhere.
- **The snapshot masks password fields**: `value="••••••"` says it is filled, not with what.
  A dataset column named like a password, a key or a code (`password`,
  `token`, `api_key`…) is shown as `(hidden)` to an agent.
- **What the agent knows of them**: their names and descriptions, in its instructions and in
  `get_project_context` (`secrets`). A secret the project lacks is reported
  (`no secret named "X"`); outside the recording of a project, no secret is read.
- **In CI**, `IZITEST_SECRET_<NAME>` in the server's environment replaces the stored value (the
  dashboard says so: *from the environment*).
- **At the Playwright export**, a secret is the environment variable of the same name
  (`process.env.TIIME_PASSWORD`): its value is never written in the code.

| Route or tool | Role |
| :--- | :--- |
| `GET /api/projects/:id/secrets` | The project's secrets: name, description, date, `from_environment`. Never a value |
| `PUT /api/projects/:id/secrets/:name` | Adds or replaces (`value`, `description`); without `value`, the stored value stays |
| `DELETE /api/projects/:id/secrets/:name` | Deletes it: the tests that type it will fail |

### `ask_user`: the agent asks for what it lacks

A test needs a value that neither the description, nor the datasets, nor the secrets give: an
account to log in with, its password, a code. The agent does not make it up and does not ask for it
in its reply: it calls `ask_user` and waits. The person who started it answers in the dashboard,
never in the agent's conversation, where it would read a password.

```
ask_user({
  why: "To log in to Tiime with the test account",
  fields: [
    { name: "email", label: "Email of the test account" },
    { name: "TIIME_PASSWORD", label: "Its password", secret: true }
  ]
})
```

- **A `secret: true` field** (password, key, token, code) is kept in the project's secrets, its
  description being its label. The agent gets its reference, `{{secret.TIIME_PASSWORD}}`, to type.
  Any other field comes back to it with its value.
- **The project** is that of the test being recorded (`start_recording(project_id)`), or
  `project_id`. A secret asked for without a project is refused.
- **Where to answer**: beside the agent's browser, in the *Create test with AI* window that started
  it. A question no window shows (that of an agent started elsewhere, Claude Code for
  instance, or of a window closed while the agent works) appears at the bottom right of every
  page. *Don't give* refuses it.
- **The wait**: a call waits `IZITEST_ASK_WAIT_MS` (45 s) at most, under the limit of an MCP client.
  Without an answer, it says so, and the agent calls `ask_user({ request_id })` again. The dashboard's
  agent, for its part, waits for the answer in the same call.
- **Without an answer** after `IZITEST_ASK_TIMEOUT_MS` (15 min), refused, or when the agent's run
  stops, the agent is asked to stop: close its window, save nothing, say what is missing.

| Route | Role |
| :--- | :--- |
| `GET /api/asks` | The questions waiting: reason, fields, project, run |
| `POST /api/asks/:id/answer` | Answers: `{ values: { name: value } }`, every field |
| `POST /api/asks/:id/cancel` | Refuses: the agent stops |

The *Create test with AI* agent started as a CLI may use `ask_user` and `get_project_context`. The
chat agent, which talks to the user, does not ask for a password in the conversation: it sends the
user to add it to the project's secrets, then writes `{{secret.NAME}}`.

### Server steps: keeping a value, calling an API

Two kinds of steps run on the server, between those the browser plays
(`lib/server-steps.js`):

- **`capture`** keeps a value as a variable for the steps after it, written `{{name}}`: the text,
  the value or an attribute of an element, the URL or the title of the page, a value of the last
  API response (`what: "response"`, `path: "data.items[0].id"`), or a value of the response to a
  request the page made (`what: "request"`, `url: "/api/orders"`, `method`, `path: "id"`) — the id
  a click on "Buy" received without showing it. A pattern (a regular expression) keeps only a
  part of it, its first group: `#(\d+)` keeps `4521` of "Order #4521".

  For a request of the page, the capture takes the last one whose URL contains `url`, made since
  the step before; if the page has not received it yet, it waits for it up to 10 s, otherwise it takes
  the last one from before. The extension listens to the network of each tab it drives as soon as it
  takes control of it.
- **`http`** calls an API to prepare the data (create a user, an order), with the
  test's values in the URL, the headers and the body. The step fails on a status other than 2xx, or
  than `expect_status`. Its response is read by the captures that follow.

A test that holds some is played in segments: the browser plays the steps up to the next
server step, the server runs it, then the next segment starts in the same tab with the values
kept. Assertions see the values kept before them. A server step that fails stops
the run there. Debug mode runs them too, step by step. Tests without a server step are played
as before, sent in one go, except an assertion followed by actions, checked in its place.

| Tool | Role |
| :--- | :--- |
| `capture_value` | Keeps a value of the page, of the last response or of a request of the page (`name`, `what`, `ref`/`selector`, `attribute`, `url`, `method`, `path`, `pattern`), recorded as a step |
| `call_api` | Calls an API from the server (`method`, `url`, `headers`, `body`, `expect_status`), recorded as a step; returns the response |

During a session, `{{name}}` in an action (`fill`, `navigate`, `select`, `add_assertion`…) gets
the kept, or computed, value right away, and the recorded step keeps `{{name}}`.

The Gherkin phrases: `I store the text of {string} as {string}`,
`I store the text of {string} matching {string} as {string}`,
`I store the value of {string} as {string}`, `I store the URL as {string}`,
`I store {string} of the response as {string}`,
`I store {string} of the request to {string} as {string}`, `I call {word} {string}`,
`I call {word} {string} with {string}`. In French: `je retiens le texte de {string} dans {string}`,
`je retiens {string} de la requête vers {string} dans {string}`,
`j'appelle {word} {string} avec {string}`…

The export follows: in Playwright, the kept values go into `VARS`, the API goes through the
`request` fixture, and the page's responses are kept from the start of the test (`ANSWERS`, read by
`answerTo`); in Cucumber, through the World (`this.vars`, `this.call()`, `this.requestValue()`), and
the kept values are not columns of the Outline.

### Parameters of `run_test`

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `name` | string | Name of the test to run (required) |
| `variables` | object | Replaces the `{{variable}}` placeholders with custom values |
| `substitutions` | object | Raw text replacement in all the parameters (key → value) |
| `start_step` | number | Resume the run at a specific step (1-indexed) |
| `new_window` | boolean | If `true`, runs in a new window instead of a new tab |
| `close_window` | boolean | Closes the window of a run that passed. By default, as the user chose in *Settings → Browser windows*; `false` leaves it open, for an `add_assertion` on the page where the test stopped. The window of a failed run always stays open: the agent repairs the step there. Never a tab of the user's (`new_window: false`) |
| `row` | number | For a test that has rows (its own, or those of its dataset): the only row to play, numbered from 1. Without `row`, every row is played, a run each; with `start_step` or `debug`, the first one only |

### Requirements: what a test is the proof of

A requirement says what the app must do: a title, a description, its **acceptance criteria**
(one observable behaviour each, with its expected result), and the **cases** that test them. The
same object, wherever it comes from:

| From where | How |
| :--- | :--- |
| A request (a dev, as a prompt) | the agent keeps it: `save_requirement(source: "prompt", title: the request, criteria: what it understood of it)`, shows the criteria and waits for an agreement before planning. In the dashboard, *Create test with AI* keeps the request as a requirement and links the recorded test to it — or, when its *Requirement* field names an existing requirement of the project (and, if it has any, the criterion checked), links the test to that one without creating any: the agent then gets its criteria and passes `requirement` and `criterion` to `start_recording`; the agent gets the base URL and the context of the project, and if it stops without saving the test (no URL to start from), the window stays open with its last message. |
| A file (a test plan, an export) | `import_requirements(path)` or the *Import* button of the *Requirements* page (see below). |
| Any document (a Word spec, an email, notes) | the agent reads it: in the dashboard, *Have the agent read it* in the import; in MCP, the agent reads the document itself and passes its requirements in Markdown to `import_requirements(content)` (see below). |
| A connected tool (Jira, GitHub Issues) | `import_from_connector(connector, query)` or the *From Jira*, *From GitHub Issues*… tab of the import (see the connectors below), once the tool is set in *Settings*. |
| A tool without a connector (a Notion page) | the agent reads it (for instance with the tool's MCP server) and keeps it: `source` the id of a connector (`"jira"`) or a name of its choice (`"notion"`), its key (`SHOP-123`), its link, its criteria as written. Kept again under the same key, it is updated: the answer says whether its content changed, and a criterion whose text did not change keeps its tests. |
| A tester | the *Requirements* page of the dashboard: write the requirement and its criteria, ask for scenarios (*Propose scenarios*), plan cases, link tests to them. |

A case is first **planned** (`plan_tests`: its title, the criterion it checks, its type —
`nominal`, `alternative`, `error`, `boundary`), then recorded: `start_recording(requirement, case_id)`
— or `create_test_from_gherkin(…, requirement, case_id)` — links the saved test to that case. `link_test`
links an existing test. A test linked to a project's requirement joins that project if it has none.

**Coverage** is read from the links and from the last replay of each test (not from the checks of a
repair nor from the confirmations of bugs): `not_covered` (a criterion without a test), `failing` (a
test failed), `not_run` (a test never replayed), `passing`.

**The expected result comes from the requirement, not from what the app shows.** If the page shows
something else, it is not a value to accept: `add_assertion` refuses first, as always, then —
when the element is there and the agent passes `non_conformity: true` after checking that the
steps before did what they had to — records it as failing: the test reports the
non-conformity as long as the app does not fix it. At triage, the failure of an assertion of a test
linked to a requirement is a **non-conformity** (`non_conformity`): no repair proposes
to expect the value shown; a broken selector (`test_drift`) or a slow page (`timing`) remain
the test's business. The same goes for any step where the app is at fault (`app_regression`), for
instance a wait for the submitted note when the app refused the submission: the non-conformity
quotes the criterion the test checks.

At export, a test's requirements become tags: `test('…', { tag: ['@REQ-1'] }, …)`
in Playwright (`npx playwright test --grep @REQ-1`), `@REQ-1` on the Cucumber feature
(`cucumber-js --tags @REQ-1`), with a comment that says the criterion checked.

#### Importing requirements from a file: `import_requirements`

Many test plans live in spreadsheets. The import reads:

- **a table** — CSV or TSV (the `;` separator of a French Excel is understood, as is the
  Windows-1252 encoding of an old Excel), or Excel `.xlsx` (the sheet `sheet`, the first one by
  default). Columns are found by their names, in English or in French: key (`Key`, `Réf.`,
  `ID Exigence`, `Issue key`), title (`Title`, `Summary`, `Intitulé`), description, acceptance criteria
  (`Acceptance criteria`, `Critères d'acceptation`, `Règles de gestion`, a Jira custom field), priority
  (`Priorité`, `Criticité`: "Haute", "Majeure", "Highest", "P1"…), link. `columns` names a
  column its name does not give away. One criterion per line in a cell, or per row of the table:
  a row with neither key nor title adds to the requirement above, rows with the same key (or, without
  a key, the same title) make a single one. A column of plain numbers (1, 2, 3) numbers the rows: they
  are not keys. A **Jira CSV export** is imported as it is (source `jira`).
- **JSON** — a list of requirements, `{ requirements: [...] }`, or the result of a Jira search
  (`{ issues: [{ key, fields: { summary, description, priority } }] }`).
- **Markdown** — a heading per requirement (its key first: `## SHOP-12 — Title`), the items of its
  lists as criteria, a `Priority:` or `Link:` line, the rest as description. The document's title
  and those of the chapters (headings with no list of their own, above others) are not requirements.
- **a Word document** (`.docx`) written the same way: its headings (the styles Title, Heading 1,
  Heading 2…), its lists and its tables are read as Markdown. A document written otherwise gives
  nothing without the agent, and the preview says so.
- **an API** — a **Postman collection** (v2.0, v2.1, recognised by its `info.schema` or by its `info`
  and its `item`) or an **OpenAPI** 3 / **Swagger** 2 document in JSON. Each request (each operation)
  is a requirement: its key is its Postman `id` (its `operationId`), its title its name preceded by its
  folders ("Auth / Login"; for OpenAPI, its `summary` preceded by its first tag), its description that
  of the request followed by its method and its URL. Its criteria: the behaviours its description puts
  in a list (or under "Acceptance criteria"), one response per saved example or per documented response
  ("Answers 401 (Wrong password)"), and the name of each test of its scripts (`pm.test("…")`). A folder
  is not a requirement, and its description is not carried over. The body of the responses is never
  read: a collection can therefore weigh up to 30 MB (5 MB for the other files). Read by the agent, the
  API is sent to it in this form, without the bodies. An OpenAPI in YAML is not read as it is:
  convert it to JSON, or have the agent read it by pasting its text. These requirements describe an
  API: `call_api` checks the status of a response, not yet its content.

Without a criteria column, those a description puts under "Acceptance criteria" or "Critères
d'acceptation" (including Jira's `h3.` and `#` lists) are extracted from it.

Criteria written in **Gherkin** — `Given` / `When` / `Then` / `And` or `Étant donné` / `Quand` /
`Alors` / `Et`, one step per line, in a list or not — give one criterion per scenario: "Given
I am on my profile, when I tick "Public profile", then …", preceded by its name when a
`Scenario:` line gives it. An action or a context after a `Then` opens the next scenario;
lines without a `Then` ("When I click on A, B shows") stay criteria of their own. This holds
in a cell, a Jira criteria field, a description or Markdown.

It is first a **dry run** (`dry_run`, by default): each requirement is said to be new, changed or
unchanged, nothing is saved. Imported again, a requirement is updated under its key (or its
title) and its unchanged criteria keep their tests; a changed requirement that has linked tests is
flagged. In the dashboard, the *Import* button of the *Requirements* page takes a file (chosen
or dropped) or a pasted text, shows the preview and the column of each field (which can be changed),
then imports into the project chosen at the top of the panel: the dashboard's by default; with
*All projects*, one to choose (*No project* included, but on purpose).

#### Any document, read by the agent

A Word spec written freely, an email, notes, the text of a PDF have neither columns nor headings to
go by: it is for an agent to read them. A requirement says what its source says, and its tests
check it: the agent follows the document, it invents nothing.

- **In the dashboard**: tick *Have the agent read it* in the import, then choose a file
  (`.docx`, `.txt`, or any accepted file) or paste a text. On a preview with no requirement or that
  does not look like the document, *Have the agent read it* reads the same file again with the agent.
  The agent set in *Settings* (the same as *Propose scenarios*) gets the document's text — a `.docx`
  as Markdown, with its headings, lists and tables — and the project's requirements already saved (key,
  title). Its instructions: keep the document's keys and titles; reuse the key of a requirement already
  saved when it is the same one; write only the criteria the document states, never a criterion or a
  value it does not give; quote the passage each requirement comes from; list the passages that are
  unclear or contradictory, without settling them. It answers in JSON, which IziTest checks: a key that
  is neither in the document nor in the project is removed (a new one will be given); the quoted
  passage must be found in the document; a criterion of which a figure, or most of the words, are not
  in it is marked *not in the document as written*. The preview is that of any import — new, changed,
  unchanged —, with under each requirement the passage it comes from, and at the top the passages to
  clear up. Nothing is saved before *Import*; it is then the preview that is saved, as it is: the agent
  is not asked again, its next answer could differ from what the person checked. Reading a document
  takes up to a few minutes, 60,000 characters at most (some fifteen pages): beyond that, import it in
  parts.
- **A PDF** is not read by IziTest (it would take a heavy library): open the PDF, copy its
  text and paste it in the import, with the agent. An old `.doc`: save it as `.docx` in Word.
- **In MCP**: the developer's agent reads the document itself (a PDF, a wiki page, an email), then
  passes its requirements in Markdown to `import_requirements(content, project_id)`, a dry run first —
  `## SHOP-12 — Title` for each (a key written otherwise on a `Key: US 3.2` line), its
  description, its criteria in a list, `Priority: high` if the document gives it —, with the same rules.
  It shows the dry run, the passage each requirement comes from and the unclear passages, then imports
  (`dry_run: false`) with the person's agreement.

### Connectors: the tools requirements come from, and results go to

A requirement is an object of IziTest, wherever it comes from. A team's tools — Jira, GitHub
Issues, tomorrow Notion or Linear — are plugged into it by **connectors** (`lib/connectors`): one
file per tool, which declares how it is reached and what it can do. Three roles, a connector
has one or several:

| Role | What it does | Today |
| :--- | :--- | :--- |
| `requirements` | reads the tool's requirements: by a query in its language, their keys, or again (`sync`) to see what changed | Jira (JQL), GitHub Issues (GitHub's search) |
| `coverage` | tells the tool where each requirement that comes from it stands: a comment of IziTest's, updated afterwards | Jira |
| `results` | sends a campaign's results, updated if they were sent already | Xray (a Test Execution) |

The rest is common to all, and done only once:
- **the settings**: each connector has its card in *Settings* (Jira, Xray, GitHub Issues…), made of
  its fields (an address, an account, a token); a secret is kept on the machine and never shown again
  (masked, and given back masked it keeps the saved one); *Test the connection* says whether it works;
  failing that, environment variables stand in for them (`JIRA_API_TOKEN`…). A connector that needs
  nothing (GitHub, for a public repository) works as it is;
- **reading** writes nothing in the tool: a dry run first (new, changed, unchanged), then the
  import; the requirement keeps as its `source` the connector's id (`jira`, `github`), its key and its
  link;
- **writing** is done only on request, after a dry run that shows what would be sent; what was
  sent (the comment of a story, the Test Execution of a campaign) is remembered
  (`connector_refs`): sent again, it is updated, not repeated.

| Route or tool | Role |
| :--- | :--- |
| `GET /api/connectors` | The connectors: what each does, its fields, its settings (secrets masked) |
| `PUT /api/connectors/:id` | Its settings (`{ values }`); its first field empty removes them |
| `POST /api/connectors/:id/test` | Whether these settings (or the saved ones) work |
| `GET /api/connectors/:id/scopes` | Where to start reading: the projects of a Jira site, each with its query |
| `POST /api/connectors/:id/import` | `{ query \| keys \| sync, project_id, dry_run }`: the requirements read, saved when not a dry run |
| `POST /api/connectors/:id/coverage` | `{ keys \| campaign_id, dry_run }`: the coverage sent, when not a dry run |
| `POST /api/campaigns/:id/send/:connector` | `{ options, dry_run }`: a campaign's results sent, when not a dry run |
| `import_from_connector`, `send_coverage`, `send_results` | The same, for an agent: their description lists the connectors and what they take |

#### Writing a connector

A connector is an object exported by a file of `lib/connectors/`, registered in
`lib/connectors/index.js` (the list of connectors, at the top). Nothing else to touch: the API, the MCP
tools, *Settings*, the import and a campaign's page pick it up by themselves.

```js
export const notion = {
  id: 'notion', name: 'Notion',                     // the id becomes the source of its requirements
  description: 'The pages of a Notion database, read as requirements.',
  settings: {
    fields: [{ name: 'token', label: 'Token', type: 'secret', env: 'NOTION_TOKEN' }],  // url | text | secret, optional
    hint: 'Where to create the token.', link: 'https://www.notion.so/my-integrations',
  },
  async test({ config, fetch }) { /* calls the tool */ return 'Reads as …'; },        // one sentence
  requirements: {
    item: 'page', items: 'pages', keys: 'abc123', reads: 'its title, its text, its criteria',
    query: { label: 'database id', placeholder: '…' },
    async read({ config, fetch }, { query, keys, known }) {                          // known: already imported (sync)
      return { records: [{ key, title, description, criteria: [], priority: 'medium', url }], warnings: [] };
    },
  },
  // coverage: { where, render(requirement, { campaign }) → { body, text }, async post(ctx, requirement, body, { ref }) → { ref, action, url } }
  // results:  { what, options, note, prepare(campaign, options, { ref }) → { target, items, payload }, async send(ctx, prepared, { ref }) → { ref, url } }
};
```

The connector receives `fetch` (a stand-in in its tests: see `test/connectors.test.js`), its settings,
and those of another (`configOf('jira')`, from which Xray takes the site's address). It touches neither
the database nor the settings: the keys, the criteria found in a description ("Acceptance criteria"),
the dry run, what was sent — the common frame takes care of all that.

#### Jira: its stories as requirements (`import_from_connector`, connector `jira`)

The site is set in the dashboard (*Settings → Jira*): its address
(`https://your-team.atlassian.net`), the account's email, and an API token of that account (created at
id.atlassian.com → Security → API tokens). It is kept on the machine, and never shown again: the
dashboard shows it masked. *Test the connection* says under which account IziTest reads. Failing that,
`JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` stand in for them. Reading writes nothing in Jira;
only the coverage comments (`send_coverage`, below) write there, and only when asked.

`import_from_connector(connector: "jira")` reads, through the REST API v3 of Jira Cloud (the
"enhanced" JQL search, page after page, 500 stories at most):
- the stories of a JQL query (`query`, `project = SHOP AND issuetype = Story ORDER BY key`: a bounded
  query, Jira refuses the others);
- or those of their keys (`keys`) — a key Jira does not know, or that this account cannot see, is
  reported, the others are read;
- or, `sync: true`, those already imported from Jira (of the project, or all): to see which changed.

Each story becomes a requirement (source `jira`): its key, its summary, its description (Atlassian's
rich format, turned into text), its priority, its link. Its acceptance criteria come from a field of
their own ("Acceptance Criteria", a custom field) when the site has one, otherwise from the list under
"Acceptance criteria" in its description. As for a file: a dry run first, then the import;
a story changed since, which has linked tests, is flagged. In the dashboard:
*Requirements → Import → From Jira*, with the site's projects to start from a query (*Where to start*)
(choosing a project proposes its stories, `issuetype = Story`; without a Story type, its issues except
sub-tasks), and *Check the imported ones for changes*.

#### Telling Jira where each story stands: `send_coverage` (connector `jira`)

`send_coverage(connector: "jira")` writes on each story, as a comment, where it stands in IziTest:
its coverage (`passing`, `failing`, `not run`, `not covered`), each of its criteria with its tests and
their last result (`✓`, `✗`, `○` without a test), the campaign it comes from, and when. For the
stories of `keys`, or those the tests of a campaign check (`campaign_id`: its requirements imported
from Jira, the others left aside). **One comment per story**, IziTest's own: sent again, it is
updated, not repeated; deleted in Jira in the meantime, a new one replaces it.

It is first a **dry run** (`dry_run`, by default) that shows each comment: the agent shows it to
the user and asks them before calling again with `dry_run: false`. A story Jira refuses (deleted,
this account has no right to it) is reported, the others are commented. In the dashboard: the report
of a campaign, *Send the results → Tell the Jira stories…*, a preview then *Send N to Jira*.

#### GitHub Issues: its issues as requirements (connector `github`)

A **public repository is read without setting anything**; a token (*Settings → GitHub Issues*, failing
that `GITHUB_TOKEN`) is only useful for a private repository, or beyond 60 requests an hour.
`import_from_connector(connector: "github")` reads:
- the issues of a GitHub search (`query`, `repo:acme/shop is:open label:story`; `is:issue` is added,
  pull requests left aside; 500 at most);
- or those of their keys (`keys`, `acme/shop#12`) — an issue that cannot be found is reported, a pull
  request too;
- or, `sync: true`, those already imported, read again from their link.

Each issue becomes a requirement (source `github`): its key (the repository's name and its number,
`SHOP-12`), its title, its text, its link, its priority from its labels (`priority: high`, `P1`…), and
its criteria: the list under "Acceptance criteria" in its text, otherwise its task list (`- [ ] …`).
Nothing is written to GitHub. Two repositories of the same name under two owners would give the same
keys: import only one of them per IziTest project.

#### Designing the tests of a requirement: `design_tests`

One method only, whichever agent applies it. IziTest does not reason: it lays out
the requirement, the cases it already has, the app (the project, its address, its notes) and the
**project's Gherkin phrases** — saying, for each, which argument is a CSS selector, and which are
business steps; the phrases that name a field by its label (`I fill the field "…" with "…"`,
`I select "…" in the field "…"`, `I check the field "…"`) ask for none —, then the rules:

1. **Testability review**: a criterion can be tested when it says what is done and what is seen
   afterwards, with its values. A vague word ("fast", "simple"), a missing result, a missing value:
   the criterion is flagged, with the question to ask its author and a rewording.
2. **What the requirement does not say** but its scope implies (an empty field, a value out of
   range): rules to add, except those another requirement of the project already states (the agent
   sees them all, with their criteria). For each rule, two pieces of information, and the reason for
   the level in one sentence:
   - **where it goes**: `this` (this requirement), `other` (another requirement of the project, named
     by its key, whose subject it is), or `project` (the whole project: the language of the messages, a
     form sent twice). An unknown key, or that of the requirement itself, brings the rule back to `this`;
   - **the level at which a test checks it best**: `e2e` (through the app's screens: a message, a
     button there or not, a journey), `api` (through its API: a rule to try with many
     values, a refusal from the server), or `unit` (in the code, by its developers).

   A rule is written in a requirement whatever its level. The level says where its test goes, not
   whether it should be said.
3. **The scenarios**, criterion by criterion, with a technique: `use_case` (expected path and
   variants), `equivalence_partitioning`, `boundary_values`, `decision_table`, `state_transition`,
   `error_guessing`. A scenario checks one criterion, with concrete values, and a priority.
4. **The expected result comes from the requirement.** Where it does not say it, there is no scenario
   to write: it is a question.
5. **The steps in Gherkin**, with the project's phrases word for word. Never a guessed selector:
   the phrases that ask for none (`I am on`, `I click on the text`, `I should see`) and the business
   steps first; a step no phrase covers is written in plain words.

Each scenario is resolved against the project's phrases: **ready** when all its steps are —
the test is created as it is (`create_test_from_gherkin(…, requirement, case_id)`) —, otherwise its
steps in plain words are **to record**: an agent follows them in the browser
(`start_recording(requirement, case_id)`).

- **In MCP**, the dev's agent reads `design_tests(requirement)`, shows the review and the scenarios to
  the user, then saves what it retains: `save_requirement` for the reworded or added
  criteria (on the other requirement for an `other` rule, on a new requirement of the project for a
  `project` rule), `plan_tests` for the scenarios (`technique`, `priority`, `rationale`, `gherkin`).
- **In the dashboard**, *Propose scenarios* sends the same method to the agent set in
  *Settings* (a model through the API, or a CLI run once with `-p`, without tools), which answers in JSON.
  The proposal is kept on the requirement. The review shows under each criterion concerned (with
  *Use this wording*), and the scenarios are to be ticked, grouped by criterion.

  What is missing shows under the criteria, each rule with its level (*End to end*, *API*,
  *Unit · developers*) and its reason. Its button depends on where it goes:
  - **this requirement**: *Add as a criterion*, then *Save* with the other criteria;
  - **another requirement**: *Add to DOLI-6*, which adds it at the end of its criteria;
  - **the whole project**: *Create a requirement*, which creates a requirement of the project with this
    rule as its title and as its criterion.

  *Not needed* sets it aside. Placed or set aside, the rule leaves the proposal
  (`POST /api/requirements/:ref/design/missing`, `{ text, dismiss }`). A proposal made before
  this classification keeps its rules as rules of this requirement, without a level. *Plan* makes
  planned cases of the scenarios, attached to their criterion by its text. If the requirement changes
  afterwards, the proposal is marked as made for an earlier version.
- **A planned case** is created from its scenario (*Create*: the Gherkin dialog, prefilled, links the
  test to the case) or recorded (*Record*: the agent gets the criteria, the scenario to follow, and the
  rule on non-conformities). *Scenario* opens its Gherkin: edited, it is checked again.

### Campaigns: `run_campaign`

A campaign replays together the tests of a **project**, of a **requirement** (the tests linked to it)
or a **list**, for a **version** of the app (`version: "1.4.0"`, a commit). Each test runs in a
window of its own, closed after, a few at a time (`concurrency`, 3 by default, 6 at most), in a
session of the campaign's own: not that of the agent that started it. A failure is diagnosed as with
`run_test`; these replays count in the coverage of the requirements (trigger `campaign`).

**In stages.** A campaign can also run its tests stage after stage (`stages`): for example a
set-up, then the tests that use what it made.

- Each stage runs its tests **side by side** (`parallel`, `concurrency` at a time) or **one after
  the other**, in their order (`sequential`). A stage starts when the one before it has finished.
- A stage marked `needs_previous` starts only if every test of the stages before it passed.
  Otherwise its tests are `skipped`, with the reason: "not run: the stage "Set-up" did not pass".
  The JUnit report carries it in its `skipped`.
- A value a test keeps (`capture`) is given to the tests that come after it and do not make it
  themselves. For example, a test creates an order and keeps its number; those of the next stage
  open it with `{{order}}`. In a side-by-side stage, the tests get the values kept before the
  stage; one after the other, those kept so far.
- A login, though, does not pass from one test to the next: each test logs in itself.
- Independent tests, each with its own data, are better. Stages are for what cannot be.
- `POST /api/campaigns/plan` (a project, a requirement or tests) proposes stages: a test that
  uses a value kept by another goes in a stage after it, `needs_previous`. Without such a value,
  a single stage.
- In the dashboard, *New campaign → Order → In stages* shows this proposal; there you name the
  stages, choose *Side by side* or *One after the other*, and move the tests from one stage to
  another by dragging them, or with their arrows. The report groups the tests by stage, with the
  status of each. *Run again* replays the same stages.
- MCP: `run_campaign(stages: [{ name, tests, mode, needs_previous }])`. CI: `--stages stages.json`.

A replay that stops by itself says why: its timeout ran out, or the browser was closed, stopped or
reloaded while it was running. In that last case, it fails at once instead of waiting for its
timeout.

**Tests that log in, side by side.** The windows of one Chrome share its cookies, incognito
included: a test that logs in as a manager logs out the one beside it, logged in as an employee,
and both fail.

- **Headless**, each lane of the campaign has a headless browser of its own, with its profile, hence
  its cookies. The tests run side by side, whoever they log in as.
- **In the user's Chrome**, the tests of a site where one of them logs in run one at a time; the
  others, side by side. A test logs in when it types a secret (`{{secret.NAME}}`) or in a password
  field. Its site is the origin of its first navigation, failing that the base URL of its
  project. The report says so: "One at a time: the 9 tests of http://127.0.0.1:5173, which log in there"
  (`one_at_a_time` in the API).

The report says:
- what passed, what failed and why (the cause from the triage);
- **what regressed** (passed in the last campaign this test ran in, whichever it was, fails
  now) and what was fixed. The comparison is made test by test: a campaign for a commit,
  which does not run the same list every time, is compared all the same. `changes.since` is the most
  recent of these campaigns, `changes.campaigns` all of them;
- **where each requirement stands**, criterion by criterion, from this campaign's replays: `passing`,
  `failing`, `not run` (one of its tests did not run here), `no test`;
- the **non-conformities**: to report, not to "repair" in the tests.

`run_campaign` waits for the end (10 minutes at most; past that, `get_campaign(id)` follows it) and
answers with the report. A list of tests that all belong to one project makes a campaign of that
project: it is listed with the project's, and its JUnit report files its tests under the project's
name. In the dashboard, the *Campaigns* page starts a campaign (a project, a requirement or chosen
tests, a version, how many at a time), follows it live, stops it (the tests running finish, the
others do not start), runs it again, and gives its *JUnit* and its *HTML report*. A requirement has
its *Run its tests* button; on the *Tests* page, checked tests start together with
*Run as campaign*. A test's *Campaigns* tab lists the campaigns it ran in and how it did in each
(`GET /api/tests/:name/campaigns`).

For a CI or a terminal, on a machine where the server runs (and the Chrome with the extension):

```bash
IZITEST_TOKEN=… node mcp-server/bin/campaign.js --project 3 --version 1.4.0 --junit reports/junit.xml --html reports/campaign.html
```

`--requirement REQ-12` or `--tests a,b` instead of `--project`; `--concurrency`, `--name`.
`IZITEST_URL` gives the server (by default `http://127.0.0.1:3467`). Exit code: 0 if every test
passes, 1 if a test fails or did not run, 2 if the campaign could not be started. In the JUnit
report, the cause from the triage is the `type` of each `failure`, and a test's requirements are its
`property name="requirement"`. A campaign left running by a server that stopped is marked
`interrupted` at the restart.

#### For a commit: the tests the change touches

Rather than all the tests of a project, a campaign can run **those a change touches**, each
chosen with its reason, the others left out with theirs. The risk is a test left out that would
have failed: when in doubt, more tests run, and the selection says so.

**What each test touches** (its footprint). A replay that passes from its first step keeps:
- the pages it went to;
- the data requests (fetch, XHR) its pages made to the app, front and API, whatever the port.
  Scripts, styles, the dev server and other sites do not count;
- the HTTP calls of its server steps;
- the requests that failed all the same, on every site, with their status (`failed`:
  `GET /manifest.json 404`), and its steps as they were (`steps_hash`). When the same steps fail
  later, a request that already failed the same way on this passing replay is not counted
  against the app (see the triage below).

Identifiers are replaced by `*`: `GET /api/notes/*`. Without a replay that kept it, a test has only
what its steps say (its navigations, its pages), and what its pages call is not
known.

**How a changed file is weighed** (`lib/regression.js`):
- **ignored**: documentation, the app's own tests (`test/`, `*.test.js`, `*.spec.ts`),
  editor and CI settings;
- **shared**, hence every test: dependencies (`package.json`, lockfiles), configuration and build
  (`vite.config.ts`, `.env*`, `Dockerfile`), a middleware, the database schema (migrations, `*.sql`),
  global styles, `index.html`, translations;
- **used everywhere**: its name says no part of the app (`App.tsx`, `server.js`, `api.ts`,
  `utils.js`, `Header.tsx`). Every test, unless `touched` says what the change touches;
- **code**: the words of its path (`api/src/routes/notes.js` → "note") are looked for in the
  routes of each test (`POST /api/notes`), then in its name (`ManagerPage.tsx` →
  `ndf_manager_approuve`, useful when all the pages have the same URL). A file that leads to
  no test makes every test run, unless `touched` is given.

**Also chosen**:
- the tests that go to a route of `touched` (`"POST /api/review/notes/:id/approve"`, `"/notes/*"`;
  a route without a method covers its pages and everything under it);
- those of the requirements the commit message names (`fix(NDF-3): …`);
- a test whose footprint is not known (no replay kept it);
- a test that failed last time: does the change fix it?
- those of `include`: the base to always run (logging in, the main flow);
- a test that keeps a value (`capture`) a chosen test uses. The stages are then proposed
  by themselves.

A route of `touched` no test goes to is reported (`uncovered`): what the change does there is
not tested. A change that touches no test starts nothing: "Nothing to run".

The first time, there is hardly any choice: with no footprint known, every test is taken. A full
campaign keeps them all.

- **MCP**: `plan_regression(project_id, changed_files, touched?, include?, commit_message?)` shows the
  choice without running anything. `run_campaign(project_id, changed_files, touched?, include?, commit?)`
  runs it. The agent that wrote the code knows its routes: it passes them in `touched`.
- **The commit** (`commit: { sha, branch, message, dirty }`) is kept with the campaign, and its short
  sha becomes the campaign's version. The report says so, with the tests chosen and left out
  (`commit`, `selection` in the API).
- **CI or git hook**, from the app's repository:

  ```bash
  node mcp-server/bin/campaign.js --project 3 --changed origin/main --include ndf_connexion_employe --headless
  ```

  `--changed <ref>` takes the files changed since the branch left `<ref>`, committed or not, new
  ones included. The commit (`HEAD`, sha, branch, message, `dirty`) is kept with the campaign.
  Other options:
  - `--files a,b`: the list of files;
  - `--touched "POST /api/notes"`: the routes touched;
  - `--repo <dir>`: the repository, if it is not the current folder;
  - `--plan`: shows the choice and stops.

  Nothing to run: exit code 0.
- **API**: `POST /api/campaigns/select` (the choice only); `changed_files`, `touched`, `include` and
  `commit` in `POST /api/campaigns`. Nothing to run: `200 { nothing_to_run, message, selection }`.
- **Dashboard**: *New campaign → What a change touches*, with the project, the files and the
  routes. The preview shows the tests chosen, with their reasons, and those left out.
  *Run it anyway* adds one. The report has a *Chosen for the change* card.

#### Replaying without a window: the headless Chrome

A replay opens its window **without giving it the focus**: the window you are in keeps it, and the
replayed page believes it is in the foreground all the same (focus emulated by the debugger,
screenshots taken by it, which draws a hidden tab). So a campaign opens its windows without taking
the focus from any.

To not see them at all, a **headless browser**: Chrome for Testing (Google's Chrome no longer
accepts an extension loaded from the command line), installed once from the dashboard
(*Settings → Headless browser → Install*, ~150 MB in `~/.izitest/browsers`), started with the
extension of the repository and a profile of its own (`~/.izitest/profiles/headless`). It starts at
the first replay asked headless and stops with the server, or before: after **10 minutes without
work** (set in *Settings → Headless browser → Stop after*, 0: never). Without work, that is:
- no command under way nor sent since;
- no replay or campaign running in it (even between two tests, or during a step that waits);
- no test being recorded in it (the agent may be waiting for the user's answer).

What the *Live* page does for it (listing its tabs every 3 s, filming them) does not count. What
needs it starts it again: a headless replay or campaign, a command that names it
(`profile: "headless"`), an agent with no other browser. A headless campaign of 3 at a time starts
two more, `headless-2` and `headless-3`, each with its profile (`~/.izitest/profiles/headless-2`, …),
stopped at the end of the campaign. Each learns its name from the page it starts on
(`data:text/html,headless-2#izitest-profile=headless-2`). Its extension registers as the
**`headless`** profile: a command that names no profile **never** goes to it, even if it connected
first (`list_profiles` points it out); an agent uses it only by naming it (`profile: "headless"`).
Its pages see an ordinary Chrome (no "HeadlessChrome" in the user agent).

- **Dashboard**: the *Headless — no window* option (a test's *Run options*, the campaign form,
  *Settings*), a single preference remembered; *Run as campaign* and *Run its tests* follow it;
  *Run again* does as the original campaign did. Not in debug nor with *Use Agent*: the first is
  watched step by step, the second repairs in the user's Chrome. The window of a headless replay
  is closed after.
- **MCP**: `run_campaign(…, headless: true)`.
- **CI**: `node mcp-server/bin/campaign.js --project 3 --headless`.
- **API**: `GET /api/headless` (installed, being installed, started, connected, the lanes connected,
  `idle_minutes`), `POST /api/headless/install|start|stop`, `PUT /api/headless/settings { idle_minutes }`
  (whole minutes, 0 to 1440); `headless: true` in `POST /api/tests/:name/execute` and `POST
  /api/campaigns`.

#### The recording read over before it is saved

At `stop_recording`, before saving, the server reads the steps over (`lib/recording-review.js`,
without a model) and looks for what would pass once, then fail at the next run:
- the **name of an item picked by its place**, written as it was in a later step: the check that
  "Penne rigate" is in the list, after taking the first result of a search for pasta. The name is
  first what the label of the element clicked says that the labels of the other cards do not
  ("Lait demi-écrémé UHT" in "Ajouter le produit : Lait demi-écrémé UHT à une liste");
  a later step names it if it holds it whole, its CSS escapes undone
  (`Supprimer\ le\ produit\ \:\ Lait\ demi-écrémé\ UHT…`). Without these labels, it is the words of the
  card: it takes at least two that its neighbours do not all read (they all read "Afficher le prix",
  "500g", the word searched for) — a single word is often the site's. Everything is read at the
  click: the card of the item picked (a button that says nothing, an icon, is read with the card it
  is in) and its neighbours, kept with the variable (`pickedText`, `otherTexts`, `pickedLabel`,
  `otherLabels`);
- a **value typed**, written as it was (or encoded in a URL) in the selector or the expected value
  of a later step.

The name of an item picked by its place, when its label gives it and the click's selector finds
the element by its place (not by that name), is **fixed by the server itself**: right after the pick,
a `capture` step keeps its name (`{{product_name}}`, read from the attribute the label comes from, the
words around it removed by a `pattern`), and the steps that named it write it `{{product_name}}` — their
selector, their expected value, their locators. The answer of `stop_recording` says so. On a replay,
the 2nd card of another search gives its own name, and that is the one removed from the list.

For the rest, if it finds any, the test **is not saved yet**: the answer lists these steps with
their `action_id` and how to fix them while the page is still there
(`record_step(action_id, remove: true)`, `capture_value`, `add_assertion` with `{{value}}`). The
second call to `stop_recording` saves, fixed or not. A typed value that the encoded URL checks
(`p%C3%A2tes` for "pâtes") is now linked to its variable by itself: a URL check also compares the
decoded URL.

#### A test written in Gherkin first

In the dashboard, *New test → Gherkin*: the user describes what the test checks,
*Generate Gherkin* has the agent write the scenario (`POST /api/projects/:id/scenario/write
{ name, description }` → `{ gherkin, phrases }`), with the project's library: its business steps
first, its generic phrases with the application's elements by name, never a guessed selector.
What none says, it writes as a **new step**, in the words of the domain. An account, a
password, a code: a secret of the project (`{{secret.NAME}}`, it gets their names, never the values)
or a value of its datasets (`{{users[1].email}}`), never an invented account; when none
fits, the value stays empty (`""`), and the agent recording asks the user for it (`ask_user`).
The scenario is shown, editable; each phrase is read against the library as you type
(`POST /api/projects/:id/scenario/check { gherkin }` → `phrases`), and the window counts separately the
project's business steps (listed), the generic phrases every project has (go to, click, see…) and the
new ones (listed). Each phrase is:
- `library`: a business step of the project, played in one go (`play_business_step`);
- `phrase`: a phrase of the library, on an element the project knows (the agent gets its
  selector) or on a selector;
- `find`: a phrase of the library on an element the project does not know, written by its name
  ("I click on "Empty the cart""): to be found on the page;
- `new`: a phrase no definition says.

*Create test* has the agent record the test, in the browser, its console and its browser
shown: `start_recording(name, project_id, scenario)` answers with the numbered phrases and how to do
each; before the actions of each phrase, `start_phrase(number, phrase)`. At `stop_recording`:
- each new phrase becomes a **business step** of the project, made of the steps recorded for it,
  its values in quotes its parameters when the steps use them (a variable of the test,
  a typed value); a phrase without a step, or whose steps do not follow one another, does not, and the
  answer says so;
- the element of a phrase that names it is that one: the step's element is merged with the
  project's element that has this name, or named so if there is none — except an element the user
  named otherwise.

The test then reads as the scenario was written. The agent always records, even when every
phrase is already in the library: the test is checked on the application before it is saved. A
ready case of a requirement (*Create*) goes through the same recording.

#### The windows after a run or a recording

In the user's Chrome, the window IziTest opened for a run or a recording stays open by default
once the work is done. The user chooses to have it closed in *Settings → Browser windows*, in a
test's *Run options* (*After the run, its window*) or in the *New test → AI Agent* window
(*Close the window once the test is saved*); it is a single setting for everyone, kept by the
server (`lib/run-windows.js`):

- `after_run`: `keep` (it stays open, by default), `passed` (it closes when the test passes; a
  failed run's stays open, to be looked at), `always` (it closes, passed or failed: a failed run
  keeps its screenshot and its video in *Runs*). For the dashboard's runs and `run_test`; with
  `run_test`, a failed run always keeps its window, since the agent repairs the step there, and
  `close_window` decides for that call. Never a debug run, which is followed step by step, nor a
  tab of the user's (*Open in a new window* unchecked, `new_window: false`).
- `after_recording`: the window the test was recorded in closes as soon as `stop_recording` has
  saved it (not a recording cancelled for lack of steps); the answer tells the agent, and its next
  `navigate` opens a new window.

Only a window IziTest opened is closed (`close_window` refuses any other), with the popups
its pages opened. A campaign already closes each test's window at the end of the test, and the
headless browser that of each run.

- **API**: `GET /api/settings/windows` → `{ after_run, after_recording }`; `PUT /api/settings/windows
  { after_run?, after_recording? }` (what is not given does not change; a wrong value → 400).

Its profile is its own: cookies, sessions and storage are not those of the user's Chrome. A
test of an app behind a login logs in itself.

#### Sending a campaign to Xray: `send_results` (`xray` connector)

Xray's API key is set in the dashboard (*Settings → Xray*): its client id and its secret,
created in Jira → Apps → Xray → API Keys (by an administrator). The secret is kept on the machine and
never shown again; *Test the connection* checks that Xray takes it. Without it, `XRAY_CLIENT_ID` and
`XRAY_CLIENT_SECRET` stand in for it; `XRAY_BASE_URL` names a regional Xray
(`https://eu.xray.cloud.getxray.app`).

`send_results(connector: "xray", id, options)` sends the results of a finished campaign, through
Xray Cloud's JSON import (`/api/v2/import/execution`):
- a **Test Execution** in the Jira project `options.project_key` — by default that of the stories its
  tests cover, when they all belong to one project —, added to the Test Plan
  `options.test_plan_key` if it is given; its summary is "IziTest — <campaign> (<version>)", its
  description the totals, the regressions, the non-conformities;
- each IziTest test is a **Generic test** of Xray, created at the first send then found again by its
  definition `izitest:<name>`, labelled `izitest`, **linked to the stories it covers** (its requirements
  imported from Jira): Xray shows their coverage;
- its result: `PASSED`, `FAILED` with the step, the error and the triage as a comment, or `TODO` if it
  did not run; its start and end times.

Sent again, the campaign **updates its Test Execution** (its key is kept): its results, not
its fields (Xray may not be allowed to rewrite its dates, on a "team-managed" project), and
the same tests, found again by their definition; deleted in Jira in the meantime, a new one is
created. It is first a **dry run** (`dry_run`, by default) that says what would be sent: the agent
shows it and asks before sending. In the dashboard: a campaign's report,
*Send the results → Send to Xray…* (the project and the Test Plan, the preview, then the sending),
and the Test Execution once sent. Xray needs a project where its issue types (Test, Test Execution)
are enabled; on a "team-managed" project, go through its Xray configuration first.

### Autonomous exploration: `explore_app`

The explorer walks a site on its own and reports what goes wrong without any assertion
having been written. From `url`, it visits the pages of the same site (same origin, breadth first,
following their links, `max_pages` at most — 8 by default) and, on each, checks:

| Check | What is reported |
| :--- | :--- |
| `console` | the errors the page writes in the console, and the exceptions it throws (`Uncaught …`) |
| `network` | the requests answered 4xx/5xx or failed (the favicon excepted) |
| `links` | the links to the site's pages that do not answer (requested from the page, with its cookies; links to other sites are not followed: many refuse a request that does not come from a browser) |
| `a11y` | the accessibility rules broken, by axe-core (WCAG 2.1 A/AA and best practices), of *serious* or *critical* impact (`include_moderate` for more) |

With `interact` (by default), it also clicks each harmless control of the page — buttons,
tabs, menus, named — and looks at what each click makes the page write or fail. Never what
deletes, pays, orders, logs out, sends, confirms or cancels (in French as in English), nor
a link (it is followed, not clicked). The page is reloaded after a click that changed it. No
form is submitted: to explore in depth (fill in, submit), the connected agent uses
`check_page` on the page it is on.

Each bug is kept once (same kind, same page, same click, same message, request, link or
rule): a later exploration counts it again without duplicating it, a bug marked fixed and
seen again is reopened, a dismissed bug stays dismissed. Each new bug gets a test that reproduces it,
`bug_<id>_<type>`: the page, the click that caused it, a second, then the check that fails as long as
the bug is there — and passes the day it is fixed. This test is replayed at once (`confirm`): the bug
is marked *reproduced by its test* if it does fail on this check. The exploration runs in a window of
its own, closed at the end, like those of replayed tests. Allow 2 to 10 s per page: Chrome slows down
a page in a background window.

The four checks are also assertion types (`add_assertion`): added to a test that
fails on it, such a check is not refused — the test then reproduces the bug; if it passes, it
guards against it. A bug's test that fails is diagnosed `app_regression`: the page still has the bug.

The dashboard has a *Bugs* page: start an exploration (*Start URL*, *Pages*, *Click controls*; the
project's base URL to start from, and the exploration is attached to that project), follow the
latest, and the list of the bugs of the dashboard's current project, from the most to the least
severe, filtered by status, kind, origin and severity, with their test and the actions *Fixed*,
*Dismiss*, *Reopen*. `/bugs?bug=12` shows only one. API: `GET /api/bugs?status=&project_id=`,
`PUT /api/bugs/:id`, `GET|POST /api/explorations`.

#### The bugs a test meets

**By default, a failure does not open a bug by itself**: a person reads the run and reports the bug
from its report (the test's *Runs* tab, *Report a bug* button on a failed run). The bug
is opened with what the run knows (its failed step, what was expected and what was read, the page,
the campaign), whatever the diagnosis, and the run is linked to it (*Bug #N* button). A diagnosis
can be wrong: opened by themselves, bugs due to the test filled the *Bugs* page. `run_test` says
when the diagnosis puts the failure on the app, so that the agent reports it to the user. Route:
`POST /api/executions/{id}/bug`.

When it is checked in the project (*Projects → Edit → Open a bug automatically when a test fails*,
`auto_bugs`), the earlier rule applies: a test whose failure is put on the app also opens a bug in
this page. This holds for a failure in a campaign, through `run_test` or from the dashboard, when the
diagnosis says:
- `non_conformity`: the app does not do what the requirement says. Kind *Non-conformity*, high severity.
- `app_regression`: the app fails where the test used to pass. Kind *Regression*, high severity if a
  request of the app answered 5xx or nothing, medium otherwise. The requests the triage sets aside
  (a manifest, another site's analytics script blocked by a proxy…) do not count.

A low-confidence `app_regression`, when nothing on the page says the app failed, opens no
bug. A failure due to the test (`test_drift`, `timing`, `test_outdated`, `session_state`) or to
the environment opens none either.

The bug keeps:
- its title, which says the criterion not met, then what went wrong: "NDF-2 criterion 3 not met:
  POST /api/notes/*/submit answered 400", or "expected "42,50", the page shows "…42,00 €…"". Without
  an expected value or a failed request of the app, the step and its intent: "step 7 (Open Create
  User Request) fails". A request set aside by the triage never gives its name to a bug;
- the diagnosis, the step, the requests refused, the page's message;
- the requirement criteria the test checks;
- the campaign, with its commit.

Its reproduction test is the test that failed: no other is created. The run is linked to the
bug.

The same failure, on the same test, the same step and the same dataset row, is **the same
bug**: it counts one more occurrence. A *Fixed* bug seen again goes back to *Open*; a *Dismissed* bug stays
so.

When the test **passes again, from its first step**, its bugs become *Fixed*, with the run that
saw them fixed, unless the test has changed since the bug: its commands, parameters or checks. A
changed test may pass because it no longer checks what was failing; the bug then stays open, and the
*Bugs* page and `run_test` both say to check by hand. The replay of a repair being
verified neither opens nor closes a bug.

The campaign lists the bugs its tests met, new or already seen, and those it saw
fixed: in its report (text, HTML, the dashboard's *Bugs* card), and beside each failed
test. `run_test` says the bug opened or seen again, then those the passing test fixed.

#### Reporting and handling a bug: `report_bug`, `update_bug`, `send_bug`

`report_bug` keeps a bug a person describes in their own words: `title`, `description` (what
happens and how to get there), `expected`, `page_url`, `severity`, `priority`, `assignee`,
`project_id`, `requirement`. The bug has no test yet. The answer tells the agent how to
reproduce it: follow the report in the browser, then record the test `bug_<id>_repro`, which
ends on a check of the **expected** behaviour. This test fails as long as the bug is there; when it
passes, the bug closes by itself. The test's name is enough to link it to the bug. If the agent does
not reproduce the bug, it records nothing and says what it tried. In the dashboard:
*Bugs → Report a bug*, then *Reproduce*.

`update_bug` handles a bug: `priority` (how urgent the fix is), `assignee`, `severity`, `title`,
`repro_test`, and `status`:

| Status | Meaning |
|---|---|
| `open` | To be fixed. |
| `to_retest` | The developers say it is fixed: its test has to confirm it. If it passes, the bug is *fixed*; if it fails, it goes back to *open*. |
| `deferred` | A real bug, not fixed for now. It stays so if it is seen again, and closes if its test passes. |
| `duplicate` | The same as another (`duplicate_of`). |
| `fixed` | Set by the test passing again; by hand only when no test can show it. |
| `dismissed` | Not a bug. |

`list_bugs` takes these statuses, and `unresolved`: *open*, *to_retest* and *deferred*.

`send_bug` sends the bug to the team's issue tracker (`jira` connector, `bugs` role):
what goes wrong, what was expected, the test that reproduces it, the requirement it breaks. It is a
**dry run by default**: the answer shows what would be written. `dry_run: false` writes, and
the agent does so only on the person's explicit yes. `project_key` names the Jira project; without
it, that of the requirement it breaks when that one comes from Jira. Sent again, the same issue is updated
(title and description). IziTest does not read back the status of the Jira issue.

### Product risk, test plan and reports

`save_requirement` takes `likelihood` and `impact` (`low`, `medium`, `high`): how likely the
requirement is to break and what that costs. Both give its risk level. `design_tests` plans
more cases for a high risk, a campaign runs its tests first, and the reports name it
as long as it does not pass: that is the residual risk.

`run_campaign` takes a test plan: `objective`, `scope_note` and `exit_criteria`.

| Criterion | Met when |
|---|---|
| `high_requirements_passing` | Every requirement of high priority or high risk the campaign checks passes. |
| `no_open_high_bug` | No high-severity bug the campaign met is *open* or *to_retest*. A *deferred* bug does not count. |
| `min_coverage` | The share of the acceptance criteria a test of the campaign ran reaches this percentage. |
| `min_pass_rate` | The share of the tests that passed reaches this percentage. |

`get_campaign` then gives the verdict, criterion by criterion with the value measured, and the
residual risk. The HTML report of a finished campaign that has a plan is its completion report. The API:
`POST /api/campaigns` takes the same fields, `PUT /api/campaigns/:id` changes the plan of an existing
campaign. On the command line: `--objective`, `--scope-note`, `--require-high`, `--no-high-bug`,
`--min-coverage`, `--min-pass-rate`; the exit code then follows the verdict.

`get_progress_report` gives the progress report of a period (`project_id`, `from`, `to`; the
last 7 days by default): runs and pass rate, campaigns and verdicts, requirements by
coverage and by risk, bugs opened and fixed with their trend, what is in the way, residual risk,
what comes next. The same as a page to print or send:
`/api/reports/progress.html?project_id=&from=&to=`, and in the dashboard's *Reports* page.

### Triage and repair of a failing test

A failure is diagnosed the moment it happens, on the page where it occurred (the replay's
window stays there), whether the test is started by `run_test` or from the dashboard — not in
step-by-step debug. The diagnosis is deterministic — it calls no model: the connected agent remains the one that
reasons about the ambiguous cases, with the evidence it is given. It is kept with the run, shown
in the output of `run_test` (section `=== TRIAGE ===`), in the run's live window and in
the dashboard's run history.

| Cause | What it means | Repair proposed |
| :--- | :--- | :--- |
| `test_drift` | The test broke, not necessarily the app: no locator finds the element any more, but the page has an element that clearly resembles it (same or similar name, same role, same placeholder, same test ID), or the text an assertion reads is elsewhere, in a single element | `relocate`: the step points at this element (selector, locators, role and name) |
| `timing` | The element is there now, under a selector of the step; or the assertion passes 1.5 s later | `wait`: a wait inserted before the step |
| `changed_value` | An assertion reads another value: a regression, or an intended change (new wording) | `expect`, **for a person to judge**: expect the new value. Never for the value of a variable, nor for a long text read by "contains" |
| `disabled` | The element is there but disabled | — |
| `app_regression` | The element has disappeared, or the value has changed, and the page reports an error (`role="alert"`, a request of the app in 4xx/5xx or without an answer, quoted in the summary: "POST /api/notes/111/submit answered 400"); or it does not show the value the test typed; or the step looks for what the test created (a row found by `{{description}}`) and the page no longer shows that value anywhere | — : to report, not to "repair" |
| `environment` | The page did not load (network error, page served in 5xx) | — |
| `test_outdated` | An assertion reads another value, and the requirement the test checks says that value now ("the status "À soumettre"") and no longer the expected one: the requirement changed, the test did not follow. Before, it was a `non_conformity`, and the agent that had just updated the requirement was told not to touch the test | `expect` without review: expect what the requirement says |
| `session_state` | A login step does not find the form, and the page offers to log out ("Se déconnecter", "Log out"): the browser was already logged in, by an earlier replay. A "login" step types a password or a secret, or comes shortly before the one that does | — : make the test start logged out (a first step to the app's logout URL, or a headless lane of its own), without touching its login steps |
| `unknown` | None of these, or several elements resemble the one looked for equally, or all show the text an assertion reads (the status of each row of a list) | — |

A failed request is not an error of the page when it was asked again later with success,
or when it is a 401 or 403 followed by a successful request to the same site: it is the session
check before the login (`GET /api/auth/me` in 401, then the login and the notes in 200). It
made the triage say "the page reports an error" on every app with a login.

A request that fails on every page says nothing of a test's failure. The triage sets it
aside, with its reason, and does not count it against the app:
- a manifest, a beacon or a ping (`manifest.json`, `*.webmanifest`, `beacon`, type `manifest`
  or `ping`): the browser asks for them, not the app;
- a request to another site than the app's. The app's site is the domain of the page,
  of the URLs the test navigates to and of the project's base URL, subdomains included: `api.example.com`
  is the app of `app.example.com`, `cdn.pendo.io` is not;
- an analytics request with no answer (Pendo, Google Analytics, Cloudflare Insights, Segment,
  Hotjar, Sentry…, or a path `analytics`, `collect`, `telemetry`, `tracking`): a proxy or a
  blocker stops it;
- a request given up by the browser (`net::ERR_ABORTED`: the page was left before the
  answer; `net::ERR_BLOCKED_BY_CLIENT`: an extension blocked it);
- a request that already failed, with the same status, on the last passing replay of the same steps
  of the test. That replay keeps its failed requests in its footprint. A 500 where that replay had a
  404 counts. If the test has changed since, or if no passing replay has kept them yet, this
  rule does not apply.

Example on an identity management portal, on 12 November 2026. On every page, `GET /manifest.json` answered
404, Pendo's and Cloudflare Insights' scripts got no answer and
`GET /ECMv6/api/idw/personalizations/1` answered 404:
- **Before**: every element the replay did not find became an `app_regression`, then a
  `non_conformity` of REQ-37 or REQ-38. Eight bugs were opened in one day, at high severity, with
  titles like "REQ-38 not met: GET /manifest.json answered 404".
- **Now**: the manifest, Pendo and Cloudflare are set aside. `personalizations` is too
  as soon as a passing replay has seen it fail. The failure is then `unknown`, at low confidence, and
  opens no bug. Before that passing replay, this 404 of the app's API still counts.

A step that looks for what the test created is never "repaired" towards another element. Example
with "Notes de frais": an expense note of €200 (the transport ceiling) is wrongly refused when submitted.
The test waited for its row at the status "Soumise", then checked it on the manager's page:
- **Before**: the wait failed without saying anything and the test failed 7 steps further on. The triage
  found "Soumise" on the first row of the table, that of another note, concluded it was a
  `test_drift`, and proposed to check that row. Accepted, this repair would have made
  the test pass again on someone else's note and hidden the bug.
- **Now**: the test fails on the wait, as a `non_conformity` on criterion 3 of NDF-2, with the
  400 of the submission. No repair is proposed.

The evidence comes with the diagnosis: the page's address, its alerts, the failed requests
(those set aside apart, each with its reason: "Not counted against the app: …"), the
best candidates with their score, and how many times the test passed before.

A repair is never applied by itself. `verify_repair` (or *Verify* in the run history)
replays the test with it, without saving it, with the variables and substitutions of the run that
failed: verified if the whole test passes, assertions included. `resolve_repair` (*Apply* /
*Reject*) saves it or discards it; another repair still open for the same step is
then replaced (`superseded`). A repair that finds its element another way can apply to all
the steps that act on it (`all_uses`, see "The elements of a project"). A step modified since the
proposal is not repaired blindly (`stale`). The same failure seen again proposes the same repair: it
is reused, not duplicated. The verification replays appear in the history with the trigger `repair`.

The steps of the replay are numbered as in the test: an assertion placed in the middle used to shift
every following step by one, and the failure was reported (and repaired) on the wrong one. A browser
step that fails after a server step (a capture, an API call) also keeps its
number and its diagnosis. Before, the results of its segment were lost on the way back, and the failure
arrived without a step or a diagnosis.

### Visual Regression Testing (VRT)

To enable VRT when recording:
```javascript
start_recording("my_test", { use_vrt: true })
```

Then add a retroactive visual assertion:
```javascript
add_retroactive_vrt("my_test", { step_order: 3, selector: "#header" })
```

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `test_name` | string | Name of the test |
| `step_order` | number | Position of the reference step (1-indexed) |
| `selector` | string | (Optional) CSS selector to target a specific element |

---
[< Previous: Usage](usage.md) | [Next: Multi-Account Management >](multi-account.md)
