// Jev action loop — lets an MCP-connected agent delegate a bounded browser task.
//
// The connected agent (Claude, etc.) stays the planner ("System Two"). Instead of
// paying two of its own LLM round trips per action (snapshot → think → click), it
// hands a goal + the values to type to this loop. Each step here is:
//   1 snapshot → 1 Jev request (operation + speculative targets, in parallel) → 1 action
// The loop hands control back as soon as Jev says DONE/BLOCKED, is unsure, errors,
// or repeats itself — with the candidate refs, so the agent can finish by hand.
//
// Jev never generates text, so every value to type comes from `inputs`. Those
// values are sent to the browser only — never to Jev (it only sees the input keys).

import { log } from './logger.js';

const MAX_OPTIONS = 200;      // Jev caps a choice at 255 options; keep headroom for the 32k-token request limit
const DESC_MAX_CHARS = 100;
const MIN_OPERATION_P = 0.5;  // below this, hand back to the agent instead of guessing
const MIN_TARGET_P = 0.4;
const BATCH_MIN_TARGET_P = 0.9; // extra fills in the same step are not re-checked: demand near-certainty
const BATCH_MIN_NOW_P = 0.8;
const REPEAT_LIMIT = 3;       // same action N times in a row = stuck
const SETTLE_MS = 150;
const RELOOK_MS = 700;        // extra wait before the one-time second look (see runJevAct)
const SNAPSHOT_RETRY_MS = 600;
const SCROLL_AMOUNT_PX = 600;
export const DEFAULT_MAX_STEPS = 10;
export const HARD_MAX_STEPS = 25;

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const TEXT_ONLY_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);

const RULES = [
  'Pick the single next operation that makes progress toward the goal from the CURRENT page state.',
  'recent_actions lists what was already done, oldest first. Never repeat an action that already succeeded.',
  'Before submitting a form, fill every field for which an input value is still pending.',
  'Dismiss a cookie banner or modal only when it blocks the goal.',
  'Only the form or area the goal names matters. Ignore unrelated forms on the page and their empty required fields.',
  'Choose DONE as soon as the goal is accomplished. Choose BLOCKED rather than guessing.',
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Snapshot → element table ──────────────────────────────────────
// Tree lines look like:  @e5 [textbox] "Email" type="email" placeholder="you@…" value=""
// Native <select> options follow their select as un-ref'd lines:  [option] "France" [selected]

// With includeRects a line ends with its box:  ... [120,340,200x32]   (x,y relative to the viewport)

export function parseElements(tree, refs) {
  const elements = [];
  for (const raw of String(tree || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^@(e\d+) \[([^\]]+)\]\s*(.*)$/);
    if (m) {
      const [, ref, role] = m;
      let rest = m[3];
      if (refs && !refs[ref]) continue;

      let rect = null;
      const box = rest.match(/\s*\[(-?\d+),(-?\d+),(\d+)x(\d+)\]$/);
      if (box) {
        rect = { x: Number(box[1]), y: Number(box[2]), w: Number(box[3]), h: Number(box[4]) };
        rest = rest.slice(0, box.index);
      }
      // A testid is noise next to a real label and eats the description budget (seen live:
      // `button "Acheter" [testid="shell_ufrn_header-NavigationBar-Navigati…` cut mid-id).
      // Keep it only when it is the element's sole identifier.
      if (/^"/.test(rest)) rest = rest.replace(/\s*\[testid="[^"]*"\]/, '');

      // An element with no text at all (icon-only button: `button`, `button [active]`) gives Jev
      // nothing to reason about. Seen live on pap.fr: it clicked such a button four times in a
      // row. Offering it only invites a blind guess — handing back is better.
      const labeled = /"|testid=/.test(rest);
      elements.push({ ref, role, desc: `${role} ${rest}`.trim().slice(0, DESC_MAX_CHARS), nativeSelect: false, rect, labeled });
      continue;
    }
    const last = elements[elements.length - 1];
    if (last && line.startsWith('[option]') && (last.role === 'combobox' || last.role === 'listbox')) {
      last.nativeSelect = true;
    }
  }
  return elements;
}

