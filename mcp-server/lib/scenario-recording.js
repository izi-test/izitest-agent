// A test written in Gherkin first, then recorded by the agent phrase by phrase (the dashboard's
// New test → Gherkin, or start_recording with a scenario).
//
// Writing it: the agent is told what the test should check and the project's library — its
// business steps first, then the generic phrases, and the elements of the app by name — and
// writes the scenario with them; what none says, it writes as a new phrase in the words of the
// domain. The user reads it, edits it, then has it recorded.
//
// Each phrase of the scenario is one of:
// - "library": a business step of the project — played as one (play_business_step);
// - "phrase": a generic phrase of the library on an element the project knows, or a selector;
// - "find": a generic phrase on an element the project does not know yet, named as the
//   scenario writes it ("je clique sur "Vider le panier""): found on the page, it is then named so.
//   A phrase on an element the project knows is told its selector: the step done for it is that
//   element, under the name written;
// - "new": a phrase no definition says — the agent finds how to do it on the page.
//
// Recording it: before the actions of each phrase, the agent says which one it starts
// (start_phrase); the steps recorded until the next are that phrase's. Once the test is saved,
// each new phrase becomes a business step of the project's library, made of its steps — its
// values in quotes its parameters —: the test reads as the scenario was written, and the next
// tests can use it.

import { db } from './db.js';
import { log } from './logger.js';
import { loadTest } from './test-store.js';
import { featurePhrases, compileDefinitions, effectiveKeyword, matchingDefinition } from './gherkin/parse.js';
import { listStepDefinitions, writingDefinitions } from './gherkin/step-definition-store.js';
import { keywordsOf } from './gherkin/language.js';
import { elementTargets, elementLines, elementAsWritten } from './element-store.js';
import { addBusinessStep } from './business-steps.js';
import { secretLines } from './secrets.js';
import { datasetLines } from './datasets.js';

// Tags a selector argument may be, alone: "button", "main".
const HTML_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'main', 'header', 'footer', 'nav', 'section', 'article',
  'aside', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'img', 'label', 'body', 'dialog']);

// A part of a selector: a tag, an id or a class, a tag with one.
const cssPart = (part) => HTML_TAGS.has(part) || /^[#.[]/.test(part) || /^[a-z][a-z0-9-]*[#.[:]/.test(part);

/** Whether a selector argument is CSS rather than the name of an element: "#q", "main h2", "div > a". */
export const looksLikeCss = (value) => /[>~+\]=]/.test(value) || value.trim().split(/\s+/).every(cssPart);

/** Which argument of a generic phrase is the element it acts on. */
function selectorSlot(definition) {
  const slot = /^\{(\d+)\}$/.exec(String(definition.params_template?.selector ?? ''))?.[1];
  return slot === undefined ? null : Number(slot);
}

/**
 * The phrases of `gherkin` against the library of `projectId`, numbered from 1:
 * [{ n, keyword, written, text, kind, target?, pattern? }] — `{ error }` when it does not parse.
 */
export function scenarioOf(projectId, gherkin) {
  let phrases;
  try {
    phrases = featurePhrases(String(gherkin ?? ''));
  } catch (err) {
    return { error: err.message.replace(/^Parser errors:\s*/, '').replace(/\s+/g, ' ').slice(0, 300) };
  }
  if (!phrases.length) return { error: 'The scenario has no step' };
  const compiled = compileDefinitions(projectId ? listStepDefinitions(projectId) : []);
  // The project's elements by name, whatever its case: how its steps find each.
  const known = new Map([...(projectId ? elementTargets(projectId) : new Map())].map(([name, target]) => [name.toLowerCase(), target]));
  let last = null;
  return {
    phrases: phrases.map(({ text, keyword: raw, written }, i) => {
      const keyword = effectiveKeyword(raw, last) ?? raw ?? 'Given';
      const match = matchingDefinition(text, compiled, keyword);
      last = match?.def.keyword ?? keyword;
      const phrase = { n: i + 1, keyword: last, written, text };
      if (!match) return { ...phrase, kind: 'new' };
      if (match.def.steps_template) return { ...phrase, kind: 'library', pattern: match.def.pattern };
      const slot = selectorSlot(match.def);
      const target = slot === null ? null : match.args[slot];
      if (typeof target !== 'string' || !target || looksLikeCss(target) || target.includes('{{')) return { ...phrase, kind: 'phrase' };
      const element = known.get(target.toLowerCase());
      if (element) return { ...phrase, kind: 'phrase', target, selector: element.selector };
      return { ...phrase, kind: 'find', target };
    }),
  };
}

