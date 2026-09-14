import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

interface RecentTest {
  name: string;
  description: string | null;
  project_id: number | null;
  updated_at: string;
  step_count: number;
}

interface RecentExecution {
  id: number;
  test_name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  total_steps: number;
  completed_steps: number;
  error: string | null;
  assertions_total: number;
  assertions_passed: number;
  assertions_failed: number;
}

interface TrendPoint {
  date: string;
  total: number;
  passed: number;
  failed: number;
}

interface FlakyTest {
  test_name: string;
  total_runs: number;
  pass_count: number;
  fail_count: number;
}

export interface DashboardStats {
  tests: {
    total: number;
    recent: RecentTest[];
  };
  executions: {
    total: number;
    passed: number;
    failed: number;
    running: number;
    avg_duration_ms: number;
    assertions_total: number;
    assertions_passed: number;
    assertions_failed: number;
    recent: RecentExecution[];
    trend: TrendPoint[];
    flaky: FlakyTest[];
  };
}

export const statsApi = createApi({
  reducerPath: 'statsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Stats'],
  endpoints: (builder) => ({
    getStats: builder.query<DashboardStats, number | null>({
      query: (projectId) => {
        const params = projectId ? `?project_id=${projectId}` : '';
        return `api/stats${params}`;
      },
      providesTags: ['Stats'],
    }),
  }),
});

export const { useGetStatsQuery } = statsApi;
