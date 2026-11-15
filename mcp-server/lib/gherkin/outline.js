// A test with rows — those of the dataset it is bound to, or its own (lib/datasets.js
// rowsOfTest) — reads as a Scenario Outline in the Gherkin IziTest shows and edits: its
// variables <name> in the steps, an Examples row per row it plays. With one row or none, a
// Scenario, its variables {{name}}. Saving that Gherkin reads the Examples back as the test's
// rows, and <name> as {{name}} in its steps (parse.js featurePhrases, examplesOf).
//
// Not the Cucumber export's outline (codegen/playwright-cucumber.js toScenarioOutline): that
// one escapes a quote in a cell for Cucumber, which puts the value in before it reads a
// {string}; IziTest reads <name> back as {{name}}, a cell holds the value as it is.

import { keywordsOf } from './language.js';
import { shownValue } from '../datasets.js';

/** What a cell of a column holding a password shows instead of its value; saved, the value stays. */
export const HIDDEN_CELL = '(hidden)';

/** A value as a cell of a Gherkin table: | and \ escaped, a line break as \n. */
const cell = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');

/**
 * `feature` (serialize.js: a Scenario, its variables {{name}}) as the Gherkin of a test that
 * plays `rows`. With two rows or more, a Scenario Outline: <name> in its steps, and Examples
 * with a column per variable the steps use or the rows give a value to, a line per row — a
 * value a row has not is the variable's default (`variables`), a password's is hidden
 * (HIDDEN_CELL), a secret is its {{secret.NAME}}. With one row or none, `feature` as it is.
 */
export function withExamples(feature, { rows, variables = {}, language } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return feature;
  const words = keywordsOf(language);
  const fromRows = [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))];
  const known = new Set([...Object.keys(variables ?? {}), ...fromRows]);
  // The steps only: what comes after the Scenario line.
  const head = new RegExp(`^(\\s*)${words.scenario}:.*$`, 'm').exec(feature);
  if (!head) return feature;
  const start = head.index + head[0].length;
  const used = [];
  const steps = feature.slice(start).replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (whole, name) => {
    if (!known.has(name)) return whole;
    if (!used.includes(name)) used.push(name);
    return `<${name}>`;
  });
  const columns = [...used, ...fromRows.filter((name) => !used.includes(name))];
  if (!columns.length) return feature;
  const value = (row, name) => shownValue(name, row?.[name] ?? variables?.[name]?.defaultValue ?? '');
  return feature.slice(0, head.index) + head[0].replace(`${words.scenario}:`, `${words.outline}:`) + steps.trimEnd() + '\n\n' +
    `    ${words.examples}:\n` +
    `      | ${columns.join(' | ')} |\n` +
    rows.map((row) => `      | ${columns.map((name) => cell(value(row, name))).join(' | ')} |\n`).join('');
}

/**
 * The rows read from the Examples of an edited Gherkin, as the test saves them: a cell left
 * hidden (a password) keeps the value the row at that place has now (`current`) — none, the
 * variable's default it showed.
 */
export function rowsFromExamples(examples, current = []) {
  return examples.rows.map((row, i) => Object.fromEntries(Object.entries(row).flatMap(([column, value]) => {
    if (value !== HIDDEN_CELL) return [[column, value]];
    return current[i] && column in current[i] ? [[column, String(current[i][column] ?? '')]] : [];
  })));
}