/** How the recording agent does a phrase of each kind. */
function howTo(phrase) {
  if (phrase.kind === 'library') return `a business step of the project: play_business_step(phrase: ${JSON.stringify(phrase.text)})`;
  if (phrase.kind === 'phrase') {
    const what = phrase.keyword === 'Then' ? 'a check of the library: add_assertion with what it expects' : 'a phrase of the library: do what it says';
    return phrase.selector ? `${what}, on the element ${JSON.stringify(phrase.target)} of the project — selector ${JSON.stringify(phrase.selector)}: use it` : what;
  }
  if (phrase.kind === 'find') {
    return `${phrase.keyword === 'Then' ? 'a check of the library: add_assertion' : 'a phrase of the library'} on the element ${JSON.stringify(phrase.target)}, `
      + 'to find on the page — it is then named so';
  }
  return phrase.keyword === 'Then'
    ? 'new: check it with add_assertion, on what the page shows'
    : 'new: find on the page how to do it, and do it with the browser tools';
}

/**
 * What the agent recording a scenario is told (start_recording's answer): its phrases in
 * order, how to do each, and to say which one it starts.
 */
export function scenarioBrief(scenario) {
  const lines = ['', 'Record this scenario, phrase by phrase, in this order. Before the actions of each phrase, call',
    'start_phrase(number, phrase): the steps recorded until the next call are that phrase\'s.'];
  for (const phrase of scenario.phrases) lines.push(`${phrase.n}. ${phrase.written} ${phrase.text} — ${howTo(phrase)}`);
  lines.push(
    'Values in quotes are the values to type, pick or expect: use them as written. An empty one, "", is a value the scenario',
    'does not know (an account, a password): ask the user for it with ask_user (secret: true for a password), never make one up.',
    'To look at the page, use snapshot or extract: they record nothing. An execute_js that only looked is a step too —',
    'remove it with record_step(action_id, remove: true).',
    'A Then phrase is checked with add_assertion right after the actions before it, on what it says.',
    'A new phrase becomes a step of the project\'s library once the test is saved, made of the actions you record for it:',
    'record only what it says, nothing of the next phrase. Then stop_recording.');
  return lines.join('\n');
}

/** start_phrase: the steps recorded from now on are phrase `n`'s. A text for the agent; `error` when it cannot. */
export function startPhrase(recording, n) {
  if (!recording) return { error: 'No recording in progress: start_recording with the scenario first.' };
  if (!recording.scenario) return { error: 'This recording has no scenario: pass it to start_recording (scenario).' };
  const phrase = recording.scenario.phrases[Number(n) - 1];
  if (!phrase) return { error: `The scenario has ${recording.scenario.phrases.length} phrase(s), numbered from 1: no phrase ${n}.` };
  recording.phraseStarts ??= [];
  recording.phraseStarts.push({ n: phrase.n, at: recording.steps.length });
  return { text: `Phrase ${phrase.n}: ${phrase.written} ${phrase.text} — ${howTo(phrase)}.` };
}

/** Each recorded step marked with the phrase it was recorded for (`_phrase`, not saved): before cleaning them up. */
export function markPhrases(recording) {
  const starts = recording?.phraseStarts ?? [];
  if (!starts.length) return;
  recording.steps.forEach((step, i) => {
    const start = starts.findLast((s) => s.at <= i);
    if (start) step._phrase = start.n;
  });
}

