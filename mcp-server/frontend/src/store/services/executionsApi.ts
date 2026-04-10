import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Execution, ExecutionStep } from '../../types';

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
  }),
});

export const {
  useGetExecutionsQuery,
  useGetExecutionQuery,
  useLazyGetExecutionQuery,
} = executionsApi;
