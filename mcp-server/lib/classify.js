// Variable detection helpers: LLM classification and list context detection

import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './logger.js';
import { evaluate, getOpenRouterKey } from './jev.js';
import { itemLabel, isNavigation } from './variable-detection.js';
import { resolveCli } from './agent/cli-spawn.js';

const execFileAsync = promisify(execFile);

const sanitize = (s) => (s || '').replace(/[\x00-\x1f]/g, ' ').substring(0, 150);

// Jev cannot generate free text, so the variable name is picked from a closed
// list. Callers dedupe via uniqueVarName (product, product_2, ...).
const VARIABLE_NAMES = {
  product: 'A product, offer, or item for sale.',
  category: 'A category, filter, tag, or section.',
  search_result: 'An entry in a list of search results.',
  menu_item: 'A navigation menu or dropdown menu entry.',
  article: 'An article, post, news item, or video.',
  user: 'A person, account, contact, or member.',
  row: 'A row in a data table or grid.',
  date: 'A calendar day or time slot.',
  option: 'A generic option among a set of choices.',
  item: 'None of the above — a generic repeated item.',
};

// Fast path: one Jev request answers all three questions in parallel (~100–500ms
// vs. seconds for the CLI subprocess below). Throws on any failure so the caller
// can fall back.
async function classifyWithJev(apiKey, listContext, intent) {
  const { type, itemTexts, selectedText, totalItems } = listContext;

  const state = {
    container_type: type,
    total_items: totalItems,
    clicked_item_text: sanitize(selectedText),
    sample_items: (itemTexts || []).slice(0, 5).map(sanitize),
    ...(intent ? { step_intent: sanitize(intent) } : {}),
  };

  const { answers } = await evaluate(apiKey, state, {
    is_list: {
      type: 'noul',
      instructions: 'A click was recorded on an element inside this container. Is the clicked element one item of a repeated list/collection of similar items?',
      criteria: {
        true: 'The items are similar, interchangeable entries of the same kind (products, search results, menu entries, table rows).',
        false: 'The items are unrelated one-off controls that merely share a parent (toolbar buttons, form actions).',
      },
    },
    selection_mode: {
      type: 'choice',
      instructions: 'When this click is replayed on a different item of the container, how should that item be identified?',
      criteria: {
        by_index: 'By position: item texts change between runs or the user means a rank (first result, third product).',
        by_text: 'By text: items have stable, meaningful labels the user would name (a category, a country, a menu entry).',
      },
    },
    variable_name: {
      type: 'choice',
      instructions: 'What kind of thing is the clicked item?',
      criteria: VARIABLE_NAMES,
    },
  });

  const result = {
    isList: (answers.is_list?.noul ?? 0) >= 0.5,
    variableName: Object.hasOwn(VARIABLE_NAMES, answers.variable_name?.choice ?? '') ? answers.variable_name.choice : 'item',
    selectionMode: answers.selection_mode?.choice === 'by_text' ? 'by_text' : 'by_index',
  };
  log(`Jev classification result: ${JSON.stringify(result)} (P(is_list)=${answers.is_list?.noul})`);
  return result;
}

