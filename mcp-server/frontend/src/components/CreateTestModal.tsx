import { useState, useRef, useEffect } from 'react';
import { Button } from './Button';
import { X, Wand2, Loader2, Square, FileCode, Bot, Sparkles, Play } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { ProjectField } from './ProjectSelector';
import { LiveScreen } from './LiveScreen';
import { AfterRecordingSwitch } from './BrowserWindows';
import { toolCallLine, appendLine } from '../agent-log';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useCreateRequirementMutation } from '../store/services/requirementsApi';
import {
  testsApi,
  useAssignToProjectMutation,
  useProposeBusinessStepsMutation,
} from '../store/services/testsApi';
import { AgentAskForm } from './AgentAsk';
import { useRunWindow } from '../agent-asks';
import type { AgentAsk } from '../types';

export type CreateMode = 'ai' | 'gherkin';

/**
 * What the modal opens with for a requirement's planned case: its scenario — to create the
 * test from, or for the agent to record — and the requirement and case the test is linked to.
 */
export interface CreateTestPreset {
  mode: CreateMode;
  name: string;
  description: string;
  projectId: number | null;
  gherkin: string | null;
  /** A requirement's planned case: the test is linked to it. */
  requirement?: string;
  caseId?: number;
  /** A reported bug to reproduce (mcp-server/lib/bugs.js reproBrief): the test the agent records is the bug's. */
  bugId?: number;
}

interface CreateTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTestCreated: (testName: string, projectId: number | null, mode?: CreateMode) => void;
  preset?: CreateTestPreset | null;
}

type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'stopped';

/**
 * A phrase of the scenario against the project's library (mcp-server/lib/scenario-recording.js):
 * a business step, a phrase of the library, one on an element to find on the page, or new.
 */
interface ScenarioPhrase {
  n: number;
  written: string;
  text: string;
  kind: 'library' | 'phrase' | 'find' | 'new';
  target?: string;
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

export function CreateTestModal({ isOpen, onClose, onTestCreated, preset = null }: CreateTestModalProps) {
  const dispatch = useAppDispatch();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);

  const [assignToProject] = useAssignToProjectMutation();
  const [createRequirement] = useCreateRequirementMutation();
  const [proposeBusinessSteps] = useProposeBusinessStepsMutation();

