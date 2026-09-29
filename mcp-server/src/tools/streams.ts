import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fn } from '../functions.js';
import type { OrbitClient } from '../client.js';
import { resolveId } from '../ids.js';
import { register, json, text, expectOk } from './shared.js';

const ID = z.string().min(1).describe('Convex id, or the pre-migration uuid');

export function registerStreamTools(server: McpServer, client: OrbitClient): void {
  register(
    server,
    'list_streams',
    'List all active streams. member_count is derived from active memberships, not a stored counter.',
    { include_inactive: z.boolean().default(false) },
    async ({ include_inactive }) => {
      const streams = await client.query(fn.listStreams, { includeInactive: include_inactive });
      return json(streams);
    },
  );

  register(
    server,
    'get_stream',
    'Get details of a specific stream including its active members',
    { stream_id: ID },
    async ({ stream_id }) => {
      const streamId = await resolveId(client, 'streams', stream_id);

      // Two calls rather than one join. The Supabase version asked for
      // `orbit_users(full_name, email)` through the membership row and had to be
      // rewritten once already because that table has several foreign keys to
      // orbit_users and PostgREST could not tell which one was meant.
      const [stream, members] = await Promise.all([
        client.query(fn.getStream, { streamId }),
        client.query(fn.streamMembers, { streamId }),
      ]);

      if (!stream) return text(`No stream with id ${stream_id}`);
      return json({ stream, members });
    },
  );

  register(
    server,
    'create_stream',
    'Create a new stream',
    {
      name: z.string().min(2).max(100),
      description: z.string().optional(),
      emoji: z.string().optional(),
      privacy: z.enum(['public', 'private']).optional(),
    },
    async ({ name, description, emoji, privacy }) => {
      const result = await client.mutateAudited(
        fn.createStream,
        { name, description, emoji, privacy },
        {
          action: 'CREATE_STREAM',
          tableName: 'streams',
          onSuccess: (r) => ({ recordId: r.id, values: { name, privacy } }),
        },
      );

      // expectOk, not a bare `result.id`. streams.create always succeeds today,
      // so reading the id unconditionally worked — and would have printed
      // `Created stream "x" (undefined)` alongside a bogus audit row the moment
      // it grew a failure path. Every other write tool already checked.
      return text(`Created stream "${name}" (${expectOk(result).id})`);
    },
  );
}
