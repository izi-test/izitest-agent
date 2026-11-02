import { useState, useRef, useEffect } from 'react';
import { Button } from './Button';
import { X, Wand2, Loader2, Folder, Square, FileCode, Bot } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { useGetProjectsQuery, } from '../store/services/projectsApi';
import { useCreateRequirementMutation } from '../store/services/requirementsApi';
import {
  testsApi,
  useAssignToProjectMutation,
  useCreateTestMutation,
  usePutTestFeatureMutation,
} from '../store/services/testsApi';

type CreateMode = 'ai' | 'gherkin';

interface CreateTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTestCreated: (testName: string, projectId: number | null, mode?: CreateMode) => void;
}

type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'stopped';

function defaultGherkinTemplate(name: string, description: string): string {
  const descLines = description
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  const header = description ? `Feature: ${name}\n${descLines}\n\n` : `Feature: ${name}\n\n`;
  return (
    header +
    `  Scenario: ${name}\n` +
    `    Given I am on "https://example.com"\n` +
    `    When I click on "#submit"\n` +
    `    Then I should see "Welcome"\n`
  );
}

const VIEWPORT_PRESETS = [
  { label: 'Default', value: '' },
  { label: '1920×1080 (Full HD)', value: '1920x1080' },
  { label: '1440×900 (MacBook)', value: '1440x900' },
  { label: '1366×768 (Laptop)', value: '1366x768' },
  { label: '1280×720 (HD)', value: '1280x720' },
  { label: '768×1024 (iPad)', value: '768x1024' },
  { label: '375×812 (iPhone)', value: '375x812' },
  { label: '360×640 (Android)', value: '360x640' },
] as const;

function viewportToString(vp: { width: number; height: number } | null | undefined): string {
  if (!vp) return '';
  return `${vp.width}x${vp.height}`;
}

function parseViewportString(value: string): { width: number; height: number } | null {
  if (!value) return null;
  const [w, h] = value.split('x').map(Number);
  if (!w || !h) return null;
  return { width: w, height: h };
}

