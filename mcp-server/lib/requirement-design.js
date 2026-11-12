// Test design for a requirement: one method, whichever agent applies it. A developer's agent
// (over MCP) reads it with design_tests and reasons itself, with the user; the dashboard sends
// it to the agent set in Settings and gets its answer back as JSON. IziTest does not reason:
// it lays out the requirement, the cases it already has, the application and the Gherkin
// phrases of its project, and the rules — then checks what comes back: a review of each
// criterion (can a test tell pass from fail?), what the requirement leaves unsaid, and the
// scenarios, each with its technique and its steps in Gherkin, resolved against the project's
// phrases. A scenario whose steps all resolve is created as it is; a step no phrase covers is
// recorded by an agent browsing the app.

import { db } from './db.js';
import { log } from './logger.js';
import {
  CASE_KINDS, PRIORITIES, TECHNIQUES, MISSING_SCOPES, TEST_LEVELS, getRequirement, saveRequirement, addCriterion, planCases, saveDesign, scenarioFeature,
} from './requirements.js';
import { writingDefinitions, projectLanguage } from './gherkin/step-definition-store.js';
import { keywordsOf } from './gherkin/language.js';
import { elementLines } from './element-store.js';
import { DEFAULT_STEP_DEFINITIONS, translatedPattern } from './gherkin/default-step-definitions.js';
import { featurePhrases, compileDefinitions, effectiveKeyword, stepsForPhrase } from './gherkin/parse.js';

const TECHNIQUE_GUIDE = {
  use_case: 'the expected path (nominal), and the other ways through it (alternative)',
  equivalence_partitioning: 'one value per class of inputs the app treats the same, valid and invalid',
  boundary_values: 'the values at each limit, just under and just over it',
  decision_table: 'the combinations of conditions that change the result',
  state_transition: 'the sequences that move between states (logged out → in, locked after N failures)',
  error_guessing: 'what usually goes wrong: empty, blank, too long, special characters, twice in a row',
};

/** The Gherkin phrases a requirement's scenarios are written with: its project's, or the defaults. */
export function definitionsFor(requirement) {
  return requirement.project_id ? writingDefinitions(requirement.project_id) : DEFAULT_STEP_DEFINITIONS;
}

/**
 * Which of a phrase's arguments are CSS selectors — the ones a scenario written without
 * seeing the page cannot fill in.
 */
function selectorArguments(definition) {
  if (definition.steps_template) return [];
  return Object.entries(definition.params_template ?? {})
    .filter(([key, value]) => (key === 'selector' || key === 'target') && /^\{\d+\}$/.test(String(value)))
    .map(([, value]) => Number(String(value).slice(1, -1)));
}

const ORDINALS = ['1st', '2nd', '3rd', '4th'];

/**
 * A phrase as the agent reads it, with the keyword of the project's language; `withElements`:
 * the app has elements, named where a selector goes.
 */
function phraseLine(definition, withElements = false, words = keywordsOf('en')) {
  const selectors = selectorArguments(definition);
  const actions = definition.steps_template?.length;
  const orName = withElements ? ` (or the name of an element of the app)` : '';
  const note = actions ? ` — business step (${actions} action${actions === 1 ? '' : 's'} of this app)`
    : selectors.length ? ` — the ${selectors.map((n) => ORDINALS[n] ?? `#${n + 1}`).join(' and ')} {string} ${selectors.length > 1 ? 'are CSS selectors' : 'is a CSS selector'}${orName}` : '';
  return `- ${words[definition.keyword] ?? definition.keyword} ${definition.pattern}${note}`;
}

/** How deep to design, from the requirement's product risk (ISTQB CTFL 5.2: the test effort follows the risk). */
export function riskGuide(requirement) {
  const said = `likelihood ${requirement.likelihood}, impact ${requirement.impact}`;
  if (requirement.risk === 'high') {
    return `HIGH (${said}). Test it in depth: every class of inputs and every limit of each criterion, the combinations of conditions that change the result, the moves between states, and what usually goes wrong — a failure here costs the most.`;
  }
  if (requirement.risk === 'medium') {
    return `Medium (${said}). The expected path, the alternatives, and the errors and limits a user will meet.`;
  }
  if (requirement.risk === 'low') {
    return `Low (${said}). Keep it short: the expected path of each criterion and its main error — no combinations, no rare limits.`;
  }
  return 'Not assessed. Design as for a medium risk: the expected path, the alternatives, and the errors and limits a user will meet.';
}