// Special in a Cucumber expression: written as text.
const escapePattern = (text) => text.replace(/[\\(){}/]/g, (c) => `\\${c}`);
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** What a value in quotes of a phrase is, among the steps `from`–`to` of `test`: a parameter of the business step. */
function argFor(value, test, from, to) {
  const variable = /^\{\{\s*([A-Za-z_]\w*)\s*\}\}$/.exec(value)?.[1];
  const steps = test.steps.slice(from - 1, to);
  const uses = (name) => steps.some((step) => JSON.stringify(step.params ?? {}).includes(`{{${name}}}`) || JSON.stringify(step.assertion ?? {}).includes(`{{${name}}}`));
  if (variable && uses(variable)) return { variable };
  const named = Object.entries(test.variables ?? {}).find(([name, v]) => same(v?.defaultValue, value) && uses(name));
  if (named) return { variable: named[0] };
  for (const [k, step] of steps.entries()) {
    const data = step.command === 'assert' ? step.assertion ?? step.params ?? {} : step.params ?? {};
    for (const param of ['value', 'expected', 'text', 'url']) {
      if (typeof data[param] !== 'string') continue;
      if (same(data[param], value)) return { step: from + k, param };
      if (data[param].includes(value)) return { step: from + k, param, value };
    }
  }
  return null;
}

/** A phrase as a business step's pattern: each value in quotes a parameter when the steps use it. */
export function businessPattern(text, test, from, to) {
  let pattern = '';
  let last = 0;
  const args = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const arg = argFor(m[1], test, from, to);
    pattern += escapePattern(text.slice(last, m.index)) + (arg ? '{string}' : escapePattern(m[0]));
    if (arg) args.push(arg);
    last = m.index + m[0].length;
  }
  return { pattern: pattern + escapePattern(text.slice(last)), args };
}

/**
 * Once the test recorded from `recording.scenario` is saved: each new phrase made a business
 * step of the project out of the steps recorded for it, and the element of each "find" phrase
 * named as the scenario writes it. What it says to the agent.
 */
