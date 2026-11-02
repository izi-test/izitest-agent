import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Step } from '../../types';

type TabType = 'steps' | 'history' | 'data' | 'gherkin' | 'code' | 'campaigns';

interface TestDetailState {
  editName: string;
  editDescription: string;
  projectId: number | null;
  variableOverrides: Record<string, string>;
  activeTab: TabType;
  executeNewWindow: boolean;
  useAgent: boolean;
  useDebug: boolean;

  isStepModalOpen: boolean;
  editingStep: Step | null;

  isAssertionModalOpen: boolean;
  editingAssertionStep: Step | null;

  confirmModal: {
    isOpen: boolean;
    message: string;
    /** Stored as a serializable identifier — the actual callback is handled in the component */
    actionType: 'deleteStep' | 'deleteTest' | null;
    actionPayload: number | string | null;
  };
}

const initialState: TestDetailState = {
  editName: '',
  editDescription: '',
  projectId: null,
  variableOverrides: {},
  activeTab: 'steps',
  executeNewWindow: true,
  useAgent: false,
  useDebug: false,

  isStepModalOpen: false,
  editingStep: null,

  isAssertionModalOpen: false,
  editingAssertionStep: null,

  confirmModal: { isOpen: false, message: '', actionType: null, actionPayload: null },
};

const testDetailSlice = createSlice({
  name: 'testDetail',
  initialState,
  reducers: {
    initTestDetail(state, action: PayloadAction<{ name: string; description: string; projectId: number | null; variables: Record<string, string> }>) {
      state.editName = action.payload.name;
      state.editDescription = action.payload.description;
      state.projectId = action.payload.projectId;
      state.variableOverrides = action.payload.variables;
    },
    setEditName(state, action: PayloadAction<string>) {
      state.editName = action.payload;
    },
    setEditDescription(state, action: PayloadAction<string>) {
      state.editDescription = action.payload;
    },
    setProjectId(state, action: PayloadAction<number | null>) {
      state.projectId = action.payload;
    },
    setActiveTab(state, action: PayloadAction<TabType>) {
      state.activeTab = action.payload;
    },
    setVariableOverride(state, action: PayloadAction<{ key: string; value: string }>) {
      state.variableOverrides[action.payload.key] = action.payload.value;
    },
    toggleNewWindow(state) {
      state.executeNewWindow = !state.executeNewWindow;
    },
    toggleAgent(state) {
      state.useAgent = !state.useAgent;
    },
    setExecuteNewWindow(state, action: PayloadAction<boolean>) {
      state.executeNewWindow = action.payload;
    },
    setUseAgent(state, action: PayloadAction<boolean>) {
      state.useAgent = action.payload;
    },
    setUseDebug(state, action: PayloadAction<boolean>) {
      state.useDebug = action.payload;
    },

    openStepModal(state, action: PayloadAction<Step | null>) {
      state.editingStep = action.payload;
      state.isStepModalOpen = true;
    },
    closeStepModal(state) {
      state.isStepModalOpen = false;
      state.editingStep = null;
    },

    openAssertionModal(state, action: PayloadAction<Step | null>) {
      state.editingAssertionStep = action.payload;
      state.isAssertionModalOpen = true;
    },
    closeAssertionModal(state) {
      state.isAssertionModalOpen = false;
      state.editingAssertionStep = null;
    },

    openConfirmModal(state, action: PayloadAction<{ message: string; actionType: 'deleteStep' | 'deleteTest'; actionPayload: number | string }>) {
      state.confirmModal = { isOpen: true, ...action.payload };
    },
    closeConfirmModal(state) {
      state.confirmModal = { isOpen: false, message: '', actionType: null, actionPayload: null };
    },

    resetTestDetail() {
      return initialState;
    },
  },
});

export const {
  initTestDetail,
  setEditName,
  setEditDescription,
  setProjectId,
  setActiveTab,
  setVariableOverride,
  toggleNewWindow,
  toggleAgent,
  setExecuteNewWindow,
  setUseAgent,
  setUseDebug,
  openStepModal,
  closeStepModal,
  openAssertionModal,
  closeAssertionModal,
  openConfirmModal,
  closeConfirmModal,
  resetTestDetail,
} = testDetailSlice.actions;

export default testDetailSlice.reducer;