// Jev takes at most MAX_OPTIONS elements. Cutting in DOM order fails on real sites (seen on
// seloger.com: header menus and carousels used up the budget, the search form on screen was
// dropped, and Jev confidently clicked the only "Acheter" it could see — the wrong one).
// So: what is ON SCREEN first, then what is nearest below, then nearest above — like a
// person would look. The kept elements go back to DOM order so forms read naturally.
export function prioritize(elements, viewport) {
  if (elements.length <= MAX_OPTIONS) return { elements, offscreen: null, dropped: 0 };
  if (!viewport?.h || !elements.some((el) => el.rect)) {
    // Older extension build: no geometry — fall back to DOM order.
    return { elements: elements.slice(0, MAX_OPTIONS), offscreen: null, dropped: elements.length - MAX_OPTIONS };
  }

  const zone = (el) => {
    if (!el.rect) return 1;
    const { y, h, x, w } = el.rect;
    if (y + h > 0 && y < viewport.h && x + w > 0 && x < (viewport.w || Infinity)) return 0; // on screen
    return y >= viewport.h ? 1 : 2; // below, above
  };
  const distance = (el) => (el.rect ? (zone(el) === 2 ? -(el.rect.y + el.rect.h) : el.rect.y) : Infinity);

  const indexed = elements.map((el, i) => ({ el, i, z: zone(el) }));
  const kept = [...indexed].sort((a, b) => a.z - b.z || distance(a.el) - distance(b.el) || a.i - b.i).slice(0, MAX_OPTIONS);
  const keptSet = new Set(kept.map((k) => k.i));
  const dropped = indexed.filter((k) => !keptSet.has(k.i));

  return {
    elements: kept.sort((a, b) => a.i - b.i).map((k) => k.el),
    offscreen: { below: dropped.filter((k) => k.z === 1).length, above: dropped.filter((k) => k.z === 2).length },
    dropped: dropped.length,
  };
}

// The snapshot shows current field values — including type="password" — so once a
// field is filled its value would travel to Jev on the next step. Jev only needs to
// know the field is filled: mask password fields and anything that came from `inputs`.
// Same normalisation as the snapshot's truncate(): collapsed whitespace.
const inputSecrets = (inputs = {}) => Object.values(inputs).map((v) => String(v).replace(/\s+/g, ' ').trim()).filter(Boolean);

function maskSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[filled]');
  return out;
}

export function redactInputValues(tree, inputs = {}) {
  const secrets = inputSecrets(inputs);
  return String(tree || '').split('\n').map((line) => {
    const at = line.indexOf(' value="');
    if (at === -1) return line;
    // Drop the rest of the line: a value containing a quote would defeat any regex.
    // (the trailing [x,y,wxh] box, when present, is geometry — keep it)
    if (line.includes('type="password"')) {
      const box = line.match(/\s\[-?\d+,-?\d+,\d+x\d+\]$/);
      return `${line.slice(0, at)} value="[filled]"${box ? box[0] : ''}`;
    }
    // The trailing box is geometry: a short value ("7") would otherwise be masked inside
    // its digits and hand Jev a broken position.
    const box = line.match(/\s\[-?\d+,-?\d+,\d+x\d+\]$/);
    const text = box ? line.slice(0, box.index) : line;
    let out = maskSecrets(text, secrets) + (box ? box[0] : '');
    // Long values are cut by the snapshot ("abc..."), so also match on prefix.
    return out.replace(/ value="([^"]*?)\.\.\."/, (whole, shown) =>
      (shown && secrets.some((s) => s.startsWith(shown)) ? ' value="[filled]"' : whole));
  }).join('\n');
}

const isFillable = (el) => el.nativeSelect || TEXT_ROLES.has(el.role);

// ─── Choice inputs: radio buttons and checkboxes ───────────────────
// Jev never sees the values, so for {"pizza size": "Medium"} it cannot know which radio is
// meant — and with only "enter the value into its field" on offer, it typed "Medium" into the
// pizza form's Delivery instructions box (p=0.98, seen live on httpbin.org/forms/post). The
// server does know the value: an input whose value is the label of a radio button or checkbox
// on the page is offered to Jev as CHOOSE (tick that option), never as FILL.