export async function classifyWithLLM(listContext, intent) {
  const { type, itemTexts, selectedText, totalItems } = listContext;

  const apiKey = await getOpenRouterKey();
  if (apiKey) {
    try {
      return await classifyWithJev(apiKey, listContext, intent);
    } catch (err) {
      log(`Jev classification failed (falling back to CLI): ${err.message}`);
    }
  }

  const prompt = [
    `You are analyzing a web page element for browser automation.`,
    `An element was clicked that appears to be part of a "${type}" (detected via DOM structure analysis).`,
    `The container has ${totalItems} similar items.`,
    `The clicked item text: "${sanitize(selectedText)}"`,
    `Sample items from the container (first 5):`,
    ...(itemTexts || []).slice(0, 5).map((t, i) => `  ${i + 1}. "${sanitize(t)}"`),
    intent ? `User intent for this step: "${sanitize(intent)}"` : '',
    ``,
    `Determine:`,
    `1. Is this truly a repeated list/collection of similar items? (true/false)`,
    `2. A short snake_case variable name for this selection (e.g. "product", "category", "search_result", "menu_item")`,
    `3. Should the item be selected by_index (position) or by_text (text content match)?`,
    ``,
    `Reply ONLY with a JSON object, no markdown, no explanation:`,
    `{"is_list": true, "variable_name": "product", "selection_mode": "by_index"}`
  ].filter(Boolean).join('\n');

  try {
    // On Windows, what the .cmd of a CLI installed with npm starts (lib/agent/cli-spawn.js).
    const cli = resolveCli('copilot');
    const { stdout } = await execFileAsync(cli.command, [...cli.args, '--model', 'gpt-4.1', '-p', prompt], {
      timeout: 30000,
      encoding: 'utf-8',
      windowsHide: true
    });

    const jsonMatch = stdout.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      log(`LLM classification result: ${JSON.stringify(parsed)}`);
      return {
        isList: parsed.is_list === true,
        variableName: parsed.variable_name || 'item',
        selectionMode: parsed.selection_mode === 'by_text' ? 'by_text' : 'by_index'
      };
    }
  } catch (err) {
    log(`LLM classification failed (falling back to heuristic): ${err.message}`);
  }

  return classifyHeuristically(listContext);
}

/**
 * The verdict without an LLM. "More than two similar items" made a list of every click:
 * a form's submit button among its neighbours, a row of unlabelled toggles. Those became
 * variables picked by position, which replay then resolved by position in the page.
 */
export function classifyHeuristically({ type, itemTexts = [], selectedText = '', totalItems = 0, itemXpath = '' }) {
  const variableName = type === 'box' ? 'item' : 'option';
  const notAList = { isList: false, variableName, selectionMode: 'by_index' };
  const label = itemLabel(selectedText);
  const texts = itemTexts.map(itemLabel).filter(Boolean);

  // Two items are a pair of controls, not a choice among many.
  if (totalItems < 3) return notAList;
  // An item with no text of its own (a bare toggle, an icon) can only be found again by
  // position, which breaks as soon as the page changes.
  if (!label) return notAList;
  // Buttons side by side with their own labels are separate actions (Sign in / Clear,
  // Save / Discard / Delete). The same button repeated per item ("Add to cart") is a list.
  const itemTag = /(?:^|\/)([a-z][\w-]*)(?:\[[^\]]*\])*$/i.exec(itemXpath)?.[1]?.toLowerCase();
  if (itemTag === 'button' && texts.filter((t) => t === label).length < 2) return notAList;

  // Items with labels of their own are found again by text, whatever their order.
  const labelled = texts.length >= 2 && new Set(texts).size === texts.length;
  return { isList: true, variableName, selectionMode: labelled ? 'by_text' : 'by_index' };
}

/**
 * The list the element `selector` (or of text `text`) is an item of, as the page says: null when
 * it is in none, undefined when it could not be told (no element, no answer).
 */
export async function detectListContext(sendCommand, { selector, text, tabId, profile }) {
  try {
    const params = {};
    if (selector) params.selector = selector;
    if (text) params.text = text;
    if (tabId) params.tabId = tabId;
    const result = await sendCommand(profile, 'detect_list_context', params, 10000);
    // What the item picked reads, and its neighbours: the name of what was picked is what it
    // alone reads — read over before saving (recording-review.js), a later step naming it is told.
    if (result && typeof result === 'object' && result.parentSelector) {
      const texts = await itemTexts(sendCommand, result, { tabId, profile });
      if (texts) Object.assign(result, texts);
    }
    return result ?? null;
  } catch (err) {
    log(`detect_list_context failed: ${err.message}`);
    return undefined;
  }
}

// An item that reads little ("Ajouter", an icon) is read with the card it is in.
const ITEM_CARD = 'article, li, [role="listitem"], [class*="card"], [class*="product"], [class*="tile"]';

/**
 * The text of the item a list click picked, and of a few others: `{ pickedText, otherTexts }`,
 * with what the element clicked is called in each — `pickedLabel`, `otherLabels` ("Ajouter le
 * produit : Lait demi-écrémé UHT à une liste", the same button of the other cards) —, or null.
 */
