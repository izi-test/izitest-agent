import { useEffect } from 'react';

// What the dock of agents' questions (components/AgentAsk.tsx) knows of this page.

/** The questions this page shows where they were asked (a run's window, beside its browser): the dock leaves them there. */
export const shownInPlace = new Set<string>();

/**
 * The run windows open on this page: while one works, the dock leaves the questions of other
 * dashboard runs to their own windows, and shows only those of agents started elsewhere.
 */
export const runWindows = new Set<symbol>();

/** Marks this page as showing a dashboard run's window while `active`. */
export function useRunWindow(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    const id = Symbol('run window');
    runWindows.add(id);
    return () => { runWindows.delete(id); };
  }, [active]);
}