/**
 * The method applied to one requirement, as the agent reads it. `answer`: "json" (the
 * dashboard: the answer is read by IziTest) or "mcp" (the agent shows it to the user, then
 * plans what they keep).
 */
export function designBrief(requirement, { answer = 'json' } = {}) {
  const project = requirement.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(requirement.project_id) : null;
  // The scenarios are written in the language of the project's tests, with its phrases.
  const language = projectLanguage(requirement.project_id);
  const words = keywordsOf(language);
  const say = (pattern) => translatedPattern(pattern, language);
  const lines = [`# Test design for ${requirement.key} — ${requirement.title}`];
  if (requirement.description) lines.push('', requirement.description);
  lines.push('', '## Acceptance criteria');
  if (requirement.criteria.length) for (const c of requirement.criteria) lines.push(`${c.position}. ${c.text}`);
  else lines.push('(none written: the title and description are all there is — the review says which criteria are missing)');
  lines.push('', '## Product risk', riskGuide(requirement));

  if (requirement.cases.length) {
    lines.push('', '## Cases it already has — do not propose them again');
    for (const c of requirement.cases) {
      const criterion = requirement.criteria.find((x) => x.id === c.criterion_id);
      lines.push(`- ${criterion ? `criterion ${criterion.position}` : 'the whole requirement'}, ${c.kind}: ${c.title}${c.test ? ` (test "${c.test}")` : ' (planned)'}`);
    }
  }

  lines.push('', '## The application');
  if (project) {
    lines.push(`Project "${project.name}"${project.base_url ? `, at ${project.base_url}` : ' — no address set: take it from the notes or the requirement, else ask'}${project.project_type ? ` (${project.project_type})` : ''}.`);
    if (project.description) lines.push(project.description);
    if (project.context?.trim()) lines.push('', project.context.trim());
  } else {
    lines.push('No project: no address nor notes. Where the scenario needs the address, write it as the requirement gives it.');
  }

  // What the tests of the project act on, by name: a scenario can name them where a selector goes.
  const elements = requirement.project_id ? elementLines(requirement.project_id) : [];
  lines.push('', '## The Gherkin phrases of the project — write the steps with these, word for word',
    ...definitionsFor(requirement).map((definition) => phraseLine(definition, elements.length > 0, words)));
  if (elements.length) {
    lines.push('', '## The elements of the app — where a phrase takes a CSS selector, the name of one of these, word for word, acts on it',
      'Recorded by the tests of the project, page by page:', ...elements);
  }

  const others = otherRequirementLines(requirement);
  if (others.length) {
    lines.push('', '## The other requirements of the project — what they say is not missing here', ...others);
  }

  lines.push('', '## Method',
    '1. Review each criterion: can a test tell pass from fail? It can when the criterion says what is done and what is then',
    '   seen — a message, a page, a state — with its values. Flag the ones that cannot: a vague word (fast, simple, correct,',
    '   clear), no expected result, a value left out (how many, how long, which message). For each: the issue in one',
    '   sentence, the question to ask its author, and a rewording when you can propose one.',
    '2. List what the requirement leaves unsaid but its scope implies (an empty field, a value out of range, a second',
    '   attempt): each a rule it could add. Nothing another requirement of the project already says. For each, say:',
    '   - where it belongs: "this" requirement; "other": another requirement of the project, by its key, whose subject it',
    '     is (a calculation another one is about); "project": the whole project rather than one requirement (the language',
    '     of the messages, a form sent twice, accessibility), to say once for all of them;',
    '   - the level a test checks it best at: "e2e" through the screens of the app (what a user sees and does: a message,',
    '     a button there or not, a flow); "api" through its API (a rule to try with many values, a refusal by the server);',
    '     "unit" in the code, by its developers (a calculation, a format). A rule is written in a requirement whatever',
    '     the level: the level says where its test goes, not whether it is said;',
    '   - why that level, in one sentence.',
    '3. Design the scenarios, criterion by criterion, with these techniques:',
    ...TECHNIQUES.map((t) => `   - ${t}: ${TECHNIQUE_GUIDE[t]};`),
    '   One scenario checks one criterion (the one it is mainly for), with concrete values. No two check the same thing.',
    '   A criterion flagged in step 1 gets scenarios only for what it does say.',
    '4. The expected results come from the requirement — never from what the app shows or might show. Where it does not',
    '   say what is expected, there is no scenario to write: that is a question of step 1.',
    '5. Write each scenario\'s steps in Gherkin with the phrases above, word for word, values in quotes. Start from the',
    '   address of the app. Fill in a CSS selector only when the project notes or a business step give it — never a',
    `   guessed one: prefer the phrases that need none (${['I am on {string}', 'I click on the text {string}', 'I should see {string}', 'the URL should contain {string}'].map((p) => say(p).replace(' {string}', '')).join(', ')}),`,
    `   the business steps, and the names of the elements of the app where it lists them (${words.When} ${say('I click on {string}').replace('{string}', '"Save profile"')}).`,
    `   A step no phrase covers is written in plain words (${words.When} ${language === 'fr' ? 'je tape "faux" comme mot de passe' : 'I type "wrong" as the password'}):`,
    '   an agent records it later, browsing the app.',
    '6. Priority: high for the expected path and for what loses data, money or access; medium for the alternatives and',
    '   the errors users will meet; low for the rest.',
    '   How many scenarios follows the product risk above: the higher it is, the deeper the design.',
    `7. Write the issues, questions, rewordings and reasons in the language of the requirement. Write the scenarios —`,
    `   titles and steps — in ${words.name}, the language of the project's tests, with its keywords: ${[words.scenario, words.Given, words.When, words.Then, words.And].join(' / ')}.`);

  const shape = [
    '{',
    '  "review": [{ "criterion": 2, "issue": "…", "question": "…", "suggestion": "the criterion reworded, or null" }],',
    '  "missing": [{ "text": "a rule it could add", "scope": "this | other | project", "requirement": "the key of the other',
    '    requirement, or null", "level": "e2e | api | unit", "why": "why that level, in one sentence" }],',
    '  "scenarios": [{',
    '    "title": "…", "criterion": 1, "kind": "nominal | alternative | error | boundary",',
    `    "technique": "${TECHNIQUES.join(' | ')}", "priority": "high | medium | low",`,
    '    "rationale": "why this scenario, in one sentence",',
    `    "gherkin": "${words.scenario}: …\\n  ${words.Given} …\\n  ${words.When} …\\n  ${words.Then} …"`,
    '  }]',
    '}',
  ];
  if (answer === 'json') {
    lines.push('', '## Answer',
      'Answer with this JSON and nothing else. "review" lists only the criteria with an issue; "criterion" is a number from',
      'the list above, null for a scenario about the whole requirement.', ...shape);
  } else {
    lines.push('', '## Then',
      'Show the user the review, what is missing and the scenarios, in that order. With their go-ahead:',
      `- the criteria they reword or add: save_requirement(key: "${requirement.key}", criteria: all of them, in order);`,
      '- a missing rule of another requirement: save_requirement on that one, its criteria and the rule; one of the whole',
      '  project: save_requirement(title, criteria: [the rule], project_id), a requirement of its own;',
      `- the scenarios they keep: plan_tests(requirement: "${requirement.key}", cases: [{ title, criterion, kind, technique,`,
      '  priority, rationale, gherkin }]) — it says which scenarios are ready and which have steps to record;',
      '- a ready one: create_test_from_gherkin(project_id, gherkin, test_name, requirement, case_id), then run_test;',
      '- one with steps no phrase covers: start_recording(name, requirement, case_id), its steps in the browser, then',
      '  add_assertion with the expected results of its criterion — non_conformity: true when the app does otherwise.');
  }
  return lines.join('\n');
}

