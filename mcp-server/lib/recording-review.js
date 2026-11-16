// The recording read over before it is saved (stop_recording): what would make the test pass
// once, then fail at the next run. Found by reading the steps, without a model:
// - the name of an item picked in a list by its place ("the first result"), written as it was in
//   a later step — the check that "Penne rigate" is in the list, after picking the first pasta of
//   the search: another search, another first result, and the check fails;
// - a value typed earlier written as it was in a later step's selector or in what it expects —
//   checks are linked to the variables already (recorded-checks.js), a click on 'a[title="pâtes"]'
//   is not.
// The agent recording is told, the page still there to fix them; a second stop_recording saves.

const WORD = /[\p{L}\p{N}][\p{L}\p{N}°'-]*/gu;
const words = (text) => (String(text ?? '').match(WORD) ?? []).map((w) => w.toLowerCase());
const hasLetter = (word) => /\p{L}/u.test(word);

/** What a step says, where a value could be written: its target, its value, what it expects. */
function textsOf(step) {
  const data = step.command === 'assert' ? step.assertion ?? {} : step.params ?? {};
  return [data.selector, data.text, data.value, data.expected, data.url].filter((v) => typeof v === 'string' && v);
}

/** What a person reads on the element a step acts on: its labels and texts. */
function labelOf(step) {
  const fromLocators = (step.locators ?? []).filter((l) => ['aria', 'text', 'label'].includes(l.type) && l.value).map((l) => l.value);
  const fromRole = (step.locators ?? []).filter((l) => l.type === 'role' && l.name).map((l) => l.name);
  const fromSelector = [...String(step.params?.selector ?? '').matchAll(/\[(?:aria-label|title|alt)="((?:[^"\\]|\\.)*)"\]/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return [...fromLocators, ...fromRole, ...fromSelector, step.params?.text].filter(Boolean).join(' ');
}

/**
 * How the element clicked names the item a pick took, from what it is called in each item: what
 * its label reads that the same element of the other items does not — "Ajouter le produit : Lait
 * demi-écrémé UHT à une liste" among "Ajouter le produit : … à une liste" is "Lait demi-écrémé
 * UHT" —, and the words around it: `{ name, before, after, from }` (`from`: the attribute it is
 * read from, or "text"). null when the labels do not tell (no other label read, all the same).
 */
export function pickTemplate(context) {
  const picked = typeof context?.pickedLabel === 'string' ? context.pickedLabel.trim() : '';
  const others = (context?.otherLabels ?? []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
  if (!picked || !others.length) return null;
  const reversed = (t) => [...t].reverse().join('');
  // What every label begins and ends with, cut back to a whole word: the label's own words.
  let start = Math.min(...others.map((o) => commonLength(picked, o)));
  let end = Math.min(...others.map((o) => commonLength(reversed(picked), reversed(o))));
  if (start + end >= picked.length) return null;
  // In no label through a word: "1L à une liste" ends "Boisson d'amande 1L…" and "…UHT 6x1L…"
  // alike, and cut there the name of the second was "…UHT 6x".
  const inWord = (c) => /[\p{L}\p{N}]/u.test(c ?? '');
  const labels = [picked, ...others];
  const throughWord = (label, at) => at > 0 && at < label.length && inWord(label[at - 1]) && inWord(label[at]);
  while (start > 0 && labels.some((label) => throughWord(label, start))) start--;
  while (end > 0 && labels.some((label) => throughWord(label, label.length - end))) end--;
  const middle = picked.slice(start, picked.length - end);
  const name = middle.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if ((name.match(/\p{L}/gu) ?? []).length < 3) return null;
  const at = start + middle.indexOf(name);
  return { name, before: picked.slice(0, at), after: picked.slice(at + name.length), from: context.pickedLabelFrom ?? 'text' };
}

/** The name of the item a pick by place took, as the element clicked says it (pickTemplate), or null. */
export const pickedName = (step) => pickTemplate(step.variable?.listContext)?.name ?? null;

function commonLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Whether `text` holds `name`, whole — its CSS escapes undone, case and spaces aside. */
function namesIt(text, name) {
  const flat = (s) => s.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').toLowerCase();
  const at = flat(text).indexOf(flat(name));
  if (at < 0) return false;
  const before = flat(text)[at - 1] ?? '';
  const after = flat(text)[at + flat(name).length] ?? '';
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

/**
 * The words that name the item a pick by place took, when its label does not tell: in what it
 * reads, not in what every item of the list reads ("Ajouter le produit … à une liste") — the other
 * items' texts, the selector kept for all of them.
 */
export function pickedWords(step) {
  const context = step.variable?.listContext;
  if (!context) return [];
  const selectorWords = new Set(words(String(step.params?.selector ?? '').replace(/\[(?:aria-label|title|alt)="(?:[^"\\]|\\.)*"\]/g, '')));
  // The selector kept for every item (aria-label^="Ajouter le produit"): its words are the list's.
  for (const m of String(step.params?.selector ?? '').matchAll(/\[[\w-]+[\^$*]="((?:[^"\\]|\\.)*)"\]/g)) for (const w of words(m[1])) selectorWords.add(w);
  // What the other items read, when recorded: a word all of them read is the list's ("Ajouter",
  // "panier", the word searched). One of them only: the products of a search for "lait" are alike.
  const others = (context.otherTexts ?? []).filter((t) => typeof t === 'string');
  const listWords = new Set(words(others[0] ?? '').filter((w) => others.every((t) => words(t).includes(w))));
  const texts = (context.itemTexts ?? []).filter((t) => typeof t === 'string');
  const common = new Set(words(texts.join(' ')).filter((w) => texts.filter((t) => words(t).includes(w)).length > 1));
  return [...new Set(words(`${labelOf(step)} ${context.pickedText ?? ''}`))]
    .filter((w) => w.length >= 4 && hasLetter(w) && !selectorWords.has(w) && !common.has(w) && !listWords.has(w));
}

/** Whether `text` holds `word`, whole. */
const holds = (text, word) => words(text).includes(word);

/** A value typed: in a URL it is encoded ("pâtes" is p%C3%A2tes, "two words" two+words). */
const forms = (value) => [...new Set([value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, '+')])];

/**
 * What would make the test pass once: [{ step, actionId, says }], each step numbered from 1.
 * `steps` as they are about to be saved, their values made variables.
 */
export function reviewSteps(steps) {
  const findings = [];
  steps.forEach((step, i) => {
    // An item picked by its place: its name, in a later step.
    if (step.variable?.listContext && step.variable.listContext.selectionMode !== 'by_text') {
      const name = pickedName(step);
      const named = name ? [] : pickedWords(step);
      if (name) {
        steps.slice(i + 1).forEach((later, k) => {
          if (textsOf(later).some((t) => namesIt(t, name))) {
            findings.push({
              step: i + k + 2, actionId: later._actionId ?? null,
              says: `names "${name}", the item step ${i + 1} picked by its place — at the next run, another item is there`
                + ` (another search, another first result). Keep its name right after the pick with capture_value, then write {{its name}} in the steps that name it`,
            });
          }
        });
      }
      if (named.length) {
        steps.slice(i + 1).forEach((later, k) => {
          const found = named.filter((w) => textsOf(later).some((t) => holds(t, w)));
          // Two of its words at least: one alone is often the site's ("panier" in "Ajouter au panier" and the cart link).
          if (found.length >= 2) {
            findings.push({
              step: i + k + 2, actionId: later._actionId ?? null,
              says: `names "${found.join(' ')}", the item step ${i + 1} picked by its place — at the next run, another item is there`
                + ` (another search, another first result). Keep its name right after the pick with capture_value, then write {{its name}} in the steps that name it`,
            });
          }
        });
      }
    }
    // A value typed: as it was, in a later selector or expected value.
    const typed = step.command === 'fill' && step.variable?.name && typeof step.variable.defaultValue === 'string' ? step.variable.defaultValue : null;
    if (typed && typed.length >= 3 && !/^\{\{/.test(typed)) {
      steps.slice(i + 1).forEach((later, k) => {
        if (textsOf(later).some((t) => forms(typed).some((form) => t.includes(form)))) {
          findings.push({
            step: i + k + 2, actionId: later._actionId ?? null,
            says: `holds "${typed}", the value typed at step ${i + 1} ({{${step.variable.name}}}) — at the next run, another value is typed. Write {{${step.variable.name}}} there instead`,
          });
        }
      });
    }
  });
  return findings;
}

/** What the agent is told when the review found something: the test is not saved yet. */
export function reviewText(findings, steps) {
  const line = (f) => `- Step ${f.step}${f.actionId ? ` (${f.actionId})` : ''}, ${describe(steps[f.step - 1])}: ${f.says}.`;
  return [
    `Not saved yet: read over, the recording has ${findings.length === 1 ? 'a step' : `${findings.length} steps`} that would pass once, then fail at the next run:`,
    ...findings.map(line),
    'Fix them now, while the page is still there: remove a step with record_step(action_id, remove: true), keep a value with',
    'capture_value, add the check again with add_assertion and its {{value}}. Then call stop_recording again: it saves.',
    'If one cannot be fixed, call stop_recording again all the same — the test is saved, and you tell the user what is left.',
  ].join('\n');
}

function describe(step) {
  if (!step) return '';
  const target = step.command === 'assert' ? `${step.assertion?.type ?? 'check'} ${step.assertion?.selector ?? ''}` : `${step.command} ${step.params?.selector ?? step.params?.url ?? ''}`;
  return `${target.trim()}${step.intent ? ` ("${step.intent}")` : ''}`;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `name` as a selector may write it — "Lait\ demi-écrémé\ UHT", CSS-escaped — or as it reads. */
function nameRegex(name) {
  const chars = [...name].map((c) => (/[\p{L}\p{N}]/u.test(c) ? escapeRegex(c) : `\\\\?${escapeRegex(c)}`));
  return new RegExp(`(?<![\\p{L}\\p{N}])${chars.join('')}(?![\\p{L}\\p{N}])`, 'gu');
}

/** Every string of a step (its params, check, locators), `fix` applied; whether one changed. */
function rewriteStrings(value, fix) {
  if (typeof value === 'string') return fix(value);
  if (Array.isArray(value)) return value.map((v) => rewriteStrings(v, fix));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, fix)]));
  return value;
}

/**
 * The steps naming the item a pick by place took, made to name whichever item is picked: its name
 * kept right after the pick (a capture of what the element clicked is called there, the words
 * around its name left out), then written {{its name}} in them. An Auchan recording picked the
 * second "lait" by its place, then removed "Lait demi-écrémé UHT" from the list by its name.
 *
 * Only where the pick's own selector finds the element by its place: one naming the item finds
 * this item only. `steps` is changed in place; `usedNames` gets the names given. What was done:
 * [{ pick, name, variable, named }], step numbers counted once the captures are in.
 */
export function keepPickedNames(steps, usedNames = new Set()) {
  const done = [];
  // The values the agent kept itself (capture_value): names taken.
  for (const step of steps) if (step.command === 'capture' && step.params?.name) usedNames.add(step.params.name);
  for (let i = 0; i < steps.length; i++) {
    const pick = steps[i];
    const context = pick.variable?.listContext;
    if (!context || context.selectionMode === 'by_text' || pick.command !== 'click') continue;
    const template = pickTemplate(context);
    const selector = pick.params?.selector;
    if (!template || !selector || nameRegex(template.name).test(selector)) continue;
    const pattern = nameRegex(template.name);
    const later = [];
    for (let j = i + 1; j < steps.length; j++) if (textsOf(steps[j]).some((t) => namesIt(t, template.name))) later.push(j);
    if (!later.length) continue;
    let variable = `${pick.variable.name}_name`;
    for (let n = 2; usedNames.has(variable); n++) variable = `${pick.variable.name}_name_${n}`;
    usedNames.add(variable);
    for (const j of later) {
      for (const key of ['params', 'assertion', 'locators']) {
        if (steps[j][key] != null) steps[j][key] = rewriteStrings(steps[j][key], (s) => s.replace(pattern, `{{${variable}}}`));
      }
    }
    const around = (text) => escapeRegex(text.trim()).replace(/\s+/g, '\\s+');
    steps.splice(i + 1, 0, {
      command: 'capture',
      params: {
        name: variable, selector,
        ...(template.from === 'text' ? { what: 'text' } : { what: 'attribute', attribute: template.from }),
        pattern: `${template.before.trim() ? `${around(template.before)}\\s*` : '^\\s*'}(.+?)${template.after.trim() ? `\\s*${around(template.after)}` : '\\s*$'}`,
      },
      intent: `Keep the name of the ${pick.variable.name} picked as {{${variable}}}`,
    });
    done.push({ pick: i + 1, name: template.name, variable, named: later.map((j) => j + 2) });
  }
  return done;
}

/** What the agent is told of the names kept (keepPickedNames). */
export function keptNamesText(done) {
  return done.map((d) => `The item picked by its place at step ${d.pick} was named as it was ("${d.name}") in step${d.named.length > 1 ? 's' : ''} ${d.named.join(', ')}:`
    + ` its name is kept right after the pick as {{${d.variable}}} (step ${d.pick + 1}), and written {{${d.variable}}} there — a replay that picks another item names that one.`).join('\n');
}
