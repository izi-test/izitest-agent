// A value recorded in a step, turned into a variable of the test.
// Pure: no DB. The add_test_variable tool saves what this returns.
//
// Recording only variabilises what was typed (fill) or picked in a list: a city or a
// budget inside a URL stays literal. As {{name}}, it shows in the dashboard (Data),
// run_test can override it, plain Playwright code reads it from VARS, and the Cucumber
// export makes it a column of a Scenario Outline.

// Used as {{name}}, VARS.name and <name> in a Scenario Outline.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `{ test }` with the variable in place, or `{ error }`. `step` is numbered from 1;
 * `value` is the part of the recorded value to replace (the whole value when omitted).
 */
export function addTestVariable(test, { step, param, value, name, description }) {
  const steps = test.steps || [];
  if (!Number.isInteger(step) || step < 1 || step > steps.length) {
    return { error: `Step ${step} is out of range: test "${test.name}" has ${steps.length} step(s), numbered from 1` };
  }
  if (!VARIABLE_NAME.test(name ?? '')) {
    return { error: `"${name}" is not a usable variable name: letters, digits and _, not starting with a digit` };
  }
  if (test.variables?.[name]) {
    return { error: `Test "${test.name}" already has a variable "${name}"` };
  }

  const recordedStep = steps[step - 1];
  // Assertions keep their data in `assertion`.
  const holder = recordedStep.command === 'assert' ? (recordedStep.assertion || {}) : (recordedStep.params || {});
  const recorded = holder[param];
  if (recorded == null || typeof recorded === 'object') {
    return { error: `Step ${step} (${recordedStep.command}) has no "${param}" value (it has: ${Object.keys(holder).join(', ') || 'nothing'})` };
  }
  const part = value == null ? String(recorded) : String(value);
  if (!part || !String(recorded).includes(part)) {
    return { error: `"${part}" is not in the "${param}" of step ${step} ("${recorded}")` };
  }
  if (/\{\{.*\}\}/.test(part)) {
    return { error: `"${part}" is already a variable` };
  }

  const updated = structuredClone(test);
  const target = recordedStep.command === 'assert' ? updated.steps[step - 1].assertion : updated.steps[step - 1].params;
  target[param] = String(recorded).replace(part, `{{${name}}}`);
  updated.variables = {
    ...(updated.variables || {}),
    [name]: {
      type: 'text',
      defaultValue: part,
      step,
      description: description || recordedStep.intent || `${param} of step ${step}`,
    },
  };
  return { test: updated };
}
