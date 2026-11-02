import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import {
  initTestDetail,
  setEditName,
  setEditDescription,
  setProjectId,
  setActiveTab,
  setVariableOverride,
  setExecuteNewWindow,
  setUseAgent,
  setUseDebug,
  openStepModal,
  closeStepModal,
  openAssertionModal,
  closeAssertionModal,
} from '../store/slices/testDetailSlice';
import { executeTest, executeAgent, closeLiveModal, stopExecution, sendDebugAction, toggleBreakpoint } from '../store/slices/executionSlice';
import { useGetTestQuery, useUpdateTestMutation, useDeleteTestMutation, useDeleteStepMutation, useReorderStepsMutation } from '../store/services/testsApi';
import { StepModal } from './StepModal';
import { AssertionModal } from './AssertionModal';
import { ConfirmModal } from './ConfirmModal';
import { ProjectAssign } from './ProjectSelector';
import { Button } from './Button';
import { ExecutionHistory } from './ExecutionHistory';
import { LiveExecutionModal } from './LiveExecutionModal';
import { GherkinEditor } from './GherkinEditor';
import { CodePanel } from './CodePanel';
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
  Database,
  ShieldCheck,
  Monitor,
  FileCode,
  Code
} from 'lucide-react';
import { useState } from 'react';

interface TestDetailProps {
  testName: string;
  onBack: () => void;
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

export function TestDetail({ testName, onBack }: TestDetailProps) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  // Redux state
  const {
    editName,
    editDescription,
    projectId,
    variableOverrides,
    activeTab,
    executeNewWindow,
    useAgent,
    useDebug,
    isStepModalOpen,
    editingStep,
    isAssertionModalOpen,
    editingAssertionStep,
  } = useAppSelector(state => state.testDetail);

  const {
    isExecuting,
    isLiveModalOpen,
    liveSteps,
    liveStatus,
    liveError,
    liveSummary,
    isAgentMode,
    agentOutput,
    refreshTrigger,
    isDebugMode,
    isPaused,
    breakpoints,
    pausedAtStep,
    debugExecutionId,
  } = useAppSelector(state => state.execution);

  // RTK Query
  const { data: test, isLoading, refetch } = useGetTestQuery(testName);
  const [updateTestMut] = useUpdateTestMutation();
  const [deleteTestMut] = useDeleteTestMutation();
  const [deleteStepMut] = useDeleteStepMutation();
  const [reorderStepsMut] = useReorderStepsMutation();

