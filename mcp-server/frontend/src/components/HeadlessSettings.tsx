import { Download, MonitorOff, Play, Square, Loader2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { setRunHeadless } from '../store/slices/uiSlice';
import { useGetHeadlessQuery, useHeadlessActionMutation } from '../store/services/settingsApi';
import { Button } from './Button';
import { Card, Pill } from './ui';

// The Chrome without windows tests can run in (mcp-server/lib/headless.js): installed here
// (Chrome for Testing, ~150 MB), started on demand or by hand, stopped with the server.

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

export function HeadlessSettings() {
  const dispatch = useAppDispatch();
  const runHeadless = useAppSelector((state) => state.ui.runHeadless);
  const { data: status, refetch } = useGetHeadlessQuery(undefined, { pollingInterval: 0 });
  const busy = !!status?.installing || !!status?.starting;
  // Followed while it installs or starts.
  useGetHeadlessQuery(undefined, { pollingInterval: busy ? 1500 : 0 });
  const [act, { isLoading, error }] = useHeadlessActionMutation();

  const state = !status ? null
    : status.installing ? <Pill tone="blue">Installing · {status.installing.total ? `${megabytes(status.installing.downloaded)} of ${megabytes(status.installing.total)}` : 'starting'}</Pill>
      : !status.installed ? <Pill tone="slate">Not installed</Pill>
        : status.starting ? <Pill tone="blue">Starting</Pill>
          : status.connected ? <Pill tone="green">Running</Pill>
            : <Pill tone="slate">Stopped</Pill>;

  return (
    <Card title="Headless browser" icon={MonitorOff} className="settings-integration" id="headless" actions={state}
      subtitle="A Chrome without windows the tests can run in, out of sight: your windows keep the focus while a campaign runs.">
      <div className="settings-integration__body">
        <p className="help">
          It is Chrome for Testing{status?.installed && ` ${status.installed.version}`}, with the extension of this repository and a profile of
          its own: its cookies and logins are not your Chrome's — a test of an app behind a login logs in itself. It starts on the first
          run asked headless, and stops with the server. Agents never work in it unless they name it (profile “headless”).
        </p>
        {status && !status.extension_built && <div className="alert alert--warning">The extension is not built: run <code>npm run build</code> in <code>extension/</code>.</div>}
        {(status?.error || error) && <div className="alert alert--error">{status?.error ?? errorOf(error)}</div>}
        <label className="switch">
          <input type="checkbox" checked={runHeadless} disabled={!status?.installed} onChange={(e) => dispatch(setRunHeadless(e.target.checked))} />
          <span className="switch__text">
            Run headless by default
            <span className="switch__hint">Runs of a test and campaigns started from the dashboard; the run options of a test and the campaign form change it too.</span>
          </span>
        </label>
        <div className="repair-actions">
          {!status?.installed && (
            <Button icon={status?.installing ? Loader2 : Download} disabled={!!status?.installing} onClick={() => act('install').then(() => refetch())}>
              {status?.installing ? 'Installing…' : 'Install (~150 MB)'}
            </Button>
          )}
          {status?.installed && !status.connected && (
            <Button size="sm" variant="secondary" icon={status.starting || isLoading ? Loader2 : Play} disabled={status.starting || isLoading} onClick={() => act('start')}>Start now</Button>
          )}
          {status?.connected && (
            <Button size="sm" variant="secondary" icon={Square} disabled={isLoading} onClick={() => act('stop')}>Stop</Button>
          )}
        </div>
        {status && <p className="settings-apikey-hint">Installed in <code>{status.browsers_dir}</code>; its profile is <code>{status.profile_dir}</code>.</p>}
      </div>
    </Card>
  );
}