  const [mode, setMode] = useState<CreateMode>('ai');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [useVrt, setUseVrt] = useState(false);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  // The project in scope to start with; with all of them in scope, chosen (undefined until then).
  const [projectId, setProjectId] = useState<number | null | undefined>(selectedProjectId ?? undefined);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentOutput, setAgentOutput] = useState('');
  // The tab the agent works in, once it has opened one: shown live beside its output.
  const [liveTabId, setLiveTabId] = useState<number | null>(null);
  // A question the agent asks while it works (ask_user): answered here, beside its browser.
  const [ask, setAsk] = useState<AgentAsk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gherkinDraft, setGherkinDraft] = useState('');
  // The agent writing the scenario from the description, with the project's library.
  const [writing, setWriting] = useState(false);
  // Each phrase of the scenario against the library, as the server reads it; or why it does not read.
  const [phrases, setPhrases] = useState<ScenarioPhrase[]>([]);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [agentOutput]);

  useEffect(() => {
    if (isOpen) {
      setMode(preset?.mode ?? 'ai');
      setName(preset?.name ?? '');
      setDescription(preset?.description ?? '');
      setUseVrt(false);
      setViewport(null);
      setAgentStatus('idle');
      setAgentOutput('');
      setLiveTabId(null);
      setAsk(null);
      setError(null);
      setGherkinDraft(preset?.gherkin ?? '');
      setWriting(false);
      setPhrases([]);
      setScenarioError(null);
    }
  }, [isOpen, preset]);

  const { data: projects = [] } = useGetProjectsQuery();
  const language = projects.find((p) => p.id === projectId)?.language ?? 'en';

  // The scenario read against the project's library as it is written: which phrases are its
  // steps, which are new.
  useEffect(() => {
    if (mode !== 'gherkin' || projectId == null || !gherkinDraft.trim()) {
      setPhrases([]);
      setScenarioError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/scenario/check`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gherkin: gherkinDraft }), signal: controller.signal,
        });
        const data = await response.json();
        setPhrases(response.ok ? data.phrases ?? [] : []);
        setScenarioError(response.ok ? null : data.error ?? 'The scenario does not read');
      } catch {
        // Typed over, or the server is away: read again at the next change.
      }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, projectId, gherkinDraft]);

  useEffect(() => {
    if (isOpen) {
      setProjectId(preset ? preset.projectId : selectedProjectId ?? undefined);
    }
  }, [isOpen, selectedProjectId, preset]);

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
    if (projectId === undefined) {
      setError('Choose the project the test belongs to');
      return;
    }
    return runAgent(buildPrompt(name.trim(), description.trim(), useVrt, viewport), { proposeSteps: true });
  };

  // The agent writes the scenario from the description, with the project's library: shown to edit.
  const handleWriteScenario = async () => {
    if (projectId == null) {
      setError('A Gherkin test belongs to a project: its library is the project\'s. Pick one above.');
      return;
    }
    if (!description.trim()) {
      setError('Describe what the test should check: the agent writes its scenario from it');
      return;
    }
    if (gherkinDraft.trim() && !window.confirm('Replace the scenario written here with the one the agent writes?')) return;
    setError(null);
    setWriting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/scenario/write`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'Test', description: description.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setGherkinDraft(data.gherkin);
      setPhrases(data.phrases ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWriting(false);
    }
  };

  // The agent records the test phrase by phrase, its output and its browser shown here.
  const handleRecordScenario = async () => {
    if (!name.trim()) {
      setError('Test name is required');
      return;
    }
    if (projectId == null) {
      setError('A Gherkin test belongs to a project: its library is the project\'s. Pick one above.');
      return;
    }
    if (!gherkinDraft.trim()) {
      setError('Write the scenario first, or have it written from the description');
      return;
    }
    if (scenarioError) {
      setError(`The scenario does not read: ${scenarioError}`);
      return;
    }
    return runAgent(buildScenarioPrompt(name.trim(), description.trim(), gherkinDraft, projectId, useVrt, viewport), { proposeSteps: false });
  };

  const runAgent = async (prompt: string, { proposeSteps }: { proposeSteps: boolean }) => {
    setError(null);
    setAgentStatus('running');
    setAgentOutput('');
    setLiveTabId(null);
    setAsk(null);

    // The request is kept as a requirement (source "prompt"), and the test the agent records is
    // linked to it: what the test is for is not lost with the conversation. A requirement's
    // case is linked to its own.
    let requirement: string | undefined = preset?.requirement;
    if (!requirement && !preset?.bugId && description.trim()) {
      try {
        const firstLine = description.trim().split('\n')[0];
        const saved = await createRequirement({
          title: firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine,
          description: description.trim(), source: 'prompt', project_id: projectId ?? null,
        }).unwrap();
        requirement = saved.requirement.key;
      } catch {
        requirement = undefined;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, requirement, case_id: preset?.caseId, bug_id: preset?.bugId, project_id: projectId ?? null }),
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
            } else if (event.type === 'tool_call') {
              setAgentOutput(prev => appendLine(prev, toolCallLine(event.tool, event.input)));
            } else if (event.type === 'live') {
              setLiveTabId(event.tabId);
            } else if (event.type === 'ask') {
              setAsk(event.ask);
            } else if (event.type === 'ask_done') {
              setAsk((current) => (current?.id === event.id ? null : current));
            } else if (event.type === 'error') {
              setError(event.error);
              setAgentStatus('error');
            } else if (event.type === 'done') {
              if (event.exitCode === 0) {
                try {
                  // The agent may end without saving the test (a URL it lacks, a page that does not
                  // load): it then says why, in its output, which stays open here.
                  const saved = await fetch(`/api/tests/${encodeURIComponent(name.trim())}`);
                  if (!saved.ok) {
                    setAgentStatus('error');
                    setError('The agent stopped without saving the test: its last message, below, says why. Add what it lacks to the description (a URL to start from, say) and generate again.');
                    continue;
                  }
                  dispatch(testsApi.util.invalidateTags([{ type: 'TestList', id: 'LIST' }]));

                  if (projectId) {
                    try {
                      await assignToProject({ testName: name.trim(), projectId }).unwrap();
                    } catch (assignErr: any) {
                      console.error('Failed to assign test to project:', assignErr);
                      setError(`Warning: Test was created but could not be assigned to project (${assignErr.message}). You can manually assign it later.`);
                    }
                  }
                  // The agent then proposes its business steps, in the background: the test page shows them.
                  // Recorded from a scenario, its new phrases already joined the library.
                  if (projectId && proposeSteps) proposeBusinessSteps(name.trim());
                  setAgentStatus('done');
                  onTestCreated(name.trim(), projectId ?? null, mode);
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

  // While its agent works, the dock of this page leaves other runs' questions to their windows.
  useRunWindow(isOpen && agentStatus === 'running');

  if (!isOpen) return null;

  const isRunning = agentStatus === 'running';
  const showOutput = agentStatus !== 'idle';
  const isBusy = isRunning || writing;
  // While the agent works, and once it is done, the browser and the agent's output take the
  // room: the form gives way to a line saying what was asked. It comes back to try again.
  const watching = isRunning || agentStatus === 'done';
  const count = (kind: ScenarioPhrase['kind']) => phrases.filter((p) => p.kind === kind).length;
  const newPhrases = phrases.filter((p) => p.kind === 'new');

  return (
    // Closed by its buttons only (✕, Cancel / Close): a click beside it closed it, losing what was
    // typed — and stopping the agent recording the test.
    <div className="modal">
      <div className="modal-overlay" />
      <div
        className={`modal-content create-wf-modal ${showOutput ? 'create-wf-modal--expanded' : ''} ${showOutput ? 'create-wf-modal--live' : ''}`}
      >
        <div className="modal-header">
          <h3>{mode === 'gherkin' ? 'Create test from Gherkin' : 'Create test with AI'}</h3>
          <button className="btn-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {preset?.bugId && (
            <p className="create-wf-hint create-wf-hint--linked">
              For bug #{preset.bugId}: the agent follows the report, records the test that shows the bug and runs it once. It must fail while the bug is there; it is kept as the bug's test, and confirms the fix when it passes.
            </p>
          )}
          {preset?.requirement && (
            <p className="create-wf-hint create-wf-hint--linked">
              For {preset.requirement}, case #{preset.caseId}: the test is linked to it.
              {preset.mode === 'ai' && ' The agent is told the requirement\'s criteria: expected results come from them.'}
            </p>
          )}
          {watching && (
            <p className="create-wf-asked">
              <strong>{name.trim()}</strong>
              <span>{description.trim()}</span>
            </p>
          )}
          {!watching && (<>
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
                <span>Its scenario first, with the project's steps</span>
              </div>
            </button>
          </div>

          <ProjectField
            value={projectId}
            onChange={setProjectId}
            allowNone={mode !== 'gherkin'}
            hint={mode === 'gherkin' ? 'Its phrases come from the project: a Gherkin test needs one.' : 'The request is kept as a requirement of this project, the test too.'}
          />

          <div className="field-group">
            <label>Test name</label>
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
            <label>What should the test check?</label>
            <textarea
              className="create-wf-textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={mode === 'gherkin'
                ? "Describe what the test should check. The agent writes its scenario with the project's steps, and proposes new ones where none says it.\n\nExample: search a product, add the second result to the cart three times, check the cart total is three times its price."
                : "Describe what the test should verify step by step. The AI agent will use the browser to record the actions and add assertions.\n\nExample: Go to google.com, search for 'React documentation', verify the results page contains 'react.dev'."}
              disabled={isBusy}
              rows={4}
            />
            {mode === 'gherkin' && (
              <div className="create-wf-write">
                <Button size="sm" variant="secondary" icon={writing ? Loader2 : Sparkles} onClick={handleWriteScenario}
                  disabled={isBusy || projectId == null || !description.trim()}>
                  {writing ? 'Writing the scenario…' : 'Generate Gherkin'}
                </Button>
                <span className="create-wf-hint">With the steps of the project's library first; what none says, as a new step.</span>
              </div>
            )}
          </div>

          {mode === 'gherkin' && (
            <div className="field-group">
              <label>Gherkin scenario</label>
              <textarea
                className="gherkin-textarea gherkin-textarea--modal"
                value={gherkinDraft}
                onChange={(e) => setGherkinDraft(e.target.value)}
                placeholder={language === 'fr'
                  ? '# language: fr\nFonctionnalité: …\n\n  Scénario: …\n    Soit je suis sur "…"\n    Quand …\n    Alors …'
                  : 'Feature: …\n\n  Scenario: …\n    Given I am on "…"\n    When …\n    Then …'}
                spellCheck={false}
                disabled={isBusy}
                rows={12}
              />
              {scenarioError ? (
                <p className="create-wf-hint create-wf-hint--error">It does not read yet: {scenarioError}</p>
              ) : phrases.length > 0 ? (
                <div className="scenario-steps">
                  {/* The project's business steps apart from the generic phrases every project has: only those say its app. */}
                  <p className="create-wf-hint">
                    Of its {phrases.length} steps: <strong>{count('library')} business step{count('library') === 1 ? '' : 's'}</strong> of the project
                    {' · '}<strong>{count('phrase') + count('find')} generic phrase{count('phrase') + count('find') === 1 ? '' : 's'}</strong> every project has (go to, click, see…
                    {count('find') > 0 && <>; {count('find')} on an element to find on the page, named as written</>})
                    {' · '}<strong>{newPhrases.length} new</strong>{newPhrases.length > 0 && <> — the agent finds how to do {newPhrases.length === 1 ? 'it' : 'them'} on the page, and {newPhrases.length === 1 ? 'it joins' : 'they join'} the library once the test is recorded</>}.
                  </p>
                  {(count('library') > 0 || newPhrases.length > 0) && (
                    <ul className="scenario-steps__new">
                      {phrases.filter((p) => p.kind === 'library').map((p) => <li key={p.n}><span className="tag tag--green">business step</span> {p.written} {p.text}</li>)}
                      {newPhrases.map((p) => <li key={p.n}><span className="tag tag--blue">new</span> {p.written} {p.text}</li>)}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="create-wf-hint">Generate it from the description, or write it. At <em>Create test</em>, the agent records it in the browser, phrase by phrase.</p>
              )}
            </div>
          )}

          {/* The recording's options, whichever way it is made. */}
          <div className="create-options">
            <label className="switch">
              <input type="checkbox" checked={useVrt} onChange={e => setUseVrt(e.target.checked)} disabled={isRunning} />
              <span className="switch__text">Visual regression (VRT)<span className="switch__hint">Keep a screenshot to compare the next runs against.</span></span>
            </label>
            <label className="field">
              <span className="field__label">Window size</span>
              <select value={viewportToString(viewport)} onChange={(e) => setViewport(parseViewportString(e.target.value))} disabled={isRunning}>
                {VIEWPORT_PRESETS.map(preset => (
                  <option key={preset.value} value={preset.value}>{preset.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="create-options__after">
            <AfterRecordingSwitch hint="Once the agent has saved the test, the window it recorded it in closes — for every recording (Settings → Browser windows)." />
          </div>
          </>)}

          {error && (
            <div className="create-wf-error" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>
          )}

          {showOutput && (
            <div className="create-wf-run">
            <LiveScreen tabId={liveTabId} running={isRunning} waiting="Waiting for the agent to open a page…" />
            <div className="create-wf-run__log">
            {ask && isRunning && <AgentAskForm ask={ask} onSettled={() => setAsk(null)} />}
            <div className="create-wf-run__output">
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
            </div>
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
            <Button variant="cancel" onClick={handleClose} disabled={writing}>
              {agentStatus === 'done' || agentStatus === 'stopped' ? 'Close' : 'Cancel'}
            </Button>
          )}
          {mode === 'ai' && agentStatus !== 'done' && agentStatus !== 'stopped' && (
            <Button
              variant="primary"
              icon={isRunning ? Loader2 : Wand2}
              onClick={handleGenerate}
              disabled={isRunning || !name.trim() || !description.trim() || projectId === undefined}
            >
              {isRunning ? 'Generating…' : 'Generate test'}
            </Button>
          )}
          {mode === 'gherkin' && agentStatus !== 'done' && agentStatus !== 'stopped' && (
            <Button
              variant="primary"
              icon={isRunning ? Loader2 : Play}
              onClick={handleRecordScenario}
              disabled={isBusy || !name.trim() || projectId == null || !gherkinDraft.trim() || !!scenarioError}
              title="The agent records it in the browser, phrase by phrase: its output and its browser show here"
            >
              {isRunning ? 'Recording…' : 'Create test'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the agent recording a test from its scenario is told: start_recording with it, as written —
 * its answer numbers the phrases and says how to do each (mcp-server/lib/scenario-recording.js).
 */
function buildScenarioPrompt(name: string, description: string, gherkin: string, projectId: number, useVrt: boolean, viewport: { width: number; height: number } | null): string {
  const options = [
    `name "${name}"`,
    description ? `description ${JSON.stringify(description)}` : null,
    `project_id ${projectId}`,
    useVrt ? 'use_vrt true' : null,
    viewport ? `viewport_width ${viewport.width}, viewport_height ${viewport.height}` : null,
  ].filter(Boolean).join(', ');
  return `You are a browser test automation assistant. Record the test below from its Gherkin scenario, phrase by phrase, in the browser.

1. Call "start_recording" with ${options}, and scenario: the feature below, exactly as written. Its answer numbers the phrases and says how to do each.
2. For each phrase, in order: call "start_phrase" with its number and the phrase, then do it in the browser — a business step of the project with "play_business_step", any other with the browser tools (navigate, snapshot, click, fill, select…), a Then phrase with "add_assertion" (test_name "${name}") right after the actions before it. Do only what the phrase says; values in quotes are the values to type, pick or expect.
3. Use "snapshot" to find on the page what a phrase names before acting on it. If a step fails, try another way to do the same thing; never change what the phrase checks.
4. When every phrase is done, call "stop_recording": the new phrases join the project's library.

The scenario:

\`\`\`gherkin
${gherkin.trim()}
\`\`\`

Begin now.`;
}

function buildPrompt(name: string, description: string, useVrt: boolean, viewport: { width: number; height: number } | null): string {
  let vrtParam = useVrt ? `, use_vrt=true` : '';
  let vpParam = viewport ? `, viewport_width=${viewport.width}, viewport_height=${viewport.height}` : '';
  
  return `You are a browser test automation assistant. Your task is to create a reusable test by recording browser actions and adding assertions to verify expected behavior.

TEST NAME: "${name}"
TEST DESCRIPTION: "${description}"

INSTRUCTIONS:
1. First, call the "start_recording" tool with the name "${name}" and description "${description}"${vrtParam}${vpParam}.
2. Then, execute the browser actions described above step by step using the appropriate browser tools (navigate, click, fill, snapshot, etc.). Steps are automatically recorded — do NOT call record_step except to make a step optional (record_step(action_id, optional: true): a cookie banner or a popup only shown sometimes).
3. Check each outcome as you go: right after an action whose result matters (a page or a tab opened, a form sent, a list or search results loaded), call "add_assertion" with test_name "${name}", before the next action. The check is recorded as the next step, and a replay waits there for what it checks. Check for instance:
   - Page URL or title after navigation
   - Presence of expected elements
   - Text content of key elements
   - Visibility of success/error messages
   A value typed or picked (a search, a suggestion) becomes a variable, replayed with other values: after it, act on and check what holds for any value. Check the value itself in the title, a heading or the URL, a list of results shown (its container, a count) — never one particular result (a product, a row) only this value brings. Act on a result by its place among the others ("the second result"), not by a name only it has (a product's name in an aria-label); a name the next steps need, keep it first with "capture_value" and use {{name}} in their selectors.
   A computed amount (3 × a price): keep the price with "capture_value", then expect "{{price * 3 | 0,00}}" (text_contains; "6,42 €" reads as 6.42).
   A test that adds to a cart or creates data removes it at the end, so the next run starts the same.
4. To look at the page without recording a step, use "snapshot" or "extract"; an "execute_js" that only looked: record_step(action_id, remove: true).
   A click's result may say "List: taken as item N of M": that click becomes a variable replayed by its place or its text. If it is not what you meant, say so right away: record_step(action_id, pick: "none") for a one-off button, "by_place" for "the second result", "by_text" for "the category Garden".
5. When all steps are done and checked, call "stop_recording" to save the test (variable detection runs automatically).

IMPORTANT:
- Use "snapshot" to scan the page and identify elements before interacting with them.
- Use the element references (@e1, @e2, etc.) from snapshot results for precise interactions.
- Be methodical: navigate first, then snapshot, then interact with elements.
- If a step fails, try an alternative approach (different selector, etc.).
- Always add at least one assertion to verify the test outcome — while recording, never all of them at the end.

Begin now.`;
}
