// ask_user: an agent asks the person who started it for values a test needs (lib/asks.js).
// Session-scoped: the session's recording gives the project a secret is kept in, and its
// dashboard run shows the question beside its browser.

import { z } from 'zod';
import { askUser, ASK_USER_DESCRIPTION, ASK_FIELD_DESCRIPTION } from '../asks.js';
import { currentSession } from '../session.js';

export function registerAskTools(server) {
  server.tool(
    'ask_user',
    ASK_USER_DESCRIPTION,
    {
      why: z.string().optional().describe('What the values are for, shown to the person: "To log in to Tiime as the test user". Needed for a new question.'),
      fields: z.array(z.object({
        name: z.string().describe(ASK_FIELD_DESCRIPTION.name),
        label: z.string().optional().describe(ASK_FIELD_DESCRIPTION.label),
        secret: z.boolean().optional().describe(ASK_FIELD_DESCRIPTION.secret),
      })).optional().describe('The values asked, all at once. Needed for a new question.'),
      project_id: z.number().int().optional().describe('The project a secret is kept in: by default the one of the test being recorded.'),
      request_id: z.string().optional().describe('A question asked before that has no answer yet: waits for it again.'),
    },
    async (args) => {
      const { text, isError } = await askUser(args, { session: currentSession() });
      return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
    },
  );
}
