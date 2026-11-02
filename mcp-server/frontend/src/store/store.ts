import { configureStore } from '@reduxjs/toolkit';
import uiReducer from './slices/uiSlice';
import testDetailReducer from './slices/testDetailSlice';
import executionReducer from './slices/executionSlice';
import { testsApi } from './services/testsApi';
import { executionsApi } from './services/executionsApi';
import { projectsApi } from './services/projectsApi';
import { settingsApi } from './services/settingsApi';
import { chatApi } from './services/chatApi';
import { statsApi } from './services/statsApi';
import { bugsApi } from './services/bugsApi';
import { requirementsApi } from './services/requirementsApi';

export const store = configureStore({
  reducer: {
    ui: uiReducer,
    testDetail: testDetailReducer,
    execution: executionReducer,
    [testsApi.reducerPath]: testsApi.reducer,
    [executionsApi.reducerPath]: executionsApi.reducer,
    [projectsApi.reducerPath]: projectsApi.reducer,
    [settingsApi.reducerPath]: settingsApi.reducer,
    [chatApi.reducerPath]: chatApi.reducer,
    [statsApi.reducerPath]: statsApi.reducer,
    [bugsApi.reducerPath]: bugsApi.reducer,
    [requirementsApi.reducerPath]: requirementsApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware()
      .concat(testsApi.middleware)
      .concat(executionsApi.middleware)
      .concat(projectsApi.middleware)
      .concat(settingsApi.middleware)
      .concat(chatApi.middleware)
      .concat(statsApi.middleware)
      .concat(bugsApi.middleware)
      .concat(requirementsApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
