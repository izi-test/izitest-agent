import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Campaign, CampaignCommit, CampaignStage, CampaignSummary, ExitCriteria, ProgressReport, ResultsSend, CoverageSend, RegressionSelection } from '../../types';

/** What a campaign is started with: a project's tests, a requirement's, or a list. */
export interface CampaignInput {
  project_id?: number | null;
  requirement?: string;
  tests?: string[];
  version?: string;
  name?: string;
  concurrency?: number;
  /** In the Chrome without windows. */
  headless?: boolean;
  /** Instead of a project, a requirement or tests: the tests in stages. */
  stages?: CampaignStage[];
  /** With project_id: only the tests a change needs (mcp-server/lib/regression.js). */
  changed_files?: string[];
  touched?: string[];
  include?: string[];
  commit?: CampaignCommit;
  /** Its plan: what it is for, what is in and out of scope, what says the testing can stop. */
  objective?: string | null;
  scope_note?: string | null;
  exit_criteria?: ExitCriteria | null;
}

/** What a change is, to choose the tests it needs. */
export interface ChangeInput {
  project_id: number;
  changed_files: string[];
  touched?: string[];
  include?: string[];
  commit_message?: string;
}

// Campaigns: tests replayed together for a version of the app (mcp-server/lib/campaigns.js).
export const campaignsApi = createApi({
  reducerPath: 'campaignsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Campaigns', 'Campaign'],
  endpoints: (builder) => ({
    getCampaigns: builder.query<CampaignSummary[], number | null | undefined>({
      query: (projectId) => `api/campaigns${projectId ? `?project_id=${projectId}` : ''}`,
      transformResponse: (response: { campaigns: CampaignSummary[] }) => response.campaigns ?? [],
      providesTags: ['Campaigns'],
    }),
    getCampaign: builder.query<Campaign, number>({
      query: (id) => `api/campaigns/${id}`,
      transformResponse: (response: { campaign: Campaign }) => response.campaign,
      providesTags: (_result, _error, id) => [{ type: 'Campaign', id }],
    }),
    startCampaign: builder.mutation<{ campaign: Campaign }, CampaignInput>({
      query: (body) => ({ url: 'api/campaigns', method: 'POST', body }),
      invalidatesTags: ['Campaigns'],
    }),
    // The tests a change needs, run; a change that touches no test: { nothing_to_run, message }, no campaign.
    startChangeCampaign: builder.mutation<{ campaign: Campaign; nothing_to_run?: undefined } | { campaign?: undefined; nothing_to_run: true; message: string }, CampaignInput & ChangeInput>({
      query: (body) => ({ url: 'api/campaigns', method: 'POST', body }),
      invalidatesTags: ['Campaigns'],
    }),
    // The tests of a scope, and the stages proposed for them (mcp-server/lib/campaigns.js proposeStages).
    planCampaign: builder.mutation<{ tests: string[]; stages: CampaignStage[] }, Pick<CampaignInput, 'project_id' | 'requirement' | 'tests'>>({
      query: (body) => ({ url: 'api/campaigns/plan', method: 'POST', body }),
    }),
    // The tests a change needs, each with why; nothing is run.
    selectTests: builder.mutation<RegressionSelection, ChangeInput>({
      query: (body) => ({ url: 'api/campaigns/select', method: 'POST', body }),
      transformResponse: (response: { selection: RegressionSelection }) => response.selection,
    }),
    updateCampaignPlan: builder.mutation<{ campaign: Campaign }, { id: number } & Pick<CampaignInput, 'objective' | 'scope_note' | 'exit_criteria'>>({
      query: ({ id, ...body }) => ({ url: `api/campaigns/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { id }) => ['Campaigns', { type: 'Campaign', id }],
    }),
    // Where the testing stands over a period (mcp-server/lib/reports.js).
    getProgressReport: builder.query<ProgressReport, { projectId?: number | null; from: string; to: string }>({
      query: ({ projectId, from, to }) => `api/reports/progress?from=${from}&to=${to}${projectId ? `&project_id=${projectId}` : ''}`,
      providesTags: ['Campaigns'],
    }),
    stopCampaign: builder.mutation<{ campaign: Campaign }, number>({
      query: (id) => ({ url: `api/campaigns/${id}/stop`, method: 'POST' }),
      invalidatesTags: (_result, _error, id) => ['Campaigns', { type: 'Campaign', id }],
    }),
    deleteCampaign: builder.mutation<{ success: boolean }, number>({
      query: (id) => ({ url: `api/campaigns/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Campaigns'],
    }),
    // Written to a tool (mcp-server/lib/connectors) unless a dry run: what would be sent, first.
    sendResults: builder.mutation<ResultsSend, { id: number; connector: string; options: Record<string, string>; dry_run: boolean }>({
      query: ({ id, connector, ...body }) => ({ url: `api/campaigns/${id}/send/${connector}`, method: 'POST', body }),
      transformResponse: (response: { results: ResultsSend }) => response.results,
      invalidatesTags: (_result, _error, { id, dry_run }) => (dry_run ? [] : [{ type: 'Campaign', id }]),
    }),
    sendCoverage: builder.mutation<CoverageSend, { connector: string; campaign_id?: number; keys?: string[]; dry_run: boolean }>({
      query: ({ connector, ...body }) => ({ url: `api/connectors/${connector}/coverage`, method: 'POST', body }),
      transformResponse: (response: { coverage: CoverageSend }) => response.coverage,
    }),
  }),
});

export const {
  useGetCampaignsQuery,
  useGetCampaignQuery,
  useStartCampaignMutation,
  useStartChangeCampaignMutation,
  usePlanCampaignMutation,
  useSelectTestsMutation,
  useUpdateCampaignPlanMutation,
  useGetProgressReportQuery,
  useStopCampaignMutation,
  useDeleteCampaignMutation,
  useSendResultsMutation,
  useSendCoverageMutation,
} = campaignsApi;
