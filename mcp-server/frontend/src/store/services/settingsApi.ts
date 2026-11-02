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

/** The Jira site requirements are read from (mcp-server/lib/jira.js): its token comes back masked. */
export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  from?: 'settings' | 'env';
}

export const settingsApi = createApi({
  reducerPath: 'settingsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['AgentConfig', 'JiraConfig'],
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

    getJiraConfig: builder.query<JiraConfig | null, void>({
      query: () => 'api/settings/jira',
      transformResponse: (response: { jira: JiraConfig | null }) => response.jira,
      providesTags: ['JiraConfig'],
    }),

    updateJiraConfig: builder.mutation<{ jira: JiraConfig | null }, JiraConfig>({
      query: (body) => ({ url: 'api/settings/jira', method: 'PUT', body }),
      invalidatesTags: ['JiraConfig'],
    }),

    testJira: builder.mutation<{ success: boolean; user?: string; site?: string; error?: string }, Partial<JiraConfig>>({
      query: (body) => ({ url: 'api/settings/jira/test', method: 'POST', body }),
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
  useGetJiraConfigQuery,
  useUpdateJiraConfigMutation,
  useTestJiraMutation,
} = settingsApi;
