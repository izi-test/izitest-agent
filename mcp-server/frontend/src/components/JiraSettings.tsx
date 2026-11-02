import { useState } from 'react';
import { Check, X, Play, Save } from 'lucide-react';
import { useGetJiraConfigQuery, useUpdateJiraConfigMutation, useTestJiraMutation, type JiraConfig } from '../store/services/settingsApi';
import { Button } from './Button';
import { Card } from './ui';

// The Jira site requirements are read from, and coverage is commented on (mcp-server/lib/jira.js):
// its address, the email of the account to act as, and an API token of that account — kept on
// this machine, the token never shown back. Tested before it is relied on.

export function JiraSettings() {
  const { data: saved, isLoading } = useGetJiraConfigQuery();
  if (isLoading) return null;
  // Keyed by what is saved: the form starts from it again once it changes.
  return <JiraForm key={JSON.stringify(saved)} saved={saved ?? null} />;
}

function JiraForm({ saved }: { saved: JiraConfig | null }) {
  const [config, setConfig] = useState<JiraConfig>({ baseUrl: saved?.baseUrl ?? '', email: saved?.email ?? '', apiToken: saved?.apiToken ?? '' });
  const [showToken, setShowToken] = useState(false);
  const [update, { isLoading: saving }] = useUpdateJiraConfigMutation();
  const [test, { isLoading: testing }] = useTestJiraMutation();
  const [result, setResult] = useState<{ success: boolean; text: string } | null>(null);
  const set = (field: keyof JiraConfig, value: string) => { setConfig({ ...config, [field]: value }); setResult(null); };
  const complete = !!(config.baseUrl.trim() && config.email.trim() && config.apiToken.trim());

  const save = async () => {
    try {
      await update(config).unwrap();
      setResult({ success: true, text: config.baseUrl.trim() ? 'Saved.' : 'Jira connection removed.' });
    } catch (err) {
      setResult({ success: false, text: (err as { data?: { error?: string } })?.data?.error ?? 'Not saved' });
    }
  };
  const check = async () => {
    const answer = await test(config).unwrap().catch(() => ({ success: false, error: 'The request failed' } as const));
    setResult(answer.success
      ? { success: true, text: `Connected to ${answer.site} as ${answer.user}.` }
      : { success: false, text: answer.error ?? 'Jira did not answer' });
  };

  return (
    <Card title="Jira" className="settings-integration" id="jira">
      <p className="help">
        The Jira site requirements are read from: its stories, by a JQL query or their keys (Requirements → Import → Jira, or
        import_from_jira). Written to only when asked, after a preview: a campaign's results as a comment on each story it checks.
        {saved?.from === 'env' && ' Set now by JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN; saved here, these come first.'}
      </p>
      <div className="settings-integration__body">
        <div className="jira-fields">
          <div className="field-group">
            <label>Site</label>
            <input type="text" value={config.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://your-team.atlassian.net" spellCheck={false} />
          </div>
          <div className="field-group">
            <label>Email of the account</label>
            <input type="text" value={config.email} onChange={(e) => set('email', e.target.value)} placeholder="you@example.com" autoComplete="off" spellCheck={false} />
          </div>
          <div className="field-group">
            <label>API token</label>
            <div className="settings-apikey-input-wrapper">
              <input
                type={showToken ? 'text' : 'password'} value={config.apiToken} onChange={(e) => set('apiToken', e.target.value)}
                placeholder="Paste a token of that account" autoComplete="off" spellCheck={false}
              />
              <button className="settings-apikey-toggle" type="button" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button>
            </div>
          </div>
        </div>
        <p className="settings-apikey-hint">
          A token is made at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com → Security → API tokens</a>.
          Stored on this machine; the dashboard never shows it back.
        </p>
        <div className="repair-actions">
          <Button size="sm" variant="secondary" icon={Play} disabled={!complete || testing} onClick={check}>{testing ? 'Testing…' : 'Test the connection'}</Button>
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
