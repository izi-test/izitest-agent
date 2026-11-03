// Business steps the dashboard's agent proposes for a test, which the user accepts or
// dismisses: runs of steps that together do one thing a person means ("je renseigne mon
// profil", "the profile is saved"), each made a phrase of the project. What a business step of
// the project already groups — recognised by its elements (lib/elements.js) — is shown as such
// and not proposed again. A proposal is checked before it is shown: it groups steps that can
// be grouped, its parameters map recorded values or variables of the test. Proposals are kept
// on the test until accepted or dismissed; asked for, they are worked out in the background.

import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';
import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { loadTest } from './test-store.js';
import { withElementNames } from './element-store.js';
import { buildBusinessStep } from './gherkin/business-step.js';
import { scenarioPhrases, serializeTestToFeatureWith } from './gherkin/serialize.js';
import { listStepDefinitions, createStepDefinition } from './gherkin/step-definition-store.js';

const KEYWORDS = ['Given', 'When', 'Then'];
const MAX_PROPOSALS = 5;
const MIN_STEPS = 2;
const MAX_STEPS = 12;
// A proposal still running when the server started was stopped with it.
const STARTED_AT = new Date().toISOString();
const registry = new ParameterTypeRegistry();

/** The business step `spec` groups in `test`, made a step definition of `projectId`; `{ error }` otherwise. */
export function addBusinessStep(projectId, test, { from_step, to_step, keyword, pattern, args = [] }) {
  if (!KEYWORDS.includes(keyword)) return { error: `The keyword is one of ${KEYWORDS.join(', ')}` };
  const built = buildBusinessStep(test, { from_step, to_step, pattern, args });
  if (built.error) return { error: built.error };
  try {
    const definition = createStepDefinition(projectId, { keyword, pattern, command: 'composite', params_template: {}, steps_template: built.steps_template });
    if (!test.project_id) db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(projectId, test.name);
    log(`Business step "${pattern}" created from steps ${from_step}-${to_step} of "${test.name}"`);
    return { definition, steps_grouped: built.steps_template.length };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: `A step definition "${pattern}" already exists` };
    return { error: err.message };
  }
}

/** The steps of each phrase of the test, numbered from 1: [{ keyword, phrase, from, to, business }]. */
function numberedPhrases(test, definitions) {
  let next = 1;
  return scenarioPhrases(test, definitions).map((phrase) => {
    const from = next;
    next += phrase.steps.length;
    return { keyword: phrase.keyword, phrase: phrase.phrase, from, to: next - 1, business: phrase.business ?? null };
  });
}

// ─── What the agent is asked ────────────────────────────────────────

export const SYSTEM = 'You group the steps of an automated test into business steps: Gherkin phrases that say what a user does or checks, in the words of the domain. You answer with JSON only.';

/** What the agent reads: the test step by step, the project's business steps, and what to propose. */
export function proposalBrief(test, definitions) {
  const lines = [`# Business steps for the test "${test.name}"`];
  if (test.description) lines.push('', test.description);

  lines.push('', '## Its scenario, step by step');
  for (const phrase of numberedPhrases(test, definitions)) {
    const range = phrase.from === phrase.to ? `${phrase.from}` : `${phrase.from}–${phrase.to}`;
    if (phrase.business) {
      lines.push(`${range}. ${phrase.keyword} ${phrase.phrase}   [already a business step of the project]`);
      continue;
    }
    const step = test.steps[phrase.from - 1];
    const about = [step.intent && step.intent !== phrase.phrase ? step.intent : null, step.page ? `on ${step.page}` : null].filter(Boolean).join(' — ');
    lines.push(`${range}. ${phrase.keyword} ${phrase.phrase}${about ? `   (${about})` : ''}`);
  }

  const variables = Object.entries(test.variables ?? {});
  if (variables.length) {
    lines.push('', '## Its variables', ...variables.map(([name, v]) => `- {{${name}}}${v?.defaultValue !== undefined ? ` (default "${v.defaultValue}")` : ''}`));
  }

  const business = definitions.filter((d) => d.steps_template);
  lines.push('', '## The business steps the project already has — word yours alike');
  lines.push(...(business.length ? business.map((d) => `- ${d.keyword} ${d.pattern}`) : ['(none yet)']));

  lines.push('', '## What to propose',
    'Group runs of consecutive steps that together do one thing a user of the app means — fill in a form and send it, log',
    'in, choose a filter, check that a save worked — into one business step.',
    `- A group is ${MIN_STEPS} to ${MAX_STEPS} consecutive steps, by their numbers above, none of them already a business step;`,
    '  groups do not overlap. Actions and checks are not mixed: a run of checks may become one Then.',
    '- The phrase says what the user does or sees, not how: no selector, no "click", no field-by-field list',
    '  ("je renseigne mon profil", "the profile is saved"). In it, ( ) and / mean optional text and alternatives: avoid them.',
    '- A value that changes from one scenario to the next is a parameter of the phrase, {string} or {int}, each mapped in',
    '  "args", in order: { "variable": "display_name" } for a {{variable}} of the test — every variable the grouped steps',
    '  use needs one —, { "step": 3, "param": "value" } for a value a step typed. What defines the action stays fixed.',
    '- Write the phrase in the language of the project\'s business steps, else of the test.',
    `- Propose nothing rather than a group that does not make sense; at most ${MAX_PROPOSALS}.`,
    '', '## Answer', 'Answer with this JSON and nothing else:',
    '{ "proposals": [{ "from_step": 2, "to_step": 6, "keyword": "When", "pattern": "…", "args": [{ "variable": "…" }], "reason": "why, in one sentence" }] }');
  return lines.join('\n');
}