export function CreateTestModal({ isOpen, onClose, onTestCreated }: CreateTestModalProps) {
  const dispatch = useAppDispatch();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);

  const { data: projects = [] } = useGetProjectsQuery(undefined, { skip: !isOpen });
  const [assignToProject] = useAssignToProjectMutation();
  const [createRequirement] = useCreateRequirementMutation();
  const [createTest] = useCreateTestMutation();
  const [putTestFeature] = usePutTestFeatureMutation();

  const [mode, setMode] = useState<CreateMode>('ai');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [useVrt, setUseVrt] = useState(false);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [projectId, setProjectId] = useState<number | null>(selectedProjectId);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentOutput, setAgentOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [gherkinDraft, setGherkinDraft] = useState('');
  const [gherkinDraftDirty, setGherkinDraftDirty] = useState(false);
  const [isCreatingGherkin, setIsCreatingGherkin] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [agentOutput]);

  useEffect(() => {
    if (isOpen) {
      setMode('ai');
      setName('');
      setDescription('');
      setUseVrt(false);
      setViewport(null);
      setAgentStatus('idle');
      setAgentOutput('');
      setError(null);
      setGherkinDraft('');
      setGherkinDraftDirty(false);
      setIsCreatingGherkin(false);
    }
  }, [isOpen]);

  // Keep the Gherkin draft in sync with name/description until the user edits it.
  useEffect(() => {
    if (mode !== 'gherkin' || gherkinDraftDirty) return;
    setGherkinDraft(defaultGherkinTemplate(name.trim() || 'My test', description.trim()));
  }, [mode, name, description, gherkinDraftDirty]);

  useEffect(() => {
    if (isOpen) {
      setProjectId(selectedProjectId);
    }
  }, [isOpen, selectedProjectId]);

  const handleClose = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    onClose();
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setAgentStatus('stopped');
    setError(null);
  };

  const handleGenerate = async () => {
    if (!name.trim()) {
      setError('Test name is required');
      return;
    }
    if (!description.trim()) {
      setError('Please describe what the test should do');
      return;
    }

    setError(null);
    setAgentStatus('running');
    setAgentOutput('');

    const prompt = buildPrompt(name.trim(), description.trim(), useVrt, viewport);
    // The request is kept as a requirement (source "prompt"), and the test the agent records is
    // linked to it: what the test is for is not lost with the conversation.
    let requirement: string | undefined;
    try {
      const firstLine = description.trim().split('\n')[0];
      const saved = await createRequirement({
        title: firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine,
        description: description.trim(), source: 'prompt', project_id: projectId,
      }).unwrap();
      requirement = saved.requirement.key;
    } catch {
      requirement = undefined;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, requirement }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'chunk') {
              setAgentOutput(prev => prev + event.text);
            } else if (event.type === 'error') {
              setError(event.error);
              setAgentStatus('error');
            } else if (event.type === 'done') {
              if (event.exitCode === 0) {
                try {
                  // Verify the test was actually created by invalidating the cache
                  dispatch(testsApi.util.invalidateTags([{ type: 'TestList', id: 'LIST' }]));

                  if (projectId) {
                    try {
                      await assignToProject({ testName: name.trim(), projectId }).unwrap();
                    } catch (assignErr: any) {
                      console.error('Failed to assign test to project:', assignErr);
                      setError(`Warning: Test was created but could not be assigned to project (${assignErr.message}). You can manually assign it later.`);
                    }
                  }
                  setAgentStatus('done');
                  onTestCreated(name.trim(), projectId);
                } catch {
                  setAgentStatus('error');
                  setError('Agent finished but the test was not saved. Please try again.');
                }
              } else {
                setAgentStatus('error');
                if (!error) {
                  setError(`Agent exited with code ${event.exitCode}`);
                }
              }
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // User stopped the agent — status is already set by handleStop
        return;
      }
      setError(err.message);
      setAgentStatus('error');
    } finally {
      abortRef.current = null;
    }
  };

  const handleCreateFromGherkin = async () => {
    if (!name.trim()) {
      setError('Test name is required');
      return;
    }
    if (projectId == null) {
      setError('A project is required to use Gherkin. Pick one below.');
      return;
    }
    if (!gherkinDraft.trim()) {
      setError('Gherkin content is empty');
      return;
    }

    setError(null);
    setIsCreatingGherkin(true);
    try {
      await createTest({
        name: name.trim(),
        description: description.trim() || undefined,
      }).unwrap();

      await assignToProject({ testName: name.trim(), projectId }).unwrap();
      await putTestFeature({ testName: name.trim(), feature: gherkinDraft }).unwrap();

      dispatch(testsApi.util.invalidateTags([{ type: 'TestList', id: 'LIST' }]));
      onTestCreated(name.trim(), projectId, 'gherkin');
    } catch (err) {
      const body = (err as { data?: { error?: string; errors?: string[] } })?.data;
      if (body?.errors?.length) {
        setError(body.errors.join('\n'));
      } else {
        setError(body?.error || (err as Error).message || 'Failed to create test');
      }
    } finally {
      setIsCreatingGherkin(false);
    }
  };

  if (!isOpen) return null;

  const isRunning = agentStatus === 'running';
  const showOutput = agentStatus !== 'idle';
  const isBusy = isRunning || isCreatingGherkin;

  return (
    <div className="modal" onClick={handleClose}>
      <div className="modal-overlay" />
      <div
        className={`modal-content create-wf-modal ${showOutput ? 'create-wf-modal--expanded' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{mode === 'gherkin' ? 'Create Test from Gherkin' : 'Create Test with AI'}</h3>
          <button className="btn-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="create-mode-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'ai'}
              className={`create-mode-btn ${mode === 'ai' ? 'active' : ''}`}
              onClick={() => !isBusy && setMode('ai')}
              disabled={isBusy}
            >
              <Bot size={16} />
              <div className="create-mode-btn__text">
                <strong>AI Agent</strong>
                <span>Describe and let the agent record it</span>
              </div>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'gherkin'}
              className={`create-mode-btn ${mode === 'gherkin' ? 'active' : ''}`}
              onClick={() => !isBusy && setMode('gherkin')}
              disabled={isBusy}
            >
              <FileCode size={16} />
              <div className="create-mode-btn__text">
                <strong>Gherkin</strong>
                <span>Write the scenario yourself</span>
              </div>
            </button>
          </div>

          <div className="field-group">
            <label>Test Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. login-test, search-validation..."
              disabled={isRunning}
              autoFocus
            />
          </div>

          <div className="field-group">
            <label>Description</label>
            <textarea
              className="create-wf-textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe what the test should verify step by step. The AI agent will use the browser to record the actions and add assertions.&#10;&#10;Example: Go to google.com, search for 'React documentation', verify the results page contains 'react.dev'."
              disabled={isRunning}
              rows={4}
            />
          </div>

          {mode === 'ai' && (
            <>
              <div style={{ marginBottom: '16px' }}>
                <label htmlFor="useVrtCheck" style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text)' }}>
                  <input
                    type="checkbox"
                    id="useVrtCheck"
                    checked={useVrt}
                    onChange={e => setUseVrt(e.target.checked)}
                    disabled={isRunning}
                    style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  Enable Visual Regression Testing (VRT)
                </label>
              </div>

              <div className="field-group">
                <label>Window Resolution</label>
                <select
                  value={viewportToString(viewport)}
                  onChange={(e) => setViewport(parseViewportString(e.target.value))}
                  disabled={isRunning}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    fontSize: '13px',
                    fontFamily: 'var(--font)',
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    opacity: isRunning ? 0.5 : 1
                  }}
                >
                  {VIEWPORT_PRESETS.map(preset => (
                    <option key={preset.value} value={preset.value}>{preset.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="field-group">
            <label>{mode === 'gherkin' ? 'Project (required)' : 'Project (optional)'}</label>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => !isBusy && setShowProjectDropdown(!showProjectDropdown)}
                disabled={isBusy}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  color: 'var(--text)',
                  fontSize: '13px',
                  textAlign: 'left',
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  opacity: isRunning ? 0.5 : 1
                }}
              >
                <Folder size={14} />
                {projectId
                  ? projects.find(p => p.id === projectId)?.name
                    || (projects.length === 0 ? 'Loading...' : 'Project #' + projectId)
                  : 'No project'}
              </button>

              {showProjectDropdown && (
                <div style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '4px',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                  zIndex: 100,
                  maxHeight: '200px',
                  overflowY: 'auto'
                }}>
                  <div
                    className="project-assign-option"
                    onClick={() => { setProjectId(null); setShowProjectDropdown(false); }}
                    style={{
                      padding: '8px 12px',
                      fontSize: '13px',
                      cursor: 'pointer',
                      background: projectId === null ? 'rgba(124, 58, 237, 0.15)' : 'transparent',
                      color: projectId === null ? 'var(--accent)' : 'var(--text)'
                    }}
                  >
                    No project
                  </div>
                  {projects.map(project => (
                    <div
                      key={project.id}
                      className="project-assign-option"
                      onClick={() => { setProjectId(project.id); setShowProjectDropdown(false); }}
                      style={{
                        padding: '8px 12px',
                        fontSize: '13px',
                        cursor: 'pointer',
                        background: projectId === project.id ? 'rgba(124, 58, 237, 0.15)' : 'transparent',
                        color: projectId === project.id ? 'var(--accent)' : 'var(--text)'
                      }}
                    >
                      {project.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {mode === 'gherkin' && (
            <div className="field-group">
              <label>Gherkin scenario</label>
              <textarea
                className="gherkin-textarea gherkin-textarea--modal"
                value={gherkinDraft}
                onChange={(e) => { setGherkinDraft(e.target.value); setGherkinDraftDirty(true); }}
                spellCheck={false}
                disabled={isBusy}
                rows={12}
              />
              <p className="create-wf-hint">
                Edit the template to match your scenario. It will be validated against the project's step definitions on save.
              </p>
            </div>
          )}

          {error && (
            <div className="create-wf-error" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>
          )}

          {mode === 'ai' && showOutput && (
            <div className="create-wf-output-section">
              <div className="create-wf-output-header">
                <span className="create-wf-output-label">
                  {isRunning && <Loader2 size={14} className="spin" />}
                  Agent Output
                </span>
                <span className={`create-wf-status create-wf-status--${agentStatus}`}>
                 {agentStatus === 'running' && 'Running...'}
                  {agentStatus === 'done' && 'Completed'}
                  {agentStatus === 'error' && 'Failed'}
                  {agentStatus === 'stopped' && 'Stopped'}
                </span>
              </div>
              <div className="create-wf-output" ref={outputRef}>
                <pre>{agentOutput || 'Waiting for agent output...'}</pre>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {isRunning ? (
            <Button variant="danger" icon={Square} onClick={handleStop}>
              Stop Agent
            </Button>
          ) : (
            <Button variant="cancel" onClick={handleClose} disabled={isCreatingGherkin}>
              {agentStatus === 'done' || agentStatus === 'stopped' ? 'Close' : 'Cancel'}
            </Button>
          )}
          {mode === 'ai' && agentStatus !== 'done' && agentStatus !== 'stopped' && (
            <Button
              variant="primary"
              icon={isRunning ? Loader2 : Wand2}
              onClick={handleGenerate}
              disabled={isRunning || !name.trim() || !description.trim()}
            >
              {isRunning ? 'Generating...' : 'Generate Test'}
            </Button>
          )}
          {mode === 'gherkin' && (
            <Button
              variant="primary"
              icon={isCreatingGherkin ? Loader2 : FileCode}
              onClick={handleCreateFromGherkin}
              disabled={isCreatingGherkin || !name.trim() || projectId == null}
            >
              {isCreatingGherkin ? 'Creating...' : 'Create & Edit Gherkin'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function buildPrompt(name: string, description: string, useVrt: boolean, viewport: { width: number; height: number } | null): string {
  let vrtParam = useVrt ? `, use_vrt=true` : '';
  let vpParam = viewport ? `, viewport_width=${viewport.width}, viewport_height=${viewport.height}` : '';
  
  return `You are a browser test automation assistant. Your task is to create a reusable test by recording browser actions and adding assertions to verify expected behavior.

TEST NAME: "${name}"
TEST DESCRIPTION: "${description}"

INSTRUCTIONS:
1. First, call the "start_recording" tool with the name "${name}" and description "${description}"${vrtParam}${vpParam}.
2. Then, execute the browser actions described above step by step using the appropriate browser tools (navigate, click, fill, snapshot, etc.). Steps are automatically recorded — do NOT call record_step.
3. After all steps are done, call "stop_recording" to save the test (variable detection runs automatically).
4. After the test is saved, add assertions using "add_assertion" to verify the expected outcomes. Consider adding assertions for:
   - Page URL or title after navigation
   - Presence of expected elements
   - Text content of key elements
   - Visibility of success/error messages

IMPORTANT:
- Use "snapshot" to scan the page and identify elements before interacting with them.
- Use the element references (@e1, @e2, etc.) from snapshot results for precise interactions.
- Be methodical: navigate first, then snapshot, then interact with elements.
- If a step fails, try an alternative approach (different selector, etc.).
- Always add at least one assertion to verify the test outcome.

Begin now.`;
}
