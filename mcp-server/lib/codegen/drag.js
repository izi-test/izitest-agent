// Generated code for a drag step: Playwright's dragTo, from the dragged element to where it
// was dropped — its centre, or a quarter of the way in from one of its edges, where IziTest
// drops it (extension/src/commands/drag.ts). The top of an item in a vertical list puts what
// is dropped before it.

// Where on the target, as fractions of its width and height.
const EDGES = {
  top: ['width / 2', 'height / 4'],
  bottom: ['width / 2', 'height * 3 / 4'],
  left: ['width / 4', 'height / 2'],
  right: ['width * 3 / 4', 'height / 2'],
};

/**
 * Where a drag step dropped, as a step of its own (its selector, its locators): what
 * chooseTarget and selectorFor take.
 */
export function dropTargetOf(step) {
  const params = step.params ?? {};
  return { command: 'drag', params: { selector: params.target }, locators: params.targetLocators ?? [] };
}

/** The code of a drag from `source` to `target`, two locator expressions on `page`. */
export function dragToCode(source, target, position) {
  const edge = EDGES[position];
  if (!edge) return `await ${source}.dragTo(${target});`;
  return [
    '{',
    `  const target = ${target};`,
    '  const { width, height } = await target.boundingBox();',
    `  await ${source}.dragTo(target, { targetPosition: { x: ${edge[0]}, y: ${edge[1]} } }); // its ${position}`,
    '}',
  ].join('\n');
}
