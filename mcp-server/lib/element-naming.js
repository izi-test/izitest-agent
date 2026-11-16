// The elements of a project named the way a person reads them, by the agent. An element found
// by a selector or a test ID alone has no name on the page: it was named in words drawn from
// its selector ("Shop cart total"), or after another element of the same name, its page added
// ("Save (profile)"). The Gherkin says that name (When I click on "…"): the agent names it from
// what the tests do with it — "Total du panier", "Message de confirmation" —, in the language
// of the project, each name its own: one that another element of the project, on another page,
// already has is not given again, the agent tells them apart ("Rechercher un produit",
// "Rechercher un utilisateur"); one it gives anyway gets its page added. A name the user gave
// is never changed (element-store.js).
//
// Asked once a test is recorded, for the elements it acts on — in the background: the agent
// recording it is not kept waiting —, and from the Elements page for every element of a project.

import { db } from './db.js';
import { log } from './logger.js';
import { elementsToName, nameElementsAs } from './element-store.js';
import { keywordsOf } from './gherkin/language.js';

export const MAX_PER_CALL = 30;
const MAX_TAKEN = 300;

export const SYSTEM = 'You name the elements of a web application the way a person using it reads them, for test scenarios written in Gherkin. You answer with JSON only.';

const quote = (value) => JSON.stringify(String(value ?? '')).slice(0, 160);

/** What a step does with its element, in a line. */
function useLine({ command, intent, assertion, value }) {
  const what = command === 'assert' && assertion
    ? `checked: ${assertion.type}${assertion.expected !== undefined ? ` ${quote(assertion.expected)}` : ''}${assertion.attribute ? ` (attribute ${assertion.attribute})` : ''}`
    : command === 'fill' ? `filled with ${quote(value)}`
      : command === 'wait' ? 'waited for'
        : command;
  return `${what}${intent ? ` — ${quote(intent)}` : ''}`;
}

/** What the agent reads: the elements to name, what the tests do with each, the names taken. */
export function namingBrief({ project, language, elements, taken }) {
  const words = keywordsOf(language);
  const lines = [`# Elements to name — project "${project}", its tests written in ${words.name}`, '',
    'Each element: its id, its page, how the tests find it (a selector or a test ID — not a name), and what they do with it.'];
  for (const element of elements) {
    lines.push('', `- id ${element.id}, page ${element.page}, found by ${element.target} (named "${element.name}" for now)`);
    for (const use of element.uses) lines.push(`  - ${useLine(use)}`);
  }
  lines.push('', '## Names other elements of the project already have — a name you give must differ from each, and from the others you give');
  lines.push(...(taken.length ? taken.slice(0, MAX_TAKEN).map((t) => `- "${t.name}" (${t.page})`) : ['(none)']));
  lines.push('', '## How to name',
    '- The words a person reads on it when it has some (the text of a button, the label of a field): "Ajouter au panier";',
    '  else what it is for a user: "Total du panier", "Message de confirmation", "Prix du deuxième produit".',
    '- 1 to 5 words. No selector, no CSS, no id, no quotes, no {{ }}; not "button" or "field" alone.',
    '- Every name its own: an element like one of another page, or like a name already taken, gets a name that says what',
    '  sets it apart ("Rechercher un produit", "Rechercher un utilisateur") — never the same name with a number.',
    `- In ${words.name}.`,
    '', '## Answer', 'Answer with this JSON and nothing else, one entry per element above:',
    '{ "names": [{ "id": 12, "name": "…" }] }');
  return lines.join('\n');
}

function jsonOf(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object') return value;
  } catch { /* told below */ }
  throw new Error(`The agent did not answer with names (JSON): ${text.trim().slice(0, 200) || '(empty answer)'}`);
}

/** The names of the agent's answer that can be names: [{ id, name }], for the elements asked only. */
export function parseNames(text, elements) {
  const asked = new Set(elements.map((e) => e.id));
  const names = [];
  const answer = jsonOf(text);
  for (const entry of Array.isArray(answer.names) ? answer.names : []) {
    const id = Number(entry?.id);
    const name = typeof entry?.name === 'string' ? entry.name.replace(/\s+/g, ' ').trim().replace(/^["'«]+|["'»]+$/g, '').trim() : '';
    if (!asked.has(id) || !name || name.length > 60) continue;
    // What finds an element is no name: a selector, an id, a {{value}}, a quote that would end the phrase.
    if (/[#[\]{}<>="_]|^\.|::/.test(name) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name)) {
      log(`Element #${id}: "${name}" is no name, left as it was`);
      continue;
    }
    names.push({ id, name });
  }
  return names;
}

/**
 * Names the elements of `projectId` still to name — those `testName` acts on, when given —,
 * `MAX_PER_CALL` at a time. `complete`: the agent (lib/agent/complete.js). The names changed:
 * [{ id, from, to }]; `left`: those the agent gave no name.
 */
export async function nameElements(projectId, { testName = null, complete, signal } = {}) {
  const project = db.prepare('SELECT name, language FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`No project #${projectId}`);
  const changed = [];
  let left = 0;
  const { elements } = elementsToName(projectId, { testName });
  for (let i = 0; i < elements.length; i += MAX_PER_CALL) {
    // The names taken as they are now: those given by the batch before count.
    const { elements: all, taken } = elementsToName(projectId, { testName });
    const batch = all.filter((e) => elements.slice(i, i + MAX_PER_CALL).some((asked) => asked.id === e.id));
    if (!batch.length) continue;
    const answer = await complete({ system: SYSTEM, prompt: namingBrief({ project: project.name, language: project.language, elements: batch, taken }), signal });
    const names = parseNames(answer, batch);
    left += batch.length - names.length;
    changed.push(...nameElementsAs(projectId, names));
  }
  if (changed.length) log(`Elements named (project #${projectId}${testName ? `, test "${testName}"` : ''}): ${changed.map((c) => `"${c.from}" → "${c.to}"`).join(', ')}`);
  return { changed, left };
}

// The agent once the server has one (server.js): unit tests run without.
let agent = null;
export function setElementNamer(complete) { agent = complete; }

/**
 * Once a test is saved: the elements it acts on that nothing names, named by the agent in the
 * background. Never throws; nothing without an agent, or for a test of no project.
 */
export function nameElementsLater(testName) {
  if (!agent) return;
  const projectId = db.prepare('SELECT project_id FROM tests WHERE name = ?').get(testName)?.project_id;
  if (!projectId) return;
  if (!elementsToName(projectId, { testName }).elements.length) return;
  nameElements(projectId, { testName, complete: agent })
    .catch((err) => log(`The elements of "${testName}" were not named: ${err.message}`));
}
