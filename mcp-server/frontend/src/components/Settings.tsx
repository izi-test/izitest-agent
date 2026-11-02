import { useState, useMemo } from 'react';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useGetAgentConfigQuery, useUpdateAgentConfigMutation, useTestAgentMutation, useTestApiKeyMutation, useGetModelsQuery } from '../store/services/settingsApi';
import type { AgentConfig } from '../store/services/settingsApi';
import { Button } from './Button';
import { JiraSettings } from './JiraSettings';
import { ArrowLeft, Save, Play, Check, X, Terminal, Cloud, Search } from 'lucide-react';

const CLI_PROVIDERS = [
  { id: 'claude', label: 'Claude Code', command: 'claude', description: 'Anthropic Claude Code CLI' },
  { id: 'copilot', label: 'GitHub Copilot', command: 'copilot', description: 'GitHub Copilot CLI' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', description: 'Google Gemini CLI' },
  { id: 'opencode', label: 'Open Code', command: 'opencode', description: 'Open Code CLI' },
];

interface SettingsProps {
  onBack: () => void;
}

const DEFAULT_CONFIG: AgentConfig = {
  mode: 'cli',
  cli: { provider: 'copilot', command: 'copilot' },
  api: { model: 'anthropic/claude-sonnet-4-6', apiKey: '' }
};

function formatPrice(price: string): string {
  const n = parseFloat(price);
  if (n === 0) return 'Free';
  if (n < 0.000001) return '<$0.01/M';
  return `$${(n * 1_000_000).toFixed(2)}/M`;
}

export function Settings({ onBack }: SettingsProps) {
  const dispatch = useAppDispatch();

  const { data: serverConfig, isLoading } = useGetAgentConfigQuery();
  const [updateConfig] = useUpdateAgentConfigMutation();
  const [testAgentMut] = useTestAgentMutation();
  const [testApiKeyMut] = useTestApiKeyMutation();
  const { data: allModels, isLoading: modelsLoading } = useGetModelsQuery();

  // Local form state — initialized from server config
  const [localConfig, setLocalConfig] = useState<AgentConfig | null>(null);

  // Sync server data to local form on first load
  if (serverConfig && !localConfig) {
    setLocalConfig({ ...DEFAULT_CONFIG, ...serverConfig });
  }

  const config = localConfig || serverConfig || DEFAULT_CONFIG;

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; output?: string; error?: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  const filteredModels = useMemo(() => {
    if (!allModels) return [];
    const q = modelSearch.toLowerCase().trim();
    if (!q) return allModels.slice(0, 30);
    return allModels.filter(m =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    ).slice(0, 30);
  }, [allModels, modelSearch]);

  const selectedModelName = useMemo(() => {
    if (!allModels || !config.api?.model) return config.api?.model || '';
    const found = allModels.find(m => m.id === config.api.model);
    return found?.name || config.api.model;
  }, [allModels, config.api?.model]);

  const handleProviderChange = (providerId: string) => {
    const provider = CLI_PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;
    setLocalConfig(prev => ({
      ...(prev || config),
      cli: { provider: providerId, command: provider.command }
    }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (config.mode === 'cli') {
        const data = await testAgentMut({ command: config.cli.command }).unwrap();
        setTestResult(data);
      } else {
        const data = await testApiKeyMut({
          apiKey: config.api.apiKey,
          model: config.api.model
        }).unwrap();
        setTestResult(data);
      }
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateConfig({ agent: config }).unwrap();
      dispatch(showToast({ message: 'Agent configuration saved' }));
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Save failed', type: 'error' }));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <section className="view active"><p className="empty-state">Loading...</p></section>;

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
          Configure the AI agent that will control the browser and help create tests.
        </p>

        <div className="settings-card">
          <div className="settings-card-header">
            <h3>Agent Type</h3>
          </div>
          <div className="settings-mode-grid">
            <button
              className={`settings-mode-btn ${config.mode === 'cli' ? 'active' : ''}`}
              onClick={() => { setLocalConfig(prev => ({ ...(prev || config), mode: 'cli' })); setTestResult(null); }}
            >
              <Terminal size={20} />
              <span className="settings-mode-label">CLI</span>
              <span className="settings-mode-desc">Local command-line agent</span>
            </button>
            <button
              className={`settings-mode-btn ${config.mode === 'api' ? 'active' : ''}`}
              onClick={() => { setLocalConfig(prev => ({ ...(prev || config), mode: 'api' })); setTestResult(null); }}
            >
              <Cloud size={20} />
              <span className="settings-mode-label">API</span>
              <span className="settings-mode-desc">OpenRouter (all models)</span>
            </button>
          </div>
        </div>

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

            <div className="settings-command-row">
              <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                <label>Command</label>
                <input
                  type="text"
                  value={config.cli.command}
                  onChange={e => {
                    setLocalConfig(prev => ({
                      ...(prev || config),
                      cli: { ...(prev || config).cli, command: e.target.value }
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

        {config.mode === 'api' && (
          <>
            <div className="settings-card">
              <div className="settings-card-header">
                <h3>OpenRouter API Key</h3>
              </div>
              <div className="settings-apikey-row">
                <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label>API Key</label>
                  <div className="settings-apikey-input-wrapper">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={config.api?.apiKey || ''}
                      onChange={e => {
                        setLocalConfig(prev => ({
                          ...(prev || config),
                          api: { ...(prev || config).api, apiKey: e.target.value }
                        }));
                        setTestResult(null);
                      }}
                      placeholder="sk-or-... paste your OpenRouter key"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      className="settings-apikey-toggle"
                      onClick={() => setShowApiKey(!showApiKey)}
                      type="button"
                      title={showApiKey ? 'Hide' : 'Show'}
                    >
                      {showApiKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                <Button
                  variant="action"
                  icon={Play}
                  onClick={handleTest}
                  disabled={testing || !config.api?.apiKey?.trim()}
                  style={{ alignSelf: 'flex-end', background: 'var(--accent)', color: '#fff', border: 'none' }}
                >
                  {testing ? 'Testing...' : 'Test'}
                </Button>
              </div>
              <p className="settings-apikey-hint">
                Get your key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>. Stored locally, never shared.
              </p>

              {testResult && (
                <div className={`settings-test-result ${testResult.success ? 'success' : 'error'}`} style={{ marginTop: 12 }}>
                  <div className="settings-test-status">
                    {testResult.success ? <Check size={16} /> : <X size={16} />}
                    <span>{testResult.success ? 'API key is valid' : 'API key test failed'}</span>
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

            <div className="settings-card">
              <div className="settings-card-header">
                <h3>Model</h3>
                {config.api?.model && (
                  <span className="settings-selected-model">{selectedModelName}</span>
                )}
              </div>

              <div className="settings-model-search">
                <Search size={16} />
                <input
                  type="text"
                  value={modelSearch}
                  onChange={e => setModelSearch(e.target.value)}
                  placeholder="Search models... (e.g. claude, gpt, gemini)"
                />
              </div>

              {modelsLoading ? (
                <p className="empty-state" style={{ padding: '16px 0' }}>Loading models...</p>
              ) : (
                <div className="settings-model-list">
                  {filteredModels.map(model => (
                    <button
                      key={model.id}
                      className={`settings-model-item ${config.api?.model === model.id ? 'active' : ''}`}
                      onClick={() => {
                        setLocalConfig(prev => ({
                          ...(prev || config),
                          api: { ...(prev || config).api, model: model.id }
                        }));
                        setTestResult(null);
                      }}
                    >
                      <span className="settings-model-item-name">{model.name}</span>
                      <span className="settings-model-item-meta">
                        <span className="settings-model-item-id">{model.id}</span>
                        <span className="settings-model-item-pricing">
                          {formatPrice(model.pricing.prompt)} in / {formatPrice(model.pricing.completion)} out
                        </span>
                      </span>
                      {config.api?.model === model.id && (
                        <span className="settings-provider-check"><Check size={14} /></span>
                      )}
                    </button>
                  ))}
                  {filteredModels.length === 0 && modelSearch && (
                    <p className="empty-state" style={{ padding: '16px 0' }}>No models match "{modelSearch}"</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <JiraSettings />
    </section>
  );
}
