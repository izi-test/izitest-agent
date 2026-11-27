# IziTest compared with the ISTQB and REQB test processes

This document compares what the certification syllabi describe with what IziTest does today. It
is used to decide what to add so that the tool suits the testing roles that have no technical
background: head of testing, test manager, test lead, functional tester.

**The stance.** IziTest stays an agentic tool. The functional tester meant here is a person who
automates their tests without writing code: they describe or approve the scenario, the agent
runs it. Having tests executed by hand is not a goal.

**What is compared**

- **ISTQB CTFL v4.0**, "Testeur certifié Niveau Fondation", the CFTL's French version (in force
  since May 2023). It is the reference syllabus for the test process.
- **REQB CPRE Foundation Level v1.3**, French version (GASQ, 2011), for requirements
  engineering. The REQB is no longer issued under that name: the current certification is IREB's
  CPRE (Foundation Level v3.x). The concepts used here (quality criteria, traceability, change
  management) are in it too, but that syllabus was not compared line by line.
- **IziTest** as it is on the `main` branch (commit `201932b`), according to the code and the
  documentation.

**How to read the tables**

| Verdict | Meaning |
|---|---|
| ● Covered | IziTest does what the syllabus describes. |
| ◐ Partial | Part of it exists; the "What is missing" column says which part does not. |
| ○ Absent | Nothing exists. |
| — Out of scope | Nothing exists, and it is not the tool's job. |

## In short

Of 44 points compared: 22 covered, 10 partial, 7 absent, 5 out of scope.

- **The model fits.** IziTest follows the same chain as the ISTQB: test basis (the requirement),
  test condition (the acceptance criterion), test case, test script, test result, defect. The
  traceability both syllabi ask for is the heart of the tool.
- **The tester's work is covered, and without code**: test analysis, test design, test
  implementation, test execution, confirmation testing and regression testing. The tester
  describes or approves the scenario; the agent records it, then the test replays on its own.
- **The test manager's work is mostly covered, campaign by campaign**: test planning, test
  monitoring and control, test completion and risk management. A campaign has a test plan, exit
  criteria with a computed verdict and a test completion report; each requirement has a product
  risk. Entry criteria, a schedule, a plan above the campaigns and lessons learned are missing.
- **Three obstacles remain for non-technical people**: a command-line installation, no accounts
  or roles, an interface in English, without the ISTQB vocabulary, where editing a test by hand
  takes JSON or a CSS selector (*Ask the agent* changes it from a request in plain words, with
  Claude Code as the agent).

## 1. The test process (CTFL v4.0, § 1.4)

The seven activities of the test process, then traceability and roles.

