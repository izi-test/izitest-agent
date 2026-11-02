import { useState } from 'react';
import { Check, X, Play, Save } from 'lucide-react';
import { useGetXrayConfigQuery, useUpdateXrayConfigMutation, useTestXrayMutation, type XrayConfig } from '../store/services/settingsApi';
import { Button } from './Button';
import { Card } from './ui';

// The Xray API key a campaign's results are sent with (mcp-server/lib/xray.js): its client id
// and secret — kept on this machine, the secret never shown back. Tested before it is relied on.

export function XraySettings() {
  const { data: saved, isLoading } = useGetXrayConfigQuery();
  if (isLoading) return null;
  // Keyed by what is saved: the form starts from it again once it changes.
  return <XrayForm key={JSON.stringify(saved)} saved={saved ?? null} />;
}

function XrayForm({ saved }: { saved: XrayConfig | null }) {
  const [config, setConfig] = useState<XrayConfig>({ clientId: saved?.clientId ?? '', clientSecret: saved?.clientSecret ?? '' });
  const [showSecret, setShowSecret] = useState(false);
  const [update, { isLoading: saving }] = useUpdateXrayConfigMutation();
  const [test, { isLoading: testing }] = useTestXrayMutation();
  const [result, setResult] = useState<{ success: boolean; text: string } | null>(null);
  const set = (field: keyof XrayConfig, value: string) => { setConfig({ ...config, [field]: value }); setResult(null); };
  const complete = !!(config.clientId.trim() && config.clientSecret.trim());

  const save = async () => {
    try {
      await update(config).unwrap();
      setResult({ success: true, text: config.clientId.trim() ? 'Saved.' : 'Xray API key removed.' });
    } catch (err) {
      setResult({ success: false, text: (err as { data?: { error?: string } })?.data?.error ?? 'Not saved' });
    }
  };
  const check = async () => {
    const answer = await test(config).unwrap().catch(() => ({ success: false, error: 'The request failed' } as const));
    setResult(answer.success
      ? { success: true, text: `Xray takes this API key (${answer.url}).` }
      : { success: false, text: answer.error ?? 'Xray did not answer' });
  };

  return (
    <Card title="Xray" className="settings-integration" id="xray">
      <p className="help">
        The API key a campaign's results are sent to Xray with (Campaigns → a campaign → Send to Xray, or export_to_xray): a Test
        Execution, each test a Generic test linked to the stories it covers. Nothing is sent without a preview first.
        {saved?.from === 'env' && ' Set now by XRAY_CLIENT_ID and XRAY_CLIENT_SECRET; saved here, these come first.'}
      </p>
      <div className="settings-integration__body">
        <div className="jira-fields">
          <div className="field-group">
            <label>Client ID</label>
            <input type="text" value={config.clientId} onChange={(e) => set('clientId', e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div className="field-group">
            <label>Client secret</label>
            <div className="settings-apikey-input-wrapper">
              <input
                type={showSecret ? 'text' : 'password'} value={config.clientSecret} onChange={(e) => set('clientSecret', e.target.value)}
                placeholder="The secret of that API key" autoComplete="off" spellCheck={false}
              />
              <button className="settings-apikey-toggle" type="button" onClick={() => setShowSecret(!showSecret)}>{showSecret ? 'Hide' : 'Show'}</button>
            </div>
          </div>
        </div>
        <p className="settings-apikey-hint">
          An API key is made in Jira → Apps → Xray → API Keys (a Jira administrator's). Stored on this machine; the dashboard never shows the secret back.
        </p>
        <div className="repair-actions">
          <Button size="sm" variant="secondary" icon={Play} disabled={!complete || testing} onClick={check}>{testing ? 'Testing…' : 'Test the API key'}</Button>
          <Button size="sm" icon={Save} disabled={saving} onClick={save}>Save</Button>
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
