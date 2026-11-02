import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Execution, ExecutionStep, Repair } from '../../types';

interface ExecutionsResponse {
  executions: Execution[];
}

interface ExecutionDetailResponse {
  execution: Execution & { steps: ExecutionStep[] };
}

export const executionsApi = createApi({
  reducerPath: 'executionsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['ExecutionList', 'ExecutionDetail'],
  endpoints: (builder) => ({

    getExecutions: builder.query<Execution[], { testName: string; limit?: number }>({
      query: ({ testName, limit = 20 }) =>
        `api/tests/${encodeURIComponent(testName)}/executions?limit=${limit}`,
      transformResponse: (response: ExecutionsResponse) => response.executions || [],
      providesTags: (_result, _error, { testName }) => [{ type: 'ExecutionList', id: testName }],
    }),

    getExecution: builder.query<ExecutionDetailResponse['execution'], number>({
      query: (executionId) => `api/executions/${executionId}`,
      transformResponse: (response: ExecutionDetailResponse) => response.execution,
      providesTags: (_result, _error, id) => [{ type: 'ExecutionDetail', id }],
    }),

    // Verify (replays the test with it, unsaved), apply or reject a repair the triage proposed.
    repairAction: builder.mutation<{ repair: Repair; passed?: boolean; error?: string | null }, { id: number; action: 'verify' | 'apply' | 'reject' }>({
      query: ({ id, action }) => ({ url: `api/repairs/${id}/${action}`, method: 'POST' }),
      invalidatesTags: ['ExecutionList', 'ExecutionDetail'],
    }),
  }),
});

export const {
  useGetExecutionsQuery,
  useGetExecutionQuery,
  useLazyGetExecutionQuery,
  useRepairActionMutation,
} = executionsApi;
