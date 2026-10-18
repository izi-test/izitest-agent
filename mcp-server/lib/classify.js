// Variable detection helpers: LLM classification and list context detection

import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './logger.js';
import { evaluate, getOpenRouterKey } from './jev.js';

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
    const { stdout } = await execFileAsync('copilot', ['--model', 'gpt-4.1', '-p', prompt], {
      timeout: 30000,
      encoding: 'utf-8'
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

  return {
    isList: totalItems > 2,
    variableName: type === 'box' ? 'item' : 'option',
    selectionMode: 'by_index'
  };
}

export async function detectListContext(sendCommand, { selector, text, tabId }) {
  try {
    const params = {};
    if (selector) params.selector = selector;
    if (text) params.text = text;
    if (tabId) params.tabId = tabId;
    const result = await sendCommand(undefined, 'detect_list_context', params, 10000);
    return result;
  } catch (err) {
    log(`detect_list_context failed: ${err.message}`);
    return null;
  }
}
