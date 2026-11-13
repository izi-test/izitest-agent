import type { StepRef } from './types';

// How many steps, in how many tests, act on an element (components/SharedUses.tsx).

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 steps in 2 tests". */
export function usesCount(steps: StepRef[]): string {
  return `${plural(steps.length, 'step')} in ${plural(new Set(steps.map((s) => s.test)).size, 'test')}`;
}