const CHOICE_ROLES = new Set(['radio', 'checkbox', 'switch', 'menuitemradio', 'menuitemcheckbox']);
const normalise = (text) => String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const labelOf = (el) => el.desc.match(/"([^"]*)"/)?.[1] ?? '';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The radio buttons and checkboxes whose label is `value` — or, failing that, contains it as a whole phrase. */
export function choiceTargets(elements, value) {
  const wanted = normalise(value);
  if (!wanted) return [];
  const choices = elements.filter((el) => CHOICE_ROLES.has(el.role));
  const exact = choices.filter((el) => normalise(labelOf(el)) === wanted);
  if (exact.length) return exact;
  const phrase = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(wanted)}($|[^\\p{L}\\p{N}])`, 'u');
  return choices.filter((el) => phrase.test(normalise(labelOf(el))));
}

/** Pending input key → the options its value names, for the inputs that are choices on this page. */
export function choiceInputs(elements, pendingInputs, inputs) {
  const found = {};
  for (const key of pendingInputs) {
    const targets = choiceTargets(elements, inputs[key] ?? '');
    if (targets.length) found[key] = targets;
  }
  return found;
}

/** A field's value at the time of the action says nothing true afterwards: keep it out of history. */
const historyDesc = (desc) => desc.replace(/ value="[^"]*"/, '');
const isClickable = (el) => !el.nativeSelect && el.role !== 'iframe' && !TEXT_ONLY_ROLES.has(el.role) && el.labeled !== false;

// ─── Jev request ───────────────────────────────────────────────────
// Operation and every possible target are asked in ONE request (questions are
// evaluated in parallel), so a step costs a single network round trip.

export function buildRequest({ goal, page, elements, pendingInputs, history, offscreen = null, choices = {} }) {
  const clickables = elements.filter(isClickable).slice(0, MAX_OPTIONS);
  const fillables = elements.filter(isFillable).slice(0, MAX_OPTIONS);
  const isChoice = (key) => !!choices[key]?.length;

  const operations = {};
  if (clickables.length) operations.CLICK = 'Click a button, link, tab, checkbox, menu entry or suggestion.';
  pendingInputs.forEach((key, i) => {
    if (isChoice(key)) {
      operations[`CHOOSE_${i + 1}`] = `Select the "${key}" option: tick the radio button or checkbox whose label is that value (see available_inputs).`;
    } else if (fillables.length) {
      operations[`FILL_${i + 1}`] = `Enter the "${key}" value into its field (text field or dropdown). The value is available (see available_inputs).`;
    }
  });
  operations.PRESS_ENTER = 'Press Enter to submit the field that was just filled.';
  // Clicking/filling scrolls to its target by itself, so scrolling only helps to reach what is
  // NOT listed. Saying so matters: on real sites Jev parked ~0.2-0.4 of its probability on the
  // two scroll operations, which pushed the right CLICK under the confidence threshold.
  operations.SCROLL_DOWN = offscreen?.below
    ? `Scroll down: ${offscreen.below} more element(s) exist BELOW the screen and are not listed; the one needed next is probably among them.`
    : 'Scroll down ONLY to make a lazy-loading page load more content. Every listed element can be used without scrolling.';
  operations.SCROLL_UP = offscreen?.above
    ? `Scroll up: ${offscreen.above} more element(s) exist ABOVE the screen and are not listed; the one needed next is probably among them.`
    : 'Scroll up: almost never needed. Every listed element can be used without scrolling.';
  operations.DONE = 'The goal is accomplished; nothing is left to do.';
  // Measured against live Jev on a page with several forms: the previous wording ("a needed
  // value is absent from available_inputs") left BLOCKED at ~0.10-0.20 once every value was
  // typed, because OTHER forms still had empty required fields. This one brings it to ~0.03.
  // The "missing value" clause must point at the state field Jev can actually check.
  const missingValue = pendingInputs.length
    ? 'or the goal needs a value that is NOT listed in available_inputs'
    : 'or the goal needs a typed value although none is available (see inputs_status)';
  operations.BLOCKED = `The goal cannot progress: the page shows a captcha, an error or unexpected content, ${missingValue}. Empty fields of forms the goal does not mention are irrelevant and are NOT a reason to choose this.`;

  const toCriteria = (list) => Object.fromEntries(list.map((el) => [el.ref, el.desc]));
  const questions = {
    operation: { type: 'choice', instructions: { goal, rules: RULES }, criteria: operations },
  };
  // A one-option choice is not a decision — resolve it locally instead of asking.
  if (clickables.length > 1) {
    questions.click_target = {
      type: 'choice',
      instructions: { goal, operation: 'CLICK', rule: 'Pick the element to click next.' },
      criteria: toCriteria(clickables),
    };
  }
  pendingInputs.forEach((key, i) => {
    if (choices[key]?.length > 1) {
      questions[`choose_target_${i + 1}`] = {
        type: 'choice',
        instructions: { goal, operation: 'CHOOSE', rule: `Pick the option that is the "${key}" choice.` },
        criteria: toCriteria(choices[key]),
      };
    }
  });
  const typedInputs = pendingInputs.filter((key) => !isChoice(key));
  if (fillables.length > 1) {
    pendingInputs.forEach((key, i) => {
      if (isChoice(key)) return;
      questions[`fill_target_${i + 1}`] = {
        type: 'choice',
        instructions: { goal, operation: 'FILL', rule: `Pick the field that must receive the "${key}" value.` },
        criteria: toCriteria(fillables),
      };
    });
    // Batching (see decide): Jev already names every field in this one request, so
    // filling them one step at a time re-asks the same questions. It also says which
    // values belong to THIS page — a multi-page goal must not spend a later value early.
    if (typedInputs.length > 1) {
      pendingInputs.forEach((key, i) => {
        if (isChoice(key)) return;
        questions[`fill_now_${i + 1}`] = {
          type: 'noul',
          // Wording measured against live Jev: asking "MUST it be entered now" scored optional
          // fields as low as 0.62; this one gives ≥0.88 for fields of the current form and
          // ≤0.48 for later-page values, so BATCH_MIN_NOW_P = 0.8 separates them cleanly.
          instructions: { goal, rule: `Does the "${key}" value belong in a field of the form being filled on the CURRENT page?` },
          criteria: {
            true: 'Yes: a matching field is visible on this page, in the form the goal is working on right now (required or optional).',
            false: 'No: the value is for a later page or a later part of the goal, or no matching field is on this page.',
          },
        };
      });
    }
  }

  const state = {
    page,
    elements: elements.slice(0, MAX_OPTIONS).map((el) => `${el.ref} ${el.desc}`),
    // Jev must know these values EXIST without seeing them — otherwise it answers BLOCKED.
    // And once all are typed, say so: an empty object reads as "values are missing".
    ...(pendingInputs.length
      ? { available_inputs: Object.fromEntries(pendingInputs.map((key) => [key, isChoice(key)
          ? '<value available, hidden for privacy: it is the label of an option on this page, not ticked yet>'
          : '<value available, hidden for privacy, not typed yet>'])) }
      : { inputs_status: history.some((h) => h.summary.startsWith('FILL '))
          ? 'Every provided value has already been entered. Nothing is left to type.'
          : 'No input values were provided for this task.' }),
    recent_actions: history.slice(-10).map((h) => h.summary),
    ...(offscreen && (offscreen.below || offscreen.above)
      ? { not_listed: { elements_below_the_screen: offscreen.below, elements_above_the_screen: offscreen.above } }
      : {}),
  };

  return { state, questions, clickables, fillables, choices, truncated: elements.length > MAX_OPTIONS };
}

// ─── Jev answers → decision ────────────────────────────────────────

function topCandidates(probabilities, list, n = 3) {
  return Object.entries(probabilities || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([ref, p]) => ({ ref, p, desc: list.find((el) => el.ref === ref)?.desc || '' }));
}

export function decide(answers, { clickables, fillables, pendingInputs, choices = {} }) {
  const op = answers.operation;
  if (!op?.choice) return { stop: 'error', detail: 'Jev returned no operation.' };

  // FILL_1..FILL_n are n equally right answers to "what next?" on a form, so Jev SPLITS
  // its probability between them (seen live: FILL_3 0.30, FILL_1 0.23, ...). The decision
  // that matters is the KIND of operation: judge FILL on the sum, then take its best member.
  const kinds = {};
  let bestFill = null;
  // CHOOSE_k is the same kind of step as FILL_k — entering one of the provided values.
  for (const [name, p] of Object.entries(op.probabilities || {})) {
    const kind = name.startsWith('FILL_') || name.startsWith('CHOOSE_') ? 'FILL' : name;
    kinds[kind] = (kinds[kind] || 0) + p;
    if (kind === 'FILL' && (!bestFill || p > bestFill.p)) bestFill = { name, p };
  }
  const ranked = Object.entries(kinds).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]);
  const ranking = ranked.slice(0, 3).map(([name, p]) => `${name} p=${Number(p.toFixed(2))}`).join(', ');

  // The same split happens one level up: on a search form, "open the type menu" (CLICK) and
  // "type the city" (FILL) are BOTH right, so neither kind reaches 0.5 alone (seen live on
  // seloger.com: CLICK p=0.49 → handed back). What needs confidence is "keep going" versus
  // "stop": act when the action kinds together hold the majority AND the best of them is at
  // least as likely as stopping. Which element is still guarded by MIN_TARGET_P below.
  // Scrolling is NOT pooled with them: wanting to scroll means "I do not see what I need",
  // which is doubt, not progress (live: CLICK 0.31 / BLOCKED 0.31 / SCROLL_UP 0.22 was Jev
  // being lost — pooling the scroll would have made it click blindly). A scroll runs only
  // when it wins on its own.
  const PROGRESS = new Set(['CLICK', 'FILL', 'PRESS_ENTER']);
  const isStop = (kind) => kind === 'DONE' || kind === 'BLOCKED';
  const actions = ranked.filter(([kind]) => PROGRESS.has(kind));
  const stops = ranked.filter(([kind]) => isStop(kind));
  const scrolls = ranked.filter(([kind]) => !PROGRESS.has(kind) && !isStop(kind));
  const actionMass = actions.reduce((n, [, p]) => n + p, 0);
  const [bestAction, bestActionP] = actions[0] || [null, 0];
  const [bestStop, bestStopP] = stops[0] || [null, 0];
  const [bestScroll, bestScrollP] = scrolls[0] || [null, 0];

  let topKind;
  let opP;
  if (bestStop && bestStopP >= MIN_OPERATION_P && bestStopP >= bestActionP) {
    [topKind, opP] = [bestStop, bestStopP];
  } else if (bestAction && actionMass >= MIN_OPERATION_P && bestActionP >= bestStopP) {
    [topKind, opP] = [bestAction, actionMass];
  } else if (bestScroll && bestScrollP >= MIN_OPERATION_P) {
    [topKind, opP] = [bestScroll, bestScrollP];
  } else {
    return { stop: 'uncertain', detail: `Unsure about the next operation: ${ranking}.` };
  }
  opP = Math.min(1, Number(opP.toFixed(2)));
  const choice = topKind === 'FILL' ? bestFill.name : topKind;

  if (choice === 'DONE') return { stop: 'done', p: opP, ranking };
  // Tell the agent how close the call was: "BLOCKED p=0.52, CLICK p=0.44" is worth a manual retry.
  if (choice === 'BLOCKED') return { stop: 'blocked', p: opP, ranking, detail: `Jev's ranking: ${ranking}.` };
  if (choice === 'PRESS_ENTER' || choice === 'SCROLL_DOWN' || choice === 'SCROLL_UP') {
    return { operation: choice, p: opP };
  }

  const chooseMatch = choice.match(/^CHOOSE_(\d+)$/);
  if (chooseMatch) {
    const inputKey = pendingInputs[Number(chooseMatch[1]) - 1];
    const options = choices[inputKey] || [];
    if (!inputKey || !options.length) return { stop: 'error', detail: `Unknown operation "${choice}".` };
    const answer = answers[`choose_target_${chooseMatch[1]}`];
    const targetRef = options.length === 1 ? options[0].ref : answer?.choice;
    const targetP = options.length === 1 ? 1 : (answer?.probabilities?.[targetRef] ?? 0);
    const target = options.find((el) => el.ref === targetRef);
    if (!target || targetP < MIN_TARGET_P) {
      return { stop: 'uncertain', detail: `Unsure which option is the "${inputKey}" choice.`, candidates: topCandidates(answer?.probabilities, options) };
    }
    return { operation: 'CHOOSE', inputKey, target, p: opP, targetP };
  }

  const fillMatch = choice.match(/^FILL_(\d+)$/);
  const candidates = fillMatch ? fillables : clickables;
  const answer = fillMatch ? answers[`fill_target_${fillMatch[1]}`] : answers.click_target;
  const inputKey = fillMatch ? pendingInputs[Number(fillMatch[1]) - 1] : undefined;
  if (choice !== 'CLICK' && !inputKey) return { stop: 'error', detail: `Unknown operation "${choice}".` };

  // Single candidate: the question was not asked (see buildRequest).
  const targetRef = candidates.length === 1 ? candidates[0].ref : answer?.choice;
  const targetP = candidates.length === 1 ? 1 : (answer?.probabilities?.[targetRef] ?? 0);
  const target = candidates.find((el) => el.ref === targetRef);
  if (!target) return { stop: 'error', detail: `Jev picked no valid target for ${choice}.` };

  if (targetP < MIN_TARGET_P) {
    return {
      stop: 'uncertain',
      detail: `Unsure which element to ${fillMatch ? `fill with "${inputKey}"` : 'click'}.`,
      candidates: topCandidates(answer?.probabilities, candidates),
    };
  }

  const decision = { operation: fillMatch ? 'FILL' : 'CLICK', inputKey, target, p: opP, targetP };
  if (fillMatch) decision.batch = batchFills(answers, { fillables, pendingInputs }, decision);
  return decision;
}

