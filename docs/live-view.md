# Live view 📺

Watch from the cockpit what an agent does in its tab, live and step by step, without
disturbing it.

## Routes

All of them require the same token as everything else (`?token=…` or `Authorization: Bearer …`).
They are read-only: GET only, except the setting.

| Route | Response |
|---|---|
| `GET /live/sessions` | The active sessions: `id`, `name`, `client` (name and version announced by the MCP client), `windowId`, `tabs` (`tabId`, `url`, `title`, `active`, `viewers`, `recording`, `popup`), `lastAction` (`tool`, `at`, `endedAt`, `status`, `frameId`), `recording` (the tabs being recorded), `createdAt` |
| `GET /live/tabs/{tabId}/stream?fps=10` | MJPEG stream (`multipart/x-mixed-replace`), usable as is in an `<img src>` |
| `GET /live/frames/{frameId}.jpg` | One kept image |
| `GET /live/tabs/{tabId}/recording` | The tab's images since its session started (JSON, with the `src` of each image) |
| `GET /live/tabs/{tabId}/recording?format=mjpeg&speed=4` | The same, replayed as MJPEG at its original pace (×`speed`, pauses cut to 2 s) |
| `GET /live/settings` · `PUT /live/settings {"enabled": false}` | The setting that turns everything off |
| `PUT /live/settings {"continuousRecording": false}` | Turns off continuous recording only |

## The stream

- One image each time the screen changes, at most `fps` per second (1 to 30, 10 by default),
  as JPEG quality 60, at most 1280 px wide.
- The first image arrives at once, even if the page does not move.
- At most **2 viewers per tab**: the third gets a `429`.
- The stream stops as soon as the last viewer disconnects.
- A viewer that is too slow skips images, but always gets the last one, the one that shows
  the current screen.
- Only the agents' tabs are visible: windows opened by IziTest Agent and popups opened from
  them. A tab of the user's answers `403`, unless a session works in it.

**Tab in the background.** Chrome no longer paints a hidden tab (another tab in front, the
window minimized or covered), and the screencast goes quiet. The extension then captures the
tab at the requested rate and sends only the images that differ from the one before. So the
stream goes on without bringing anything to the front.

## In the dashboard

The dashboard shows this stream in four places.

- **The *Live* page** (left menu, `/watch`): each connected agent, with the tabs of its
  window; the tab of the agent that acted last is shown, a click shows another. This is where
  you follow an agent working in the headless browser, when Chrome does not have the
  extension.

- **Creating a test with the AI agent**: the window widens as soon as the agent starts. The
  browser is on the left, the agent's log on the right. The form folds into one line that
  recalls the request; it comes back if the agent fails or is stopped, to try again.
- **Running a test**: the steps panel widens, with the browser beside it. It is the only
  way to see a headless run while it plays: the *Live* page lists the agents' sessions, not
  the runs of tests.
- **Asking the agent about a test** (*Ask the agent*, on the test's page): the browser the
  agent works in is on the left, the conversation on the right.

At the end, the last image stays on screen.

The server says which tab to show in the run's event stream, and says it again if the tab
changes:

```json
{ "type": "live", "tabId": 123 }
```

- **For the CLI agent**: it connects to the MCP server with the id of its run
  (`/sse?run=run-…`). The sessions it opens carry this id, and the server follows the tab of
  the one it used last (`followRun` in `lib/live.js`).
- **For the dashboard's internal agent**: it gets the id directly.
- **For a test**: as soon as a step returns the tab it was played in.

The dashboard reads the stream with `fetch`, not with an `<img>`, so that it can say why it
is refused (live view turned off, too many viewers). In development, Vite's proxy forwards
`/live` and adds the token, as it does for `/api`. It counts as one of the tab's
2 viewers.

## The cursor

The mouse IziTest drives (DevTools protocol) has no image of its own: a click landed with nothing
to show it. So each move and each press of this mouse is drawn in the page, by the extension
(`extension/src/cursor.ts`, `dom/cursor.ts`):

- a blue arrow that glides to the point it aims at (350 ms);
- a blue circle that widens where it presses.

It shows in the live view, in the images kept per action and in the window itself. It stays
where it was when a new page loads.

- **Never in the way**: it takes no click (`pointer-events: none`), has no text and lives in a
  shadow root.
- **Hidden during a capture** that is compared with a reference (`screenshot`, VRT), which would
  otherwise differ because of it.
- **Only in the piloted tabs**: the user's mouse is never followed.
- **A click made by script** (`el.click()`, for a checkbox) does not move it: it does not go
  through the mouse.

## One image per action

After each `navigate`, `click`, `fill`, `select`, `upload_file`, `drag`, `keyboard` and `act`,
the image of the tab is kept once the page has settled (100 ms without a change to the DOM,
300 ms at most). Its id comes back in the result:

```json
{ "success": true, "tag": "button", "changes": ["…"], "frameId": "mv9kgok0-33292a14c0a1" }
```

- If the action fails, the id ends the error message: `… (frameId: mv9kgok0-…)`.
- `act` gives one `frameId` per step and a last one for the page as it leaves it.
- This costs about 80 ms per action.

These images are taken whether someone is watching or not: no step is missing.

## Continuous recording

As long as a session has its working window open, its tab is recorded, even with no
viewer.

- **What**: one image each time the screen changes, at most 2 per second, as JPEG quality 50,
  at most 1280 px wide. The last image of a burst is always kept.
- **Where they go**: in `/live/tabs/{tabId}/recording` with `kind: "stream"`, mixed with the
  action images.
- **Which tabs**: the session's working tab, the tab in front in its window (the one a click
  opened, for example) and the tab of the popups opened from it. Not the user's tabs.