const SYSTEM = 'You are a test analyst. You design the tests of a requirement with standard test design techniques, '
  + 'and you never invent what the requirement does not say: you ask. You answer with JSON only.';

/** The JSON of an answer: a fenced block, or the outermost object of the text. */
function jsonOf(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object') return value;
  } catch { /* told below */ }
  throw new Error(`The agent did not answer with the test design (JSON): ${text.trim().slice(0, 200) || '(empty answer)'}`);
}

const clean = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * An agent's test design, checked: review items of criteria the requirement has, the
 * missing criteria, and scenarios with a title — their kind, technique and priority known
 * (else left to what the technique says, or medium), their criterion one of the
 * requirement's, their Gherkin a whole feature. Each item keeps the text of its criterion:
 * once the criteria change, it still says which one it was about.
 */
export function parseDesign(text, requirement) {
  const answer = jsonOf(text);
  const criterionAt = (n) => requirement.criteria.find((c) => c.position === Number(n)) ?? null;
  const seen = new Set();
  const review = (Array.isArray(answer.review) ? answer.review : []).flatMap((item) => {
    const criterion = criterionAt(item?.criterion);
    if (!criterion || seen.has(criterion.id) || !clean(item.issue)) return [];
    seen.add(criterion.id);
    return [{ criterion: criterion.position, criterion_text: criterion.text, issue: clean(item.issue), question: clean(item.question) || null, suggestion: clean(item.suggestion) || null }];
  });
  // Where each missing rule belongs: another requirement only if it is one of the project's.
  const otherOf = (key) => (typeof key === 'string' && key.trim()
    ? db.prepare('SELECT key FROM requirements WHERE key = ? AND project_id IS ? AND id != ?').get(key.trim(), requirement.project_id ?? null, requirement.id) ?? null
    : null);
  const missing = (Array.isArray(answer.missing) ? answer.missing : []).flatMap((m) => {
    const item = typeof m === 'string' ? { text: m } : (m ?? {});
    const text = clean(item.text, 500);
    if (!text) return [];
    const other = item.scope === 'other' ? otherOf(item.requirement) : null;
    const scope = other ? 'other' : MISSING_SCOPES.includes(item.scope) && item.scope !== 'other' ? item.scope : 'this';
    return [{ text, scope, requirement: other?.key ?? null, level: TEST_LEVELS.includes(item.level) ? item.level : null, why: clean(item.why, 300) || null }];
  }).slice(0, 12);
  const scenarios = (Array.isArray(answer.scenarios) ? answer.scenarios : []).flatMap((s) => {
    const title = clean(s?.title, 200);
    if (!title) return [];
    const criterion = criterionAt(s.criterion);
    const technique = TECHNIQUES.includes(s.technique) ? s.technique : null;
    const kind = CASE_KINDS.includes(s.kind) ? s.kind
      : technique === 'boundary_values' ? 'boundary' : technique === 'error_guessing' ? 'error' : 'nominal';
    return [{
      title, criterion: criterion?.position ?? null, criterion_text: criterion?.text ?? null, kind, technique,
      priority: PRIORITIES.includes(s.priority) ? s.priority : 'medium',
      rationale: clean(s.rationale, 500) || null,
      gherkin: scenarioFeature(clean(s.gherkin, 6000), requirement.title, title, projectLanguage(requirement.project_id)),
    }];
  }).slice(0, 40).map((s, i) => ({ id: `s${i + 1}`, ...s }));
  return { review, missing, scenarios };
}