// Other pending inputs that can be filled in the SAME step, with no new snapshot or
// Jev call. Stricter than the primary action because nothing re-checks them: Jev must
// say the value belongs on this page, be near-certain of the field, and no two values
// may land on the same field.
function batchFills(answers, { fillables, pendingInputs }, primary) {
  const taken = new Set([primary.target.ref]);
  const batch = [];
  pendingInputs.forEach((key, i) => {
    if (key === primary.inputKey) return;
    const answer = answers[`fill_target_${i + 1}`];
    const targetP = answer?.probabilities?.[answer?.choice] ?? 0;
    const target = fillables.find((el) => el.ref === answer?.choice);
    const fillNow = answers[`fill_now_${i + 1}`]?.noul ?? 0;
    if (!target || taken.has(target.ref) || targetP < BATCH_MIN_TARGET_P || fillNow < BATCH_MIN_NOW_P) return;
    taken.add(target.ref);
    batch.push({ inputKey: key, target, targetP });
  });
  return batch;
}

// ─── Loop ──────────────────────────────────────────────────────────

async function takeSnapshot(browser, tabId) {
  // pointerInteractive: also list cursor:pointer div/li "buttons" (autocomplete suggestions, SPA
  // widgets) — without it Jev cannot see them at all. includeRects + the result's viewport feed
  // prioritize(); textDigest feeds page.text. Older extension builds ignore the unknown options.
  const params = { tabId, interactiveOnly: true, compact: true, format: 'text', includeRects: true, pointerInteractive: true, textDigest: true };
  let result = await browser('snapshot', params).catch(() => null);
  if (!result?.tree) {
    // Usually a navigation in flight — give the page a moment and retry once.
    await delay(SNAPSHOT_RETRY_MS);
    result = await browser('snapshot', params).catch(() => null);
  }
  return result;
}

