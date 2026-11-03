import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { initialScope } from '../../scope';

interface ToastState {
  message: string | null;
  type: 'success' | 'error';
}

interface UiState {
  toast: ToastState;
  selectedProjectId: number | null;
  searchQuery: string;
  /** The "New test" window, opened from the top bar or from a page. */
  createTestOpen: boolean;
  /** Runs and campaigns started here go to the Chrome without windows. */
  runHeadless: boolean;
}

const HEADLESS_KEY = 'izitest.headless';
const storedHeadless = () => {
  try {
    return localStorage.getItem(HEADLESS_KEY) === '1';
  } catch {
    return false;
  }
};

const initialState: UiState = {
  toast: { message: null, type: 'success' },
  // The URL's project, or the last one chosen: a reload keeps it.
  selectedProjectId: initialScope(),
  searchQuery: '',
  createTestOpen: false,
  runHeadless: storedHeadless(),
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
    setCreateTestOpen(state, action: PayloadAction<boolean>) {
      state.createTestOpen = action.payload;
    },
    setRunHeadless(state, action: PayloadAction<boolean>) {
      state.runHeadless = action.payload;
      try {
        localStorage.setItem(HEADLESS_KEY, action.payload ? '1' : '0');
      } catch {
        // Private window: the choice lasts as long as the tab.
      }
    },
  },
});

export const {
  showToast,
  clearToast,
  setSelectedProjectId,
  setSearchQuery,
  setCreateTestOpen,
  setRunHeadless,
} = uiSlice.actions;

export default uiSlice.reducer;
