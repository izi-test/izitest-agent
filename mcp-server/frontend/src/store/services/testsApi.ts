import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Test } from '../../types';

interface TestsResponse {
  tests: Test[];
}

interface TestResponse {
  test: Test;
}

interface StepBody {
  command: string;
  intent?: string | null;
  params: Record<string, unknown>;
  locators?: unknown[] | null;
  variable?: unknown | null;
  assertion?: unknown | null;
}

interface ReorderEntry {
  id: string;
  step_order: number;
}

export const testsApi = createApi({
  reducerPath: 'testsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Test', 'TestList'],
  endpoints: (builder) => ({

    getTests: builder.query<Test[], number | null | undefined>({
      query: (projectId) => {
        const queryString = projectId !== undefined ? `?project_id=${projectId ?? 'null'}` : '';
        return `api/tests${queryString}`;
      },
      transformResponse: (response: TestsResponse) => response.tests,
      providesTags: (result) =>
        result
          ? [...result.map(({ name }) => ({ type: 'TestList' as const, id: name })), { type: 'TestList', id: 'LIST' }]
          : [{ type: 'TestList', id: 'LIST' }],
    }),

    getTest: builder.query<Test, string>({
      query: (name) => `api/tests/${encodeURIComponent(name)}`,
      transformResponse: (response: TestResponse) => response.test,
      providesTags: (_result, _error, name) => [{ type: 'Test', id: name }],
    }),

    createTest: builder.mutation<{ id: number; name: string }, { name: string; description?: string; project_id?: number | null; use_vrt?: boolean }>({
      query: (body) => ({ url: 'api/tests', method: 'POST', body }),
      invalidatesTags: [{ type: 'TestList', id: 'LIST' }],
    }),

    updateTest: builder.mutation<void, { originalName: string; name: string; description?: string; variables?: Record<string, unknown>; viewport?: { width: number; height: number } | null }>({
      query: ({ originalName, ...body }) => ({
        url: `api/tests/${encodeURIComponent(originalName)}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { originalName, name }) => [
        { type: 'Test', id: originalName },
        { type: 'Test', id: name },
        { type: 'TestList', id: 'LIST' },
      ],
    }),

    deleteTest: builder.mutation<void, string>({
      query: (name) => ({ url: `api/tests/${encodeURIComponent(name)}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'TestList', id: 'LIST' }],
    }),

    addStep: builder.mutation<void, { testName: string; body: StepBody }>({
      query: ({ testName, body }) => ({
        url: `api/tests/${encodeURIComponent(testName)}/steps`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_result, _error, { testName }) => [{ type: 'Test', id: testName }],
    }),

    updateStep: builder.mutation<void, { testName: string; stepOrder: number; body: StepBody }>({
      query: ({ testName, stepOrder, body }) => ({
        url: `api/tests/${encodeURIComponent(testName)}/steps/${stepOrder}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { testName }) => [{ type: 'Test', id: testName }],
    }),

    deleteStep: builder.mutation<void, { testName: string; stepOrder: number }>({
      query: ({ testName, stepOrder }) => ({
        url: `api/tests/${encodeURIComponent(testName)}/steps/${stepOrder}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { testName }) => [{ type: 'Test', id: testName }],
    }),

    reorderSteps: builder.mutation<void, { testName: string; orders: ReorderEntry[] }>({
      query: ({ testName, orders }) => ({
        url: `api/tests/${encodeURIComponent(testName)}/steps-reorder`,
        method: 'PUT',
        body: { orders },
      }),
      invalidatesTags: (_result, _error, { testName }) => [{ type: 'Test', id: testName }],
    }),

    assignToProject: builder.mutation<void, { testName: string; projectId: number | null }>({
      query: ({ testName, projectId }) => ({
        url: `api/tests/${encodeURIComponent(testName)}/project`,
        method: 'PUT',
        body: { project_id: projectId },
      }),
      invalidatesTags: [{ type: 'TestList', id: 'LIST' }],
    }),
  }),
});

export const {
  useGetTestsQuery,
  useGetTestQuery,
  useCreateTestMutation,
  useUpdateTestMutation,
  useDeleteTestMutation,
  useAddStepMutation,
  useUpdateStepMutation,
  useDeleteStepMutation,
  useReorderStepsMutation,
  useAssignToProjectMutation,
} = testsApi;
