// A value recorded in a step, turned into a variable of the test.
// Pure: no DB. The add_test_variable tool saves what this returns.
//
// Recording only variabilises what was typed (fill) or picked in a list: a city or a
// budget inside a URL stays literal. As {{name}}, it shows in the dashboard (Data),
// run_test can override it, plain Playwright code reads it from VARS, and the Cucumber
// export makes it a column of a Scenario Outline.

// Used as {{name}}, VARS.name and <name> in a Scenario Outline.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Values an assertion may check that a replay changes: what was typed (text) or chosen in
// a <select>. A list variable's value is an index, or a label the page shows otherwise.
const LINKABLE_TYPES = new Set(['text', 'select']);
// "on", "1", "fr" turn up by chance in any text: not worth a link.
const MIN_LINKED_LENGTH = 3;

/**
 * The assertion with the values typed in the test it checks replaced by their {{variable}}:
 * checking "jane.doe@example.com" typed in step 2, it then checks whatever e-mail a replay
 * types, in run_test, VARS and a Scenario Outline alike. `{ assertion, linked }`.
 */
export function linkAssertionToVariables(assertion, variables = {}) {
  if (typeof assertion.expected !== 'string') return { assertion, linked: [] };
  const candidates = Object.entries(variables)
    .filter(([, v]) => LINKABLE_TYPES.has(v?.type) && String(v.defaultValue ?? '').length >= MIN_LINKED_LENGTH)
    // Longest first: "jane.doe@example.com" before a "jane" it contains.
    .sort(([, a], [, b]) => String(b.defaultValue).length - String(a.defaultValue).length);

  let expected = assertion.expected;
  const linked = [];
  for (const [name, variable] of candidates) {
    const value = String(variable.defaultValue);
    // Never inside a {{placeholder}} put in for a longer value.
    const parts = expected.split(/(\{\{[^}]*\}\})/);
    if (!parts.some((part, i) => i % 2 === 0 && part.includes(value))) continue;
    expected = parts.map((part, i) => (i % 2 === 0 ? part.replaceAll(value, `{{${name}}}`) : part)).join('');
    linked.push(name);
  }
  return { assertion: linked.length ? { ...assertion, expected } : assertion, linked };
}

/**
 * `{ test, reused }` with the variable in place, or `{ error }`. `step` is numbered from 1;
 * `value` is the part of the recorded value to replace (the whole value when omitted).
 * A name the test already has reuses that variable — an assertion checking the e-mail a
 * fill step typed — provided the value is that variable's default.
 */
export function addTestVariable(test, { step, param, value, name, description }) {
  const steps = test.steps || [];
  if (!Number.isInteger(step) || step < 1 || step > steps.length) {
    return { error: `Step ${step} is out of range: test "${test.name}" has ${steps.length} step(s), numbered from 1` };
  }
  if (!VARIABLE_NAME.test(name ?? '')) {
    return { error: `"${name}" is not a usable variable name: letters, digits and _, not starting with a digit` };
  }
  const existing = test.variables?.[name];
  if (existing && value != null && String(value) !== String(existing.defaultValue)) {
    return {
      error: `{{${name}}} already stands for "${existing.defaultValue}": to use it here, give that value or none. ` +
        'A different value needs a variable of its own.',
    };
  }

  const recordedStep = steps[step - 1];
  // Assertions keep their data in `assertion`.
  const holder = recordedStep.command === 'assert' ? (recordedStep.assertion || {}) : (recordedStep.params || {});
  const recorded = holder[param];
  if (recorded == null || typeof recorded === 'object') {
    return { error: `Step ${step} (${recordedStep.command}) has no "${param}" value (it has: ${Object.keys(holder).join(', ') || 'nothing'})` };
  }
  const part = String(value ?? (existing ? existing.defaultValue : recorded));
  if (!part || !String(recorded).includes(part)) {
    return { error: `"${part}" is not in the "${param}" of step ${step} ("${recorded}")` };
  }
  if (/\{\{.*\}\}/.test(part)) {
    return { error: `"${part}" is already a variable` };
  }

  const updated = structuredClone(test);
  const target = recordedStep.command === 'assert' ? updated.steps[step - 1].assertion : updated.steps[step - 1].params;
  target[param] = String(recorded).replace(part, `{{${name}}}`);
  if (!existing) {
    updated.variables = {
      ...(updated.variables || {}),
      [name]: {
        type: 'text',
        defaultValue: part,
        step,
        description: description || recordedStep.intent || `${param} of step ${step}`,
      },
    };
  }
  return { test: updated, reused: !!existing };
}
