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

*Requirements → New requirement*, or *Import*: a file (CSV, Excel, JSON, Markdown, Word, a Postman
collection or an OpenAPI document — a request per requirement), Jira, or GitHub Issues
([connectors](mcp-tools.md#connecteurs--les-outils-doù-viennent-les-exigences-et-où-vont-les-résultats)).
Any other document — a Word spec written freely, an email, notes, the text of a PDF — is read by the
agent set in Settings: tick *Have the agent read it*, then choose the file or paste the text. It keeps
the document's keys, titles and words, writes only the criteria the document states, and lists the
passages that are unclear. The preview shows each requirement with the passage it comes from; nothing
is saved until you import, and then what you checked is saved as it is.
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
The window the agent records in stays open once the test is saved, unless you check *Close the
window once the test is saved* (in *New test → AI Agent*, or in *Settings → Browser windows*): then
it closes as soon as the test is saved, for every recording, yours and your agent's.
With your own agent, ask it — for instance in Claude Code:

> Design the tests of REQ-12 with design_tests, then record the first scenario.

The expected results come from the requirement, never from what the application shows: when the
page does otherwise, the test reports a **non-conformity** rather than adapting to it.

When the agent needs something nobody gave it — an account to log in with, its password — it
**asks you** instead of making it up: the question shows beside its browser, you answer, it goes
on. A password you give is kept in the project's secrets; the agent gets its name, not its value.

What the tests click, fill and check are the project's **elements**, listed page by page under
*Elements* with the tests using each. An element has a name the Gherkin uses ("When I fill
"E-mail"…"); rename it there and every test reads the new name. The same field recorded twice is
one element, even when one test kept its id and another its label or placeholder: two steps of a
page sharing its id, test ID, `name` or placeholder are merged, under the name you gave it. Two
buttons a person reads differently ("Next", "Finish") stay two.

## 5. Run them

On a test, *Run*. Its options (*Run options*): in a new window of your Chrome or **headless**,
**let the agent fix failures**, or **debug step by step** with breakpoints. The run is shown live,
step by step.

Once a run is over, its window stays open by default, so you can look at the page it ended on. To
have it closed, choose in *Run options → After the run, its window* (or in *Settings → Browser
windows*): **Closes when the test passes** (a failed run's window stays open, to be looked at), or
**Always closes** (a failed run keeps its screenshot and its video under *Runs*). The choice is the
same for every run, the dashboard's and an agent's, and stays until you change it. Only a window
IziTest opened is ever closed, never one of yours, nor your own tab when *Open in a new window* is
off. A debug run keeps its window, and so does a run an agent is repairing: the agent fixes the
step there. In the headless browser and in a campaign, each test's window is closed anyway.

Each step waits for the button or field it acts on, and each check for what it expects, up to
the project's **wait for an element**: 10 s by default, set in *Projects → Edit*. Raise it when
tests fail on pages still loading (a slow test server, a company laptop, the browser without
windows); a test that passes is not slowed down.

A failing run is **triaged**: the test drifted from the page, the page was late, a value changed,
the application regressed, the requirement is not met, the environment failed. When it can, IziTest
proposes a **repair** — another locator, a wait — that you verify on a replay before applying it,
under the test's *Runs* tab.

When the application changes a button or a field that other tests use too, fix it once. A repair
that finds the element another way says "also used by 3 steps in 2 tests", and applies to all of
them while *Apply the repair to them too* stays checked. Editing a step by hand (its selector, its
locators) shows the same list, with a box to give them the new locators as well — unchecked, since
an edited step may now aim at another element. Each step keeps what it types and what it checks.

## 6. With data

A test's *Data* tab has a table, **Test data**: a column per variable of the test (`{{first_name}}`,
`{{email}}`…), a row per case to play. *Add a row* (it starts from the defaults), type the values,
duplicate or delete a row, *Save rows*. A cell left greyed plays the variable's default; a cell may
compute its value (`{{today + 3 days | dd/MM/yyyy}}`) or type a secret of the project
(`{{secret.NAME}}`).

- **Run** plays every row, one after the other, a run each; the live window shows the row being
  played and how each one did. *Rows* in the *Run options* plays only one, or *Run every row as a
  campaign*.
- **Each run says the row it played** under the *Runs* tab — "Row 2 — Bob, Martin", and all its values
  once opened; so does the campaign report, a row per run. A password shows `(hidden)`, a secret
  only by its name.
- **The test's status counts every row**: one row failing, the test shows *Failed* — "row 1 of 2
  failed" in the test list and on its page, and its requirement is failing —, even when a later run of
  another row passed. Fix it, play that row alone (*Rows* in the *Run options*), and it turns green.
- **Its Gherkin**, with two rows or more, is a *Scenario Outline* whose *Examples* are the rows; with
  one row or none, a *Scenario*. Edit the *Examples* in the *Gherkin* tab and save: the rows change
  too.

*Datasets*: tables of values (users, products) shared by the project's tests. A test bound to one
(*Data* tab) plays the dataset's rows instead of its own, with `{{email}}`, `{{password}}` the values
of the row. An agent recording a test of the project takes its values from there rather than making
them up.

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

A test's *Gherkin* tab shows it as a scenario — a *Scenario Outline* when it has rows —, editable;
its *Code* tab exports it to Playwright, plain or with Cucumber, a test or an *Examples* line per row.

---

More: driving the browser with the basic tools ([browser-tools.md](browser-tools.md), in French),
watching a run ([live-view.md](live-view.md)), several agents at once
([parallel-sessions.md](parallel-sessions.md)).

---
[< Installation](installation.md) | [MCP tools >](mcp-tools.md)
