import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAppContext } from '../context/AppContext';
import { Button } from './Button';
import { ArrowLeft, Save, Play, Check, X, Terminal } from 'lucide-react';

interface AgentConfig {
  mode: 'cli' | 'api';
  cli: {
    provider: string;
    command: string;
  };
}

const CLI_PROVIDERS = [
  { id: 'claude', label: 'Claude Code', command: 'claude', description: 'Anthropic Claude Code CLI' },
  { id: 'copilot', label: 'GitHub Copilot', command: 'copilot', description: 'GitHub Copilot CLI' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', description: 'Google Gemini CLI' },
  { id: 'opencode', label: 'Open Code', command: 'opencode', description: 'Open Code CLI' },
];

interface SettingsProps {
  onBack: () => void;
}

export function Settings({ onBack }: SettingsProps) {
  const { showToast } = useAppContext();
  const [config, setConfig] = useState<AgentConfig>({
    mode: 'cli',
    cli: { provider: 'copilot', command: 'copilot' }
  });
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; output?: string; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const data = await api('GET', '/api/settings/agent');
      setConfig(data.agent);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleProviderChange = (providerId: string) => {
    const provider = CLI_PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;
    setConfig(prev => ({
      ...prev,
      cli: { provider: providerId, command: provider.command }
    }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await api('POST', '/api/settings/agent/test', { command: config.cli.command });
      setTestResult(data);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api('PUT', '/api/settings/agent', { agent: config });
      showToast('Agent configuration saved');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className="view active"><p className="empty-state">Loading...</p></section>;

  return (
    <section className="view active">
      <div className="detail-header">
        <Button variant="back" icon={ArrowLeft} onClick={onBack} title="Back">
          Back
        </Button>
        <Button variant="save" icon={Save} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      <div className="settings-section">
        <h2 className="settings-title">AI Agent Configuration</h2>
        <p className="settings-desc">
          Configure the AI agent that will control the browser and help create workflows.
        </p>

        {/* Mode selector */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3>Agent Type</h3>
          </div>
          <div className="settings-mode-grid">
            <button
              className={`settings-mode-btn ${config.mode === 'cli' ? 'active' : ''}`}
              onClick={() => setConfig(prev => ({ ...prev, mode: 'cli' }))}
            >
              <Terminal size={20} />
              <span className="settings-mode-label">CLI</span>
              <span className="settings-mode-desc">Local command-line agent</span>
            </button>
            <button
              className="settings-mode-btn disabled"
              disabled
              title="Coming soon"
            >
              <span style={{ fontSize: '20px', lineHeight: 1 }}>{'{ }'}</span>
              <span className="settings-mode-label">API</span>
              <span className="settings-mode-desc">Remote API (coming soon)</span>
            </button>
          </div>
        </div>

        {/* CLI Provider selection */}
        {config.mode === 'cli' && (
          <div className="settings-card">
            <div className="settings-card-header">
              <h3>CLI Provider</h3>
            </div>
            <div className="settings-provider-grid">
              {CLI_PROVIDERS.map(provider => (
                <button
                  key={provider.id}
                  className={`settings-provider-btn ${config.cli.provider === provider.id ? 'active' : ''}`}
                  onClick={() => handleProviderChange(provider.id)}
                >
                  <span className="settings-provider-name">{provider.label}</span>
                  <span className="settings-provider-cmd">$ {provider.command}</span>
                  <span className="settings-provider-desc">{provider.description}</span>
                  {config.cli.provider === provider.id && (
                    <span className="settings-provider-check"><Check size={14} /></span>
                  )}
                </button>
              ))}
            </div>

            {/* Custom command override */}
            <div className="settings-command-row">
              <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                <label>Command</label>
                <input
                  type="text"
                  value={config.cli.command}
                  onChange={e => {
                    setConfig(prev => ({
                      ...prev,
                      cli: { ...prev.cli, command: e.target.value }
                    }));
                    setTestResult(null);
                  }}
                  placeholder="e.g. claude, copilot, gemini..."
                />
              </div>
              <Button
                variant="action"
                icon={Play}
                onClick={handleTest}
                disabled={testing || !config.cli.command.trim()}
                style={{ alignSelf: 'flex-end', background: 'var(--accent)', color: '#fff', border: 'none' }}
              >
                {testing ? 'Testing...' : 'Test'}
              </Button>
            </div>

            {/* Test result */}
            {testResult && (
              <div className={`settings-test-result ${testResult.success ? 'success' : 'error'}`}>
                <div className="settings-test-status">
                  {testResult.success ? <Check size={16} /> : <X size={16} />}
                  <span>{testResult.success ? 'Agent is operational' : 'Agent not available'}</span>
                </div>
                {testResult.output && (
                  <pre className="settings-test-output">{testResult.output}</pre>
                )}
                {testResult.error && (
                  <pre className="settings-test-output error">{testResult.error}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
