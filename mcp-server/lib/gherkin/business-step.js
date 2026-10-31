// A business step built from steps a test actually recorded: the composite step
// definition behind a phrase like "When I keep only houses with a garden".
// Pure: no DB. The create_business_step tool stores what this returns.
//
// The sub-steps are the recorded ones, params and locators included. So the Cucumber
// export of that test (and of any test with the same steps) collapses them into the
// phrase, and the generated step definition can pick stable locators the way plain
// Playwright code does.

const PATTERN_PARAMETER = /\{(string|int|float|word)\}/g;

/**
 * `{ steps_template }`, or `{ error }`. Steps are numbered from 1, both ends included.
 * Each entry of `args` maps a parameter of the pattern, in order, to a recorded value:
 * `{ step, param }` takes the whole value of `param` in that step, `{ step, param, value }`
 * only that part of it (a city inside a URL).
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

  const steps_template = steps.slice(from_step - 1, to_step).map(step => ({
    command: step.command,
    // Assertions keep their data in `assertion`; parsing a composite puts it back there.
    params: structuredClone(step.command === 'assert' ? (step.assertion || step.params || {}) : (step.params || {})),
    ...(step.locators?.length && { locators: structuredClone(step.locators) }),
  }));

  for (const [i, arg] of args.entries()) {
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

  return { steps_template };
}