/**
 * How far a scenario's Gherkin resolves against the phrases: ready when every step does —
 * the test can be created from it — else the steps an agent has to record.
 */
export function resolveScenario(feature, definitions) {
  if (!feature) return null;
  let phrases;
  try {
    phrases = featurePhrases(feature);
  } catch (err) {
    return { error: err.message.replace(/^Parser errors:\s*/, '').replace(/\s+/g, ' ').slice(0, 300), phrases: 0, unresolved: [], ready: false };
  }
  const compiled = compileDefinitions(definitions);
  const unresolved = [];
  let last = null;
  let steps = 0;
  for (const { text, keyword, written } of phrases) {
    const parsed = stepsForPhrase(text, effectiveKeyword(keyword, last), compiled, steps);
    if (!parsed) {
      unresolved.push(`${written} ${text}`);
      continue;
    }
    steps += parsed.steps.length;
    last = parsed.keyword;
  }
  return { phrases: phrases.length, unresolved, ready: phrases.length > 0 && unresolved.length === 0 };
}

/** The requirement with how far each scenario resolves: its planned cases', its design's. */
export function withResolution(requirement) {
  if (!requirement) return requirement;
  const definitions = definitionsFor(requirement);
  const resolve = (item) => (item.gherkin ? { ...item, resolution: resolveScenario(item.gherkin, definitions) } : item);
  return {
    ...requirement,
    cases: requirement.cases.map((c) => (c.test ? c : resolve(c))),
    design: requirement.design ? { ...requirement.design, scenarios: requirement.design.scenarios.map(resolve) } : null,
  };
}

