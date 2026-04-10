import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Project } from '../../types';

interface ProjectsResponse {
  projects: Project[];
}

export const projectsApi = createApi({
  reducerPath: 'projectsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['ProjectList'],
  endpoints: (builder) => ({

    getProjects: builder.query<Project[], void>({
      query: () => 'api/projects',
      transformResponse: (response: ProjectsResponse) => response.projects,
      providesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),

    createProject: builder.mutation<{ id: number; name: string }, { name: string; description?: string }>({
      query: (body) => ({ url: 'api/projects', method: 'POST', body }),
      invalidatesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),

    updateProject: builder.mutation<void, { id: number; name?: string; description?: string }>({
      query: ({ id, ...body }) => ({
        url: `api/projects/${id}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),

    deleteProject: builder.mutation<void, number>({
      query: (id) => ({ url: `api/projects/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'ProjectList', id: 'LIST' }],
    }),
  }),
});

export const {
  useGetProjectsQuery,
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
} = projectsApi;
