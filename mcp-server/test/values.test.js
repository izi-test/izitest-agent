// Unit tests for computed values (lib/values.js): dates relative to the day, values unique to a
// run, calculations, in a variable or in a step, worked out once per run — what is typed is what
// is checked. A run with one that does not work out stops before the browser, told. The code
// exported for the test computes them the same way, with the very same file. The extension is a
// stand-in. On a database of their own, thrown away after.
// Run with: node --test test/values.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'values-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { resolveValues, computeVariables, valueContext, hasExpression } = await import('../lib/values.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { executeTest } = await import('../lib/test-execute.js');
const { addTestVariable } = await import('../lib/test-variable.js');
const { generateTestCode } = await import('../lib/codegen/index.js');
const { defaultStepDefinitions } = await import('../lib/gherkin/default-step-definitions.js');

// Saturday 31 January 2026, 14:05:09.
const NOW = new Date(2026, 0, 31, 14, 5, 9);
const at = (text, { language = 'en', variables = {} } = {}) =>
  resolveValues(text, valueContext({ now: NOW, language, lookup: (name) => variables[name] }));

test('dates relative to the day, moved by durations, written as asked, in the language of the tests', () => {
  assert.equal(at('{{today}}').text, '2026-01-31');
  assert.equal(at('{{tomorrow}} {{yesterday}}').text, '2026-02-01 2026-01-30');
  assert.equal(at('{{today + 3 days | dd/MM/yyyy}}').text, '03/02/2026');
  assert.equal(at('{{today + 1 month}}').text, '2026-02-28', 'the last day of a shorter month');
  assert.equal(at('{{today - 2 weeks + 1 year}}').text, '2027-01-17');
  assert.equal(at('{{now + 30 minutes | HH:mm}}').text, '14:35');
  assert.equal(at('{{now}}').text, '2026-01-31 14:05');
  assert.equal(at("{{today | EEEE d MMMM yyyy 'à' HH'h'}}", { language: 'fr' }).text, 'samedi 31 janvier 2026 à 00h');
  assert.equal(at('{{today | EEE, MMM d}}').text, 'Sat, Jan 31');
  assert.equal(at('{{today + 2 jours | d/M}}').text, '2/2', 'durations in French too');
  assert.equal(at('{{(today + 1 year) - today}}').text, '365', 'two dates: days between');
});

