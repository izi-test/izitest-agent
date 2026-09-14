import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Conversation, ChatResponse, Message } from '../../types';

interface ConversationsResponse {
  conversations: Conversation[];
}

interface ConversationDetail {
  id: number;
  project_id: number;
  title: string;
  messages: Message[];
}

export const chatApi = createApi({
  reducerPath: 'chatApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['ConversationList', 'ConversationDetail'],
  endpoints: (builder) => ({

    getConversations: builder.query<Conversation[], number>({
      query: (projectId) => `api/projects/${projectId}/conversations`,
      transformResponse: (response: ConversationsResponse) => response.conversations,
      providesTags: (_, __, projectId) => [{ type: 'ConversationList', id: projectId }],
    }),

    getConversation: builder.query<ConversationDetail, number>({
      query: (id) => `api/conversations/${id}`,
      providesTags: (_, __, id) => [{ type: 'ConversationDetail', id }],
    }),

    sendMessage: builder.mutation<ChatResponse, { project_id: number; conversation_id?: number; message: string }>({
      query: (body) => ({ url: 'api/agent/chat', method: 'POST', body }),
      invalidatesTags: (result, _, arg) => [
        { type: 'ConversationList', id: arg.project_id },
        ...(result?.conversation_id ? [{ type: 'ConversationDetail' as const, id: result.conversation_id }] : []),
      ],
    }),

    deleteConversation: builder.mutation<void, { id: number; projectId: number }>({
      query: ({ id }) => ({ url: `api/conversations/${id}`, method: 'DELETE' }),
      invalidatesTags: (_, __, { projectId }) => [{ type: 'ConversationList', id: projectId }],
    }),
  }),
});

export const {
  useGetConversationsQuery,
  useGetConversationQuery,
  useSendMessageMutation,
  useDeleteConversationMutation,
} = chatApi;