export function completeScenario(testName, recording) {
  const phrases = recording?.scenario?.phrases;
  if (!phrases?.length) return '';
  const test = loadTest(testName);
  const projectId = test?.project_id;
  if (!projectId) return '\nNo project: the new phrases of the scenario were not added to a library.';
  const lines = [];
  const stepsOf = (n) => recording.steps.flatMap((step, i) => (step._phrase === n ? [i + 1] : []));

  // The element a phrase names: the step done for it is that one, under the name written.
  for (const phrase of phrases.filter((p) => p.target)) {
    const step = stepsOf(phrase.n).map((order) => test.steps[order - 1]).find((s) => s && ['click', 'fill', 'select', 'upload', 'assert', 'wait'].includes(s.command));
    const done = step && elementAsWritten(projectId, step, phrase.target);
    if (done === 'named') lines.push(`The element of phrase ${phrase.n} is named "${phrase.target}", as the scenario writes it.`);
    if (done === 'merged') lines.push(`The element of phrase ${phrase.n} is "${phrase.target}", as the scenario writes it.`);
  }

  for (const phrase of phrases.filter((p) => p.kind === 'new')) {
    const orders = stepsOf(phrase.n);
    const said = `"${phrase.written} ${phrase.text}"`;
    if (!orders.length) { lines.push(`Phrase ${phrase.n} ${said}: no step recorded for it — not added to the library.`); continue; }
    const from = orders[0];
    const to = orders.at(-1);
    if (to - from + 1 !== orders.length) { lines.push(`Phrase ${phrase.n} ${said}: its steps are not one after the other — not added to the library.`); continue; }
    const { pattern, args } = businessPattern(phrase.text, test, from, to);
    const made = addBusinessStep(projectId, test, { from_step: from, to_step: to, keyword: phrase.keyword, pattern, args });
    if (made.error) {
      lines.push(`Phrase ${phrase.n} ${said}: not added to the library — ${made.error}.`);
      log(`Scenario of "${testName}": phrase ${phrase.n} not added to the library: ${made.error}`);
    } else {
      lines.push(`New step of the library: ${keywordsOf(test.language)[phrase.keyword] ?? phrase.keyword} ${pattern} (steps ${from}–${to}).`);
    }
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
}

// ─── Writing the scenario ────────────────────────────────────────────

export const SYSTEM = 'You write automated test scenarios in Gherkin, with the step library of the project first. You answer with the feature only.';

/** What the agent writing a scenario is told: what to check, the app, the library, how to write. */
export function writingBrief(projectId, { name, description }) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const words = keywordsOf(project?.language);
  const definitions = writingDefinitions(projectId);
  const business = definitions.filter((d) => d.steps_template);
  const generic = definitions.filter((d) => !d.steps_template);
  const elements = elementLines(projectId);
  const lines = [`# A test to write in Gherkin — "${name}", project "${project?.name ?? '?'}", its tests written in ${words.name}`,
    '', '## What the test should check, in the user\'s words', String(description ?? '').trim() || '(nothing more than its name)'];
  lines.push('', '## The application');
  if (project?.base_url) lines.push(`At ${project.base_url}.`);
  if (project?.description) lines.push(project.description);
  if (project?.context?.trim()) lines.push(project.context.trim());
  lines.push('', '## The library of the project — write with it, word for word',
    '### Its business steps: each stands for several actions of this app — use one wherever it does what the test needs',
    ...(business.length ? business.map((d) => `- ${words[d.keyword] ?? d.keyword} ${d.pattern}`) : ['(none yet)']),
    '### Its generic phrases ({string} takes a value in quotes)',
    ...generic.map((d) => `- ${words[d.keyword] ?? d.keyword} ${d.pattern}${selectorSlot(d) !== null ? '   — its element: a name below, or as written on the page' : ''}`));
  if (elements.length) lines.push('', '## The elements of the app, by name, page by page — where a phrase takes an element, one of these', ...elements);
  // An account, a password: the project's, never made up (lib/secrets.js, lib/datasets.js).
  const secrets = secretLines(projectId);
  const datasets = datasetLines(projectId);
  if (secrets.length) lines.push('', '## Its secrets — IziTest types their values, nobody reads them: write {{secret.NAME}} where one goes', ...secrets);
  if (datasets.length) lines.push('', '## Its datasets — values to test with, rows numbered from 1: write {{users[1].email}}', ...datasets);
  lines.push('', '## How to write it',
    `1. One feature with one scenario, "${words.scenario}: ${name}", in ${words.name}, with its keywords: ${[words.feature, words.scenario, words.Given, words.When, words.Then, words.And].join(' / ')}.`,
    ...(words.header ? [`   Its first line: ${words.header}`] : []),
    '2. Start from the address of the app.',
    '3. Wherever a business step does what the test needs, write it word for word, its values in quotes.',
    '4. Else a generic phrase, its element named as listed above — or, one not listed, as a person reads it on the page',
    '   ("Vider le panier"). Never a CSS selector, never a guessed id.',
    '5. What no phrase says well: a new phrase, in the words of the domain — what the user does or sees, not how',
    `   (${words.When} ${project?.language === 'fr' ? 'je vide le panier' : 'I empty the cart'}, ${words.Then} ${project?.language === 'fr' ? 'le panier est vide' : 'the cart is empty'}), its values in quotes. It joins the library`,
    '   once the test is recorded: write it so another test can use it again.',
    '6. Check each expected result with a Then, with the value the description expects.',
    '7. The values, in quotes: the ones the description gives. An account, a password, a code: a secret of the project',
    '   ({{secret.NAME}}) or a value of its datasets ({{users[1].email}}) — never one you make up; when none fits, leave it',
    '   empty, "", and the agent recording the test asks the user for it. Any other value: a realistic one.',
    '', '## Answer', 'The feature only, in a ```gherkin block.');
  return lines.join('\n');
}

/** The feature in the agent's answer: a ```gherkin block, or the whole answer from its first keyword. */
export function featureIn(text) {
  const fenced = /```(?:gherkin|feature)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(Math.max(0, text.search(/^\s*(#\s*language|Feature|Fonctionnalit)/m)));
  return body.trim() ? `${body.trim()}\n` : '';
}

/** The scenario the agent writes for a test of `projectId`: `{ gherkin, phrases }`; throws when it writes none. */
export async function writeScenario(projectId, { name, description, complete, signal }) {
  const answer = await complete({ system: SYSTEM, prompt: writingBrief(projectId, { name, description }), signal });
  const gherkin = featureIn(answer);
  const read = scenarioOf(projectId, gherkin);
  if (read.error) throw new Error(`The agent did not write a scenario that reads (${read.error}): ${answer.trim().slice(0, 200)}`);
  return { gherkin, phrases: read.phrases };
}
