import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fn } from '../functions.js';
import type { OrbitClient } from '../client.js';
import { resolveId, resolveOptionalId } from '../ids.js';
import { register, json, text, expectOk } from './shared.js';

const ID = z.string().min(1).describe('Convex id, or the pre-migration uuid');

export function registerUserTools(server: McpServer, client: OrbitClient): void {
  register(
    server,
    'list_users',
    'List active ORBIT users with optional role/stream filtering',
    {
      role: z.string().optional().describe('Filter by role: admin, super_admin, moderator, intern'),
      stream_id: ID.optional().describe('Filter by the user\'s current stream'),
      limit: z.number().min(1).max(200).default(50),
    },
    async ({ role, stream_id, limit }) => {
      const streamId = await resolveOptionalId(client, 'streams', stream_id);
      const users = await client.query(fn.listUsers, {});

      // Filtered here rather than server-side: `users.list` is the directory
      // query the app uses, and adding MCP-shaped filters to it would widen a
      // function every signed-in member calls. The whole platform is a few
      // hundred users.
      const filtered = users
        .filter((u) => (role ? u.roles.includes(role) : true))
        .filter((u) => (streamId ? u.currentStreamId === streamId : true))
        .slice(0, limit);

      return json(filtered);
    },
  );

  register(
    server,
    'get_user',
    'Get detailed information about a specific user',
    { user_id: ID },
    async ({ user_id }) => {
      const userId = await resolveId(client, 'users', user_id);
      const user = await client.query(fn.adminGetUser, { userId });
      return user ? json(user) : text(`No user with id ${user_id}`);
    },
  );

  register(
    server,
    'update_user_role',
    'Replace a user\'s roles. Granting super_admin requires the MCP actor to be a super_admin; ' +
      'an admin cannot strip their own admin role.',
    {
      user_id: ID,
      roles: z.array(z.enum(['admin', 'super_admin', 'moderator', 'intern'])).min(1),
    },
    async ({ user_id, roles }) => {
      const userId = await resolveId(client, 'users', user_id);

      const result = await client.mutateAudited(fn.setRoles, { userId, roles }, {
        action: 'UPDATE_USER_ROLE',
        tableName: 'users',
        onSuccess: () => ({ recordId: userId, values: { roles } }),
      });

      expectOk(result);
      return text(`Roles for ${userId} set to: ${roles.join(', ')}`);
    },
  );
}
