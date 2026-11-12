# Usage: from a requirement to a campaign

The path a team follows in the dashboard (<http://127.0.0.1:3467>). Each step can also be done by
an agent through the MCP tools ([mcp-tools.md](mcp-tools.md)).

## 1. A project

*Projects → New project*: its name, the address of the application, the language its tests are
written in (English or French), and what an agent should know about it — how to log in, what the
data looks like. Tests, requirements, datasets and campaigns belong to a project.

Its **secrets** (*Edit → Secrets*): the passwords and API keys its tests type, kept encrypted on
this machine. A step writes `{{secret.NAME}}`; IziTest types the value, and the agent only ever knows
the name.

## 2. Requirements

*Requirements → New requirement*, or *Import*: a file (CSV, Excel, JSON, Markdown), Jira, or GitHub
Issues ([connectors](mcp-tools.md#connecteurs--les-outils-doù-viennent-les-exigences-et-où-vont-les-résultats)).
A requirement has acceptance criteria; its coverage says which criteria a test proves, and how
that test last ran: *not covered*, *not run*, *failing*, *passing*.

A requirement also has a **product risk**: how likely it is to go wrong (*Likelihood*: new or
complex code, changed often, failed before) and what it costs when it does (*Impact*). Both rated,
they give its risk level, shown in the list. A high-risk requirement gets more cases when its
tests are designed, runs first in a campaign, and is named in the reports while it does not pass
(the *residual risk*).

## 3. Design its tests

On a requirement, *Propose scenarios* asks the agent set in *Settings* for a test design:

- a **review** of each criterion: can a test tell pass from fail? If not, the question to ask its
  author and a rewording;
- the **rules the requirement leaves unsaid**, each with where it belongs (this requirement,
  another one, the whole project) and the level to test it at (end to end, API, unit);
- **scenarios**, each with its technique (equivalence classes, boundary values, decision table,
  state transition, error guessing), its priority and its steps in Gherkin.

Tick the scenarios to keep and *Plan*: they become planned cases of their criterion. A case can
also be planned by hand, criterion by criterion.

## 4. Create the tests

A planned case becomes a test in one of two ways:

- **Create**, when every step of its scenario is a phrase of the project: the test is made from
  the Gherkin, nothing to record;
- **Record**: the agent opens the application in Chrome and follows the scenario, finding on the
  page what its steps say in plain words. The dashboard shows its browser live.

Without a requirement, *New test* does the same from a description (*AI Agent*) or from Gherkin.
With your own agent, ask it — for instance in Claude Code:

> Design the tests of REQ-12 with design_tests, then record the first scenario.

The expected results come from the requirement, never from what the application shows: when the
page does otherwise, the test reports a **non-conformity** rather than adapting to it.

When the agent needs something nobody gave it — an account to log in with, its password — it
**asks you** instead of making it up: the question shows beside its browser, you answer, it goes
on. A password you give is kept in the project's secrets; the agent gets its name, not its value.

## 5. Run them

On a test, *Run*. Its options (*Run options*): in a new window of your Chrome or **headless**,
**let the agent fix failures**, or **debug step by step** with breakpoints. The run is shown live,
step by step.

A failing run is **triaged**: the test drifted from the page, the page was late, a value changed,
the application regressed, the requirement is not met, the environment failed. When it can, IziTest
proposes a **repair** — another locator, a wait — that you verify on a replay before applying it,
under the test's *Runs* tab.

## 6. With data

*Datasets*: tables of values (users, products). A test bound to one runs once per row, with
`{{email}}`, `{{password}}` the values of the row. An agent recording a test of the project takes
its values from there rather than making them up.

## 7. Campaigns

*Campaigns → New campaign*: the tests of a project, of a requirement, or a list, replayed together
for a version of the application, a few at a time, with or without windows. A campaign gives:

- what passed, failed and was not run, each test compared with the last campaign it ran in;
- each requirement's coverage for that version;
- a JUnit report for a CI and an HTML report;
- its results sent to Xray, and IziTest's word on each story sent to Jira, when those connectors
  are set (*Settings → Connectors*).

*Order → In stages* runs the tests stage after stage: a set-up first, then the tests that use what it
made. Each stage runs its tests side by side or one after the other, and can wait for the stages
before it to pass. A value a test keeps is given to the tests after it. Drag a test from a stage to
another, or move it with its arrows.

Side by side without windows, each lane has a Chrome of its own, so tests logging in as different
users do not log each other out. In your Chrome, whose windows share their cookies, the tests of a
site one of them logs in to run one at a time.

*What a change touches* runs only the tests a change needs, each chosen with why: those whose
pages or API calls the changed files are about, those of the requirements the commit names, a
test that failed last time, and the tests you always run. A shared file — dependencies, the
configuration, the database schema — runs every test. The preview shows the tests left out; run
one anyway with *Run it anyway*.

A campaign can have a **test plan**, written in *New campaign → Test plan* or later on the
campaign's page: its objective, what is in and out of scope, and its exit criteria — what says
the testing can stop:

- every requirement of high priority or high risk passes;
- no high-severity bug is left open (a bug said fixed still counts until its test confirms it;
  a deferred one does not);
- at least a given share of the acceptance criteria has a test that ran;
- at least a given share of the tests pass.

The campaign's page and its reports then give the verdict, criterion by criterion with what was
measured, and the residual risk: the requirements at risk that do not pass. With a plan, the HTML
report of a finished campaign is its completion report. *Run again* keeps the plan.

From a CI job:

```bash
node mcp-server/bin/campaign.js --project 3 --version 1.4.0 --headless --junit reports/junit.xml
```

With exit criteria, they decide the exit code instead of "every test passed":

```bash
node mcp-server/bin/campaign.js --project 3 --objective "Release 1.4 can ship" \
  --require-high --no-high-bug --min-coverage 80 --min-pass-rate 95 --headless
```

Only what the branch changed since `origin/main`, the commit kept with the campaign:

```bash
node mcp-server/bin/campaign.js --project 3 --changed origin/main --headless --junit reports/junit.xml
```

Exit code 0 when every test passed, or when the change touches no test.

## 8. Bugs

The *Bugs* page keeps what the tests met (a requirement not met, a regression), what exploring an
app found, and what people report.

*Report a bug*: say what goes wrong in your own words, what you expected and where. *Reproduce*
then asks the agent to follow your report in the browser and to keep the test that shows it: that
test fails while the bug is there, and the bug closes by itself when it passes.

*Handle* on a bug sets its severity, how urgent its fix is and who has it, and its status:

- *To retest*: the developers say it is fixed; its test has to confirm it. Passing closes the
  bug, failing opens it again.
- *Deferred*: a real bug, not fixed for now. It stays in the backlog and in the reports.
- *Duplicate* of another bug, or *Dismissed*: not a bug.

*Send to Jira…* makes the bug an issue of the team's tracker: a preview first, nothing is written
before you confirm. Sent again, the same issue is updated. Its Jira status stays the team's:
IziTest does not read it back.

## 9. Reports

*Reports* says where the testing stands over a period: runs and how many passed, the campaigns
and whether each met its exit criteria, the requirements by coverage and by risk, the bugs opened
and fixed with their trend, what is in the way, the residual risk and what comes next. *Open as a
page to print or send* gives the same report as one HTML page, readable without IziTest
(`/api/reports/progress.html?project_id=3&from=2026-11-01&to=2026-11-07`). An agent gets it with
`get_progress_report`.

## 10. Take the tests elsewhere

A test's *Gherkin* tab shows it as a scenario, editable; its *Code* tab exports it to Playwright,
plain or with Cucumber.

---

More: driving the browser with the basic tools ([browser-tools.md](browser-tools.md), in French),
watching a run ([live-view.md](live-view.md)), several agents at once
([parallel-sessions.md](parallel-sessions.md)).

---
[< Installation](installation.md) | [MCP tools >](mcp-tools.md)
