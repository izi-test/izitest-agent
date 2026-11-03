import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Campaign, CampaignSummary, XrayExport, JiraComments } from '../../types';

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
    stopCampaign: builder.mutation<{ campaign: Campaign }, number>({
      query: (id) => ({ url: `api/campaigns/${id}/stop`, method: 'POST' }),
      invalidatesTags: (_result, _error, id) => ['Campaigns', { type: 'Campaign', id }],
    }),
    deleteCampaign: builder.mutation<{ success: boolean }, number>({
      query: (id) => ({ url: `api/campaigns/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Campaigns'],
    }),
    // Written to Xray and Jira unless a dry run: what would be sent, first.
    exportToXray: builder.mutation<XrayExport, { id: number; project_key?: string; test_plan_key?: string; dry_run: boolean }>({
      query: ({ id, ...body }) => ({ url: `api/campaigns/${id}/xray`, method: 'POST', body }),
      transformResponse: (response: { xray: XrayExport }) => response.xray,
      invalidatesTags: (_result, _error, { id, dry_run }) => (dry_run ? [] : [{ type: 'Campaign', id }]),
    }),
    commentOnJira: builder.mutation<JiraComments, { campaign_id?: number; keys?: string[]; dry_run: boolean }>({
      query: (body) => ({ url: 'api/jira/comments', method: 'POST', body }),
      transformResponse: (response: { comments: JiraComments }) => response.comments,
    }),
  }),
});

export const {
  useGetCampaignsQuery,
  useGetCampaignQuery,
  useStartCampaignMutation,
  useStopCampaignMutation,
  useDeleteCampaignMutation,
  useExportToXrayMutation,
  useCommentOnJiraMutation,
} = campaignsApi;