| Activity (ref.) | What the syllabus describes | What IziTest does | Verdict | What is missing |
|---|---|---|---|---|
| Test planning (1.4.1, 5.1.1) | A test plan: scope, objectives, approach, risks, entry criteria and exit criteria, schedule, budget. | A campaign has a name, a version, a commit, its selection of tests, ordered stages and the number of runs in parallel. Its *Test plan* adds an objective, what is in and out of scope, and four exit criteria. | ◐ Partial | Entry criteria and a schedule; a plan above the campaigns, for the project or the version. |
| Test monitoring and control (1.4.1, 5.3) | Compare progress with the plan, track metrics, decide on corrective actions. | Dashboard: number of tests and runs, pass rate, average duration, requirement coverage, flaky tests, open bugs. Each campaign is compared with the previous one and, when it has a test plan, with its exit criteria: target, value measured, verdict. *Reports* gives the progress over a period, what is in the way and what to do next. | ● Covered | The targets are a campaign's: none above the campaigns, for the project or the version. |
| Test analysis (1.4.1, 4.5.2) | Study the test basis, report the defects in it, define and prioritize the test conditions. | Requirements are imported (Jira, GitHub, a file, typed in, or any document read by the agent, which flags its unclear or contradictory passages). A review of each acceptance criterion: can a test tell pass from fail? If not, the question to ask its author and a rewording. A list of what the requirement leaves unsaid. Each requirement's product risk (*Likelihood*, *Impact*) says how deep its tests are designed and which run first in a campaign. | ● Covered | — |
| Test design (1.4.1, 4.2) | Derive test cases using test techniques; identify the test data and the test environment needed. | For each requirement, proposed cases with their technique, their type (nominal, alternative, error, boundary), their priority, their rationale and their Gherkin scenario. A person ticks the ones to keep. | ● Covered | — |
| Test implementation (1.4.1) | Test procedures or automated test scripts, test suites, test data, execution order, test environment. | An agent records the test in the browser from the scenario. Reusable business steps, datasets (one run per row), encrypted secrets, ordered campaign stages. *Ask the agent*, on the test's page, repairs or changes a test from a request in plain words. | ● Covered | Editing a test by hand (fixing a step, adding a check) takes JSON or a CSS selector. *Ask the agent* needs Claude Code as the agent. |
| Automated execution (1.4.1) | Run the tests, compare actual results with expected results, keep the logs, analyze anomalies, report defects. | Replay without AI, in Chrome or headless, in parallel, shown live, step by step to debug. A history of every run. Each failure gets a diagnosis: regression, non-conformity with the requirement, test behind its requirement, environment, test to repair. A bug is reported from a failed run with *Report a bug*; when the project has *Open a bug automatically when a test fails* checked, it opens by itself when the diagnosis puts the failure on the application. | ● Covered | — |
| Manual execution (1.4.1) | A tester goes through a test case step by step and notes the result. | Nothing, by choice. The tester describes or approves the scenario; the agent runs it in the browser and records it; the test then replays on its own. | — Out of scope | Intended: IziTest stays agentic. Manual campaigns stay in the team's test management tool (Xray, for example), where IziTest already sends its results. |
| Test completion (1.4.1, 5.3.2) | Test completion report, lessons learned, archiving of the testware, change requests. | Campaign report (HTML, JUnit), results sent to Xray, coverage written on the Jira issues. With a test plan, the HTML report of a finished campaign is its test completion report: the verdict against the exit criteria, and the residual risk. | ◐ Partial | Lessons learned. |
| Traceability (1.4.4) | Link the test basis, the test conditions, the test cases, the test results and the defects. | Requirement, criterion, case, test, run, bug and campaign (with version and commit) are linked. The requirement carries its product risk, and the campaign's report names the requirements at risk that do not pass. When the requirement changes, its tests are flagged. | ● Covered | — |
| Roles (1.4.5) | The test manager plans, monitors and controls, and completes the testing. The tester analyzes, designs, implements and executes. | No accounts: a single access token for everyone. | ○ Absent | Accounts, roles, and a record of who did what. |

## 2. The other chapters of the CTFL v4.0

