# IziTest Agent

**End-to-end tests written by an AI agent from your requirements, in a real Chrome — then replayed
by IziTest, without AI.**

*En français : [résumé plus bas](#en-français).*

An agent (Claude Code, or the one the dashboard starts) reads a requirement, browses your
application and records the test: its steps, the values it typed, the checks it made. From then
on IziTest replays it on its own — in your Chrome or in a Chrome without windows — and keeps
track of what each requirement is proven by. The agent comes back only when a test needs to be
created or repaired.

## What it does

- **Requirements first.** Write them, import them from a file (CSV, Excel, JSON, Markdown), Jira
  or GitHub Issues. Each has its acceptance criteria, and its coverage shows which criteria a
  passing test proves.
- **Test design.** The agent reviews the criteria (can a test tell pass from fail?), lists the
  rules the requirement leaves unsaid — where each belongs, and at which level to test it —, and
  proposes scenarios with standard techniques (equivalence classes, boundary values, decision
  tables, state transitions).
- **Recorded by an agent, replayed without one.** Steps keep several locators each, so a
  renamed class does not break them. An assertion waits for what it checks. A value that must
  change at each run (an e-mail, a date) is computed; one the page gives (an order number) is
  kept for the steps after.
- **The expected result comes from the requirement**, not from what the application shows: when
  they differ, the test reports a non-conformity.
- **Data-driven.** A test bound to a dataset runs once per row.
- **Campaigns.** A project's tests, or a requirement's, replayed together for a version of the
  application, a few at a time, with or without windows. JUnit and HTML reports, a command line
  for CI, results sent to Xray, coverage sent to Jira.
- **Triage and repair.** A failure is classified (the application changed, the test is fragile,
  the page was slow…) and a repair proposed, checked on a replay before it is applied.
- **Export.** Every test reads as Gherkin and exports to Playwright (plain or Cucumber).
- **Watch it work.** The dashboard shows the agent's or the test's browser live, with a cursor
  where it clicks.

## How it works

```
Your agent (Claude Code, Claude Desktop, any MCP client)      The dashboard (http://127.0.0.1:3467)
                         │ MCP over SSE                                │
                         └──────────────► IziTest server ◄─────────────┘
                                          (Node, SQLite, port 3467)
                                                 │ WebSocket (port 3466)
                                                 ▼
                                    IziTest's Chrome extension
                           in your Chrome · in a Chrome without windows
```

The server keeps projects, requirements, tests and their runs in a local SQLite database. The
extension drives the pages. Everything runs on your machine: the server listens on `127.0.0.1`
only.

## Quick start

**You need** Node.js 22.12 or newer, Google Chrome and git. To have tests written by an agent: Claude
Code (or another MCP client). For the Dolibarr demo: Docker.

**1. Install and build** (the server, its dashboard and the extension):

```bash
git clone <repository-url> izitest-agent
cd izitest-agent
npm run setup
```

**2. Load the extension in Chrome**: open `chrome://extensions`, turn on *Developer mode*, click
*Load unpacked* and choose the `extension/dist` folder. Later builds reload it by themselves.

**3. Start the server**, then open the dashboard at <http://127.0.0.1:3467>:

```bash
npm start
```

**4. Connect your agent.** Claude Code started in this folder finds the server by itself
([.mcp.json](.mcp.json)). Anywhere else:

```bash
claude mcp add --transport sse izitest-agent http://127.0.0.1:3467/sse
```

The dashboard's own agent (*New test → AI Agent*, *Propose scenarios*) is set in *Settings*: a
CLI (Claude Code, Gemini, GitHub Copilot, OpenCode) or a model through an API key.

**5. Write a first test.** Serve the Test Arena, a page full of what makes UI tests hard:

```bash
npm run arena    # http://127.0.0.1:8777/izitest-test.html
```

Then, in the dashboard, create a project with that address and click *New test*. Or ask your
agent:

> Record a test on http://127.0.0.1:8777/izitest-test.html: sign in with a wrong password and
> check that the error message is shown.

## Try it on a real application

[demo/dolibarr](demo/dolibarr) starts [Dolibarr](https://www.dolibarr.org), an open source ERP,
with its demo data, in Docker: quotes, invoices, credit notes, VAT, discounts. It starts on the
version before the latest, so that upgrading it is a real maintenance case for your tests.

## Documentation

| | |
|---|---|
| [Introduction](docs/introduction.md) | Why an agent writes the tests and IziTest replays them |
| [Installation](docs/installation.md) | Every step, the ports, starting the server in the background |
| [Usage](docs/usage.md) | From a requirement to a campaign |
| [MCP tools](docs/mcp-tools.md) | Every tool an agent can call: recording, assertions, datasets, connectors, campaigns |
| [Configuration](docs/configuration.md) | Environment variables, ports, the extension's settings |
| [Live view](docs/live-view.md) | Watching an agent or a test in its browser |
| [Parallel sessions](docs/parallel-sessions.md) | Several agents at once, each in its own window |
| [Security](docs/security.md) | What can reach the server, the token |
| [Troubleshooting](docs/troubleshooting.md) | When something does not connect |

Parts of the documentation are still in French (most of *MCP tools*, *Configuration*,
*Troubleshooting*).

## Status

IziTest is young. It is used on real applications, and it still has rough edges: Chrome only,
an interface in English, PDF documents not read yet. Issues and feedback are welcome.

To work on it: `npm test` runs the server's and the extension's test suites;
`npm --prefix mcp-server run dev:frontend` serves the dashboard with hot reload on port 5175.

## En français

IziTest Agent fait écrire des tests de bout en bout par un agent IA, à partir de vos exigences,
dans un vrai Chrome — puis les rejoue lui-même, sans IA, dans votre Chrome ou dans un Chrome sans
fenêtre. Il suit ce que chaque exigence a pour preuve (sa couverture), conçoit les tests avec les
techniques usuelles (classes d'équivalence, valeurs limites, tables de décision), signale une
non-conformité quand l'application ne fait pas ce que l'exigence attend, analyse les échecs et
propose des réparations. Il lit les exigences d'un fichier, de Jira ou de GitHub Issues, envoie les
résultats à Xray, et exporte les tests en Gherkin et en Playwright.

Pour l'installer : `npm run setup`, l'extension `extension/dist` chargée dans Chrome, `npm start`,
puis le tableau de bord sur <http://127.0.0.1:3467>. Pour l'essayer sur une vraie application :
[demo/dolibarr](demo/dolibarr).

## License

[Apache License 2.0](LICENSE).
