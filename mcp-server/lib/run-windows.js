// What becomes of the window a run or a recording opened in the user's Chrome once it is over
// (settings key 'windows'). By default it stays open, to be looked at; the user chooses
// otherwise in Settings → Browser windows, or in a test's Run options:
// - after_run: 'keep' — it stays open; 'passed' — it closes when the test passed, a failed
//   run's stays open to be looked at; 'always' — it closes, passed or failed (a failed run keeps
//   its screenshot and its video in Runs). A debug run keeps its window: it is watched. A failed
//   run an agent repairs (run_test) keeps it too: the agent fixes the step there.
// - after_recording: the window a test was recorded in closes once stop_recording saved it.
// Only a window IziTest opened is ever closed — the extension refuses any other (close_window):
// never one of the user's. Headless, a run's window closes anyway: nobody looks at it.

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { listSessions, forgetTabsEverywhere } from './session.js';

export const AFTER_RUN = ['keep', 'passed', 'always'];
export const DEFAULT_WINDOWS = Object.freeze({ after_run: 'keep', after_recording: false });

/** { after_run, after_recording } as the user set them, the defaults for the rest. */
export function windowSettings() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'windows'").get();
    const value = row ? parseJson(row.value) : null;
    return {
      after_run: AFTER_RUN.includes(value?.after_run) ? value.after_run : DEFAULT_WINDOWS.after_run,
      after_recording: value?.after_recording === true,
    };
  } catch {
    return { ...DEFAULT_WINDOWS }; // no database (unit tests)
  }
}

/** Keeps what `changes` says ({ after_run?, after_recording? }), the rest as it was; throws on a wrong value. */
export function setWindowSettings(changes = {}) {
  if (changes.after_run !== undefined && !AFTER_RUN.includes(changes.after_run)) {
    throw new Error(`after_run is one of ${AFTER_RUN.map((v) => `"${v}"`).join(', ')}`);
  }
  if (changes.after_recording !== undefined && typeof changes.after_recording !== 'boolean') {
    throw new Error('after_recording is true or false');
  }
  const next = { ...windowSettings(), ...Object.fromEntries(Object.entries(changes).filter(([key, value]) => key in DEFAULT_WINDOWS && value !== undefined)) };
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('windows', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(JSON.stringify(next));
  return next;
}

/** Whether the window of a run that `passed` (or not) closes, as the user set it. */
export function closesAfterRun(passed, settings = windowSettings()) {
  return settings.after_run === 'always' || (settings.after_run === 'passed' && !!passed);
}

/**
 * Closes the window holding `tabId`, when IziTest opened it (the extension refuses any other),
 * with the popups its pages opened; the sessions that worked in it forget its tabs — their
 * next navigate opens a new window. True when it was closed. Never throws: a window the user
 * already closed, or an extension that does not answer, leaves nothing to do.
 */
export async function closeWindowOf(sendCommand, tabId, params = {}) {
  if (tabId == null) return false;
  try {
    const result = await sendCommand(undefined, 'close_window', { tabId, liveSessions: listSessions().map((s) => s.id), ...params }, 10_000);
    if (result?.closed || result?.reason === 'gone') forgetTabsEverywhere(result.tabIds?.length ? result.tabIds : [tabId]);
    return !!result?.closed;
  } catch (err) {
    log(`Window of tab ${tabId} not closed: ${err.message}`);
    return false;
  }
}