| Topic (ref.) | What the syllabus describes | What IziTest does | Verdict | What is missing |
|---|---|---|---|---|
| Static testing and reviews (3.1, 3.2) | Review the requirements and the test cases before testing: planning, individual review, discussion, fixing; the roles of author, reviewer and moderator. | The AI reviews the acceptance criteria. A person approves the cases by ticking them. | ◐ Partial | Review between people: comments, a reviewer, a "reviewed" or "approved" status. |
| Testing as a driver for software development, shift left (2.1.3, 2.1.5, 4.5.3) | Write the acceptance tests from the criteria, before or during development (ATDD, BDD). | The Given/When/Then scenarios are written from the criteria as soon as the requirement exists. The requirement is reviewed before any test. | ● Covered | — |
| DevOps (2.1.4) | Automated tests in the delivery pipeline, for fast feedback. | A campaign started from the command line, headless, with an exit code and a JUnit report. Selection of only the tests a commit touches. | ● Covered | — |
| Test levels (2.2.1) | Component, component integration, system, system integration, acceptance. | System and acceptance tests, end to end through the user interface, and API calls. The review says at which level to test a rule (end to end, API, unit). | ◐ Partial | Intended: the component and component integration levels stay with the developers. |
| Test types (2.2.2) | Functional, non-functional (performance, security, usability…), black-box, white-box. | Functional, black-box. Non-functional: accessibility and visual regression. | ◐ Partial | Performance and security. |
| Confirmation testing and regression testing (2.2.3) | Check that a fixed defect really is fixed; check that a change has broken nothing. | A bug becomes *Fixed* when its test passes again without having been changed. A campaign replays everything, or only the tests a change touches. | ● Covered | — |
| Maintenance testing (2.3) | Analyze the impact of a change on the existing tests. | A test behind its requirement is flagged. A repair is proposed, then verified by a replay. | ● Covered | — |
| Black-box test techniques (4.2) | Equivalence partitioning, boundary value analysis, decision table testing, state transition testing. | All four, plus the use case. | ● Covered | — |
| White-box test techniques (4.3) | Statement coverage and branch coverage of the code. | Nothing. | — Out of scope | Belongs to the developers' unit tests. |
| Experience-based test techniques (4.4) | Error guessing; exploratory testing in sessions, with a test charter; checklists. | Error guessing at design time. Automatic exploration of the application: console errors, failed requests, broken links, accessibility. Each bug found gets a test that reproduces it. | ◐ Partial | Exploration guided by a charter the tester writes (today the exploration is given only a start address); custom checklists. |
| Entry criteria and exit criteria (5.1.3) | The conditions for starting, and for declaring the testing complete: coverage achieved, unresolved defects, failed test cases. | Four exit criteria in a campaign's *Test plan*: every requirement of high priority or high risk passes; no high-severity bug is left open; a minimum share of the acceptance criteria has a test that ran; a minimum share of the tests pass. The campaign's page and its reports give the verdict, criterion by criterion with what was measured, and the command line's exit code follows it. No entry criteria. | ◐ Partial | Entry criteria: nothing says when a campaign may start. |
| Estimation (5.1.4) | Estimate the test effort. | Nothing. The duration of each past run is known. | ○ Absent | At least the expected duration of a campaign. |
| Test case prioritization (5.1.5) | Order the execution by risk, coverage or requirements. | High, medium or low priority on the requirement and on the case. A campaign of a project or of a requirement runs its tests the riskiest first: by the risk level, then the priority, of the requirements each test checks. A list of chosen tests keeps its order; campaign stages are ordered by hand. | ● Covered | While no requirement has its risk rated, the tests keep their order: the priority alone orders nothing. |
| Risk management (5.2) | Identify the product risks, assess their likelihood and their impact, test more what is risky, monitor the residual risk. | A product risk per requirement: *Likelihood* and *Impact*, each high, medium or low, give its risk level, shown in the list of requirements. A high risk gets a deeper test design, the riskiest tests run first in a campaign, and the campaign's report and *Reports* name the requirements at risk that do not pass: the residual risk. | ● Covered | A project risk register (CTFL 5.2.1): only product risk is kept. |
| Metrics (5.3.1) | Progress, product quality, defects, risk, coverage, cost. | Test progress, requirement coverage, open bugs by severity, flaky tests. *Reports* adds, over a period, the bugs opened and fixed with their trend, the requirements passing at each risk level and the residual risk. | ● Covered | — |
| Test reports (5.3.2, 5.3.3) | A periodic test progress report and a test completion report, tailored to their audience. | Dashboard, an HTML report per campaign, coverage as a comment on the Jira issues. *Reports* gives the test progress report of a period; *Open as a page to print or send* gives it as one HTML page, readable without the tool. With a test plan, the HTML report of a finished campaign is its test completion report. | ● Covered | Sending the report on a schedule (by e-mail, every week). |
| Configuration management (5.4) | Identify and version the testware; set baselines; be able to go back to an earlier state. | The campaign keeps the version and the commit tested. The requirement keeps a fingerprint of its content. | ◐ Partial | The version history of a test and of a requirement. |
| Defect management (5.5) | A defect report: identifier, title, date, author, context, steps to reproduce, expected and actual results, severity, priority, status (open, deferred, duplicate, awaiting confirmation testing, closed, rejected). | *Bugs* page: identifier, title, kind, severity, priority, assignee, dates, number of occurrences, expected and actual, criteria concerned, the test that reproduces it, campaign. Statuses: *Open*, *To retest*, *Deferred*, *Duplicate*, *Fixed*, *Dismissed*. A bug is reported by a person (*Report a bug*, on the page or on a failed run), found by an exploration, or opened by a failed test when the project says so. It is fixed automatically, when its test passes again. *Send to Jira…* makes it an issue there, after a preview. | ● Covered | The Jira issue's status is not read back: the synchronization goes from IziTest to Jira only. |

