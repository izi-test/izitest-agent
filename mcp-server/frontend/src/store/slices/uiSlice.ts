import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface ToastState {
  message: string | null;
  type: 'success' | 'error';
}

interface UiState {
  toast: ToastState;
  selectedProjectId: number | null;
  searchQuery: string;
}

const initialState: UiState = {
  toast: { message: null, type: 'success' },
  selectedProjectId: null,
  searchQuery: '',
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
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
  },
});

export const {
  showToast,
  clearToast,
  setSelectedProjectId,
  setSearchQuery,
} = uiSlice.actions;

export default uiSlice.reducer;