- **Start and stop**: recording starts at the first action, and the list is checked again
  every 3 s. It stops when the window closes or the session ends; its images stay.
- **Limit per session**: the 300 most recent stream images
  (`IZITEST_LIVE_SESSION_MAX_FRAMES`), plus **all** the action images, which this limit
  never removes.
- **Cost**:
  - visible tab: the screencast sends nothing as long as the page does not move;
  - hidden tab: every half second the extension asks the page whether something has
    changed (DOM, scrolling, typing, resizing), and captures only in that case, or every
    5 s at the latest (canvas, CSS animations);
  - images identical to the one before are not kept.
- **With a viewer**: the same screencast serves both, at quality 60 for the viewer;
  the recorded copy is re-encoded at quality 50.

When continuous recording is turned off, a watched tab still keeps one image of the stream per
second (`IZITEST_LIVE_RECORD_INTERVAL_MS`), as before.

The images are kept **24 h** in `mcp-server/data/live/` (20,000 at most,
`IZITEST_LIVE_MAX_FRAMES`), each from the moment it was taken. A session's recording can
still be viewed after it ends, its oldest images going first.

## Read-only

- Everything goes through the DevTools protocol, on the debugging session the agent already
  uses: `Page.startScreencast` and `Page.captureScreenshot`. No tab is activated, no
  window comes to the front or changes owner.
  (The `screenshot` tool, for its part, uses `captureVisibleTab`, which has to activate the tab.)
- Nothing is drawn on the page: no border, no bar.
- No snapshot is taken: the agent's `@eX` refs do not move.
- The only things put in the tab are `MutationObserver`s and listeners of `scroll`, `input`,
  `resize` and `load`, in the extension's isolated world, to know when the page changes and
  when it is stable. The page does not see them.

## Turning it off

- `PUT /live/settings {"enabled": false}`: stops every stream, takes no more images
  after actions, and the `/live/*` routes answer `503`, except `/live/settings`, which
  still answers. The setting is kept in the database and survives a restart.
  `{"enabled": true}` turns it back on.
- `IZITEST_LIVE=off` in the server's environment: turned off, and impossible to
  turn back on without a restart.
- `PUT /live/settings {"continuousRecording": false}`: turns off continuous recording
  only. The live stream and the action images go on. The setting is kept in the database.
  `IZITEST_LIVE_RECORD=off` locks it until the restart.

The images already kept are not erased; they disappear after 24 h.

## CORS

The cockpit runs on another origin. With a token, GET requests under `/live/` therefore
answer `Access-Control-Allow-Origin: *`. They still require the token and change
nothing. The other routes keep their policy.

Without a token, only local pages and the origins in `IZITEST_ALLOWED_ORIGINS` can
read `/live/`: these images show the agents' tabs, not the user's, but those tabs are
open in the piloted Chrome with the sessions the user is signed in to, and any site open
in that Chrome could otherwise read them. A cockpit hosted elsewhere must be added to this
list (`IZITEST_ALLOWED_ORIGINS=https://pilotage.example.com`).
An `<img src>` on the MJPEG stream, which sends no `Origin`, always displays. See
[security.md](security.md).

## Limits

- The actions of the dashboard's autonomous agent (`agent-executor`) do not leave an image
  yet; only the MCP tools do.
- `scroll` leaves no image (it is not in the requested list); the stream shows it.
- The stream of a hidden tab costs one capture per period (`1/fps`) as long as someone
  is watching. The screencast of a visible tab costs nothing when the page does not move.
- On a hidden tab that is recorded with no viewer, a purely visual change (video, canvas,
  CSS animation) is only seen at the safety capture, every 5 s.
- After a restart of the extension, the stream resumes by itself within 5 s.

## The video of a run

A run too fast to follow live can be watched again. The extension records the tab of each run as
soon as it is known (after the step that opens it): one image each time the screen changes, 5 per
second at most. At the end, the video is **kept if the test failed**, or if **Record video** is
ticked; otherwise it is thrown away.

- **Where to tick it**: a test's run options (*Run* → *Record video*), a campaign's form
  (*Record video of every test*), `run_test(…, record_video: true)` and
  `run_campaign(…, record_video: true)`.
- **Where to see it**: the test's *Runs* tab, the **Video** button on the run. The player replays
  it at its own pace (×0.25 to ×2, pauses longer than 2 s shortened), with the steps beside it: the
  step on screen is highlighted, a click on a step takes the video there. Space: play or pause;
  arrows: image by image; Esc: close.
- **Routes**: `GET /api/executions/{id}/video` (the images and their times, with the steps and
  their times) and `GET /api/executions/{id}/video/{n}` (image n, JPEG).
- **Retention**: `data/videos/{id}/`, 30 days (`IZITEST_VIDEO_DAYS`), 3000 images at most per
  run (`IZITEST_VIDEO_MAX_FRAMES`). The videos of deleted runs go when the server starts,
  then once a day. `IZITEST_RUN_VIDEO=off` records no run.
- **What it shows**: the screen as it was, so also what was typed in clear (an e-mail).
  A password stays masked in its field.
- **A login through another site** (Keycloak, an SSO) or a page that changes during a
  check redoes the extension's connection to the tab: the server asks for the recording again
  every 1.5 s during the run, and the video goes on without a gap.
- IziTest's bar ("RUNNING — Step 3/5 …") is in the video. It is hidden from locators and
  snapshots: a step "Pick Spain among the suggestions" no longer finds "Spain" in the
  bar.
