import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Bug, Exploration } from '../../types';

// The bugs the explorer found, and its runs (mcp-server/lib/bugs.js).
export const bugsApi = createApi({
  reducerPath: 'bugsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Bugs', 'Explorations'],
  endpoints: (builder) => ({
    getBugs: builder.query<Bug[], { status: string }>({
      query: ({ status }) => `api/bugs?status=${status}`,
      transformResponse: (response: { bugs: Bug[] }) => response.bugs ?? [],
      providesTags: ['Bugs'],
    }),
    setBugStatus: builder.mutation<{ bug: Bug }, { id: number; status: Bug['status'] }>({
      query: ({ id, status }) => ({ url: `api/bugs/${id}`, method: 'PUT', body: { status } }),
      invalidatesTags: ['Bugs'],
    }),
    getExplorations: builder.query<Exploration[], void>({
      query: () => 'api/explorations',
      transformResponse: (response: { explorations: Exploration[] }) => response.explorations ?? [],
      providesTags: ['Explorations'],
    }),
    startExploration: builder.mutation<{ id: number }, { url: string; max_pages: number; interact: boolean }>({
      query: (body) => ({ url: 'api/explorations', method: 'POST', body }),
      invalidatesTags: ['Explorations'],
    }),
  }),
});

export const { useGetBugsQuery, useSetBugStatusMutation, useGetExplorationsQuery, useStartExplorationMutation } = bugsApi;
