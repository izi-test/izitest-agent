import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Requirement, RequirementCase, RequirementImport, TestRequirement } from '../../types';

type RequirementInput = Partial<Pick<Requirement, 'title' | 'description' | 'priority' | 'likelihood' | 'impact' | 'source' | 'key'>> & {
  criteria?: Array<string | { id?: number; text: string }>;
  url?: string | null;
  project_id?: number | null;
};

/** Where to start reading a tool's requirements from: a Jira project's stories, as a query. */
type ConnectorScope = { label: string; query: string };

// Requirements, their criteria and cases, and the tests linked to them (mcp-server/lib/requirements.js).
export const requirementsApi = createApi({
  reducerPath: 'requirementsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Requirements', 'Requirement', 'TestRequirements'],
  endpoints: (builder) => ({
    getRequirements: builder.query<Requirement[], number | null | undefined>({
      query: (projectId) => `api/requirements${projectId ? `?project_id=${projectId}` : ''}`,
      transformResponse: (response: { requirements: Requirement[] }) => response.requirements ?? [],
      providesTags: ['Requirements'],
    }),
    getRequirement: builder.query<Requirement, string>({
      query: (ref) => `api/requirements/${encodeURIComponent(ref)}`,
      transformResponse: (response: { requirement: Requirement }) => response.requirement,
      providesTags: (_result, _error, ref) => [{ type: 'Requirement', id: ref }],
    }),
    createRequirement: builder.mutation<{ requirement: Requirement }, RequirementInput>({
      query: (body) => ({ url: 'api/requirements', method: 'POST', body }),
      invalidatesTags: ['Requirements'],
    }),
    updateRequirement: builder.mutation<{ requirement: Requirement }, { ref: string } & RequirementInput>({
      query: ({ ref, ...body }) => ({ url: `api/requirements/${encodeURIComponent(ref)}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { ref }) => ['Requirements', { type: 'Requirement', id: ref }, 'TestRequirements'],
    }),
    deleteRequirement: builder.mutation<{ success: boolean }, string>({
      query: (ref) => ({ url: `api/requirements/${encodeURIComponent(ref)}`, method: 'DELETE' }),
      invalidatesTags: ['Requirements', 'TestRequirements'],
    }),
    // A test linked (test_name), or a case planned (title): for a criterion (its number), or the whole requirement.
    addCase: builder.mutation<{ requirement: Requirement }, { ref: string; test_name?: string; case_id?: number; title?: string; criterion?: number | null; kind?: string }>({
      query: ({ ref, ...body }) => ({ url: `api/requirements/${encodeURIComponent(ref)}/cases`, method: 'POST', body }),
      invalidatesTags: (_result, _error, { ref }) => ['Requirements', { type: 'Requirement', id: ref }, 'TestRequirements'],
    }),
    // A case changed: its title, kind, technique, priority, scenario.
    updateCase: builder.mutation<{ requirement: Requirement }, { ref: string; caseId: number } & Partial<Pick<RequirementCase, 'title' | 'kind' | 'technique' | 'priority' | 'rationale' | 'gherkin'>>>({
      query: ({ ref, caseId, ...body }) => ({ url: `api/requirements/${encodeURIComponent(ref)}/cases/${caseId}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { ref }) => [{ type: 'Requirement', id: ref }],
    }),
    // The agent set in Settings reviews the criteria and proposes scenarios: one answer, up to a few minutes.
    designRequirement: builder.mutation<{ requirement: Requirement }, string>({
      query: (ref) => ({ url: `api/requirements/${encodeURIComponent(ref)}/design`, method: 'POST' }),
      invalidatesTags: (_result, _error, ref) => [{ type: 'Requirement', id: ref }],
    }),
    // The proposals chosen become planned cases.
    planDesign: builder.mutation<{ requirement: Requirement }, { ref: string; scenarios: string[] }>({
      query: ({ ref, scenarios }) => ({ url: `api/requirements/${encodeURIComponent(ref)}/design/plan`, method: 'POST', body: { scenarios } }),
      invalidatesTags: (_result, _error, { ref }) => ['Requirements', { type: 'Requirement', id: ref }],
    }),
    // A rule the design found unsaid: written where it belongs (another requirement, one for the whole project), or dismissed.
    placeMissing: builder.mutation<{ requirement: Requirement; placed: string | null }, { ref: string; text: string; dismiss?: boolean }>({
      query: ({ ref, text, dismiss }) => ({ url: `api/requirements/${encodeURIComponent(ref)}/design/missing`, method: 'POST', body: { text, dismiss: !!dismiss } }),
      invalidatesTags: (result, _error, { ref }) => ['Requirements', { type: 'Requirement', id: ref }, ...(result?.placed ? [{ type: 'Requirement' as const, id: result.placed }] : [])],
    }),
    dismissDesign: builder.mutation<{ requirement: Requirement }, string>({
      query: (ref) => ({ url: `api/requirements/${encodeURIComponent(ref)}/design`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, ref) => [{ type: 'Requirement', id: ref }],
    }),
    deleteCase: builder.mutation<{ requirement: Requirement }, { ref: string; caseId: number }>({
      query: ({ ref, caseId }) => ({ url: `api/requirements/${encodeURIComponent(ref)}/cases/${caseId}`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, { ref }) => ['Requirements', { type: 'Requirement', id: ref }, 'TestRequirements'],
    }),
    // A file of requirements: previewed (dry_run), or imported.
    importRequirements: builder.mutation<{ import: RequirementImport }, {
      filename?: string; content?: string; content_base64?: string; format?: string; sheet?: string;
      columns?: Record<string, string | null>; project_id?: number | null; dry_run: boolean;
    }>({
      query: (body) => ({ url: 'api/requirements/import', method: 'POST', body }),
      invalidatesTags: (_result, _error, { dry_run }) => (dry_run ? [] : ['Requirements', 'Requirement', 'TestRequirements']),
    }),
    // Requirements read from a tool set in Settings → Connectors: by a query, their keys, or again (sync); saved unless dry_run.
    importFromConnector: builder.mutation<{ import: RequirementImport }, {
      connector: string; query?: string; keys?: string[]; sync?: boolean; project_id?: number | null; dry_run: boolean;
    }>({
      query: ({ connector, ...body }) => ({ url: `api/connectors/${connector}/import`, method: 'POST', body }),
      invalidatesTags: (_result, _error, { dry_run }) => (dry_run ? [] : ['Requirements', 'Requirement', 'TestRequirements']),
    }),
    getConnectorScopes: builder.query<ConnectorScope[], string>({
      query: (connector) => `api/connectors/${connector}/scopes`,
      transformResponse: (response: { scopes: ConnectorScope[] }) => response.scopes ?? [],
    }),
    getTestRequirements: builder.query<TestRequirement[], string>({
      query: (testName) => `api/tests/${encodeURIComponent(testName)}/requirements`,
      transformResponse: (response: { requirements: TestRequirement[] }) => response.requirements ?? [],
      providesTags: ['TestRequirements'],
    }),
  }),
});

export const {
  useGetRequirementsQuery,
  useGetRequirementQuery,
  useCreateRequirementMutation,
  useUpdateRequirementMutation,
  useDeleteRequirementMutation,
  useAddCaseMutation,
  useDeleteCaseMutation,
  useUpdateCaseMutation,
  useDesignRequirementMutation,
  usePlanDesignMutation,
  useDismissDesignMutation,
  usePlaceMissingMutation,
  useImportRequirementsMutation,
  useImportFromConnectorMutation,
  useGetConnectorScopesQuery,
  useGetTestRequirementsQuery,
} = requirementsApi;
