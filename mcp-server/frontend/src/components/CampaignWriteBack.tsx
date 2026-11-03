import { useState } from 'react';
import { Send, MessageSquare, ExternalLink, Loader2 } from 'lucide-react';
import { useSendResultsMutation, useSendCoverageMutation } from '../store/services/campaignsApi';
import { useGetConnectorsQuery } from '../store/services/settingsApi';
import { Button } from './Button';
import { Card, KeyChip, Pill } from './ui';
import type { Campaign, Connector, ResultsSend, CoverageSend } from '../types';

// A campaign's results written back through connectors (mcp-server/lib/connectors): sent to a
// tool that takes them (a Test Execution of Xray), and to the requirements it checks that come
// from a tool, as IziTest's word on each (a comment on a Jira story). Each is previewed — what
// would be sent — before it can be sent.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';
const toneOf = (status: string) => (/pass/i.test(status) ? 'green' : /fail/i.test(status) ? 'red' : 'slate');

export function CampaignWriteBack({ campaign: c }: { campaign: Campaign }) {
  const { data: connectors = [] } = useGetConnectorsQuery();
  const [open, setOpen] = useState<string | null>(null);
  if (c.running) return null;
  const takers = connectors.filter((t) => t.results && t.config);
  // A tool told the coverage of the requirements the campaign checks that come from it.
  const told = connectors.filter((t) => t.coverage && t.config && c.requirements.some((r) => r.source === t.id));
  const unset = connectors.filter((t) => (t.results || t.coverage) && !t.config);
  if (!takers.length && !told.length && !unset.length) return null;

  return (
    <Card title="Send the results" subtitle="To the tools set in Settings → Connectors. Each is previewed before anything is written.">
      {!takers.length && !told.length && (
        <div className="alert alert--info">Set {unset.map((t) => t.name).join(' or ')} in Settings to send these results there.</div>
      )}
      {(c.sent_to ?? []).map((s) => (
        <p key={s.connector} className="help">
          Sent to {s.name}: {s.url ? <a className="campaign-link" href={s.url} target="_blank" rel="noreferrer">{s.ref} <ExternalLink size={11} /></a> : <strong>{s.ref}</strong>}
          {' '}— sent again, it is updated.
        </p>
      ))}
      <div className="repair-actions" style={{ marginTop: 10 }}>
        {takers.map((t) => (
          <Button key={t.id} size="sm" variant={open === `results:${t.id}` ? 'primary' : 'secondary'} icon={Send} onClick={() => setOpen(open === `results:${t.id}` ? null : `results:${t.id}`)}>
            Send to {t.name}…
          </Button>
        ))}
        {told.map((t) => (
          <Button key={t.id} size="sm" variant={open === `coverage:${t.id}` ? 'primary' : 'secondary'} icon={MessageSquare} onClick={() => setOpen(open === `coverage:${t.id}` ? null : `coverage:${t.id}`)}>
            Tell the {t.name} {t.requirements?.items ?? 'items'}…
          </Button>
        ))}
      </div>
      {takers.filter((t) => open === `results:${t.id}`).map((t) => <ResultsPanel key={t.id} campaign={c} connector={t} onClose={() => setOpen(null)} />)}
      {told.filter((t) => open === `coverage:${t.id}`).map((t) => <CoveragePanel key={t.id} campaign={c} connector={t} onClose={() => setOpen(null)} />)}
    </Card>
  );
}

