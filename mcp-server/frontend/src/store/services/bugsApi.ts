import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Bug, BugSend, Exploration } from '../../types';

/** What handling a bug changes: null removes a priority or an assignee; duplicate_of makes it a duplicate. */
export type BugChanges = Partial<Pick<Bug, 'status' | 'priority' | 'assignee' | 'duplicate_of' | 'severity' | 'title'>>;

/** A bug a person reports, for the agent to reproduce. */
export interface BugReport {
  title: string;
  description: string;
  expected?: string;
  page_url?: string;
  severity?: Bug['severity'];
  priority?: Bug['priority'];
  assignee?: string;
  project_id?: number | null;
  requirement?: string;
}

// The bugs the explorer found, and its runs (mcp-server/lib/bugs.js).
export const bugsApi = createApi({
  reducerPath: 'bugsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Bugs', 'Explorations'],
  endpoints: (builder) => ({
    getBugs: builder.query<Bug[], { status: string; projectId?: number | null }>({
      query: ({ status, projectId }) => `api/bugs?status=${status}${projectId ? `&project_id=${projectId}` : ''}`,
      transformResponse: (response: { bugs: Bug[] }) => response.bugs ?? [],
      providesTags: ['Bugs'],
    }),
    updateBug: builder.mutation<{ bug: Bug }, { id: number } & BugChanges>({
      query: ({ id, ...body }) => ({ url: `api/bugs/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Bugs'],
    }),
    reportBug: builder.mutation<{ bug: Bug }, BugReport>({
      query: (body) => ({ url: 'api/bugs', method: 'POST', body }),
      invalidatesTags: ['Bugs'],
    }),
    // Written to a tool (mcp-server/lib/connectors) unless a dry run: what would be sent, first.
    sendBug: builder.mutation<BugSend, { id: number; connector: string; options: Record<string, string>; dry_run: boolean }>({
      query: ({ id, connector, ...body }) => ({ url: `api/bugs/${id}/send/${connector}`, method: 'POST', body }),
      transformResponse: (response: { result: BugSend }) => response.result,
      invalidatesTags: (_result, _error, { dry_run }) => (dry_run ? [] : ['Bugs']),
    }),
    getExplorations: builder.query<Exploration[], void>({
      query: () => 'api/explorations',
      transformResponse: (response: { explorations: Exploration[] }) => response.explorations ?? [],
      providesTags: ['Explorations'],
    }),
    startExploration: builder.mutation<{ id: number }, { url: string; max_pages: number; interact: boolean; project_id?: number | null }>({
      query: (body) => ({ url: 'api/explorations', method: 'POST', body }),
      invalidatesTags: ['Explorations'],
    }),
  }),
});

export const { useGetBugsQuery, useUpdateBugMutation, useReportBugMutation, useSendBugMutation, useGetExplorationsQuery, useStartExplorationMutation } = bugsApi;