## 3. Requirements engineering (REQB CPRE v1.3)

| Topic (ref.) | What the syllabus describes | What IziTest does | Verdict | What is missing |
|---|---|---|---|---|
| Requirements identification (ch. 5) | Find the stakeholders and elicit their needs (interviews, workshops…). | IziTest starts from requirements already written, imported or typed in. | — Out of scope | — |
| Functional and non-functional requirements (5.5) | Classify each requirement. | No type on the requirement. | ○ Absent | A "type" field. |
| Specification (ch. 6) | Describe the requirement: description, user story, criteria. | Key, title, description, acceptance criteria, source and a link to where it comes from. | ● Covered | — |
| Quality criteria of a requirement (1.1.3, 6.4) | Correct, feasible, necessary, prioritized, unambiguous, verifiable, unique, design-independent. The specification is complete, consistent, modifiable, traceable. | The review checks "verifiable", "unambiguous" and "complete" (what the requirement leaves unsaid), taking the project's other requirements into account. "Prioritized" and "traceable" rest on the fields and the links. | ◐ Partial | "Consistent" (conflicts between requirements), "unique", "modifiable" (change history). |
| Priority and criticality (1.1.7, 7.5) | Priority says how important or urgent a requirement is. Criticality says the damage in case of failure. | High, medium or low priority. *Impact*, high, medium or low, says what a failure costs the business or the user; with *Likelihood* it gives the product risk. | ● Covered | — |
| Analysis and modeling (7.1 to 7.3) | UML and SysML models. | Nothing. | — Out of scope | — |
| Cost estimation (7.4) | Estimate the cost of implementing a requirement. | Nothing. | — Out of scope | — |
| Agreement on requirements (7.6) | The stakeholders approve and sign the requirements before implementation. | Nothing. | ○ Absent | An "approved" status, with who and when. |
| Traceability (8.1) | In both directions, from the source to the test cases. It serves impact analysis, coverage analysis and proof of implementation. | From the origin (Jira issue, GitHub issue) to the tests, the results and the bugs. Coverage per version. Tests flagged when the requirement changes. | ● Covered | Links between requirements (horizontal traceability). |
| Change management (8.2) | Change request, impact analysis, decision. | A new import says which requirements changed. The design and the tests concerned are flagged. | ◐ Partial | You know that a requirement changed, not what changed nor who decided it. |
| Requirement life cycle (8.2.5) | Statuses: new, for review, approved, implemented, tested, deployed… | No status is stored. Only the test status is computed: *Not covered*, *Not run yet*, *Passing*, *Failing*. | ○ Absent | A status on the requirement. |
| Telling a defect from a change (8.2.6) | A defect is a deviation from the requirement. A change modifies the requirement. | The diagnosis separates the non-conformity (the application does not do what the requirement says), the regression, and the test behind a requirement that changed. | ● Covered | — |
| Testability and acceptance criteria (9.3) | Each requirement leads to at least one measurable acceptance criterion. Functional coverage can be measured. | It is the heart of the model: criteria reviewed for their testability, coverage measured criterion by criterion. | ● Covered | — |
| Requirements quality metrics (9.4) | Measure the quality of the requirements. | Nothing is shown, although the review already produces the data. | ○ Absent | The share of criteria that cannot be tested; the questions awaiting an answer. |
| Roles and stakeholders (ch. 4) | Who writes, who approves, who is consulted. | Nothing: neither author nor owner on the requirement. | ○ Absent | Ties in with accounts and roles. |
| Tools (ch. 10) | Requirements management tools. | Jira, GitHub and Xray connectors: IziTest reads the requirements where they live. | ● Covered | — |

## 4. Does it fit?