async function itemTexts(sendCommand, context, { tabId, profile }) {
  const code = `(() => {
    const ctx = ${JSON.stringify({ type: context.type, parentSelector: context.parentSelector, itemXpath: context.itemXpath, withinXpath: context.withinXpath ?? '', selectedIndex: context.selectedIndex ?? 0 })};
    const text = (node) => (node?.innerText ?? '').replace(/\\s+/g, ' ').trim();
    // The card it is in — the article, the list item —, else up the elements styled as one while
    // it reads little (a button "Afficher le prix" in a block "En drive ou livraison").
    const read = (el) => {
      const card = el?.closest('article, li, [role="listitem"]') ?? null;
      let node = card ?? el;
      while (!card && node && text(node).length < 40) node = node.parentElement?.closest(${JSON.stringify(ITEM_CARD)}) ?? null;
      return (text(node) || text(el)).slice(0, 300);
    };
    const at = (xpath, node) => xpath ? document.evaluate(xpath, node, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue : node;
    // What the element is called, and where it says so: the attribute a capture reads it from again.
    const FROM = ['aria-label', 'title', 'alt'];
    const fromOf = (el) => FROM.find((a) => el?.getAttribute(a)?.trim()) ?? 'text';
    const label = (el) => el ? (fromOf(el) === 'text' ? text(el) : el.getAttribute(fromOf(el))).replace(/\\s+/g, ' ').trim().slice(0, 150) : '';
    const parent = document.querySelector(ctx.parentSelector);
    if (!parent) return null;
    // A box: the parent is its first item, the items its siblings of its tag, the element clicked
    // at itemXpath in each. A list: its items at itemXpath, the element clicked at withinXpath.
    let items;
    let clicked;
    if (ctx.type === 'box') {
      items = [...(parent.parentElement?.children ?? [parent])].filter((el) => el.tagName === parent.tagName);
      clicked = (item) => at(ctx.itemXpath, item);
    } else {
      const found = document.evaluate(ctx.itemXpath, parent, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      items = Array.from({ length: found.snapshotLength }, (_, i) => found.snapshotItem(i));
      clicked = (item) => at(ctx.withinXpath, item);
    }
    const picked = items[ctx.selectedIndex] ?? null;
    const others = items.filter((_, i) => i !== ctx.selectedIndex).slice(0, 5);
    return {
      pickedText: read(picked), otherTexts: others.map(read).filter(Boolean),
      pickedLabel: label(picked && clicked(picked)), pickedLabelFrom: fromOf(picked && clicked(picked)),
      otherLabels: others.map((item) => label(clicked(item))).filter(Boolean),
    };
  })()`;
  try {
    const answer = await sendCommand(profile, 'execute_js', { code, ...(tabId ? { tabId } : {}) }, 5000);
    // What the script returned, as the browser answers it (execute_js: the value itself).
    const value = answer?.result !== undefined ? answer.result : answer;
    if (!value || typeof value.pickedText !== 'string') return null;
    const strings = (list) => (Array.isArray(list) ? list.filter((t) => typeof t === 'string') : []);
    return {
      pickedText: value.pickedText, otherTexts: strings(value.otherTexts),
      ...(typeof value.pickedLabel === 'string' && value.pickedLabel
        ? { pickedLabel: value.pickedLabel, pickedLabelFrom: typeof value.pickedLabelFrom === 'string' ? value.pickedLabelFrom : 'text', otherLabels: strings(value.otherLabels) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a click recorded in a list (`listContext`) becomes a variable, and how: what the agent
 * said with record_step(pick) — by its place, by its text —, else what the classifier says, a
 * menu or a tab bar never one. The classification ({ isList, variableName, selectionMode }), or
 * null when it stays a click on its element. pick "none" never comes here (the step's value is
 * kept fixed).
 */
export async function judgeListClick(listContext, step, { afterTyping = false } = {}) {
  if (!listContext) return null;
  const pick = step._pick;
  if (!pick && isNavigation(listContext, null, { afterTyping })) return null;
  const classified = await classifyWithLLM(listContext, step.intent);
  if (pick === 'by_place' || pick === 'by_text') {
    return { ...classified, isList: true, selectionMode: pick === 'by_text' ? 'by_text' : 'by_index' };
  }
  return classified.isList && !isNavigation(listContext, classified, { afterTyping }) ? classified : null;
}
