import { useEffect, useRef, useState } from 'react';
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
  setRecordVideo,
  openStepModal,
  closeStepModal,
  openAssertionModal,
  closeAssertionModal,
} from '../store/slices/testDetailSlice';
import { executeTest, executeAgent, closeLiveModal, stopExecution, sendDebugAction, toggleBreakpoint, incrementRefreshTrigger } from '../store/slices/executionSlice';
import {
  testsApi, useGetTestQuery, useUpdateTestMutation, useDeleteTestMutation, useDeleteStepMutation, useReorderStepsMutation, useGetTestCampaignsQuery,
  useBindDatasetMutation, useSetStepOptionalMutation,
} from '../store/services/testsApi';
import { executionsApi, useGetExecutionsQuery, useGetLastRunQuery } from '../store/services/executionsApi';
import { useGetProjectsQuery, useGetDatasetsQuery } from '../store/services/projectsApi';
import { useStartCampaignMutation } from '../store/services/campaignsApi';
import { useGetTestRequirementsQuery } from '../store/services/requirementsApi';
import { useBack, useFollowProject, useGo, useLeaveGuard } from '../navigation';
import { withScope } from '../scope';
import { StepModal } from './StepModal';
import { AssertionModal } from './AssertionModal';
import { ConfirmModal } from './ConfirmModal';
import { MoveToProjectDialog } from './ProjectSelector';
import { Button } from './Button';
import { ExecutionHistory } from './ExecutionHistory';
import { rowValuesText, rowsVerdict } from '../rows';
import { LiveExecutionModal } from './LiveExecutionModal';
import { TestAgentModal } from './TestAgentModal';
import { GherkinEditor } from './GherkinEditor';
import { BusinessStepProposals, BusinessStepsNotice } from './BusinessStepProposals';
import { ComputedHint } from './ComputedValues';
import { COMPUTED_HELP, useComputedPreview } from '../values';
import { CodePanel } from './CodePanel';
import { TestRows } from './TestRows';
import { HeadlessSwitch } from './HeadlessSwitch';
import { AfterRunField } from './BrowserWindows';
import { useGetWindowSettingsQuery } from '../store/services/settingsApi';
import { useRunHeadless } from '../headless';
import { Card, EmptyState, KeyChip, Menu, ProjectChip, ResultBar, StatusPill } from './ui';
import { dateTime, formatDuration, relativeTime } from '../format';
import {
  ArrowLeft, Play, Save, Trash2, List, History, ChevronUp, ChevronDown, Pencil, Plus, Database, ShieldCheck, Monitor, FileCode, Code,
  Layers, FolderInput, Loader2, Undo2, Clock, ChevronRight, MousePointerClick, Table, CircleDashed, Bot,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';

interface TestDetailProps {
  testName: string;
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

export function TestDetail({ testName }: TestDetailProps) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const go = useGo();
  const back = useBack('/tests', 'Tests');
  const scope = useAppSelector(state => state.ui.selectedProjectId);
  const runHeadless = useRunHeadless();
  const { data: windows } = useGetWindowSettingsQuery();

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
    recordVideo,
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
    liveTabId,
    liveRows,
    liveRowIndex,
    refreshTrigger,
    isDebugMode,
    isPaused,
    breakpoints,
    pausedAtStep,
    debugExecutionId,
  } = useAppSelector(state => state.execution);

  // RTK Query
  const { data: test, isLoading, refetch } = useGetTestQuery(testName);
  const { data: projects = [] } = useGetProjectsQuery();
  const { data: runs = [] } = useGetExecutionsQuery({ testName, limit: 20 }, { refetchOnMountOrArgChange: refreshTrigger });
  // How it last did, every row it plays counted: its last run alone tells only its last row.
  const { data: lastOfRows = null } = useGetLastRunQuery(testName, { refetchOnMountOrArgChange: refreshTrigger });
  const { data: campaigns = [] } = useGetTestCampaignsQuery(testName);
  const [updateTestMut] = useUpdateTestMutation();
  const [deleteTestMut] = useDeleteTestMutation();
  const [deleteStepMut] = useDeleteStepMutation();
  const [reorderStepsMut] = useReorderStepsMutation();
  // What the variables holding expressions would give now (Data tab).
  const currentValues = Object.fromEntries(Object.entries(test?.variables ?? {}).map(([key, info]) => [key, String(variableOverrides[key] ?? (info as { defaultValue?: string })?.defaultValue ?? '')]));
  const computedPreview = useComputedPreview(currentValues, projects.find((p) => p.id === test?.project_id)?.language, test?.project_id);
  // With rows (its own, or its dataset's): the row a run plays — 0, every row, a run each —, and
  // the datasets it may be bound to.
  const [dataRow, setDataRow] = useState(0);
  const [rowsDirty, setRowsDirty] = useState(false);
  const { data: datasets = [] } = useGetDatasetsQuery(test?.project_id ?? 0, { skip: !test?.project_id });
  const [bindDataset] = useBindDatasetMutation();
  const [startCampaign, { isLoading: startingCampaign }] = useStartCampaignMutation();

  // Local-only confirm modal state (callback is non-serializable)
  const [confirmData, setConfirmData] = useState<{ isOpen: boolean; title?: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [runOptionsOpen, setRunOptionsOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  // The test's conversation with the agent (TestAgentModal): repair it, change it.
  const [agentOpen, setAgentOpen] = useState(false);
  const [syncedWith, setSyncedWith] = useState<string | null>(null);
  const runOptionsRef = useRef<HTMLDivElement>(null);

  // A test of another project: that project comes into scope, its breadcrumb and list with it.
  useFollowProject(test ? test.project_id ?? null : undefined, (owner) => {
    dispatch(showToast({ message: `Now in ${projects.find((p) => p.id === owner)?.name ?? 'all projects'}: the project of ${testName}` }));
  });

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
      setSyncedWith(test.updated_at);
    }
  }, [test, dispatch]);

  useEffect(() => {
    if (!runOptionsOpen) return;
    const close = (event: MouseEvent) => { if (!runOptionsRef.current?.contains(event.target as Node)) setRunOptionsOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [runOptionsOpen]);

  // The name and description typed, not saved yet: leaving asks first. Compared once the form
  // holds this test's (the store may still hold the one opened before).
  const dirty = !!test && syncedWith === test.updated_at && (editName !== test.name || editDescription !== (test.description || ''));
  // Rows typed in the Data tab, not saved yet: leaving asks first too.
  const { blocker, allow } = useLeaveGuard(dirty || rowsDirty);

  const handleSaveMeta = async () => {
    if (!editName.trim()) return dispatch(showToast({ message: 'Name is required', type: 'error' }));
    try {
      await updateTestMut({ originalName: testName, name: editName.trim(), description: editDescription.trim(), viewport }).unwrap();
      dispatch(showToast({ message: 'Test saved' }));
      if (editName.trim() !== testName) {
        allow();
        navigate(withScope(`/tests/${encodeURIComponent(editName.trim())}`, scope), { replace: true, state: location.state });
      }
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Save failed', type: 'error' }));
    }
  };

  const discard = () => {
    if (!test) return;
    dispatch(setEditName(test.name));
    dispatch(setEditDescription(test.description || ''));
  };

  const handleStepDelete = (order: number) => {
    setConfirmData({
      isOpen: true,
      title: `Delete step #${order}?`,
      message: 'The steps after it move up by one.',
      confirmLabel: 'Delete step',
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

  const [setStepOptional] = useSetStepOptionalMutation();
  // A step only needed sometimes (a cookie banner): its failure on a replay does not fail the test.
  const handleStepOptional = async (order: number, optional: boolean) => {
    try {
      await setStepOptional({ testName, stepOrder: order, optional }).unwrap();
      dispatch(showToast({ message: optional ? `Step ${order} is optional: if it fails, the test goes on` : `Step ${order} is required again`, type: 'success' }));
    } catch {
      dispatch(showToast({ message: 'The step could not be changed', type: 'error' }));
    }
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
      title: `Delete the test “${test.name}”?`,
      message: 'Its steps and its run history are deleted with it. The requirements it checks stay, without this test.',
      confirmLabel: 'Delete test',
      onConfirm: async () => {
        try {
          await deleteTestMut(test.name).unwrap();
          dispatch(showToast({ message: 'Test deleted' }));
          setConfirmData(null);
          allow();
          back.go();
        } catch (err: any) {
          dispatch(showToast({ message: err.message || 'Delete failed', type: 'error' }));
        }
      }
    });
  };

  const handleExecute = async () => {
    if (!test) return;
    setRunOptionsOpen(false);

    if (useAgent) {
      return handleAgentExecute();
    }

    // Only the values changed here: a default sent along would win over every row's value.
    const changed = Object.fromEntries(Object.entries(variableOverrides).filter(([key, value]) => value !== String((test.variables?.[key] as { defaultValue?: string } | undefined)?.defaultValue ?? '')));
    const rowCount = test.played_rows?.row_count ?? 0;
    dispatch(executeTest({
      testName: test.name,
      newWindow: executeNewWindow,
      variables: changed,
      // A row chosen in Run options: that one; otherwise every row, a run each.
      ...(rowCount && dataRow ? { row: Math.min(dataRow, rowCount) } : {}),
      debug: useDebug,
      breakpoints: [],
      // Debug is watched step by step: it keeps a window.
      headless: runHeadless && !useDebug,
      recordVideo,
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

  if (isLoading) {
    return <Card><p className="empty-state">Loading…</p></Card>;
  }
  if (!test) {
    return (
      <Card>
        <EmptyState icon={List} title={`No test named “${testName}”`}
          action={<Button variant="secondary" icon={ArrowLeft} onClick={back.go}>{back.label}</Button>}>
          It was deleted, renamed, or never saved — an AI agent that stopped before the end does not save it.
        </EmptyState>
      </Card>
    );
  }

  const steps = test.steps || [];
  const assertionCount = steps.filter(s => s.command === 'assert').length;
  const variableCount = test.variables ? Object.keys(test.variables).length : 0;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const lastRun = runs[0];
  const headlessRun = runHeadless && !useDebug && !useAgent;
  // The window closed after the run, as chosen for every run (Settings → Browser windows).
  const closesWindow = !headlessRun && !useDebug && executeNewWindow && !!windows && windows.after_run !== 'keep';
  const optionsChanged = headlessRun || !executeNewWindow || useAgent || useDebug || recordVideo || !!viewport || closesWindow;
  const withSide = activeTab === 'steps' || activeTab === 'data';

  const tabs: Array<{ id: typeof activeTab; label: string; icon: typeof List; count?: number }> = [
    { id: 'steps', label: 'Steps', icon: List, count: steps.length },
    { id: 'gherkin', label: 'Gherkin', icon: FileCode },
    { id: 'code', label: 'Code', icon: Code },
    { id: 'data', label: 'Data', icon: Database, count: variableCount || undefined },
    { id: 'history', label: 'Runs', icon: History, count: runs.length || undefined },
    { id: 'campaigns', label: 'Campaigns', icon: Layers, count: campaigns.length || undefined },
  ];

  return (
    <>
      <Card className="detail-head">
        <div>
          <Button variant="back" size="sm" icon={ArrowLeft} onClick={back.go}>{back.label}</Button>
        </div>
        <div className="detail-head__top">
          <div className="detail-head__titles">
            <input className="inline-edit inline-edit--title" value={editName} onChange={e => dispatch(setEditName(e.target.value))} aria-label="Test name" spellCheck={false} />
            <input className="inline-edit inline-edit--sub" value={editDescription} onChange={e => dispatch(setEditDescription(e.target.value))} placeholder="Add a description…" aria-label="Description" />
          </div>
          <div className="detail-head__actions">
            <Button variant="secondary" icon={Bot} onClick={() => setAgentOpen(true)} title="Ask the agent to repair this test, to change it, or to say what it does: its browser shows live beside the conversation">
              Ask the agent
            </Button>
            <div className="split-button" ref={runOptionsRef}>
              <Button icon={isExecuting ? Loader2 : Play} onClick={handleExecute} disabled={isExecuting}>
                {isExecuting ? 'Running…' : useAgent ? 'Run with agent' : useDebug ? 'Debug' : runHeadless ? 'Run headless' : 'Run'}
              </Button>
              <Button aria-label="Run options" title="Run options" onClick={() => setRunOptionsOpen(!runOptionsOpen)}>
                <ChevronDown size={16} />
              </Button>
              {runOptionsOpen && (
                <div className="popover run-options">
                  <div className="popover__title">Run options</div>
                  {test.played_rows && (
                    <div className="field">
                      <span className="field__label"><Table size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Rows {test.played_rows.source === 'dataset' ? `of ${test.played_rows.name}` : 'of the test'}</span>
                      <select aria-label="Rows to play" value={dataRow} onChange={(e) => setDataRow(Number(e.target.value))}>
                        <option value={0}>{test.played_rows.row_count === 1 ? 'Its row' : `Every row (${test.played_rows.row_count}), a run each`}</option>
                        {test.played_rows.row_count > 1 && test.played_rows.row_labels.map((label, i) => <option key={i} value={i + 1}>Only {label}</option>)}
                      </select>
                      {test.played_rows.row_count > 1 && (
                        <Button size="sm" variant="secondary" icon={Layers} disabled={startingCampaign} onClick={async () => {
                          try {
                            const { campaign } = await startCampaign({ tests: [test.name], headless: runHeadless }).unwrap();
                            go(`/campaigns/${campaign.id}`, { from: test.name });
                          } catch (err) {
                            dispatch(showToast({ message: (err as { data?: { error?: string } })?.data?.error ?? 'The campaign did not start', type: 'error' }));
                          }
                        }}>Run every row as a campaign</Button>
                      )}
                    </div>
                  )}
                  <HeadlessSwitch disabledReason={useDebug ? 'Debug runs in a window: it is watched step by step.' : useAgent ? 'The agent repairs in your Chrome: it runs there.' : undefined} />
                  <label className={`switch ${runHeadless && !useDebug && !useAgent ? 'switch--disabled' : ''}`}>
                    <input type="checkbox" checked={executeNewWindow || (runHeadless && !useDebug && !useAgent)} disabled={runHeadless && !useDebug && !useAgent} onChange={e => dispatch(setExecuteNewWindow(e.target.checked))} />
                    <span className="switch__text">Open in a new window<span className="switch__hint">Without the focus: the window you are in keeps it.</span></span>
                  </label>
                  <AfterRunField disabledReason={headlessRun ? 'Headless: its window closes anyway.'
                    : useDebug ? 'A debug run keeps its window: you follow it step by step.'
                      : !executeNewWindow ? 'Played in your own tab: it is never closed.' : undefined} />
                  <label className="switch">
                    <input type="checkbox" checked={useAgent} onChange={e => dispatch(setUseAgent(e.target.checked))} />
                    <span className="switch__text">Let the agent fix failures<span className="switch__hint">Use Agent: a failed step is redone and repaired.</span></span>
                  </label>
                  <label className="switch">
                    <input type="checkbox" checked={useDebug} onChange={e => dispatch(setUseDebug(e.target.checked))} />
                    <span className="switch__text">Debug step by step<span className="switch__hint">Pauses at each step, with breakpoints.</span></span>
                  </label>
                  <label className="switch">
                    <input type="checkbox" checked={recordVideo} onChange={e => dispatch(setRecordVideo(e.target.checked))} />
                    <span className="switch__text">Record video<span className="switch__hint">Keep the run's video even if it passes. A failed run keeps its video anyway.</span></span>
                  </label>
                  <label className="field">
                    <span className="field__label"><Monitor size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Viewport</span>
                    <select
                      value={viewportToString(viewport)}
                      onChange={async (e) => {
                        const newViewport = parseViewportString(e.target.value);
                        setViewport(newViewport);
                        try {
                          await updateTestMut({ originalName: testName, name: test.name, viewport: newViewport }).unwrap();
                        } catch {}
                      }}
                    >
                      {VIEWPORT_PRESETS.map(preset => (
                        <option key={preset.value} value={preset.value}>{preset.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
            <Menu items={[
              { label: 'Move to project…', icon: FolderInput, onClick: () => setMoving(true) },
              'divider',
              { label: 'Delete test…', icon: Trash2, danger: true, onClick: handleDeleteTest },
            ]} />
          </div>
        </div>

        {dirty && (
          <div className="unsaved">
            <Pencil size={14} /> Unsaved changes to the name or description
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon={Undo2} onClick={discard}>Discard</Button>
            <Button size="sm" icon={Save} onClick={handleSaveMeta}>Save</Button>
          </div>
        )}

        <div className="detail-meta-row">
          <ProjectChip project={project} onClick={project ? () => navigate(withScope('/tests', project.id)) : undefined} title={project ? `The tests of ${project.name}` : undefined} />
          <TestRequirements testName={test.name} />
          <span className="meta-sep" />
          <span className="meta-item"><List size={14} />{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          {assertionCount > 0 && <span className="meta-item"><ShieldCheck size={14} />{assertionCount} assertion{assertionCount > 1 ? 's' : ''}</span>}
          <span className="meta-item">
            Last run: {lastRun ? <><StatusPill status={lastOfRows?.status ?? lastRun.status} /> {relativeTime(lastRun.started_at)}</> : <StatusPill status="never" />}
            {rowsVerdict(lastOfRows?.rows) && <span className={lastOfRows?.rows?.failed.length ? 'meta-rows meta-rows--failed' : 'meta-rows'}>· {rowsVerdict(lastOfRows?.rows)}</span>}
          </span>
          <span className="meta-item"><Clock size={14} />Updated {dateTime(test.updated_at)}</span>
          {optionsChanged && (
            <span className="meta-item" title="Run options">
              {headlessRun && <span className="tag tag--blue">headless</span>}
              {!executeNewWindow && !headlessRun && <span className="tag">same window</span>}
              {useAgent && <span className="tag tag--blue">agent</span>}
              {useDebug && <span className="tag tag--amber">debug</span>}
              {recordVideo && <span className="tag">video</span>}
              {closesWindow && <span className="tag">{windows?.after_run === 'passed' ? 'window closes if passed' : 'window closes'}</span>}
              {viewport && <span className="tag">{viewportToString(viewport)}</span>}
            </span>
          )}
        </div>
      </Card>

      <nav className="tabs" role="tablist">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={`tab ${activeTab === id ? 'active' : ''}`} onClick={() => dispatch(setActiveTab(id))}>
            <Icon size={16} />{label}{count !== undefined && <span className="tab__count">{count}</span>}
          </button>
        ))}
      </nav>

      <div className={`detail-layout ${withSide ? '' : 'detail-layout--full'}`}>
        <div className="stack">
          {activeTab === 'data' ? (
            <>
            {test.project_id != null && (
              <Card title="Dataset" icon={Table} className="dataset-binding"
                subtitle="Bound to a dataset of the project, the test runs once per row of it: each column is a variable of the run, over the values below.">
                <div className="dataset-binding__row">
                  <select aria-label="Dataset" value={test.dataset?.id ?? ''} onChange={async (e) => {
                    try {
                      await bindDataset({ testName: test.name, dataset: e.target.value ? Number(e.target.value) : null }).unwrap();
                      setDataRow(0);
                    } catch (err) {
                      dispatch(showToast({ message: (err as { data?: { error?: string } })?.data?.error ?? 'Not bound', type: 'error' }));
                    }
                  }}>
                    <option value="">None — the rows of the test below, or one run with its defaults</option>
                    {datasets.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.row_count} row{d.row_count === 1 ? '' : 's'}</option>)}
                  </select>
                  <button className="link-btn" onClick={() => go('/datasets', { from: test.name })}>{datasets.length ? 'Datasets' : 'Add a dataset'}</button>
                </div>
                {test.dataset && (
                  <p className="field__hint">
                    Its columns: {test.dataset.columns.map((c) => <span key={c} className="step-var-badge">{`{{${c}}}`}</span>)} — a run plays every row, a run each (Run options: one only), a campaign too.
                  </p>
                )}
              </Card>
            )}
            <TestRows key={test.name} test={test} onDirtyChange={setRowsDirty} />
            <Card title="Variables" subtitle="The values a run uses; change them for the next run, or save them as the defaults."
              actions={(
                <Button variant="secondary" size="sm" icon={Save} onClick={async () => {
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
                  Save defaults
                </Button>
              )}>
              {!test.variables || Object.keys(test.variables).length === 0 ? (
                <EmptyState icon={Database} title="No variable">Variables are created when a fill action is recorded.</EmptyState>
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
                        <ComputedHint name={key} value={variableOverrides[key] ?? info.defaultValue ?? ''} preview={computedPreview} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="field__hint data-help">{COMPUTED_HELP}</p>
            </Card>
            </>
          ) : activeTab === 'steps' ? (
            <>
              <div className="section-head">
                <h2>Steps</h2>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button variant="secondary" size="sm" icon={Plus} onClick={() => dispatch(openStepModal(null))}>Add step</Button>
                  <Button variant="secondary" size="sm" icon={ShieldCheck} onClick={() => dispatch(openAssertionModal(null))}>Add assertion</Button>
                </div>
              </div>
              {test.project_id != null && <BusinessStepsNotice testName={test.name} />}

              {steps.length === 0 ? (
                <Card><EmptyState icon={List} title="No step yet">Add steps to build the test, then assertions to check what it does.</EmptyState></Card>
              ) : (
                <div className="steps">
                  {steps.map((step, i) => {
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
                      paramsPreview = Object.entries(params).map(([k, v]) => `${k}: ${String(v).substring(0, 40)}${String(v).length > 40 ? '…' : ''}`).join(', ');
                    }

                    return (
                      <div key={step.id} className={`step ${isAssertion ? 'step--assertion' : ''}`}>
                        <div className="step__order">{step.step_order}</div>
                        <div className="step__body">
                          <div className="step__head">
                            <span className={`step__command ${isAssertion ? 'step__command--assertion' : ''}`}>
                              {isAssertion && <ShieldCheck size={12} />}
                              {step.command}
                            </span>
                            {step.intent && <span className="step__intent">{step.intent}</span>}
                            {variable && variable.name && <span className="var-badge">{'{{' + variable.name + '}}'}</span>}
                            {!!step.optional && <span className="optional-badge" title="If it fails on a replay, the test goes on">optional</span>}
                            {step.element && (
                              <button className="element-chip" title={`The element it acts on, on ${step.page}`} onClick={() => go(`/elements?q=${encodeURIComponent(step.element ?? '')}`, { from: testName })}>
                                <MousePointerClick size={11} />{step.element}
                              </button>
                            )}
                          </div>
                          {paramsPreview && <div className="step__params" title={paramsPreview}>{paramsPreview}</div>}
                          {isAssertion && assertion?.type === 'visual_match' && (
                            <div className="vrt-preview" style={{ marginTop: '6px' }}>
                              <span className="field__hint" style={{ display: 'block', marginBottom: '4px' }}>Visual baseline reference:</span>
                              <img src={`/${assertion.expected}`} alt="VRT baseline" style={{ maxHeight: '80px', borderRadius: '4px' }} />
                            </div>
                          )}
                        </div>
                        <div className="step__actions">
                          <button className="icon-button" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => handleStepMove(step.step_order, -1)}>
                            <ChevronUp size={15} />
                          </button>
                          <button className="icon-button" title="Move down" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => handleStepMove(step.step_order, 1)}>
                            <ChevronDown size={15} />
                          </button>
                          <button className={`icon-button ${step.optional ? 'icon-button--on' : ''}`}
                            title={step.optional ? 'Optional: if it fails, the test goes on. Click to make it required' : 'Make optional: if it fails on a replay, the test goes on'}
                            aria-label={step.optional ? 'Make required' : 'Make optional'} aria-pressed={!!step.optional}
                            onClick={() => handleStepOptional(step.step_order, !step.optional)}>
                            <CircleDashed size={15} />
                          </button>
                          <button className="icon-button" title="Edit" aria-label="Edit" onClick={() => {
                            if (isAssertion) {
                              dispatch(openAssertionModal(step));
                            } else {
                              dispatch(openStepModal(step));
                            }
                          }}>
                            <Pencil size={15} />
                          </button>
                          <button className="icon-button icon-button--danger" title="Delete" aria-label="Delete" onClick={() => handleStepDelete(step.step_order)}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <StepModal
                isOpen={isStepModalOpen}
                testName={test.name}
                projectId={test.project_id ?? null}
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
            <>
              {test.project_id != null && <BusinessStepProposals testName={test.name} />}
              <Card><GherkinEditor testName={test.name} /></Card>
            </>
          ) : activeTab === 'code' ? (
            <Card><CodePanel testName={test.name} /></Card>
          ) : activeTab === 'campaigns' ? (
            <Card title="Campaigns" subtitle="The campaigns this test ran in, newest first, and how it did in each." flush>
              {campaigns.length === 0 ? (
                <EmptyState icon={Layers} title="Not run in a campaign yet">Choose it with others on the Tests page and “Run as campaign”.</EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Campaign</th><th>Here</th><th>Whole campaign</th><th>Started</th><th className="col-chevron" /></tr></thead>
                    <tbody>
                      {campaigns.map((c) => (
                        <tr key={c.id} className="clickable" onClick={() => go(`/campaigns/${c.id}`, { from: test.name })}>
                          <td><span className="cell-title">#{c.id} {c.name}</span>{c.version && <span className="campaign-version">v{c.version}</span>}</td>
                          <td>{c.run ? <StatusPill status={c.run.status} /> : '—'}{c.run?.duration_ms != null && <span className="cell-muted"> · {formatDuration(c.run.duration_ms)}</span>}</td>
                          <td><div className="result-cell"><ResultBar totals={c.totals} /><span>{c.totals.passed}/{c.total} passed</span></div></td>
                          <td className="cell-muted">{dateTime(c.created_at)}</td>
                          <td className="col-chevron"><ChevronRight size={16} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ) : (
            <Card>
              <div className="exec-history-section">
                <ExecutionHistory testName={test.name} refreshTrigger={refreshTrigger} onTestChanged={refetch} />
              </div>
            </Card>
          )}
        </div>

        {withSide && (
          <div className="stack">
            <Card title="Recent runs" actions={runs.length > 0 && <button className="link-btn" onClick={() => dispatch(setActiveTab('history'))}>All runs</button>}>
              {runs.length === 0 ? <p className="muted">Never run yet.</p> : (
                <div className="side-list">
                  {runs.slice(0, 5).map((r) => (
                    <div key={r.id} className="side-list__row side-list__row--link" onClick={() => dispatch(setActiveTab('history'))}>
                      <StatusPill status={r.status} />
                      <div className="side-list__main">
                        <span className="side-list__title">{relativeTime(r.started_at)} · {formatDuration(r.duration_ms)}{r.data_row ? <span className="row-chip" style={{ marginLeft: 6 }} title={rowValuesText(r.data_values)}>Row {r.data_row}</span> : null}</span>
                        {r.campaign_id
                          ? <button className="link-btn side-list__sub" onClick={(e) => { e.stopPropagation(); go(`/campaigns/${r.campaign_id}`, { from: test.name }); }}>In campaign #{r.campaign_id}</button>
                          : <span className="side-list__sub">{r.trigger === 'manual' ? 'Run from here' : r.trigger}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Campaigns" actions={campaigns.length > 3 && <button className="link-btn" onClick={() => dispatch(setActiveTab('campaigns'))}>All {campaigns.length}</button>}>
              {campaigns.length === 0 ? <p className="muted">Not run in a campaign yet.</p> : (
                <div className="side-list">
                  {campaigns.slice(0, 3).map((c) => (
                    <div key={c.id} className="side-list__row side-list__row--link" onClick={() => go(`/campaigns/${c.id}`, { from: test.name })}>
                      <div className="side-list__main">
                        <span className="side-list__title">#{c.id} {c.name}{c.version && <span className="campaign-version">v{c.version}</span>}</span>
                        <span className="side-list__sub">{relativeTime(c.created_at)}</span>
                      </div>
                      {c.run && <StatusPill status={c.run.status} />}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {confirmData && (
        <ConfirmModal
          isOpen={confirmData.isOpen}
          title={confirmData.title}
          message={confirmData.message}
          confirmLabel={confirmData.confirmLabel}
          onConfirm={confirmData.onConfirm}
          onCancel={() => setConfirmData(null)}
        />
      )}

      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        tone="primary"
        title="Leave without saving?"
        message={rowsDirty ? 'The rows you typed in the Data tab are not saved yet.' : 'The name or description you changed is not saved yet.'}
        confirmLabel="Leave without saving"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />

      {moving && (
        <MoveToProjectDialog
          tests={[test.name]} currentProjectId={projectId} onClose={() => setMoving(false)}
          onMoved={(newProjectId) => {
            dispatch(setProjectId(newProjectId));
            refetch();
          }}
        />
      )}

      <TestAgentModal
        testName={test.name}
        isOpen={agentOpen}
        onClose={() => setAgentOpen(false)}
        lastRunFailed={(lastOfRows?.status ?? lastRun?.status) === 'failed'}
        onAnswered={(changed) => {
          // It ran the test, maybe changed it: its runs, its steps, its Gherkin are read again.
          dispatch(incrementRefreshTrigger());
          dispatch(executionsApi.util.invalidateTags([{ type: 'ExecutionList', id: test.name }]));
          if (changed) dispatch(testsApi.util.invalidateTags([{ type: 'Test', id: test.name }, { type: 'TestList', id: 'LIST' }]));
        }}
      />

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
        liveTabId={liveTabId}
        liveRows={liveRows}
        liveRowIndex={liveRowIndex}
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
    </>
  );
}

/** The requirements the test checks, each a link to it: "SHOP-1 · criterion 1, 2". */
function TestRequirements({ testName }: { testName: string }) {
  const go = useGo();
  const { data: requirements = [] } = useGetTestRequirementsQuery(testName);
  return (
    <>
      {requirements.map((r) => (
        <KeyChip key={r.key} title={r.title} onClick={() => go(`/requirements/${encodeURIComponent(r.key)}`, { from: testName })}>
          {r.key}{r.criteria.length ? ` · criterion ${r.criteria.map((c) => c.number).join(', ')}` : ''}
        </KeyChip>
      ))}
    </>
  );
}