**Yes for the model.** The CTFL says that acceptance criteria can be seen as the test conditions
(§ 4.5.2). The REQB says that each requirement must lead to at least one acceptance criterion,
the basis of acceptance testing (§ 9.3). IziTest is built exactly that way. A certified tester
finds the concepts they know; only the words on screen differ.

**Yes for the tester role, and without code.** The CTFL gives the tester test analysis, test
design, test implementation and test execution (§ 1.4.5). These are the four best-covered
activities, and the tester writes no code in them. On a requirement, *Propose scenarios*
proposes the cases and *Plan* keeps the ones the tester ticks. *Record* has the agent record the
case in the browser. Without a requirement, *New test* starts from a description in a few
sentences. The agent asks for what it lacks (an account, a piece of data) and the tester follows
its browser live. IziTest does not have tests executed by hand, and that is intended.

**Mostly yes for the test manager role, campaign by campaign.** The CTFL gives the test manager
test planning, test monitoring and control, and test completion. On a campaign, IziTest gives
them a test plan (objective, scope, exit criteria), the verdict against those criteria, the
product risk of the requirements with the residual risk, and a test completion report;
*Reports* gives the progress over a period. They can see where things stand and decide with the
tool whether the testing of a campaign is done. It has no entry criteria, no schedule and no
plan above the campaigns, and it keeps no lessons learned.

**IziTest goes further than the syllabi on three points**: the automatic diagnosis of each
failure, the repair of tests, and the bug that keeps the test that reproduces it and is fixed by
itself when that test passes again (it opens by itself too, when the project says so). These
are its arguments against conventional test management tools.

**Three obstacles the syllabi do not address** still stand between the functional tester and
automation without technical help:

- **Installation.** It takes Node.js, git, two commands in a terminal and a Chrome extension
  loaded in developer mode.
- **Setting up the agent.** The *Settings* page asks you to choose a command-line agent, or to
  provide an OpenRouter key and a model.
- **Editing a test by hand.** *Add step* asks for a command (`click`, `fill`…), parameters and
  locators in JSON; the element it acts on can be picked among the project's, and a business
  step added whole. *Add assertion* asks for a CSS selector. *Ask the agent*, beside *Run*,
  changes the test from a request in plain words, with Claude Code as the agent only. The test
  already reads in plain words: each step shows its intent, and the *Gherkin* tab gives the
  scenario.

## 5. The gaps, in order of priority

The order takes the intended audience into account. The size is an estimate. Gaps 2, 3, 7 and 8
are selected (decision of 11 November 2026). Two items are postponed until the project is
validated: the installation without a terminal of gap 1 (IziTest remains a server to install)
and gap 5.

**Status on 11 November 2026: gaps 2, 3, 7 and 8 are done.**

| # | What exists now | What remains |
|---|---|---|
| 2 | A test plan on the campaign (objective, scope, four exit criteria), a verdict criterion by criterion, a test completion report (text, HTML), a command-line exit code that follows the verdict. | No plan at the level of the project or the version, above the campaigns. |
| 3 | A likelihood and an impact per requirement, a risk level; more cases designed for a high risk, the riskiest tests run first, the residual risk in the reports. | No project risk register (CTFL 5.2.1): only product risk is kept. |
| 7 | Priority, assignee, the statuses *To retest*, *Deferred* and *Duplicate*; a bug reported by a person, reproduced by the agent, which keeps its test; sending to Jira with a preview. | The Jira issue's status is not read back: the synchronization goes from IziTest to Jira only. |
| 8 | The *Reports* page and an HTML page to print: progress over a period, impediments, metrics, residual risk, what is planned next, bug trend. The report of a campaign with a plan serves as its test completion report. | No scheduled sending of the report (by e-mail, every week). |

Since then, one of the three pieces of gap 1 is partly done: editing a test in everyday words.
*Ask the agent*, on a test's page, repairs or changes the test from what the tester asks (add a
step, delete one, add a check), in a conversation with its browser shown live. It needs Claude
Code as the agent; pointing at the element with a click in the page is not there.

### Priority 1: without this, these roles cannot adopt the tool

