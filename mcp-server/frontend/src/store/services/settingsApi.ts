import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Connector } from '../../types';

interface CliConfig {
  provider: string;
  command: string;
  /** Passed as --model; absent or empty, the CLI's own default. */
  model?: string;
}

interface ApiConfig {
  model: string;
  apiKey: string;
}

export interface AgentConfig {
  mode: 'cli' | 'api';
  cli: CliConfig;
  api: ApiConfig;
}

interface AgentConfigResponse {
  agent: AgentConfig;
}

interface TestAgentResponse {
  success: boolean;
  output?: string;
  error?: string;
  /** The model that answered (Claude Code), or the one set (another CLI). */
  model?: string | null;
  /** No model was set: the one that answered is the CLI's own default. */
  model_default?: boolean;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context: number;
  pricing: { prompt: string; completion: string };
}

/** Where the headless Chrome stands: installed (which version), being installed, running, connected. */
export interface HeadlessStatus {
  installed: { version: string } | null;
  installing: { downloaded: number; total: number } | null;
  starting: boolean;
  running: boolean;
  connected: boolean;
  extension_built: boolean;
  error: string | null;
  browsers_dir: string;
  profile_dir: string;
  /** Stopped after that many minutes without work; 0: only with the server. */
  idle_minutes: number;
}

/**
 * What becomes of the window a run or a recording opened, once it is over
 * (mcp-server/lib/run-windows.js): only a window IziTest opened is ever closed.
 */
export interface WindowSettings {
  /** keep: it stays open; passed: it closes when the test passed; always: it closes. */
  after_run: 'keep' | 'passed' | 'always';
  /** The window a test was recorded in closes once the test is saved. */
  after_recording: boolean;
}

export const settingsApi = createApi({
  reducerPath: 'settingsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['AgentConfig', 'Connectors', 'Headless', 'Windows'],
  endpoints: (builder) => ({

    getAgentConfig: builder.query<AgentConfig, void>({
      query: () => 'api/settings/agent',
      transformResponse: (response: AgentConfigResponse) => response.agent,
      providesTags: ['AgentConfig'],
    }),

    updateAgentConfig: builder.mutation<void, { agent: AgentConfig }>({
      query: (body) => ({ url: 'api/settings/agent', method: 'PUT', body }),
      invalidatesTags: ['AgentConfig'],
    }),

    testAgent: builder.mutation<TestAgentResponse, { command: string; provider?: string; model?: string }>({
      query: (body) => ({ url: 'api/settings/agent/test', method: 'POST', body }),
    }),

    testApiKey: builder.mutation<TestAgentResponse, { apiKey: string; model: string }>({
      query: (body) => ({ url: 'api/settings/agent/test-api', method: 'POST', body }),
    }),

    // The tools requirements are read from and results written to (mcp-server/lib/connectors).
    getConnectors: builder.query<Connector[], void>({
      query: () => 'api/connectors',
      transformResponse: (response: { connectors: Connector[] }) => response.connectors,
      providesTags: ['Connectors'],
    }),
    // A secret given masked keeps the one saved; the first field empty removes the settings.
    saveConnector: builder.mutation<{ connector: Connector }, { id: string; values: Record<string, string> }>({
      query: ({ id, values }) => ({ url: `api/connectors/${id}`, method: 'PUT', body: { values } }),
      invalidatesTags: ['Connectors'],
    }),
    testConnector: builder.mutation<{ success: boolean; text?: string; error?: string }, { id: string; values: Record<string, string> }>({
      query: ({ id, values }) => ({ url: `api/connectors/${id}/test`, method: 'POST', body: { values } }),
    }),
    getHeadless: builder.query<HeadlessStatus, void>({
      query: () => 'api/headless',
      transformResponse: (response: { headless: HeadlessStatus }) => response.headless,
      providesTags: ['Headless'],
    }),
    headlessAction: builder.mutation<{ headless: HeadlessStatus }, 'install' | 'start' | 'stop'>({
      query: (action) => ({ url: `api/headless/${action}`, method: 'POST' }),
      invalidatesTags: ['Headless'],
    }),
    setHeadlessIdle: builder.mutation<{ headless: HeadlessStatus }, number>({
      query: (minutes) => ({ url: 'api/headless/settings', method: 'PUT', body: { idle_minutes: minutes } }),
      invalidatesTags: ['Headless'],
    }),
    getWindowSettings: builder.query<WindowSettings, void>({
      query: () => 'api/settings/windows',
      providesTags: ['Windows'],
    }),
    // What is not given stays as it was; shown changed at once, put back if the server refuses it.
    setWindowSettings: builder.mutation<WindowSettings, Partial<WindowSettings>>({
      query: (body) => ({ url: 'api/settings/windows', method: 'PUT', body }),
      async onQueryStarted(changes, { dispatch, queryFulfilled }) {
        const patch = dispatch(settingsApi.util.updateQueryData('getWindowSettings', undefined, (draft) => { Object.assign(draft, changes); }));
        try {
          const { data } = await queryFulfilled;
          dispatch(settingsApi.util.upsertQueryData('getWindowSettings', undefined, data));
        } catch {
          patch.undo();
        }
      },
    }),
    getModels: builder.query<OpenRouterModel[], void>({
      query: () => 'api/models',
      transformResponse: (response: { models: OpenRouterModel[] }) => response.models,
    }),
  }),
});

export const {
  useGetAgentConfigQuery,
  useUpdateAgentConfigMutation,
  useTestAgentMutation,
  useTestApiKeyMutation,
  useGetModelsQuery,
  useGetConnectorsQuery,
  useSaveConnectorMutation,
  useTestConnectorMutation,
  useGetHeadlessQuery,
  useHeadlessActionMutation,
  useSetHeadlessIdleMutation,
  useGetWindowSettingsQuery,
  useSetWindowSettingsMutation,
} = settingsApi;