/** What the campaign would be in the tool, then is: the connector's options, each test's status and what it covers. */
function ResultsPanel({ campaign: c, connector: t, onClose }: { campaign: Campaign; connector: Connector; onClose: () => void }) {
  const role = t.results!;
  const [send, { isLoading }] = useSendResultsMutation();
  const [options, setOptions] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ResultsSend | null>(null);
  const [sent, setSent] = useState<ResultsSend | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (dryRun: boolean) => {
    setError(null);
    const given = Object.fromEntries(Object.entries(options).map(([name, value]) => [name, value.trim()]).filter(([, value]) => value));
    try {
      const result = await send({ id: c.id, connector: t.id, options: given, dry_run: dryRun }).unwrap();
      if (dryRun) setPreview(result);
      else setSent(result);
    } catch (err) {
      setError(errorOf(err));
      if (dryRun) setPreview(null);
    }
  };
  if (sent) {
    return (
      <div className="import-panel writeback-panel">
        <p className="alert alert--success">
          Sent to {t.name}: {sent.url ? <a href={sent.url} target="_blank" rel="noreferrer">{sent.ref} <ExternalLink size={11} /></a> : sent.ref ?? `a ${role.what}`},
          in {sent.target} — {sent.items.length} test{sent.items.length === 1 ? '' : 's'}.
        </p>
        <div className="repair-actions"><Button size="sm" variant="secondary" onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  return (
    <div className="import-panel writeback-panel">
      {role.note && <p className="help">{role.note}</p>}
      <div className="writeback-fields">
        {role.options.map((o) => (
          <label key={o.name}>{o.label} <input type="text" value={options[o.name] ?? ''} placeholder={o.placeholder} onChange={(e) => setOptions({ ...options, [o.name]: e.target.value })} spellCheck={false} /></label>
        ))}
        <Button size="sm" variant="secondary" disabled={isLoading} onClick={() => ask(true)}>{preview ? 'Preview again' : 'Preview'}</Button>
      </div>
      {isLoading && <p className="help"><Loader2 size={12} className="spin" /> {preview ? 'Sending…' : 'Preparing…'}</p>}
      {error && <div className="alert alert--error">{error}</div>}
      {preview && (
        <>
          <p className="help">
            Would {preview.updates ? <>update the {role.what} <strong>{preview.ref}</strong></> : `create a ${role.what}`} in <strong>{preview.target}</strong>:
          </p>
          <table className="table table--inset">
            <thead><tr><th>Test</th><th>{t.name} status</th><th>Covers</th></tr></thead>
            <tbody>
              {preview.items.map((item) => (
                <tr key={item.test}>
                  <td className="mono">{item.test}</td>
                  <td><Pill tone={toneOf(item.status)}>{item.status}</Pill></td>
                  <td>{item.links.length ? <div className="cell-chips">{item.links.map((key) => <KeyChip key={key}>{key}</KeyChip>)}</div> : <span className="cell-muted">nothing</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="repair-actions">
        <Button size="sm" variant="save" icon={Send} disabled={!preview || isLoading} onClick={() => ask(false)}>
          {preview?.updates ? `Update ${preview.ref}` : `Send to ${t.name}`}
        </Button>
        <Button size="sm" variant="cancel" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** IziTest's word on each requirement from the tool the campaign checks: what it would say, then sent. */
function CoveragePanel({ campaign: c, connector: t, onClose }: { campaign: Campaign; connector: Connector; onClose: () => void }) {
  const [post, { isLoading }] = useSendCoverageMutation();
  const [result, setResult] = useState<CoverageSend | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (dryRun: boolean) => {
    setError(null);
    try {
      setResult(await post({ connector: t.id, campaign_id: c.id, dry_run: dryRun }).unwrap());
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <div className="import-panel writeback-panel">
      <p className="help">
        IziTest's own, {t.coverage!.where}: where it stands, each criterion with its tests and how they did. Sent again, it is updated.
      </p>
      {isLoading && <p className="help"><Loader2 size={12} className="spin" /> {result ? 'Sending…' : 'Preparing…'}</p>}
      {error && <div className="alert alert--error">{error}</div>}
      {result?.warnings.length ? <ul className="import-warnings">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      {result && (
        <div className="import-items">
          {result.items.map((item) => (
            <details key={item.key} className="import-item" open={!result.sent}>
              <summary>
                <KeyChip>{item.key}</KeyChip>
                {item.error ? <span className="repair-error">Not sent: {item.error}</span>
                  : result.sent ? (item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.action} <ExternalLink size={11} /></a> : <span>{item.action}</span>)
                    : <span className="cell-muted">{item.action === 'update' ? 'updates IziTest\'s' : 'adds IziTest\'s'}</span>}
              </summary>
              <pre className="writeback-comment">{item.text}</pre>
            </details>
          ))}
        </div>
      )}
      <div className="repair-actions">
        {!result && <Button size="sm" variant="secondary" disabled={isLoading} onClick={() => ask(true)}>Preview</Button>}
        {result && !result.sent && (
          <Button size="sm" variant="save" icon={MessageSquare} disabled={!result.items.length || isLoading} onClick={() => ask(false)}>
            Send {result.items.length} to {t.name}
          </Button>
        )}
        <Button size="sm" variant={result?.sent ? 'secondary' : 'cancel'} onClick={onClose}>{result?.sent ? 'Close' : 'Cancel'}</Button>
      </div>
    </div>
  );
}
