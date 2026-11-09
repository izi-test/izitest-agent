import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Dataset, PageElement, Project, ProjectSecret } from '../../types';
import { testsApi } from './testsApi';

interface ProjectsResponse {
  projects: Project[];
}

export const projectsApi = createApi({
  reducerPath: 'projectsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['ProjectList', 'Elements', 'Datasets', 'Secrets'],
  endpoints: (builder) => ({

    getProjects: builder.query<Project[], void>({
      query: () => 'api/projects',
      transformResponse: (response: ProjectsResponse) => response.projects,
      providesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),

    createProject: builder.mutation<{ id: number; name: string }, { name: string; description?: string; context?: string; project_type?: string; base_url?: string; language?: string }>({
      query: (body) => ({ url: 'api/projects', method: 'POST', body }),
      invalidatesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),

    updateProject: builder.mutation<void, { id: number; name?: string; description?: string; context?: string; project_type?: string; base_url?: string; language?: string }>({
      query: ({ id, ...body }) => ({
        url: `api/projects/${id}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: [{ type: 'ProjectList', id: 'LIST' }],
      // In another language, its tests' Gherkin reads in it.
      async onQueryStarted({ language }, { dispatch, queryFulfilled }) {
        if (language === undefined) return;
        await queryFulfilled.catch(() => null);
        dispatch(testsApi.util.invalidateTags(['Test']));
      },
    }),

    deleteProject: builder.mutation<void, number>({
      query: (id) => ({ url: `api/projects/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),

    // The elements its steps act on (mcp-server/lib/element-store.js).
    getElements: builder.query<PageElement[], number>({
      query: (projectId) => `api/projects/${projectId}/elements`,
      transformResponse: (response: { elements: PageElement[] }) => response.elements ?? [],
      providesTags: ['Elements'],
    }),

    // Renamed, an element reads under its new name in the Gherkin of every test using it.
    renameElement: builder.mutation<{ name: string }, { id: number; name: string }>({
      query: ({ id, name }) => ({ url: `api/elements/${id}`, method: 'PATCH', body: { name } }),
      invalidatesTags: ['Elements'],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        await queryFulfilled.catch(() => null);
        dispatch(testsApi.util.invalidateTags(['Test']));
      },
    }),

    // Its secrets (mcp-server/lib/secrets.js): names and descriptions, never a value.
    getSecrets: builder.query<ProjectSecret[], number>({
      query: (projectId) => `api/projects/${projectId}/secrets`,
      transformResponse: (response: { secrets: ProjectSecret[] }) => response.secrets ?? [],
      providesTags: ['Secrets'],
    }),

    // Added, or replaced: a value left out keeps the stored one.
    saveSecret: builder.mutation<{ secret: ProjectSecret }, { projectId: number; name: string; value?: string; description?: string }>({
      query: ({ projectId, name, ...body }) => ({ url: `api/projects/${projectId}/secrets/${encodeURIComponent(name)}`, method: 'PUT', body }),
      invalidatesTags: ['Secrets'],
    }),

    deleteSecret: builder.mutation<void, { projectId: number; name: string }>({
      query: ({ projectId, name }) => ({ url: `api/projects/${projectId}/secrets/${encodeURIComponent(name)}`, method: 'DELETE' }),
      invalidatesTags: ['Secrets'],
    }),

    // Its datasets (mcp-server/lib/datasets.js).
    getDatasets: builder.query<Dataset[], number>({
      query: (projectId) => `api/projects/${projectId}/datasets`,
      transformResponse: (response: { datasets: Dataset[] }) => response.datasets ?? [],
      providesTags: ['Datasets'],
    }),

    getDataset: builder.query<Dataset, number>({
      query: (id) => `api/datasets/${id}`,
      transformResponse: (response: { dataset: Dataset }) => response.dataset,
      providesTags: ['Datasets'],
    }),

    // A file dropped in: text (CSV, JSON), or an Excel workbook in base64. Its name replaces the dataset of that name.
    saveDataset: builder.mutation<{ dataset: Dataset }, { projectId: number; name?: string; filename: string; content?: string; content_base64?: string }>({
      query: ({ projectId, ...body }) => ({ url: `api/projects/${projectId}/datasets`, method: 'POST', body }),
      invalidatesTags: ['Datasets'],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        await queryFulfilled.catch(() => null);
        dispatch(testsApi.util.invalidateTags(['Test']));
      },
    }),

    deleteDataset: builder.mutation<void, number>({
      query: (id) => ({ url: `api/datasets/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Datasets'],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        await queryFulfilled.catch(() => null);
        dispatch(testsApi.util.invalidateTags(['Test']));
      },
    }),

    deleteElement: builder.mutation<void, number>({
      query: (id) => ({ url: `api/elements/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Elements'],
    }),
  }),
});

export const {
  useGetProjectsQuery,
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useGetElementsQuery,
  useRenameElementMutation,
  useDeleteElementMutation,
  useGetDatasetsQuery,
  useGetDatasetQuery,
  useSaveDatasetMutation,
  useDeleteDatasetMutation,
  useGetSecretsQuery,
  useSaveSecretMutation,
  useDeleteSecretMutation,
} = projectsApi;