test('values unique to a run, the same everywhere in it; random numbers in their range', () => {
  const run = valueContext();
  const first = resolveValues('user-{{unique}}@example.com', run).text;
  assert.match(first, /^user-[a-z0-9]{6,}@example\.com$/);
  assert.equal(resolveValues('{{unique}}', run).text, first.slice(5, -12), 'the same token all through the run');
  assert.notEqual(resolveValues('{{unique}}', valueContext()).text, resolveValues('{{unique}}', valueContext()).text);
  assert.match(resolveValues('{{uuid}}', run).text, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (let i = 0; i < 50; i += 1) {
    const n = Number(resolveValues('{{random(1, 3)}}', valueContext()).text);
    assert.ok(n >= 1 && n <= 3 && Number.isInteger(n), String(n));
  }
});

test('calculations, with the variables of the test; numbers written as asked', () => {
  const variables = { price: '12.5', quantity: '3', delay: '2' };
  assert.equal(at('{{price * quantity}}', { variables }).text, '37.5');
  assert.equal(at('{{round(price * 1.2, 1)}}', { variables }).text, '15');
  assert.equal(at('{{price * 1.2 | 0.00}} € / {{price * 1.2 | 0,00}}', { variables }).text, '15.00 € / 15,00');
  assert.equal(at('{{0.1 + 0.2}}').text, '0.3');
  assert.equal(at('{{today + delay days}}', { variables }).text, '2026-02-02', 'a variable as a number of days');
  assert.equal(at('{{max(price, 20) - min(1, quantity)}}', { variables }).text, '19');
  assert.equal(at('Total: {{price}} €', { variables }).text, 'Total: 12.5 €', 'a {{name}} is its value, as before');
});

test('what does not work out is told and left as it is; a {{name}} nothing has is left alone', () => {
  assert.deepEqual(at('{{name}} and {{todya}}'), { text: '{{name}} and {{todya}}', problems: [] });
  const wrong = at('{{today * 2}} {{random(5, 1)}} {{price + }} {{foo(1)}}');
  assert.equal(wrong.text, '{{today * 2}} {{random(5, 1)}} {{price + }} {{foo(1)}}');
  assert.equal(wrong.problems.length, 4);
  assert.match(wrong.problems[0], /a date takes \+ or - a duration/);
  assert.match(wrong.problems[3], /no function "foo"/);
  assert.equal(at('{{today}}', { variables: { today: 'mine' } }).text, 'mine', "a variable of the test comes first");
  assert.equal(hasExpression('{{name}}'), false);
  assert.equal(hasExpression('on {{today}}'), true);
});

test('variables using variables are worked out in order; one using itself is told', () => {
  const { values, problems } = computeVariables({ total: '{{price * quantity}}', price: '{{base + 1}}', base: '9', quantity: '2', loop: '{{loop}}!' }, { now: NOW });
  assert.deepEqual([values.total, values.price, values.base], ['20', '10', '9']);
  assert.deepEqual(problems, ['{{loop}} uses itself']);
});

/** The extension, stood in for: the steps it was asked to replay, and a page that says the date typed. */
function extension() {
  const replayed = [];
  const sendCommand = async (_profile, command, params) => {
    if (command === 'replay_sequence') {
      replayed.push(...params.steps);
      return { results: params.steps.map((s, i) => ({ step: i + 1, command: s.command, status: 'success', tabId: 7 })) };
    }
    if (command === 'execute_js') {
      const typed = replayed.find((s) => s.params?.selector === '#date')?.params.value;
      return { result: { value: `Delivered on ${typed}`, pageUrl: 'https://shop.test/order' } };
    }
    return {};
  };
  return { sendCommand, replayed };
}

test('a run works the values out once: the date typed is the one checked, the run records them', async () => {
  saveTest({
    name: 'delivery', variables: { date: { type: 'text', defaultValue: '{{today + 3 days | dd/MM/yyyy}}' }, email: { type: 'text', defaultValue: 'u-{{unique}}@x.dev' } },
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test/order?ref={{unique}}' } },
      { command: 'fill', params: { selector: '#date', value: '{{date}}' } },
      { command: 'fill', params: { selector: '#email', value: '{{email}}' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#summary', expected: 'Delivered on {{date}}' } },
    ],
  });
  const { sendCommand, replayed } = extension();
  const result = await executeTest('delivery', {}, null, null, false, sendCommand, 'test');
  assert.equal(result.assertionsPassed, 1);
  const date = replayed[1].params.value;
  assert.match(date, /^\d{2}\/\d{2}\/\d{4}$/);
  const token = /ref=(\w+)/.exec(replayed[0].params.url)[1];
  assert.equal(replayed[2].params.value, `u-${token}@x.dev`, '{{unique}} is the same in the URL and the e-mail');
  assert.equal(result.values.date, date, 'the run keeps what it computed');

  const overridden = await executeTest('delivery', { date: '{{today | yyyy}}' }, null, null, false, extension().sendCommand, 'test');
  assert.match(overridden.values.date, /^\d{4}$/, 'a value given to the run may be computed too');
});

test('a run with a value that does not work out stops before the browser, saying which', async () => {
  saveTest({ name: 'broken', variables: { when: { type: 'text', defaultValue: '{{today + 3 dayz}}' } }, steps: [{ command: 'fill', params: { selector: '#d', value: '{{when}}' } }] });
  const { sendCommand, replayed } = extension();
  await assert.rejects(executeTest('broken', {}, null, null, false, sendCommand, 'test'), /Computed values that do not work out[\s\S]*\{\{when\}\} — \{\{today \+ 3 dayz\}\}: unexpected "dayz"/);
  assert.equal(replayed.length, 0);
});

test('a recorded value becomes a variable computed at each run', () => {
  saveTest({ name: 'planning', variables: {}, steps: [{ command: 'navigate', params: { url: 'https://shop.test/day/2026-01-31' } }] });
  const { test: updated } = addTestVariable(loadTest('planning'), { step: 1, param: 'url', value: '2026-01-31', name: 'day', defaultValue: '{{today}}' });
  assert.equal(updated.steps[0].params.url, 'https://shop.test/day/{{day}}');
  assert.equal(updated.variables.day.defaultValue, '{{today}}', 'not the date recorded');
});

test('the exported code computes the values with the very same file', () => {
  const t = {
    name: 'delivery', language: 'fr', project_id: 1,
    variables: { date: { defaultValue: '{{today + 3 days | dd/MM/yyyy}}' } },
    steps: [
      { command: 'fill', params: { selector: '#date', value: '{{date}}' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', selector: '#s', expected: 'Le {{today | d MMMM}}' } },
    ],
  };
  const plain = generateTestCode(t, 'playwright-plain').files;
  assert.deepEqual(plain.map((f) => f.path), ['tests/delivery.spec.js', 'tests/izitest-values.js']);
  assert.match(plain[0].content, /import \{ computeVariables, resolveValues \} from '\.\/izitest-values\.js';/);
  assert.match(plain[0].content, /computeVariables\(\{\n {2}date: '\{\{today \+ 3 days \| dd\/MM\/yyyy\}\}',\n\}, \{ language: 'fr' \}\)/);
  assert.match(plain[0].content, /toContainText\(value\('Le \{\{today \| d MMMM\}\}'\)\)/);
  assert.match(plain[1].content, /export function computeVariables/);

  const definitions = defaultStepDefinitions('fr').map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
  const cucumber = generateTestCode(t, 'playwright-cucumber', () => definitions).files;
  const file = (path) => cucumber.find((f) => f.path === path)?.content;
  assert.ok(file('features/support/values.js'));
  assert.match(file('features/support/world.js'), /this\.run = valueContext\(\{ language: 'fr' \}\);/);
  assert.match(file('features/steps/default.steps.js'), /async function \(selector, value\) \{\n {2}\[selector, value\] = this\.values\(selector, value\);/);
  assert.match(file('features/delivery.feature'), /\| \{\{today \+ 3 days \\\| dd\/MM\/yyyy\}\} \|/, 'the | of the format escaped in its cell');

  const simple = generateTestCode({ ...t, variables: {}, steps: [{ command: 'fill', params: { selector: '#a', value: 'b' } }] }, 'playwright-cucumber', () => definitions).files;
  assert.equal(simple.some((f) => f.path.endsWith('values.js')), false, 'nothing computed, nothing carried');
});
