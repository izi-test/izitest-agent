import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

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

export const settingsApi = createApi({
  reducerPath: 'settingsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['AgentConfig'],
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
} = settingsApi;