/**
 * Ask the dashboard's agent (`complete`, lib/agent/complete.js) for the test design of a
 * requirement, and keep it on the requirement: proposed, not planned yet.
 */
export async function designTests(ref, { complete, agent = null, signal } = {}) {
  const requirement = getRequirement(ref);
  if (!requirement) throw new Error(`No requirement ${ref}`);
  const started = Date.now();
  const text = await complete({ system: SYSTEM, prompt: designBrief(requirement), signal });
  const design = parseDesign(text, requirement);
  log(`Test design for ${requirement.key}: ${design.review.length} issue(s), ${design.missing.length} missing, ${design.scenarios.length} scenario(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  return withResolution(saveDesign(requirement.id, {
    ...design, agent, designed_at: new Date().toISOString(), content_hash: requirement.content_hash,
  }));
}

/**
 * Plan the scenarios of the design kept on a requirement that the user chose (by id): each
 * becomes a planned case, of the criterion it was designed for — found by its text, so a
 * criterion reworded since loses it — and leaves the design.
 */
export function planDesigned(ref, ids) {
  const requirement = getRequirement(ref);
  if (!requirement) throw new Error(`No requirement ${ref}`);
  if (!requirement.design) throw new Error(`${requirement.key} has no test design to plan from`);
  const chosen = requirement.design.scenarios.filter((s) => ids.includes(s.id));
  if (!chosen.length) throw new Error('None of these scenarios is in the design');
  const criterionNow = (s) => {
    if (s.criterion_text == null) return null;
    return requirement.criteria.find((c) => c.text.trim().toLowerCase() === s.criterion_text.trim().toLowerCase())?.position ?? null;
  };
  planCases(requirement.id, chosen.map((s) => ({ ...s, criterion: criterionNow(s) })));
  const left = requirement.design.scenarios.filter((s) => !ids.includes(s.id));
  return withResolution(saveDesign(requirement.id, { ...requirement.design, scenarios: left }));
}

/**
 * A rule the design of a requirement found unsaid, taken care of: written where it belongs —
 * a criterion of the other requirement it names, or a requirement of its own for the whole
 * project —, or `dismiss`ed. Either way it leaves the design. A rule of this requirement is
 * added to its criteria in the editor, with the others: not here.
 */
export function placeMissing(ref, text, { dismiss = false } = {}) {
  const requirement = getRequirement(ref);
  if (!requirement) throw new Error(`No requirement ${ref}`);
  const item = requirement.design?.missing.find((m) => m.text === text);
  if (!item) throw new Error(`The test design of ${requirement.key} does not list "${text}"`);
  let placed = null;
  if (!dismiss) {
    if (item.scope === 'other') placed = addCriterion(item.requirement, item.text).key;
    else if (item.scope === 'project') {
      const fr = projectLanguage(requirement.project_id) === 'fr';
      placed = saveRequirement({
        title: item.text, criteria: [item.text], source: 'manual', projectId: requirement.project_id,
        description: fr ? `Pour tout le projet, pas une seule exigence : relevé par la conception des tests de ${requirement.key}.`
          : `For the whole project, not one requirement: found unsaid by the test design of ${requirement.key}.`,
      }).requirement.key;
    } else throw new Error(`"${text}" is a rule of ${requirement.key}: add it to its criteria`);
  }
  const design = { ...requirement.design, missing: requirement.design.missing.filter((m) => m !== item) };
  return { requirement: withResolution(saveDesign(requirement.id, design)), placed };
}

/** The other requirements of the project, with their criteria: what the design must not find missing. */
function otherRequirementLines(requirement) {
  if (!requirement.project_id) return [];
  const others = db.prepare('SELECT id, key, title FROM requirements WHERE project_id = ? AND id != ? ORDER BY id LIMIT 40').all(requirement.project_id, requirement.id);
  const criteria = db.prepare('SELECT text FROM acceptance_criteria WHERE requirement_id = ? ORDER BY position LIMIT 8');
  return others.flatMap((r) => [`- ${r.key} — ${r.title}`, ...criteria.all(r.id).map((c) => `  - ${c.text}`)]);
}

/**
 * What the agent recording a test for a requirement is told: what the requirement expects,
 * and that the expected results come from it — the app doing otherwise is a non-conformity.
 * `viaMcp`: it records through the MCP tools, and links the test there.
 */
export function recordingBrief(requirement, caseId = null, { viaMcp = false } = {}) {
  const planned = caseId != null ? requirement.cases.find((c) => c.id === Number(caseId)) : null;
  const criterion = planned?.criterion_id ? requirement.criteria.find((c) => c.id === planned.criterion_id) : null;
  const lines = [`This test checks requirement ${requirement.key} — ${requirement.title}${planned ? `: case #${planned.id} (${planned.kind}), "${planned.title}"` : ''}.`];
  if (requirement.criteria.length) {
    lines.push('Its acceptance criteria:', ...requirement.criteria.map((c) => `${c.position}. ${c.text}`));
    if (criterion) lines.push(`This case checks criterion ${criterion.position}.`);
  }
  if (planned?.gherkin) {
    lines.push('Its scenario — follow it in the browser; a step written in plain words is yours to find on the page:', planned.gherkin.trim());
  }
  lines.push(
    'The expected results come from the requirement, not from what the app shows. When the page does not show what it',
    'expects — once you checked that the steps before did what they should — add the assertion with the expected value',
    'of the requirement and non_conformity: true: the test reports the non-conformity. Tell the user.');
  if (viaMcp) lines.push(`Pass requirement: "${requirement.key}"${planned ? `, case_id: ${planned.id}` : ''} to start_recording.`);
  return lines.join('\n');
}

/**
 * What the agent recording a test is told of the app: its project, the URL to start from, the
 * project's context, its datasets (`datasets`: lib/datasets.js datasetLines). Run without a
 * terminal, it cannot ask: what it lacks, it says, and stops.
 */
export function projectBrief(project, { datasets = [], secrets = [] } = {}) {
  const lines = [];
  if (project) {
    lines.push(`The app under test is the project "${project.name}".`);
    // The intents read in its Gherkin, in the language its tests are written in.
    lines.push(`Its tests are written in ${keywordsOf(project.language).name}: write the intent of each step in ${keywordsOf(project.language).name}.`);
    if (project.base_url) lines.push(`It is at ${project.base_url}: start there, unless the description gives another URL.`);
    if (project.context?.trim()) lines.push('What to know about it:', project.context.trim());
    if (project.id) lines.push(`Pass project_id: ${project.id} to start_recording: the test is saved in the project.`);
  }
  // The values it has to test with (datasetLines): taken from there, not made up.
  if (datasets.length) {
    lines.push(
      'Its datasets, tables of values to test with (rows numbered from 1):', ...datasets,
      'When the test needs a value one of them has (a user to log in with, a product to order), take it from there rather than',
      'make one up: type {{users[1].email}}, the value of row 1. When the test is to run with each row (each user, each product),',
      'pass dataset: "users" to start_recording too and type {{email}}, {{password}}: the values of row 1 now, those of each row at run.');
  }
  // Its secrets, by name: typed by IziTest, never read by the agent (lib/secrets.js).
  if (secrets.length) {
    lines.push(
      'Its secrets (a password, a key: you are told their names, never their values):', ...secrets,
      'Type {{secret.NAME}} where one goes, a password field say: IziTest types its value. Never type a value you guessed instead.');
  }
  // A value nobody gave is asked, not made up (lib/asks.js).
  lines.push(
    'If the test needs a value that neither the description, the datasets nor the secrets give (an account to log in with,',
    'a password, a code), call ask_user: the person who started this run answers it in the dashboard. Mark a password, a key',
    'or a code secret: true. Never make such a value up, and never ask for it in your reply: nobody reads it before the end.',
    'If you cannot record the test for another reason — no URL to start from, a page that does not load —, or the person',
    'does not give what you asked, close the recording window with close_window, then end with one sentence that says what is missing.');
  // A value that changes from one day or one run to the next is computed, not recorded; one the
  // page or an API gives is kept for the steps after.
  lines.push(
    'A value that depends on the day (a date) or must differ at each run (an e-mail to sign up with) is computed: once recorded,',
    'make it a variable with add_test_variable and a default_value such as {{today + 1 day | dd/MM/yyyy}} or user-{{unique}}@example.com.',
    'A value the page shows that later steps need (an order number) is kept with capture_value, then written {{name}}; data the',
    'test needs first (a user, an order) can be created through the app\'s API with call_api.');
  return lines.join('\n');
}
