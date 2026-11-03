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

/** The Xray API key campaigns are sent with (mcp-server/lib/xray.js): its secret comes back masked. */
export interface XrayConfig {
  clientId: string;
  clientSecret: string;
  from?: 'settings' | 'env';
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
  tagTypes: ['AgentConfig', 'JiraConfig', 'XrayConfig', 'Headless'],
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

    getXrayConfig: builder.query<XrayConfig | null, void>({
      query: () => 'api/settings/xray',
      transformResponse: (response: { xray: XrayConfig | null }) => response.xray,
      providesTags: ['XrayConfig'],
    }),

    updateXrayConfig: builder.mutation<{ xray: XrayConfig | null }, XrayConfig>({
      query: (body) => ({ url: 'api/settings/xray', method: 'PUT', body }),
      invalidatesTags: ['XrayConfig'],
    }),

    testXray: builder.mutation<{ success: boolean; url?: string; error?: string }, Partial<XrayConfig>>({
      query: (body) => ({ url: 'api/settings/xray/test', method: 'POST', body }),
    }),

    // The Chrome without windows tests can run in (mcp-server/lib/headless.js).
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
  useGetJiraConfigQuery,
  useUpdateJiraConfigMutation,
  useTestJiraMutation,
  useGetXrayConfigQuery,
  useUpdateXrayConfigMutation,
  useTestXrayMutation,
  useGetHeadlessQuery,
  useHeadlessActionMutation,
} = settingsApi;