function jsonOf(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object') return value;
  } catch { /* told below */ }
  throw new Error(`The agent did not answer with business steps (JSON): ${text.trim().slice(0, 200) || '(empty answer)'}`);
}

const clean = (value, max = 300) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The arguments a proposal maps its parameters with, as buildBusinessStep takes them. */
function argsOf(args) {
  return (Array.isArray(args) ? args : []).map((arg) => {
    if (typeof arg?.variable === 'string') return { variable: arg.variable.replace(/^\{\{\s*|\s*\}\}$/g, '') };
    return {
      step: Number(arg?.step),
      param: String(arg?.param ?? ''),
      ...(arg?.value != null && { value: String(arg.value) }),
    };
  });
}

/**
 * The agent's proposals, checked: each groups a run the test has, of steps no business step
 * groups, not overlapping another; its phrase is new to the project and a valid Cucumber
 * expression; its parameters map values of those steps. Each with how it reads, the phrases it
 * replaces, and the other tests of the project it would read in too. Dropped ones are logged.
 */
export function parseProposals(text, test, definitions, otherTests = []) {
  const answer = jsonOf(text);
  const phrases = numberedPhrases(test, definitions);
  const grouped = new Set(phrases.filter((p) => p.business).flatMap((p) => range(p.from, p.to)));
  const patterns = new Set(definitions.map((d) => d.pattern));
  const taken = new Set();
  const proposals = [];

  for (const raw of Array.isArray(answer.proposals) ? answer.proposals : []) {
    if (proposals.length >= MAX_PROPOSALS) break;
    const from = Number(raw?.from_step);
    const to = Number(raw?.to_step);
    const keyword = KEYWORDS.includes(raw?.keyword) ? raw.keyword : null;
    const pattern = clean(raw?.pattern, 160);
    const drop = (why) => log(`Business step proposal for "${test.name}" dropped (${from}–${to} "${pattern}"): ${why}`);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to - from + 1 < MIN_STEPS || to - from + 1 > MAX_STEPS) { drop('not a run of steps'); continue; }
    if (!keyword || !pattern) { drop('no keyword or phrase'); continue; }
    if (/[()/]|\{\{/.test(pattern)) { drop('( ) / or a {{variable}} in the phrase'); continue; }
    if (patterns.has(pattern) || proposals.some((p) => p.pattern === pattern)) { drop('the phrase exists'); continue; }
    try { new CucumberExpression(pattern, registry); } catch (err) { drop(err.message.split('\n')[0]); continue; }
    const steps = range(from, to);
    if (steps.some((n) => grouped.has(n) || taken.has(n))) { drop('already grouped'); continue; }
    // A phrase ends where it ends: a run cut through the steps of one phrase is no run of them.
    if (!phrases.some((p) => p.from === from) || !phrases.some((p) => p.to === to)) { drop('cuts a phrase'); continue; }

    const args = argsOf(raw.args);
    const built = buildBusinessStep(test, { from_step: from, to_step: to, pattern, args });
    if (built.error) { drop(built.error); continue; }

    const candidate = { id: -1, keyword, pattern, command: 'composite', params_template: {}, steps_template: built.steps_template, is_default: 0 };
    const reads = scenarioPhrases(test, [...definitions, candidate]).find((p) => p.business === -1);
    if (!reads) { drop('it does not read in the test'); continue; }
    steps.forEach((n) => taken.add(n));
    proposals.push({
      id: `p${proposals.length + 1}`,
      from_step: from,
      to_step: to,
      keyword,
      pattern,
      args,
      reads: `${keyword} ${reads.phrase}`,
      replaces: phrases.filter((p) => p.from >= from && p.to <= to).map((p) => `${p.keyword} ${p.phrase}`),
      reason: clean(raw.reason) || null,
      also_in: otherTests.filter((other) => scenarioPhrases(other, [...definitions, candidate]).some((p) => p.business === -1)).map((other) => other.name),
    });
  }
  return proposals;
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// ─── Kept on the test ───────────────────────────────────────────────

const testIdOf = (name) => db.prepare('SELECT id FROM tests WHERE name = ?').get(name)?.id ?? null;

function save(testId, record) {
  db.prepare(
    `INSERT INTO business_proposals (test_id, status, proposals, error, agent, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (test_id) DO UPDATE SET status = excluded.status, proposals = excluded.proposals, error = excluded.error,
       agent = excluded.agent, updated_at = excluded.updated_at`
  ).run(testId, record.status, JSON.stringify(record.proposals ?? []), record.error ?? null, record.agent ?? null);
}

/** The proposals kept for a test: `{ status: 'none' | 'running' | 'ready' | 'failed', proposals, error, agent }`. */
export function proposalsOf(testName) {
  const testId = testIdOf(testName);
  const row = testId && db.prepare('SELECT * FROM business_proposals WHERE test_id = ?').get(testId);
  if (!row) return { status: 'none', proposals: [] };
  if (row.status === 'running' && row.updated_at < STARTED_AT) {
    return { status: 'failed', proposals: [], error: 'Stopped with the server: ask again', agent: row.agent };
  }
  return { status: row.status, proposals: parseJson(row.proposals) ?? [], error: row.error, agent: row.agent, updated_at: row.updated_at };
}

/**
 * Asks the agent (`complete`, lib/agent/complete.js) for the business steps of a test, in the
 * background: the record says it runs, then holds the proposals or the error. One at a time.
 */
export function startProposals(testName, { complete, agent = null }) {
  const test = loadTest(testName);
  if (!test) return { error: 'Test not found', status: 404 };
  if (!test.project_id) return { error: 'The test has no project: assign it to one first', status: 400 };
  const current = proposalsOf(testName);
  if (current.status === 'running') return current;

  const testId = testIdOf(testName);
  save(testId, { status: 'running', agent });
  (async () => {
    const started = Date.now();
    try {
      const definitions = listStepDefinitions(test.project_id);
      const named = withElementNames(test);
      const text = await complete({ system: SYSTEM, prompt: proposalBrief(named, definitions) });
      const others = db.prepare('SELECT name FROM tests WHERE project_id = ? AND name != ?').all(test.project_id, test.name)
        .map((row) => loadTest(row.name)).filter(Boolean);
      const proposals = parseProposals(text, withElementNames(loadTest(testName) ?? test), definitions, others);
      save(testId, { status: 'ready', proposals, agent });
      log(`Business steps for "${testName}": ${proposals.length} proposed in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      save(testId, { status: 'failed', error: err.message, agent });
      log(`Business steps for "${testName}" failed: ${err.message}`);
    }
  })();
  return { status: 'running', proposals: [], agent };
}

/**
 * Accepts a proposal, its phrase as the user left it: the business step is created, and the
 * test (with every other one acting on the same elements) reads with it. The proposals it
 * overlaps go. `{ error, status }` otherwise.
 */
export function acceptProposal(testName, id, { pattern, keyword } = {}) {
  const record = proposalsOf(testName);
  const proposal = record.proposals.find((p) => p.id === id);
  if (!proposal) return { error: 'No such proposal', status: 404 };
  const test = loadTest(testName);
  if (!test?.project_id) return { error: 'The test has no project', status: 400 };

  const phrase = clean(pattern ?? proposal.pattern, 160);
  const added = addBusinessStep(test.project_id, test, { ...proposal, pattern: phrase, keyword: keyword ?? proposal.keyword });
  if (added.error) return { error: added.error, status: 422 };
  const rest = record.proposals.filter((p) => p.id !== id && (p.to_step < proposal.from_step || p.from_step > proposal.to_step));
  save(testIdOf(testName), { ...record, proposals: rest });
  return {
    definition_id: added.definition.id,
    feature: serializeTestToFeatureWith(withElementNames(test), listStepDefinitions(test.project_id)),
  };
}

/** Dismisses one proposal, or all of them without `id`. */
export function dismissProposal(testName, id = null) {
  const testId = testIdOf(testName);
  if (!testId) return { error: 'Test not found', status: 404 };
  const record = proposalsOf(testName);
  if (!id) {
    db.prepare('DELETE FROM business_proposals WHERE test_id = ?').run(testId);
    return { status: 'none', proposals: [] };
  }
  const proposals = record.proposals.filter((p) => p.id !== id);
  save(testId, { ...record, proposals });
  return { ...record, proposals };
}
