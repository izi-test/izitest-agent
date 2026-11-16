import { AppWindow } from 'lucide-react';
import { useGetWindowSettingsQuery, useSetWindowSettingsMutation, type WindowSettings } from '../store/services/settingsApi';
import { Card } from './ui';

// What becomes of the window a run or a recording opened in your Chrome once it is over
// (mcp-server/lib/run-windows.js): one choice for every run and recording — the dashboard's
// and an agent's —, kept by the server. Only a window IziTest opened is ever closed.

const AFTER_RUN: Array<{ value: WindowSettings['after_run']; label: string }> = [
  { value: 'keep', label: 'Stays open' },
  { value: 'passed', label: 'Closes when the test passes' },
  { value: 'always', label: 'Always closes' },
];

const AFTER_RUN_HINT: Record<WindowSettings['after_run'], string> = {
  keep: 'It stays open, to be looked at: close it when you are done.',
  passed: 'A failed run\'s window stays open, to be looked at.',
  always: 'Passed or failed: a failed run keeps its screenshot and its video in Runs.',
};

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The setting was not saved';

/** "After a run, its window": stays open, closes when the test passes, or always. */
export function AfterRunField({ disabledReason }: { disabledReason?: string }) {
  const { data: windows } = useGetWindowSettingsQuery();
  const [save, { error }] = useSetWindowSettingsMutation();
  return (
    <label className={`field ${disabledReason ? 'field--disabled' : ''}`}>
      <span className="field__label"><AppWindow size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />After the run, its window</span>
      <select aria-label="After the run, its window" value={windows?.after_run ?? 'keep'} disabled={!windows || !!disabledReason}
        onChange={(e) => save({ after_run: e.target.value as WindowSettings['after_run'] })}>
        {AFTER_RUN.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="field__hint">{disabledReason ?? (windows ? AFTER_RUN_HINT[windows.after_run] : '')}</span>
      {error && <span className="field__error">{errorOf(error)}</span>}
    </label>
  );
}

/** "Close the window once the test is saved": the window a test was recorded in. */
export function AfterRecordingSwitch({ hint }: { hint?: string }) {
  const { data: windows } = useGetWindowSettingsQuery();
  const [save] = useSetWindowSettingsMutation();
  return (
    <label className="switch">
      <input type="checkbox" checked={!!windows?.after_recording} disabled={!windows}
        onChange={(e) => save({ after_recording: e.target.checked })} />
      <span className="switch__text">
        Close the window once the test is saved
        <span className="switch__hint">{hint ?? 'The window the test was recorded in closes when the recording ends and the test is saved.'}</span>
      </span>
    </label>
  );
}

export function BrowserWindowsSettings() {
  return (
    <Card title="Browser windows" icon={AppWindow} className="settings-integration browser-windows" id="windows"
      subtitle="The windows IziTest opens in your Chrome for a run or a recording: left open once it is over, or closed.">
      <div className="settings-integration__body">
        <p className="help">
          Only a window IziTest opened is closed — never one of yours, nor a tab of yours a run played in (Run options → <em>Open in a new
          window</em> off). For the runs and recordings of the dashboard and of an agent. A campaign closes each test's window when the
          test is over, and in the headless browser a run's window closes anyway.
        </p>
        <AfterRunField />
        <p className="help">
          A debug run keeps its window: you follow it step by step. A run that fails while an agent runs it keeps its window too — the agent
          repairs the step there.
        </p>
        <AfterRecordingSwitch />
      </div>
    </Card>
  );
}