  // Local-only confirm modal state (callback is non-serializable)
  const [confirmData, setConfirmData] = useState<{ isOpen: boolean; message: string; onConfirm: () => void } | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);

  // Sync RTK Query data into form slice
  useEffect(() => {
    if (test) {
      const variables: Record<string, string> = {};
      if (test.variables) {
        for (const [key, info] of Object.entries(test.variables) as [string, any][]) {
          variables[key] = info.defaultValue ?? '';
        }
      }
      dispatch(initTestDetail({
        name: test.name,
        description: test.description || '',
        projectId: test.project_id ?? null,
        variables,
      }));
      setViewport(test.viewport || null);
    }
  }, [test, dispatch]);

  const handleSaveMeta = async () => {
    if (!editName.trim()) return dispatch(showToast({ message: 'Name is required', type: 'error' }));
    try {
      await updateTestMut({ originalName: testName, name: editName.trim(), description: editDescription.trim(), viewport }).unwrap();
      dispatch(showToast({ message: 'Test saved' }));
      if (editName.trim() !== testName) {
        navigate(`/tests/${encodeURIComponent(editName.trim())}`, { replace: true });
      }
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Save failed', type: 'error' }));
    }
  };

  const handleStepDelete = (order: number) => {
    setConfirmData({
      isOpen: true,
      message: `Delete step #${order}?`,
      onConfirm: async () => {
        try {
          await deleteStepMut({ testName: test!.name, stepOrder: order }).unwrap();
          dispatch(showToast({ message: 'Step deleted' }));
          setConfirmData(null);
        } catch (err: any) {
          dispatch(showToast({ message: err.message || 'Delete failed', type: 'error' }));
        }
      }
    });
  };

  const handleStepMove = async (order: number, direction: number) => {
    if (!test || !test.steps) return;
    const steps = test.steps;
    const idx = steps.findIndex(s => s.step_order === order);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= steps.length) return;

    const orders = steps.map(s => ({ id: s.id, step_order: s.step_order }));
    const tmp = orders[idx].step_order;
    orders[idx].step_order = orders[swapIdx].step_order;
    orders[swapIdx].step_order = tmp;

    try {
      await reorderStepsMut({ testName: test.name, orders }).unwrap();
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Reorder failed', type: 'error' }));
    }
  };

  const handleDeleteTest = () => {
    if (!test) return;
    setConfirmData({
      isOpen: true,
      message: `Delete test "${test.name}" and all its steps?`,
      onConfirm: async () => {
        try {
          await deleteTestMut(test.name).unwrap();
          dispatch(showToast({ message: 'Test deleted' }));
          setConfirmData(null);
          onBack();
        } catch (err: any) {
          dispatch(showToast({ message: err.message || 'Delete failed', type: 'error' }));
        }
      }
    });
  };

  const handleExecute = async () => {
    if (!test) return;

    if (useAgent) {
      return handleAgentExecute();
    }

    dispatch(executeTest({
      testName: test.name,
      newWindow: executeNewWindow,
      variables: variableOverrides,
      debug: useDebug,
      breakpoints: [],
    }));
  };

  const handleAgentExecute = () => {
    if (!test) return;

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
    const prompt = useDebug
      ? `Execute the saved test "${test.name}" in DEBUG MODE. You MUST step through ALL steps autonomously without ever asking for user input.

STEP 1: Call run_test(name: "${test.name}"${varsSection}${newWindowFlag}, debug: true).
This will return an execution_id and pause at step 1.

STEP 2: IMMEDIATELY start a loop — call debug_action(execution_id: <ID>, action: "step") to execute each step one by one. After each debug_action call, you will get the result. Call debug_action again for the next step. Keep calling debug_action("step") until all steps are completed or a step fails.

DO NOT STOP. DO NOT ASK THE USER. Just keep calling debug_action("step") in a loop until the execution finishes.

IF A STEP FAILS during debug:
   a. Call snapshot() to see the current page state.
   b. The error tells you the exact command type and intent. Perform ONLY that action manually using the matching browser tool. Note the action_id.
   c. Call fix_test_step(test_name="${test.name}", step_order=<FAILED_STEP_NUMBER>, action_id=<ACTION_ID>).
   d. Call debug_action(execution_id: <ID>, action: "step") to continue to the next step.

CRITICAL RULES:
- NEVER ask the user what to do. Execute ALL steps autonomously.
- NEVER stop between steps to report progress. Just keep stepping.
- Steps marked SUCCEEDED must NOT be re-executed or modified.
- Do NOT call navigate — the page is already loaded.
- fix_test_step must target ONLY the failed step number.
- Report the final result only when all steps are done.`
      : `Execute the saved test "${test.name}" using a hybrid approach:

1. FIRST: Call run_test(name: "${test.name}"${varsSection}${newWindowFlag}) to let the browser extension execute all steps at full speed.

2. IF run_test SUCCEEDS: You are done. Report success including assertion results.

3. IF run_test FAILS on a step:
   The error message will contain a STEP STATUS REPORT showing exactly which steps succeeded and which one failed. Read it carefully.

   Follow these steps IN ORDER:
   a. Use 'snapshot' to see the current page state. The page is ALREADY at the correct state after all successful steps.
   b. Look at the FAILED STEP DETAILS in the error. It tells you the exact command type (click, fill, etc.) and intent. Perform ONLY that specific action manually using the matching browser tool. Note the action_id returned.
   c. Call fix_test_step(test_name="${test.name}", step_order=<FAILED_STEP_NUMBER>, action_id=<ACTION_ID>). Use the EXACT step number from the error.
   d. Call run_test with start_step=<FAILED_STEP_NUMBER + 1> to continue remaining steps${varsSection ? ', passing the same variables' : ''}${newWindowFlag ? ' and new_window flag' : ''}.
   e. Repeat if another step fails.

CRITICAL RULES:
- The error tells you EXACTLY which step failed (e.g. "Step 3" means step 3, NOT step 1). Trust the step number.
- Steps marked as SUCCEEDED already SUCCEEDED. Do NOT re-execute, re-navigate, or modify them in any way.
- Do NOT call navigate — the page is already loaded from the successful steps. Navigation was step 1 and it succeeded.
- fix_test_step must target ONLY the failed step number. Never modify any other step.
- Your manual fix must match the SAME command type as the failed step (if it was a "click", use click; if "fill", use fill). Never replace a click/fill with a navigate.
- ALWAYS call fix_test_step after your manual fix. Without it, the step will fail again next time.`;

    dispatch(executeAgent({ prompt }));
  };

  const handleCloseLiveModal = () => {
    dispatch(closeLiveModal());
  };

  if (isLoading || !test) {
    return <section className="view active"><p className="empty-state">Loading...</p></section>;
  }

  const steps = test.steps || [];
  const assertionCount = steps.filter(s => s.command === 'assert').length;

  return (
    <section id="viewDetail" className="view active">
      <div className="detail-header">
        <Button variant="back" icon={ArrowLeft} onClick={onBack} title="Back">
          Back
        </Button>
        <div className="detail-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={executeNewWindow} onChange={e => dispatch(setExecuteNewWindow(e.target.checked))} />
            New Window
          </label>
          <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={useAgent} onChange={e => dispatch(setUseAgent(e.target.checked))} />
            Use Agent
          </label>
          <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={useDebug} onChange={e => dispatch(setUseDebug(e.target.checked))} />
            Debug
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--text-muted)' }}>
            <Monitor size={14} />
            <select
              value={viewportToString(viewport)}
              onChange={async (e) => {
                const newViewport = parseViewportString(e.target.value);
                setViewport(newViewport);
                try {
                  await updateTestMut({ originalName: testName, name: test.name, viewport: newViewport }).unwrap();
                } catch {}
              }}
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '4px 8px',
                fontSize: '12px',
                fontFamily: 'var(--font)',
                cursor: 'pointer',
              }}
            >
              {VIEWPORT_PRESETS.map(preset => (
                <option key={preset.value} value={preset.value}>{preset.label}</option>
              ))}
            </select>
          </div>
          <Button
            variant="action"
            icon={Play}
            onClick={handleExecute}
            disabled={isExecuting}
            style={{ background: '#10b981', color: '#fff', border: 'none' }}
          >
            {isExecuting ? 'Running...' : 'Run Test'}
          </Button>
          <Button variant="save" icon={Save} onClick={handleSaveMeta}>
            Save
          </Button>
          <Button variant="danger" icon={Trash2} onClick={handleDeleteTest}>
            Delete
          </Button>
        </div>
      </div>

      <div className="detail-meta">
        <div className="field-group">
          <label>Name</label>
          <input type="text" value={editName} onChange={e => dispatch(setEditName(e.target.value))} />
        </div>
        <div className="field-group">
          <label>Description</label>
          <input type="text" value={editDescription} onChange={e => dispatch(setEditDescription(e.target.value))} />
        </div>
        <div className="detail-info">
          <span className="info-badge">Created: {new Date(test.created_at).toLocaleString()}</span>
          <span className="info-badge">Updated: {new Date(test.updated_at).toLocaleString()}</span>
          {assertionCount > 0 && (
            <span className="info-badge" style={{ color: 'var(--accent, #0284c7)' }}>
              <ShieldCheck size={14} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
              {assertionCount} assertion{assertionCount > 1 ? 's' : ''}
            </span>
          )}
          <ProjectAssign
            testName={test.name}
            currentProjectId={projectId}
            onAssign={(newProjectId) => dispatch(setProjectId(newProjectId))}
          />
        </div>
      </div>

      <div className="detail-tabs">
          <button
            className={`tab-btn ${activeTab === 'steps' ? 'active' : ''}`}
            onClick={() => dispatch(setActiveTab('steps'))}
          >
            <List size={18} className="tab-icon" />
            Steps
            <span className="tab-count">{steps.length}</span>
          </button>
          <button
            className={`tab-btn ${activeTab === 'gherkin' ? 'active' : ''}`}
            onClick={() => dispatch(setActiveTab('gherkin'))}
          >
            <FileCode size={18} className="tab-icon" />
            Gherkin
          </button>
          <button
            className={`tab-btn ${activeTab === 'code' ? 'active' : ''}`}
            onClick={() => dispatch(setActiveTab('code'))}
          >
            <Code size={18} className="tab-icon" />
            Code
          </button>
          <button
            className={`tab-btn ${activeTab === 'data' ? 'active' : ''}`}
            onClick={() => dispatch(setActiveTab('data'))}
          >
            <Database size={18} className="tab-icon" />
            Data
            {test.variables && Object.keys(test.variables).length > 0 && (
              <span className="tab-count">{Object.keys(test.variables).length}</span>
            )}
          </button>
          <button
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => dispatch(setActiveTab('history'))}
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
                const updatedVars = { ...test.variables };
                for (const [key, value] of Object.entries(variableOverrides)) {
                  if (updatedVars[key]) {
                    updatedVars[key] = { ...updatedVars[key], defaultValue: value };
                  }
                }
                await updateTestMut({
                  originalName: test.name,
                  name: test.name,
                  description: test.description || undefined,
                  variables: updatedVars
                }).unwrap();
                dispatch(showToast({ message: 'Variables saved' }));
              } catch (err: any) {
                dispatch(showToast({ message: err.message || 'Save failed', type: 'error' }));
              }
            }}>
              Save Defaults
            </Button>
          </div>

          {!test.variables || Object.keys(test.variables).length === 0 ? (
            <p className="empty-state">No variables defined. Variables are created automatically when recording fill actions.</p>
          ) : (
            <div className="data-grid">
              {Object.entries(test.variables).map(([key, info]: [string, any]) => (
                <div key={key} className="data-row">
                  <div className="data-var-name">
                    <span className="step-var-badge">{`{{${key}}}`}</span>
                    {info.description && <span className="data-var-desc">{info.description}</span>}
                  </div>
                  <div className="data-var-input">
                    <input
                      type="text"
                      value={variableOverrides[key] ?? info.defaultValue ?? ''}
                      onChange={e => dispatch(setVariableOverride({ key, value: e.target.value }))}
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
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="primary" size="sm" icon={Plus} onClick={() => dispatch(openStepModal(null))}>
                Add Step
              </Button>
              <Button variant="primary" size="sm" icon={ShieldCheck} onClick={() => dispatch(openAssertionModal(null))}
                style={{ background: 'var(--accent, #0284c7)' }}
              >
                Add Assertion
              </Button>
            </div>
          </div>

          <div id="stepsList" className="steps-list">
            {steps.length === 0 ? (
              <p className="empty-state">No steps yet. Add steps to build the test, then add assertions to verify results.</p>
            ) : (
              steps.map((step, i) => {
                const params = typeof step.params === 'string' ? JSON.parse(step.params) : (step.params || {});
                const variable = typeof step.variable === 'string' ? JSON.parse(step.variable) : step.variable;
                const assertion = typeof step.assertion === 'string' ? JSON.parse(step.assertion) : step.assertion;
                const isAssertion = step.command === 'assert';

                let paramsPreview = '';
                if (isAssertion && assertion) {
                  if (assertion.type !== 'visual_match') {
                    const parts = [assertion.type];
                    if (assertion.selector) parts.push(`on "${assertion.selector}"`);
                    if (assertion.expected) parts.push(`= "${assertion.expected}"`);
                    paramsPreview = parts.join(' ');
                  }
                } else {
                  paramsPreview = Object.entries(params).map(([k, v]) => `${k}: ${String(v).substring(0, 30)}${String(v).length > 30 ? '...' : ''}`).join(', ');
                }

                return (
                  <div key={step.id} className={`step-card ${isAssertion ? 'step-card--assertion' : ''}`}>
                    <div className="step-order">{step.step_order}</div>
                    <div className="step-info">
                      <span className={`step-command ${isAssertion ? 'step-command--assertion' : ''}`}>
                        {isAssertion && <ShieldCheck size={14} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />}
                        {step.command}
                      </span>
                      {step.intent && <div className="step-intent">{step.intent}</div>}
                      {paramsPreview && <div className="step-params-preview">{paramsPreview}</div>}
                      {isAssertion && assertion?.type === 'visual_match' && (
                        <div className="vrt-preview" style={{ marginTop: '8px' }}>
                          <span style={{ fontSize: '11px', color: '#888', display: 'block', marginBottom: '4px' }}>Visual Baseline Reference:</span>
                          <img src={`/${assertion.expected}`} alt="VRT baseline" style={{ maxHeight: '80px', borderRadius: '4px', border: '1px solid #333' }} />
                        </div>
                      )}
                    </div>
                    {variable && variable.name && <span className="step-var-badge">{'{{' + variable.name + '}}'}</span>}
                    <div className="step-actions">
                      <button className="step-btn" title="Move up" disabled={i === 0} onClick={() => handleStepMove(step.step_order, -1)}>
                        <ChevronUp size={14} />
                      </button>
                      <button className="step-btn" title="Move down" disabled={i === steps.length - 1} onClick={() => handleStepMove(step.step_order, 1)}>
                        <ChevronDown size={14} />
                      </button>
                      <button className="step-btn" title="Edit" onClick={() => {
                        if (isAssertion) {
                          dispatch(openAssertionModal(step));
                        } else {
                          dispatch(openStepModal(step));
                        }
                      }}>
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
            testName={test.name}
            step={editingStep}
            onClose={() => dispatch(closeStepModal())}
            onSaved={() => { dispatch(closeStepModal()); refetch(); }}
          />

          <AssertionModal
            isOpen={isAssertionModalOpen}
            testName={test.name}
            step={editingAssertionStep}
            onClose={() => dispatch(closeAssertionModal())}
            onSaved={() => { dispatch(closeAssertionModal()); refetch(); }}
          />
        </>
      ) : activeTab === 'gherkin' ? (
        <GherkinEditor testName={test.name} />
      ) : activeTab === 'code' ? (
        <CodePanel testName={test.name} />
      ) : (
        <div className="exec-history-section">
          <ExecutionHistory testName={test.name} refreshTrigger={refreshTrigger} onTestChanged={refetch} />
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
        onStop={() => dispatch(stopExecution())}
        testName={test.name}
        totalSteps={steps.length}
        liveSteps={liveSteps}
        executionStatus={liveStatus}
        executionError={liveError}
        executionSummary={liveSummary}
        agentMode={isAgentMode}
        agentOutput={agentOutput}
        isDebugMode={isDebugMode}
        isPaused={isPaused}
        breakpoints={breakpoints}
        pausedAtStep={pausedAtStep}
        onResume={() => {
          if (debugExecutionId) dispatch(sendDebugAction({ executionId: debugExecutionId, action: 'resume' }));
        }}
        onStepOver={() => {
          if (debugExecutionId) dispatch(sendDebugAction({ executionId: debugExecutionId, action: 'step' }));
        }}
        onContinue={() => {
          if (debugExecutionId) dispatch(sendDebugAction({ executionId: debugExecutionId, action: 'continue' }));
        }}
        onToggleBreakpoint={(step) => {
          dispatch(toggleBreakpoint(step));
          if (debugExecutionId) dispatch(sendDebugAction({ executionId: debugExecutionId, action: 'toggle-breakpoint', step }));
        }}
      />
    </section>
  );
}
