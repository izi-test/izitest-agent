import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Connector } from '../../types';

interface CliConfig {
  provider: string;
  command: string;
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
}

export const settingsApi = createApi({
  reducerPath: 'settingsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['AgentConfig', 'Connectors', 'Headless'],
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

    testAgent: builder.mutation<TestAgentResponse, { command: string }>({
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
} = settingsApi;