// deps: { sendCommand, evaluate, saveActionToHistory, setLastRefMap, getRecording }
//   evaluate(state, questions) → { answers, latencyMs }   (API key already bound)
export async function runJevAct(deps, { goal, inputs = {}, maxSteps = DEFAULT_MAX_STEPS, profile, tabId, typing }) {
  const { sendCommand, evaluate, saveActionToHistory, setLastRefMap, getRecording } = deps;
  const startedAt = Date.now();
  const timing = { jevMs: 0, browserMs: 0 };
  const history = [];
  const pendingInputs = Object.keys(inputs);
  const steps = Math.min(Math.max(1, maxSteps), HARD_MAX_STEPS);
  let stepCommands = []; // "fill 702ms", ... for the step log
  let lastFrameId; // live view: the frame the last action left (see lib/live.js)

  const browser = async (command, params) => {
    const t = Date.now();
    try {
      const result = await sendCommand(profile, command, params);
      if (result?.frameId) lastFrameId = result.frameId;
      // An action by ref returns the element's locators: recorded with the step (see record).
      if (result?.target && params?.ref) setLastRefMap({ [String(params.ref).replace('@', '')]: result.target }, false);
      return result;
    }
    finally {
      timing.browserMs += Date.now() - t;
      stepCommands.push(`${command} ${Date.now() - t}`);
    }
  };

  const record = async (command, params, ref) => {
    let screenshotBase64 = null;
    if (getRecording()?.use_vrt) {
      try {
        const snap = await browser('screenshot', { tabId, annotate: false });
        if (snap?.dataUrl) screenshotBase64 = snap.dataUrl;
      } catch (e) {}
    }
    saveActionToHistory(command, params, ref, screenshotBase64);
  };

  const fillField = async (inputKey, target) => {
    const ref = `@${target.ref}`;
    const value = String(inputs[inputKey]);
    if (target.nativeSelect) {
      await browser('select', { ref, value, tabId, matchBy: 'text' });
      await record('select', { value, tabId, matchBy: 'text' }, ref);
    } else {
      // `typing` is a transport choice, not part of the test step — it is not recorded.
      await browser('fill', { ref, value, tabId, clear: true, typing });
      await record('fill', { value, tabId, clear: true }, ref);
    }
    pendingInputs.splice(pendingInputs.indexOf(inputKey), 1);
    return `FILL "${inputKey}" → ${historyDesc(target.desc)}`;
  };

  // Tick the option the input names. Clicking an option that is already ticked would untick
  // a checkbox: then the value is simply in place.
  const chooseOption = async (inputKey, target) => {
    const ref = `@${target.ref}`;
    const already = /\[checked\]/.test(target.desc);
    if (!already) {
      await browser('click', { ref, tabId });
      await record('click', { tabId }, ref);
    }
    pendingInputs.splice(pendingInputs.indexOf(inputKey), 1);
    return `CHOOSE "${inputKey}" → ${historyDesc(target.desc).replace(/ \[(un)?checked\]/, '')}${already ? ' (already ticked)' : ''}`;
  };

  let outcome = { stop: 'max_steps', detail: `Step budget of ${steps} used up.` };
  let page = null;
  let actedSinceLook = false; // an action ran since the last settled look at the page
  let relooked = false;

  for (let i = 0; i < steps; i++) {
    const stepStartedAt = Date.now();
    const browserMsBefore = timing.browserMs;
    stepCommands = [];
    let stepJevMs = 0;
    const snapshot = await takeSnapshot(browser, tabId);
    if (!snapshot?.tree) { outcome = { stop: 'error', detail: 'Snapshot returned no elements.' }; break; }
    if (snapshot.refs) setLastRefMap(snapshot.refs, snapshot.freshRefs);
    // `text` = what the page SAYS (headings, alerts, dialogs) — without it Jev judged DONE /
    // BLOCKED from the URL, title and controls alone, and called a PAP search done too early.
    const digest = (snapshot.digest || []).map((line) => maskSecrets(line, inputSecrets(inputs)));
    page = { url: snapshot.url, title: snapshot.title, ...(digest.length ? { text: digest } : {}) };

    const all = parseElements(redactInputValues(snapshot.tree, inputs), snapshot.refs);
    const { elements, offscreen, dropped } = prioritize(all, snapshot.viewport);
    const choices = choiceInputs(elements, pendingInputs, inputs);
    const request = buildRequest({ goal, page, elements, pendingInputs, history, offscreen, choices });
    request.truncated = dropped > 0;

    let answers;
    try {
      const result = await evaluate(request.state, request.questions);
      answers = result.answers;
      stepJevMs = result.latencyMs || 0;
      timing.jevMs += stepJevMs;
    } catch (err) {
      outcome = { stop: 'error', detail: err.message };
      break;
    }

    const decision = decide(answers, { ...request, pendingInputs });
    // Second look: right after an action the page may still be reacting (autocomplete results
    // from the network, a menu opening). 150ms was enough on a static form, not on real sites:
    // Jev saw no suggestion after typing a city and answered BLOCKED. Costs nothing on the
    // happy path — it only runs when Jev would otherwise give up, once per action.
    if ((decision.stop === 'uncertain' || decision.stop === 'blocked') && actedSinceLook && !relooked) {
      relooked = true;
      log(`[JevAct] Step ${i + 1}: ${decision.stop} right after an action — waiting ${RELOOK_MS}ms and looking again (${decision.ranking || decision.detail || ''})`);
      await delay(RELOOK_MS);
      i--;
      continue;
    }

    if (decision.stop) {
      outcome = { ...decision, truncated: request.truncated };
      log(`[JevAct] Step ${i + 1}: STOP ${decision.stop} — ${decision.ranking || decision.detail || ''} [jev ${stepJevMs}ms, ${elements.length} elements, ${pendingInputs.length} input(s) pending]`);
      break;
    }

    const { operation, target, inputKey } = decision;
    const ref = target ? `@${target.ref}` : null;
    let summary;
    try {
      if (operation === 'CLICK') {
        await browser('click', { ref, tabId });
        await record('click', { tabId }, ref);
        summary = `CLICK ${historyDesc(target.desc)}`;
      } else if (operation === 'FILL') {
        summary = await fillField(inputKey, target);
      } else if (operation === 'CHOOSE') {
        summary = await chooseOption(inputKey, target);
      } else if (operation === 'PRESS_ENTER') {
        await browser('keyboard', { key: 'Enter', tabId });
        await record('keyboard', { key: 'Enter', tabId }, null);
        summary = 'PRESS_ENTER';
      } else {
        await browser('scroll', { direction: operation === 'SCROLL_DOWN' ? 'down' : 'up', amount: SCROLL_AMOUNT_PX, tabId });
        summary = operation;
      }
    } catch (err) {
      outcome = { stop: 'error', detail: `${operation}${target ? ` on ${target.desc}` : ''} failed: ${err.message}` };
      break;
    }

    history.push({ summary, p: Number((decision.targetP ?? decision.p).toFixed(2)), frameId: lastFrameId });
    actedSinceLook = true;
    relooked = false;

    // Same-step batch: the refs are still those of this step's snapshot. A failure here
    // is not fatal — the value stays pending and the next step re-reads the page.
    let batched = 0;
    for (const extra of decision.batch || []) {
      try {
        const summary = `${await fillField(extra.inputKey, extra.target)} (same step)`;
        history.push({ summary, p: extra.targetP, frameId: lastFrameId });
        batched++;
      } catch (err) {
        log(`[JevAct] Step ${i + 1}: batched fill "${extra.inputKey}" failed (${err.message}) — re-reading the page`);
        break;
      }
    }

    const stepBrowserMs = timing.browserMs - browserMsBefore;
    log(`[JevAct] Step ${i + 1}: ${summary}${batched ? ` +${batched} batched fill(s)` : ''} (p=${decision.targetP ?? decision.p}) [${Date.now() - stepStartedAt}ms: jev ${stepJevMs}ms, browser ${stepBrowserMs}ms = ${stepCommands.join(' + ')}]`);

    const recent = history.slice(-REPEAT_LIMIT);
    if (recent.length === REPEAT_LIMIT && recent.every((h) => h.summary === summary)) {
      outcome = { stop: 'stuck', detail: `Repeated "${summary}" ${REPEAT_LIMIT} times without progress.` };
      break;
    }

    await delay(SETTLE_MS);
  }

  return { outcome, history, page, pendingInputs, timing, totalMs: Date.now() - startedAt };
}

