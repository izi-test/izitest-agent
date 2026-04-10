import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

type ViewType = 'List' | 'Detail' | 'Settings';

interface ToastState {
  message: string | null;
  type: 'success' | 'error';
}

interface UiState {
  view: ViewType;
  currentTestName: string | null;
  toast: ToastState;
  selectedProjectId: number | null;
  searchQuery: string;
}

const initialState: UiState = {
  view: 'List',
  currentTestName: null,
  toast: { message: null, type: 'success' },
  selectedProjectId: null,
  searchQuery: '',
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setView(state, action: PayloadAction<ViewType>) {
      state.view = action.payload;
    },
    setCurrentTestName(state, action: PayloadAction<string | null>) {
      state.currentTestName = action.payload;
    },
    showToast(state, action: PayloadAction<{ message: string; type?: 'success' | 'error' }>) {
      state.toast.message = action.payload.message;
      state.toast.type = action.payload.type ?? 'success';
    },
    clearToast(state) {
      state.toast.message = null;
    },
    setSelectedProjectId(state, action: PayloadAction<number | null>) {
      state.selectedProjectId = action.payload;
    },
    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
    },
    navigateToDetail(state, action: PayloadAction<string>) {
      state.currentTestName = action.payload;
      state.view = 'Detail';
    },
    navigateToList(state) {
      state.view = 'List';
    },
  },
});

export const {
  setView,
  setCurrentTestName,
  showToast,
  clearToast,
  setSelectedProjectId,
  setSearchQuery,
  navigateToDetail,
  navigateToList,
} = uiSlice.actions;

export default uiSlice.reducer;
