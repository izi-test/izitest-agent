import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Execution, ExecutionStep, Repair, StepRef } from '../../types';

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
    // Applied with `allUses`, the other steps acting on its element are given the new locators too.
    repairAction: builder.mutation<
      { repair: Repair; passed?: boolean; error?: string | null; relocated?: StepRef[] },
      { id: number; action: 'verify' | 'apply' | 'reject'; allUses?: boolean }
    >({
      query: ({ id, action, allUses }) => ({
        url: `api/repairs/${id}/${action}`,
        method: 'POST',
        ...(action === 'apply' && { body: { all_uses: !!allUses } }),
      }),
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