// ─── Report for the connected agent ────────────────────────────────

const STOP_LABELS = {
  done: 'DONE',
  blocked: 'BLOCKED — Jev sees no way forward',
  uncertain: 'HANDED BACK — Jev is unsure',
  stuck: 'HANDED BACK — no progress',
  max_steps: 'HANDED BACK — step budget used up',
  error: 'ERROR',
};

export function formatReport({ outcome, history, page, pendingInputs, timing, totalMs, frameId }) {
  const lines = [
    `act: ${STOP_LABELS[outcome.stop] || outcome.stop} after ${history.length} action(s) in ${totalMs}ms (jev ${timing.jevMs}ms, browser ${timing.browserMs}ms)`,
  ];
  history.forEach((h, i) => lines.push(`  ${i + 1}. ${h.summary} (p=${h.p})${h.frameId ? ` [frameId ${h.frameId}]` : ''}`));
  if (outcome.detail) lines.push(`Reason: ${outcome.detail}`);
  if (outcome.candidates?.length) {
    lines.push('Candidates (refs valid until the next snapshot — use click/fill with one of them):');
    outcome.candidates.forEach((c) => lines.push(`  @${c.ref} ${c.desc} (p=${c.p})`));
  }
  if (pendingInputs.length) lines.push(`Inputs not used: ${pendingInputs.join(', ')}`);
  if (outcome.truncated) lines.push(`Note: the page has more than ${MAX_OPTIONS} interactive elements; Jev saw the ${MAX_OPTIONS} nearest to the screen.`);
  if (page) lines.push(`Page: ${page.title} — ${page.url}`);
  if (frameId) lines.push(`frameId: ${frameId}`);
  // What the page SAYS after the last action — lets the agent confirm the outcome
  // (a "Message sent" heading, an error alert) without paying for another snapshot.
  if (page?.text?.length) {
    lines.push('Page says (visible headings / alerts / dialogs):');
    page.text.slice(0, 8).forEach((t) => lines.push(`  ${t}`));
  }
  if (outcome.stop === 'done') {
    lines.push(page?.text?.length
      ? 'Jev judged completion from the URL, title, controls and the lines above — check them against what you expected; snapshot/extract if the proof matters.'
      : 'Jev judges completion from the URL, title and interactive elements only — verify the outcome (snapshot/extract) if it matters.');
  } else {
    lines.push('Continue with snapshot/click/fill, or call act again with a narrower goal.');
  }
  return lines.join('\n');
}
