import { useState, useRef, useEffect } from 'react';
import { Button } from './Button';
import { X, Wand2, Loader2, Folder, Square } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { useGetProjectsQuery, } from '../store/services/projectsApi';
import { testsApi, useAssignToProjectMutation } from '../store/services/testsApi';

interface CreateTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTestCreated: (testName: string, projectId: number | null) => void;
}

type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'stopped';

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

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [useVrt, setUseVrt] = useState(false);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [projectId, setProjectId] = useState<number | null>(selectedProjectId);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentOutput, setAgentOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [agentOutput]);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setDescription('');
      setUseVrt(false);
      setViewport(null);
      setAgentStatus('idle');
      setAgentOutput('');
      setError(null);
    }
  }, [isOpen]);

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

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
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

  if (!isOpen) return null;

  const isRunning = agentStatus === 'running';
  const showOutput = agentStatus !== 'idle';

  return (
    <div className="modal" onClick={handleClose}>
      <div className="modal-overlay" />
      <div
        className={`modal-content create-wf-modal ${showOutput ? 'create-wf-modal--expanded' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Create Test with AI</h3>
          <button className="btn-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
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

          <div className="field-group">
            <label>Project (optional)</label>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => !isRunning && setShowProjectDropdown(!showProjectDropdown)}
                disabled={isRunning}
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

          {error && (
            <div className="create-wf-error">{error}</div>
          )}

          {showOutput && (
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
            <Button variant="cancel" onClick={handleClose}>
              {agentStatus === 'done' || agentStatus === 'stopped' ? 'Close' : 'Cancel'}
            </Button>
          )}
          {agentStatus !== 'done' && agentStatus !== 'stopped' && (
            <Button
              variant="primary"
              icon={isRunning ? Loader2 : Wand2}
              onClick={handleGenerate}
              disabled={isRunning || !name.trim() || !description.trim()}
            >
              {isRunning ? 'Generating...' : 'Generate Test'}
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
