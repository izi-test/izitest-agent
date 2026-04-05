// Variable detection helpers: LLM classification and list context detection

import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

export async function classifyWithLLM(listContext, intent) {
  const { type, itemTexts, selectedText, totalItems } = listContext;

  const sanitize = (s) => (s || '').replace(/[\x00-\x1f]/g, ' ').substring(0, 150);

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
