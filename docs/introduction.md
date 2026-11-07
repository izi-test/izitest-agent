# Introduction to IziTest Agent

IziTest Agent has AI agents write end-to-end tests from your requirements, in a real Chrome, and
replays them itself, without AI.

## Why

Writing end-to-end tests is slow, and keeping them working is slower: a renamed class, a page
that loads a little later, and the suite goes red for nothing. AI agents can now browse an
application and do what a requirement says — but a test that asks a model at every run is slow,
costly, and never quite the same twice.

IziTest splits the work:

- **an agent writes the test** — it reads the requirement, browses the application and records
  what it does and what it checks;
- **IziTest replays it**, step by step, with no model in the loop: the same test, the same way,
  every time, in seconds;
- **the agent comes back** only when a test has to be created, or repaired after the application
  changed — and a repair is checked on a replay before it is applied.

And it keeps the link a QA team cares about: which requirement each test proves, which
criteria are covered, how each one did in the last campaign.

## How it is built

```
Your agent (MCP client)      The dashboard
          │ MCP over SSE           │ HTTP
          └──────► IziTest server ◄┘   (Node, SQLite, port 3467)
                         │ WebSocket (port 3466)
                         ▼
               IziTest's Chrome extension
        in your Chrome · in a Chrome without windows
```

- **The server** keeps projects, requirements, tests, datasets and runs in SQLite, serves the
  dashboard, and exposes the MCP tools agents call.
- **The extension** drives the pages: it finds elements, clicks, types, checks, and replays a
  test's steps. In your own Chrome it acts, by default, only in the windows IziTest opened: never
  in your own tabs.
- **A Chrome without windows** (Chrome for Testing, with the same extension and a profile of its
  own) replays tests and campaigns out of sight.

## Key ideas

- **Several locators per step.** A recorded click keeps its CSS selector, its accessible name, its
  text, a test id when there is one; a replay tries them in turn.
- **Assertions wait** for what they check, as Playwright's do.
- **The expected result comes from the requirement.** When the application does otherwise, the
  test reports a non-conformity instead of adapting to it.
- **Snapshots for agents.** An agent sees a page as a compact list of its interactive elements,
  each with a reference (`@e12`) to act on — iframes included.

---
[Installation >](installation.md)
