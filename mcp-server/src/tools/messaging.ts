import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fn } from '../functions.js';
import type { OrbitClient } from '../client.js';
import { resolveId } from '../ids.js';
import { register, json, text, expectOk } from './shared.js';

const ID = z.string().min(1).describe('Convex id, or the pre-migration uuid');

export function registerMessagingTools(server: McpServer, client: OrbitClient): void {
  register(
    server,
    'send_direct_message',
    'Send a direct message to a member as the MCP actor. The recipient gets exactly one ' +
      'notification and one email, subject to their notification preferences.',
    { recipient_id: ID, content: z.string().min(1).max(4000) },
    async ({ recipient_id, content }) => {
      const recipientId = await resolveId(client, 'users', recipient_id);

      // The Supabase tool inserted the message AND hand-wrote a notification —
      // while two Postgres triggers on orbit_messages were each writing one of
      // their own. Three notifications per message. messages.send now calls
      // notifyNewMessage once and that is the only path.
      const result = await client.mutateAudited(fn.sendMessage, { recipientId, content }, {
        action: 'SEND_DIRECT_MESSAGE',
        tableName: 'messages',
        onSuccess: (r) => ({ recordId: r.success ? r.id : undefined, values: { recipientId } }),
      });

      return text(`Sent direct message ${expectOk(result).id}`);
    },
  );

  register(
    server,
    'list_agent_messages',
    'List direct messages sent TO the MCP actor, newest first',
    {
      unread_only: z.boolean().default(false),
      limit: z.number().min(1).max(100).default(20),
    },
    // Always JSON, including the empty case. A `list_*` tool that returns an
    // array most of the time and an English sentence when there is nothing to
    // report forces every caller to handle two shapes, and the prose branch is
    // the one that never gets tested.
    async ({ unread_only, limit }) =>
      json(await client.query(fn.inbox, { unreadOnly: unread_only, limit })),
  );

  register(
    server,
    'reply_to_direct_message',
    'Reply to a message the MCP actor received. The reply is threaded to the original.',
    { message_id: ID, content: z.string().min(1).max(4000) },
    async ({ message_id, content }) => {
      const messageId = await resolveId(client, 'messages', message_id);

      const result = await client.mutateAudited(fn.replyToMessage, { messageId, content }, {
        action: 'REPLY_MESSAGE',
        tableName: 'messages',
        onSuccess: (r) => ({ recordId: r.success ? r.id : undefined, values: { replyTo: messageId } }),
      });

      return text(`Replied to ${messageId} — sent as ${expectOk(result).id}`);
    },
  );

  register(
    server,
    'mark_message_read',
    'Mark a message the MCP actor received as read, clearing its notification too',
    { message_id: ID },
    async ({ message_id }) => {
      const messageId = await resolveId(client, 'messages', message_id);

      // Now audited. The Supabase version wrote no audit row for this at all,
      // and patched by id with no recipient check — so it could mark anyone's
      // mail read.
      const result = await client.mutateAudited(fn.markMessageRead, { messageId }, {
        action: 'MARK_MESSAGE_READ',
        tableName: 'messages',
        onSuccess: (r) => ({ recordId: messageId, values: { updated: r.updated } }),
      });

      return text(
        result.updated > 0
          ? `Marked message ${messageId} as read.`
          : `No change — ${messageId} is not an unread message addressed to the MCP actor.`,
      );
    },
  );
}
