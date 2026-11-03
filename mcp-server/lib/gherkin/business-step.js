// A business step built from steps a test actually recorded: the composite step
// definition behind a phrase like "When I keep only houses with a garden".
// Pure: no DB. The create_business_step tool stores what this returns.
//
// The sub-steps are the recorded ones, params and locators included. So the Cucumber
// export of that test (and of any test with the same steps) collapses them into the
// phrase, and the generated step definition can pick stable locators the way plain
// Playwright code does.

const PATTERN_PARAMETER = /\{(string|int|float|word)\}/g;

// Where a step ran and what it left behind, not what it does: navigate always records its
// tab, a recording with VRT the path of its baseline screenshot. Kept in the template,
// they would make the business step match only the test it was built from.
const RUNTIME_PARAMS = ['tabId', 'baselinePath'];

const VARIABLE = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

function replaceDeep(value, search, replacement) {
  if (typeof value === 'string') return value.replaceAll(search, replacement);
  if (Array.isArray(value)) return value.map(v => replaceDeep(v, search, replacement));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, search, replacement)]));
  }
  return value;
}

function variablesIn(value, found = new Set()) {
  if (typeof value === 'string') for (const [, name] of value.matchAll(VARIABLE)) found.add(name);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) variablesIn(v, found);
  return found;
}

/**
 * `{ steps_template }`, or `{ error }`. Steps are numbered from 1, both ends included.
 * Each entry of `args` maps a parameter of the pattern, in order, to a recorded value:
 * `{ step, param }` takes the whole value of `param` in that step, `{ step, param, value }`
 * only that part of it (a city inside a URL), `{ variable }` a variable of the test.
 */
export function buildBusinessStep(test, { from_step, to_step, pattern, args = [] }) {
  const steps = test.steps || [];
  if (!Number.isInteger(from_step) || !Number.isInteger(to_step) || from_step < 1 || to_step > steps.length || from_step > to_step) {
    return { error: `Steps ${from_step}–${to_step} are out of range: test "${test.name}" has ${steps.length} step(s), numbered from 1` };
  }

  const parameterCount = (String(pattern).match(PATTERN_PARAMETER) || []).length;
  if (parameterCount !== args.length) {
    return { error: `The pattern has ${parameterCount} parameter(s) ({string}, {int}…) but ${args.length} arg(s) were given: one per parameter, in order` };
  }

  const steps_template = steps.slice(from_step - 1, to_step).map(step => {
    // Assertions keep their data in `assertion`; parsing a composite puts it back there.
    const params = structuredClone(step.command === 'assert' ? (step.assertion || step.params || {}) : (step.params || {}));
    for (const key of RUNTIME_PARAMS) delete params[key];
    return {
      command: step.command,
      params,
      ...(step.locators?.length && { locators: structuredClone(step.locators) }),
      // The page it was recorded on: with it, the sub-step is known by its element (elements.js).
      ...(step.page && { page: step.page }),
    };
  });

  for (const [i, arg] of args.entries()) {
    // A variable of the test ({{ville}}) becomes this parameter wherever the steps use it.
    if (arg?.variable != null) {
      const placeholder = `{{${arg.variable}}}`;
      const users = steps_template.filter(tpl => variablesIn(tpl.params).has(arg.variable));
      if (!users.length) {
        return { error: `Arg ${i + 1}: none of the grouped steps (${from_step}–${to_step}) uses {{${arg.variable}}}` };
      }
      for (const tpl of users) {
        tpl.params = replaceDeep(tpl.params, placeholder, `{${i}}`);
        if (String(tpl.params.selector ?? '').includes(`{${i}}`)) delete tpl.locators;
      }
      continue;
    }

    const { step, param, value } = arg || {};
    if (!Number.isInteger(step) || step < from_step || step > to_step) {
      return { error: `Arg ${i + 1}: step ${step} is not one of the grouped steps (${from_step}–${to_step})` };
    }
    const tpl = steps_template[step - from_step];
    const recorded = tpl.params[param];
    if (recorded == null) {
      return { error: `Arg ${i + 1}: step ${step} (${tpl.command}) has no "${param}" (it has: ${Object.keys(tpl.params).join(', ') || 'nothing'})` };
    }
    if (value != null && !String(recorded).includes(String(value))) {
      return { error: `Arg ${i + 1}: "${value}" is not in the "${param}" of step ${step} ("${recorded}")` };
    }
    tpl.params[param] = value == null ? `{${i}}` : String(recorded).replace(String(value), `{${i}}`);
    // The locators describe the element recorded with one value: a parameterised selector
    // points at another one each time.
    if (param === 'selector') delete tpl.locators;
  }

  // A variable left in a sub-step would be typed as "{{name}}" by the generated code.
  const unmapped = new Set();
  for (const tpl of steps_template) variablesIn(tpl.params, unmapped);
  if (unmapped.size) {
    const names = [...unmapped];
    return {
      error: `The grouped steps use ${names.map(n => `{{${n}}}`).join(', ')}: give the phrase a parameter for ` +
        `each and map it with ${names.map(n => `{ "variable": "${n}" }`).join(', ')}`,
    };
  }

  return { steps_template };
}