| # | Gap | For whom | Ref. | To add | Size |
|---|---|---|---|---|---|
| 1 | Automating without code, without technical help | Functional tester | Outside the syllabi | Three independent pieces of work. **Installing without a terminal**: an installer, and the extension distributed through the Chrome Web Store. **An agent ready to use**: set up once for the team, not by each tester. **Editing a test in everyday words**: telling the agent what to change ("also check the total including tax") or pointing at the element with a click in the page, instead of writing JSON or a CSS selector. | Large |
| 2 | Test plan and exit criteria on the campaign | Head of testing, test manager | CTFL 5.1.1, 5.1.3, 5.3.2 | On a campaign: objective, scope, exit criteria with figures (every high-priority requirement passing, no high-severity bug open, a minimum coverage), a computed verdict and a test completion report. The data already exists. | Medium |
| 3 | Product risk | Test manager, test lead | CTFL 5.2; REQB 1.1.7 | A likelihood and an impact per requirement, which give a risk level. It guides the number of cases to design, the execution order and the report (residual risk). | Small to medium |
| 4 | Interface in French, ISTQB vocabulary | Everyone | CFTL glossary | Translate the interface and use the glossary's terms: "exigence" (requirement), "condition de test" (test condition), "cas de test" (test case), "défaut" (defect), "test de confirmation" (confirmation test). No translation mechanism exists today. | Medium |

### Priority 2: expected of a test management tool

| # | Gap | For whom | Ref. | To add | Size |
|---|---|---|---|---|---|
| 5 | Accounts, roles and review between people | Head of testing | CTFL 1.4.5, 3.2; REQB ch. 4, 7.6 | Accounts, at least two roles (head of testing, tester), the author of each action, a "reviewed" or "approved" status on the requirements and the planned cases. | Large |
| 6 | Life cycle and history of the requirement | Test lead, analyst | REQB 8.2, 8.2.5, 1.1.3 | A status (new, for review, approved, implemented, tested) and the successive versions with what changed. The fingerprint of the content exists; what remains is to keep the old text. | Medium |
| 7 | Complete defect management | Tester, test lead | CTFL 5.5 | Fix priority, assignee, the statuses "deferred", "duplicate" and "awaiting confirmation testing", sending to Jira. A defect reported by a person: they describe it, the agent reproduces it and keeps a test of it. | Medium |
| 8 | Test progress reports and test completion reports | Test manager | CTFL 5.3.2 | A report over a period (progress, impediments, metrics, risks, what is planned next) and a test completion report; the defect trend. | Small to medium |

### Priority 3: useful, not urgent

| # | Gap | Ref. | To add |
|---|---|---|---|
| 9 | Exploration guided by a charter, checklists | CTFL 4.4.2, 4.4.3 | The tester writes the charter (what to explore, what to look for) and the team's checklists; the agent explores and hands back its notes. |
| 10 | Estimation and schedule | CTFL 5.1.4 | The expected duration of a campaign from the history; campaigns started at a set time. |
| 11 | Version history of a test | CTFL 5.4 | Keep each version of a test and be able to go back to it. |
| 12 | Response time | CTFL 2.2.2 | A response-time threshold per page or per request, checked during the replay. |
| 13 | Requirements quality | REQB 9.4, 1.1.3, 5.5, 8.1.3 | Share of criteria that cannot be tested, conflicts between requirements, functional or non-functional type, links between requirements. |
| 14 | Lessons learned | CTFL 2.1.6 | A retrospective note per campaign. |

### Not to add

- Manual execution of test cases, where a tester goes through the case and notes the result:
  IziTest stays agentic. A team that keeps manual campaigns holds them in its test management
  tool; IziTest sends its results there (Xray today).
- Code coverage (white-box test techniques) and the component and component integration levels:
  that is the job of unit tests.
- Eliciting needs, UML modeling and estimating the cost of implementation: that is the job of
  requirements engineering tools, which IziTest reads through its connectors.

### Where to start

Gaps 2, 3 and 8 cost the least and rely on data that is already there. The three of them give
the test manager a plan, a verdict and a report. Next comes gap 7, which completes the *Bugs*
page. Gap 1 splits into three pieces of work; editing a test in everyday words is the one that
serves the functional tester soonest. Gap 4 can move forward in parallel.
