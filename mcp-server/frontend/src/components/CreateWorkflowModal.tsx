import { useState, useRef, useEffect } from 'react';
import { Button } from './Button';
import { X, Wand2, Loader2 } from 'lucide-react';

interface CreateWorkflowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWorkflowCreated: (workflowName: string) => void;
}

type AgentStatus = 'idle' | 'running' | 'done' | 'error';

export function CreateWorkflowModal({ isOpen, onClose, onWorkflowCreated }: CreateWorkflowModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentOutput, setAgentOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [agentOutput]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setDescription('');
      setAgentStatus('idle');
      setAgentOutput('');
      setError(null);
    }
  }, [isOpen]);

  const handleClose = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    onClose();
  };

  const handleGenerate = async () => {
    if (!name.trim()) {
      setError('Workflow name is required');
      return;
    }
    if (!description.trim()) {
      setError('Please describe what the workflow should do');
      return;
    }

    setError(null);
    setAgentStatus('running');
    setAgentOutput('');

    const prompt = buildPrompt(name.trim(), description.trim());

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
              setAgentStatus(event.exitCode === 0 ? 'done' : 'error');
              if (event.exitCode === 0) {
                // Workflow should have been created by the agent via MCP
                onWorkflowCreated(name.trim());
              }
              if (event.exitCode !== 0 && !error) {
                setError(`Agent exited with code ${event.exitCode}`);
              }
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
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
          <h3>Create Workflow with AI</h3>
          <button className="btn-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* Name field */}
          <div className="field-group">
            <label>Workflow Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. login-flow, search-products..."
              disabled={isRunning}
              autoFocus
            />
          </div>

          {/* Description field */}
          <div className="field-group">
            <label>Description</label>
            <textarea
              className="create-wf-textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe what the workflow should do step by step. The AI agent will use the browser to record the actions.&#10;&#10;Example: Go to google.com, search for 'React documentation', click on the first result."
              disabled={isRunning}
              rows={4}
            />
          </div>

          {error && (
            <div className="create-wf-error">{error}</div>
          )}

          {/* Agent streaming output */}
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
                </span>
              </div>
              <div className="create-wf-output" ref={outputRef}>
                <pre>{agentOutput || 'Waiting for agent output...'}</pre>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <Button variant="cancel" onClick={handleClose} disabled={isRunning}>
            {agentStatus === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {agentStatus !== 'done' && (
            <Button
              variant="primary"
              icon={isRunning ? Loader2 : Wand2}
              onClick={handleGenerate}
              disabled={isRunning || !name.trim() || !description.trim()}
            >
              {isRunning ? 'Generating...' : 'Generate Workflow'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function buildPrompt(name: string, description: string): string {
  return `You are a browser automation assistant. Your task is to create a reusable workflow by recording browser actions.

WORKFLOW NAME: "${name}"
WORKFLOW DESCRIPTION: "${description}"

INSTRUCTIONS:
1. First, call the "start_recording" tool with the name "${name}" and description "${description}".
2. Then, execute the browser actions described above step by step using the appropriate browser tools (navigate, click, fill, snapshot, etc.). Steps are automatically recorded — do NOT call record_step.
3. After all steps are done, call "stop_recording" to save the workflow (variable detection runs automatically).

IMPORTANT:
- Use "snapshot" to scan the page and identify elements before interacting with them.
- Use the element references (@e1, @e2, etc.) from snapshot results for precise interactions.
- Be methodical: navigate first, then snapshot, then interact with elements.
- If a step fails, try an alternative approach (different selector, etc.).

Begin now.`;
}
