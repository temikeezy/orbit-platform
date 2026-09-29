import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fn } from '../functions.js';
import type { OrbitClient } from '../client.js';
import { resolveId, resolveOptionalId } from '../ids.js';
import { register, json, text, expectOk } from './shared.js';

const ID = z.string().min(1).describe('Convex id, or the pre-migration uuid');

export function registerSocialTools(server: McpServer, client: OrbitClient): void {
  register(
    server,
    'get_leaderboard',
    'Get leaderboard rankings. Periods are ROLLING windows (week = last 7 days, month = last 30), ' +
      'not calendar periods — the Supabase tool computed a Monday-anchored week.',
    {
      period: z.enum(['overall', 'weekly', 'monthly']).default('overall'),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ period, limit }) => {
      const mapped = ({ overall: 'all', weekly: 'week', monthly: 'month' } as const)[
        period as 'overall' | 'weekly' | 'monthly'
      ];

      // Ranked server-side. The page this replaces pulled the entire points
      // ledger into the client and aggregated it there, and the MCP tool did the
      // same over the service key — both applied the showOnLeaderboard privacy
      // flag only after the data had already been read.
      const board = await client.query(fn.leaderboard, { period: mapped, limit });
      return json(board);
    },
  );

  register(
    server,
    'post_to_feed',
    'Create a post on the activity feed as the MCP actor',
    {
      content: z.string().min(1),
      stream_id: ID.optional().describe('Omit for the global feed'),
      // No post_type or metadata. `posts.create` accepts only the literal
      // 'text' and has no metadata argument at all, deliberately: the badge,
      // submission and leaderboard types render with platform chrome and no
      // delete control, so a client that could pick one could publish a post
      // that looked system-generated and could not be removed from the UI.
      // Advertising them here produced a tool that failed Convex argument
      // validation for three of its four documented options.
    },
    async ({ content, stream_id }) => {
      const streamId = await resolveOptionalId(client, 'streams', stream_id);

      const result = await client.mutateAudited(
        fn.createPost,
        { content, streamId },
        {
          action: 'POST_TO_FEED',
          tableName: 'posts',
          onSuccess: (r) => ({ recordId: r.success ? r.id : undefined, values: { streamId } }),
        },
      );

      return text(`Created post ${expectOk(result).id}`);
    },
  );

  register(
    server,
    'reply_to_post',
    'Reply to an activity feed post as the MCP actor',
    { post_id: ID, content: z.string().min(1).max(3000) },
    async ({ post_id, content }) => {
      const postId = await resolveId(client, 'posts', post_id);

      const result = await client.mutateAudited(fn.replyToPost, { postId, content }, {
        action: 'REPLY_TO_POST',
        tableName: 'postReplies',
        onSuccess: (r) => ({ recordId: r.success ? r.id : undefined, values: { postId } }),
      });

      return text(`Created reply ${expectOk(result).id}`);
    },
  );

  register(
    server,
    'post_stream_announcement',
    'Post an announcement in a stream chat as the MCP actor',
    { stream_id: ID, content: z.string().min(1).max(4000) },
    async ({ stream_id, content }) => {
      const streamId = await resolveId(client, 'streams', stream_id);

      const result = await client.mutateAudited(
        fn.sendStreamChat,
        { streamId, content, isAnnouncement: true },
        {
          action: 'POST_STREAM_ANNOUNCEMENT',
          tableName: 'streamChat',
          onSuccess: (r) => ({ recordId: r.success ? r.id : undefined, values: { streamId } }),
        },
      );

      return text(`Posted stream announcement ${expectOk(result).id}`);
    },
  );

  register(
    server,
    'check_mentions',
    // It does NOT filter out already-answered mentions — nothing records that a
    // mention was handled. The description used to claim it did, and an agent
    // polling on that promise re-answers the same mention on every pass for the
    // whole window. Whatever tracks "handled" has to live on the caller's side
    // until there is a server-side notion of it.
    'Find posts and replies mentioning the MCP actor within the last hours_back hours. ' +
      'Returns ALL matches in the window, including ones already replied to — de-duplicate ' +
      'against what you have already answered before responding.',
    {
      hours_back: z.number().min(1).max(720).default(24),
      limit: z.number().min(1).max(100).default(30),
    },
    // JSON in every case, empty array included — see the note on
    // list_agent_messages.
    async ({ hours_back, limit }) =>
      json(await client.query(fn.mentions, { hoursBack: hours_back, limit })),
  );
}
