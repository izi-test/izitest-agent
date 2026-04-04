import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Workflow, Step } from '../types';
import { useAppContext } from '../context/AppContext';
import { StepModal } from './StepModal';
import { ConfirmModal } from './ConfirmModal';
import { Button } from './Button';
import { ExecutionHistory } from './ExecutionHistory';
import { LiveExecutionModal, type LiveStep } from './LiveExecutionModal';
import {
  ArrowLeft,
  Play,
  Save,
  Trash2,
  List,
  History,
  ChevronUp,
  ChevronDown,
  Pencil,
  Plus,
  Database
} from 'lucide-react';

interface WorkflowDetailProps {
  workflowName: string;
  onBack: () => void;
  onRequestDeleteWorkflow: (name: string, onDeleted: () => void) => void;
  onNameChanged: (newName: string) => void;
}

export function WorkflowDetail({ workflowName, onBack, onRequestDeleteWorkflow, onNameChanged }: WorkflowDetailProps) {
  const { showToast } = useAppContext();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  
  const [isStepModalOpen, setIsStepModalOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<Step | null>(null);

  const [confirmData, setConfirmData] = useState<{ isOpen: boolean; message: string; onConfirm: () => void } | null>(null);

  const loadWorkflow = async (nameToLoad: string) => {
    try {
      const data = await api('GET', `/api/workflows/${encodeURIComponent(nameToLoad)}`);
      setWorkflow(data.workflow);
      setName(data.workflow.name);
      setDescription(data.workflow.description || '');
      // Initialize variable overrides from defaults
      const vars: Record<string, string> = {};
      if (data.workflow.variables) {
        for (const [key, info] of Object.entries(data.workflow.variables) as [string, any][]) {
          vars[key] = info.defaultValue ?? '';
        }
      }
      setVariableOverrides(vars);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  useEffect(() => {
    loadWorkflow(workflowName);
  }, [workflowName]);

  const handleSaveMeta = async () => {
    if (!name.trim()) return showToast('Name is required', 'error');
    try {
      await api('PUT', `/api/workflows/${encodeURIComponent(workflowName)}`, { name: name.trim(), description: description.trim() });
      showToast('Workflow saved');
      if (name.trim() !== workflowName) {
        onNameChanged(name.trim());
      } else {
        loadWorkflow(workflowName);
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleStepDelete = (order: number) => {
    setConfirmData({
      isOpen: true,
      message: `Delete step #${order}?`,
      onConfirm: async () => {
        try {
          await api('DELETE', `/api/workflows/${encodeURIComponent(workflow!.name)}/steps/${order}`);
          showToast('Step deleted');
          setConfirmData(null);
          loadWorkflow(workflow!.name);
        } catch (err: any) {
          showToast(err.message, 'error');
        }
      }
    });
  };

  const handleStepMove = async (order: number, direction: number) => {
    if (!workflow || !workflow.steps) return;
    const steps = workflow.steps;
    const idx = steps.findIndex(s => s.step_order === order);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= steps.length) return;

    const orders = steps.map(s => ({ id: s.id, step_order: s.step_order }));
    const tmp = orders[idx].step_order;
    orders[idx].step_order = orders[swapIdx].step_order;
    orders[swapIdx].step_order = tmp;

    try {
      await api('PUT', `/api/workflows/${encodeURIComponent(workflow.name)}/steps-reorder`, { orders });
      loadWorkflow(workflow.name);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const [executeNewWindow, setExecuteNewWindow] = useState(false);
  const [useAgent, setUseAgent] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionRefreshTrigger, setExecutionRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState<'steps' | 'history' | 'data'>('steps');

  // Variable overrides for execution
  const [variableOverrides, setVariableOverrides] = useState<Record<string, string>>({});

  // Live execution tracking state
  const [isLiveModalOpen, setIsLiveModalOpen] = useState(false);
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [liveStatus, setLiveStatus] = useState<'starting' | 'running' | 'completed' | 'error'>('starting');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [agentOutput, setAgentOutput] = useState('');
  const [isAgentMode, setIsAgentMode] = useState(false);

  const handleExecute = async () => {
    if (!workflow) return;

    if (useAgent) {
      return handleAgentExecute();
    }

    setIsExecuting(true);
    setIsAgentMode(false);

    // Reset modal state
    setLiveSteps([]);
    setLiveStatus('starting');
    setLiveError(null);
    setAgentOutput('');
    setIsLiveModalOpen(true);

    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(workflow.name)}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_window: executeNewWindow, variables: variableOverrides })
      });

      if (!response.body) throw new Error("ReadableStream not yet supported in this browser.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);

          if (chunk.startsWith('data: ')) {
            try {
              const data = JSON.parse(chunk.slice(6));
              handleLiveEvent(data);
            } catch (e) {
              console.error('Failed to parse SSE chunk:', chunk);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (err: any) {
      setLiveStatus('error');
      setLiveError(err.message);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleAgentExecute = async () => {
    if (!workflow) return;
    setIsExecuting(true);
    setIsAgentMode(true);

    // Reset modal state
    setLiveSteps([]);
    setLiveStatus('starting');
    setLiveError(null);
    setAgentOutput('');
    setIsLiveModalOpen(true);

    // Build the agent prompt with hybrid execution instructions
    const hasOverrides = Object.values(variableOverrides).some(v => v !== '');
    let varsSection = '';
    if (hasOverrides) {
      const varsStr = Object.entries(variableOverrides)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `"${k}": "${v}"`)
        .join(', ');
      varsSection = `, variables: { ${varsStr} }`;
    }
    const newWindowFlag = executeNewWindow ? ', new_window: true' : '';

    const prompt = `Execute the saved workflow "${workflow.name}" using a hybrid approach:

1. FIRST: Call replay_workflow(name: "${workflow.name}"${varsSection}${newWindowFlag}) to let the browser extension execute all steps at full speed.

2. IF replay_workflow SUCCEEDS: You are done. Report success.

3. IF replay_workflow FAILS on a step:
   The error message will contain a STEP STATUS REPORT showing exactly which steps succeeded (✅) and which one failed (❌). Read it carefully.

   Follow these steps IN ORDER:
   a. Use 'snapshot' to see the current page state. The page is ALREADY at the correct state after all successful steps.
   b. Look at the FAILED STEP DETAILS in the error. It tells you the exact command type (click, fill, etc.) and intent. Perform ONLY that specific action manually using the matching browser tool. Note the action_id returned.
   c. Call fix_workflow_step(workflow_name="${workflow.name}", step_order=<FAILED_STEP_NUMBER>, action_id=<ACTION_ID>). Use the EXACT step number from the error.
   d. Call replay_workflow with start_step=<FAILED_STEP_NUMBER + 1> to continue remaining steps${varsSection ? ', passing the same variables' : ''}${newWindowFlag ? ' and new_window flag' : ''}.
   e. Repeat if another step fails.

⚠️ CRITICAL RULES — READ CAREFULLY:
- The error tells you EXACTLY which step failed (e.g. "Step 3" means step 3, NOT step 1). Trust the step number.
- Steps marked ✅ already SUCCEEDED. Do NOT re-execute, re-navigate, or modify them in any way.
- Do NOT call navigate — the page is already loaded from the successful steps. Navigation was step 1 and it succeeded.
- fix_workflow_step must target ONLY the failed step number. Never modify any other step.
- Your manual fix must match the SAME command type as the failed step (if it was a "click", use click; if "fill", use fill). Never replace a click/fill with a navigate.
- ALWAYS call fix_workflow_step after your manual fix. Without it, the step will fail again next time.`;

    try {
      setLiveStatus('running');

      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
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
              setLiveError(event.error);
              setLiveStatus('error');
            } else if (event.type === 'done') {
              setLiveStatus(event.exitCode === 0 ? 'completed' : 'error');
              if (event.exitCode === 0) {
                showToast('Agent execution completed');
                setExecutionRefreshTrigger(prev => prev + 1);
              } else {
                setLiveError(`Agent exited with code ${event.exitCode}`);
              }
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err: any) {
      setLiveStatus('error');
      setLiveError(err.message);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleLiveEvent = (data: any) => {
    switch (data.type) {
      case 'execution_started':
        setLiveStatus('running');
        // Initialize pending steps based on totalSteps is possible, but we build it dynamically
        break;
      case 'step_start':
        setLiveSteps(prev => {
          const newSteps = [...prev];
          const existingIdx = newSteps.findIndex(s => s.step === data.step);
          if (existingIdx >= 0) {
            newSteps[existingIdx] = { ...newSteps[existingIdx], status: 'running' };
          } else {
            newSteps.push({
              step: data.step,
              command: data.command,
              intent: data.intent,
              status: 'running'
            });
          }
          return newSteps.sort((a, b) => a.step - b.step);
        });
        break;
      case 'step_complete':
        setLiveSteps(prev => {
          const newSteps = [...prev];
          const existingIdx = newSteps.findIndex(s => s.step === data.stepResult.step);
          if (existingIdx >= 0) {
            newSteps[existingIdx] = { ...newSteps[existingIdx], ...data.stepResult };
          } else {
            newSteps.push(data.stepResult);
          }
          return newSteps.sort((a, b) => a.step - b.step);
        });
        break;
      case 'execution_completed':
        setLiveStatus('completed');
        showToast(`Success: executed ${data.result?.results?.length || 0} steps!`);
        setExecutionRefreshTrigger(prev => prev + 1);
        break;
      case 'execution_error':
        setLiveStatus('error');
        setLiveError(data.error);
        showToast(`Execution failed: ${data.error}`, 'error');
        setExecutionRefreshTrigger(prev => prev + 1);
        break;
    }
  };

  const handleCloseLiveModal = () => {
    setIsLiveModalOpen(false);
  };

  if (!workflow) return <section className="view active"><p className="empty-state">Loading...</p></section>;

  const steps = workflow.steps || [];

  return (
    <section id="viewDetail" className="view active">
      <div className="detail-header">
        <Button variant="back" icon={ArrowLeft} onClick={onBack} title="Back">
          Back
        </Button>
        <div className="detail-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={executeNewWindow} onChange={e => setExecuteNewWindow(e.target.checked)} />
            New Window
          </label>
          <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={useAgent} onChange={e => setUseAgent(e.target.checked)} />
            Use Agent
          </label>
          <Button 
            variant="action" 
            icon={Play} 
            onClick={handleExecute} 
            disabled={isExecuting}
            style={{ background: '#10b981', color: '#fff', border: 'none' }}
          >
            {isExecuting ? 'Running...' : 'Play'}
          </Button>
          <Button variant="save" icon={Save} onClick={handleSaveMeta}>
            Save
          </Button>
          <Button variant="danger" icon={Trash2} onClick={() => onRequestDeleteWorkflow(workflow.name, onBack)}>
            Delete
          </Button>
        </div>
      </div>

      <div className="detail-meta">
        <div className="field-group">
          <label>Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="field-group">
          <label>Description</label>
          <input type="text" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="detail-info">
          <span className="info-badge">Created: {new Date(workflow.created_at).toLocaleString()}</span>
          <span className="info-badge">Updated: {new Date(workflow.updated_at).toLocaleString()}</span>
        </div>
      </div>

      <div className="detail-tabs">
          <button 
            className={`tab-btn ${activeTab === 'steps' ? 'active' : ''}`} 
            onClick={() => setActiveTab('steps')}
          >
            <List size={18} className="tab-icon" />
            Steps
            <span className="tab-count">{steps.length}</span>
          </button>
          <button
            className={`tab-btn ${activeTab === 'data' ? 'active' : ''}`}
            onClick={() => setActiveTab('data')}
          >
            <Database size={18} className="tab-icon" />
            Data
            {workflow.variables && Object.keys(workflow.variables).length > 0 && (
              <span className="tab-count">{Object.keys(workflow.variables).length}</span>
            )}
          </button>
          <button
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <History size={18} className="tab-icon" />
            Execution History
          </button>
      </div>

      {activeTab === 'data' ? (
        <div className="data-tab">
          <div className="steps-header">
            <h2>Variables</h2>
            <Button variant="save" size="sm" icon={Save} onClick={async () => {
              try {
                // Build updated variables object with new defaults
                const updatedVars = { ...workflow.variables };
                for (const [key, value] of Object.entries(variableOverrides)) {
                  if (updatedVars[key]) {
                    updatedVars[key] = { ...updatedVars[key], defaultValue: value };
                  }
                }
                await api('PUT', `/api/workflows/${encodeURIComponent(workflow.name)}`, {
                  name: workflow.name,
                  description: workflow.description,
                  variables: updatedVars
                });
                showToast('Variables saved');
                loadWorkflow(workflow.name);
              } catch (err: any) {
                showToast(err.message, 'error');
              }
            }}>
              Save Defaults
            </Button>
          </div>

          {!workflow.variables || Object.keys(workflow.variables).length === 0 ? (
            <p className="empty-state">No variables defined. Variables are created automatically when recording fill actions.</p>
          ) : (
            <div className="data-grid">
              {Object.entries(workflow.variables).map(([key, info]: [string, any]) => (
                <div key={key} className="data-row">
                  <div className="data-var-name">
                    <span className="step-var-badge">{`{{${key}}}`}</span>
                    {info.description && <span className="data-var-desc">{info.description}</span>}
                  </div>
                  <div className="data-var-input">
                    <input
                      type="text"
                      value={variableOverrides[key] ?? info.defaultValue ?? ''}
                      onChange={e => setVariableOverrides(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={info.defaultValue || 'Enter value...'}
                    />
                    {info.type && <span className="data-var-type">{info.type}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : activeTab === 'steps' ? (
        <>
          <div className="steps-header">
            <h2>Steps</h2>
            <Button variant="primary" size="sm" icon={Plus} onClick={() => { setEditingStep(null); setIsStepModalOpen(true); }}>
              Add Step
            </Button>
          </div>

          <div id="stepsList" className="steps-list">
            {steps.length === 0 ? (
              <p className="empty-state">No steps yet. Add one to build the workflow.</p>
            ) : (
              steps.map((step, i) => {
                const params = typeof step.params === 'string' ? JSON.parse(step.params) : (step.params || {});
                const paramsPreview = Object.entries(params).map(([k, v]) => `${k}: ${String(v).substring(0, 30)}${String(v).length > 30 ? '...' : ''}`).join(', ');
                const variable = typeof step.variable === 'string' ? JSON.parse(step.variable) : step.variable;
                
                return (
                  <div key={step.id} className="step-card">
                    <div className="step-order">{step.step_order}</div>
                    <div className="step-info">
                      <span className="step-command">{step.command}</span>
                      {step.intent && <div className="step-intent">{step.intent}</div>}
                      {paramsPreview && <div className="step-params-preview">{paramsPreview}</div>}
                    </div>
                    {variable && variable.name && <span className="step-var-badge">{'{{' + variable.name + '}}'}</span>}
                    <div className="step-actions">
                      <button className="step-btn" title="Move up" disabled={i === 0} onClick={() => handleStepMove(step.step_order, -1)}>
                        <ChevronUp size={14} />
                      </button>
                      <button className="step-btn" title="Move down" disabled={i === steps.length - 1} onClick={() => handleStepMove(step.step_order, 1)}>
                        <ChevronDown size={14} />
                      </button>
                      <button className="step-btn" title="Edit" onClick={() => { setEditingStep(step); setIsStepModalOpen(true); }}>
                        <Pencil size={14} />
                      </button>
                      <button className="step-btn danger" title="Delete" onClick={() => handleStepDelete(step.step_order)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <StepModal 
            isOpen={isStepModalOpen} 
            workflowName={workflow.name}
            step={editingStep}
            onClose={() => setIsStepModalOpen(false)}
            onSaved={() => { setIsStepModalOpen(false); loadWorkflow(workflow.name); }}
          />
        </>
      ) : (
        <div className="exec-history-section">
          <ExecutionHistory workflowName={workflow.name} refreshTrigger={executionRefreshTrigger} />
        </div>
      )}

      {confirmData && (
        <ConfirmModal 
          isOpen={confirmData.isOpen} 
          message={confirmData.message} 
          onConfirm={confirmData.onConfirm} 
          onCancel={() => setConfirmData(null)} 
        />
      )}

      <LiveExecutionModal
        isOpen={isLiveModalOpen}
        onClose={handleCloseLiveModal}
        workflowName={workflow.name}
        totalSteps={steps.length}
        liveSteps={liveSteps}
        executionStatus={liveStatus}
        executionError={liveError}
        agentMode={isAgentMode}
        agentOutput={agentOutput}
      />
    </section>
  );
}
