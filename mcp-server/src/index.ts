#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './env.js';
import { OrbitClient, describeError } from './client.js';
import { fn } from './functions.js';
import { registerUserTools } from './tools/users.js';
import { registerStreamTools } from './tools/streams.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerSocialTools } from './tools/social.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerAdminTools } from './tools/admin.js';

/**
 * ORBIT MCP server.
 *
 * Every tool calls a public Convex function with a session token. There is no
 * database client in this process and no table name outside `functions.ts` —
 * which is the point. The previous version connected to Postgres with the
 * service role key and wrote rows directly, so it had to reimplement, by hand
 * and from memory, whatever the triggers and the browser code did. It got two of
 * those wrong in ways nothing detected:
 *
 *   - `score_submission` awarded NO POINTS. Points were written by the browser
 *     (`src/lib/api/tasks.ts:403`), not by a trigger, so a submission approved
 *     through MCP updated its status and paid nothing. The tool reported success.
 *   - `create_task` notified every member THREE times: its own notification
 *     insert, its own email-queue insert, and the orbit_notify_new_task trigger.
 *
 * Both are now single calls into the ported mutations, which is the only place
 * that logic exists.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new OrbitClient(config);

  // Fail at startup rather than on the first tool call. An MCP server that
  // connects and then errors on everything is much harder to diagnose from the
  // client side than one that refuses to start.
  await client.authenticate();
  const actor = client.actor;

  console.error(
    `ORBIT MCP connected to ${config.convexUrl} as ${actor.fullName} <${actor.email}> ` +
      `[${actor.roles.join(', ')}]`,
  );

  const server = new McpServer({ name: 'orbit-mcp-server', version: '2.0.0' });

  registerUserTools(server, client);
  registerStreamTools(server, client);
  registerTaskTools(server, client);
  registerSocialTools(server, client);
  registerMessagingTools(server, client);
  registerAdminTools(server, client);

  server.resource('platform-stats', 'orbit://stats', async () => {
    const stats = await client.query(fn.platformStats, {});
    return {
      contents: [
        { uri: 'orbit://stats', text: JSON.stringify(stats, null, 2), mimeType: 'application/json' },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(`MCP server failed to start: ${describeError(error)}`);
  process.exit(1);
});
