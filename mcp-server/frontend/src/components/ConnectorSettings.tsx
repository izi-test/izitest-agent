import { useState } from 'react';
import { Check, X, Play, Save } from 'lucide-react';
import { useSaveConnectorMutation, useTestConnectorMutation } from '../store/services/settingsApi';
import { Button } from './Button';
import { Card } from './ui';
import type { Connector } from '../types';

// A tool IziTest reads requirements from or writes back to (mcp-server/lib/connectors): the fields
// it is reached with — a site, an account, a token —, kept on this machine, a secret never shown
// back. Tested before it is relied on. Every connector the same way, from the fields it declares.

/** Where a connector is used, from its roles. */
function usesOf(c: Connector): string {
  return [
    c.requirements && `Its ${c.requirements.items} are imported in Requirements → Import (or import_from_connector).`,
    c.coverage && `A campaign's page sends ${c.coverage.where} (or send_coverage).`,
    c.results && `A campaign's page sends its results as a ${c.results.what} (or send_results).`,
  ].filter(Boolean).join(' ');
}

export function ConnectorSettings({ connector }: { connector: Connector }) {
  // Keyed by what is saved: the form starts from it again once it changes.
  return <ConnectorForm key={JSON.stringify(connector.config)} connector={connector} />;
}

function ConnectorForm({ connector: c }: { connector: Connector }) {
  const fields = c.settings.fields;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, c.config?.[f.name] ?? ''])));
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [save, { isLoading: saving }] = useSaveConnectorMutation();
  const [test, { isLoading: testing }] = useTestConnectorMutation();
  const [result, setResult] = useState<{ success: boolean; text: string } | null>(null);
  const set = (name: string, value: string) => { setValues({ ...values, [name]: value }); setResult(null); };
  const complete = fields.every((f) => f.optional || values[f.name]?.trim());
  const writes = !!(c.coverage || c.results);
  const fromEnv = fields.filter((f) => f.env).map((f) => f.env).join(', ');

  const keep = async () => {
    try {
      const { connector } = await save({ id: c.id, values }).unwrap();
      setResult({ success: true, text: connector.config?.from === 'settings' ? 'Saved.' : `${c.name} settings removed.` });
    } catch (err) {
      setResult({ success: false, text: (err as { data?: { error?: string } })?.data?.error ?? 'Not saved' });
    }
  };
  const check = async () => {
    const answer = await test({ id: c.id, values }).unwrap().catch(() => ({ success: false, error: 'The request failed' } as const));
    setResult(answer.success ? { success: true, text: answer.text ?? 'It works.' } : { success: false, text: answer.error ?? `${c.name} did not answer` });
  };

  return (
    <Card title={c.name} className="settings-integration" id={c.id}>
      <p className="help">
        {c.description} {usesOf(c)}
        {writes && ' Written to only when asked, after a preview.'}
        {c.config?.from === 'env' && ` Set now by ${fromEnv}; saved here, these come first.`}
      </p>
      <div className="settings-integration__body">
        <div className="connector-fields">
          {fields.map((f) => (
            <div key={f.name} className="field-group">
              <label>{f.label}{f.optional && <span className="cell-muted"> (optional)</span>}</label>
              {f.type === 'secret' ? (
                <div className="settings-apikey-input-wrapper">
                  <input
                    type={shown[f.name] ? 'text' : 'password'} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)}
                    placeholder={f.placeholder} autoComplete="off" spellCheck={false}
                  />
                  <button className="settings-apikey-toggle" type="button" onClick={() => setShown({ ...shown, [f.name]: !shown[f.name] })}>{shown[f.name] ? 'Hide' : 'Show'}</button>
                </div>
              ) : (
                <input type="text" value={values[f.name]} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} autoComplete="off" spellCheck={false} />
              )}
            </div>
          ))}
        </div>
        {(c.settings.hint || fields.some((f) => f.type === 'secret')) && (
          <p className="settings-apikey-hint">
            {c.settings.link ? <a href={c.settings.link} target="_blank" rel="noopener noreferrer">{c.settings.hint}</a> : c.settings.hint}
            {fields.some((f) => f.type === 'secret') && ' Stored on this machine; the dashboard never shows a secret back.'}
          </p>
        )}
        <div className="repair-actions">
          <Button size="sm" variant="secondary" icon={Play} disabled={!complete || testing} onClick={check}>{testing ? 'Testing…' : 'Test the connection'}</Button>
          <Button size="sm" icon={Save} disabled={saving} onClick={keep}>Save</Button>
        </div>
        {result && (
          <div className={`settings-test-result ${result.success ? 'success' : 'error'}`} style={{ marginTop: 12 }}>
            <div className="settings-test-status">
              {result.success ? <Check size={16} /> : <X size={16} />}
              <span>{result.text}</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
