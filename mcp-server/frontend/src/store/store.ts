import { configureStore } from '@reduxjs/toolkit';
import uiReducer from './slices/uiSlice';
import testDetailReducer from './slices/testDetailSlice';
import executionReducer from './slices/executionSlice';
import { testsApi } from './services/testsApi';
import { executionsApi } from './services/executionsApi';
import { projectsApi } from './services/projectsApi';
import { settingsApi } from './services/settingsApi';

export const store = configureStore({
  reducer: {
    ui: uiReducer,
    testDetail: testDetailReducer,
    execution: executionReducer,
    [testsApi.reducerPath]: testsApi.reducer,
    [executionsApi.reducerPath]: executionsApi.reducer,
    [projectsApi.reducerPath]: projectsApi.reducer,
    [settingsApi.reducerPath]: settingsApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware()
      .concat(testsApi.middleware)
      .concat(executionsApi.middleware)
      .concat(projectsApi.middleware)
      .concat(settingsApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
