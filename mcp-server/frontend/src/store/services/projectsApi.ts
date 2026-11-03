import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { PageElement, Project } from '../../types';
import { testsApi } from './testsApi';

interface ProjectsResponse {
  projects: Project[];
}

export const projectsApi = createApi({
  reducerPath: 'projectsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['ProjectList', 'Elements'],
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
} = projectsApi;
