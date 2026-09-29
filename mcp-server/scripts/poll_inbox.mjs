#!/usr/bin/env node
// OrbitOps poll: check unread DMs and @mentions via the ORBIT MCP server.
// Usage: node scripts/poll_inbox.mjs [--messages N] [--hours N]
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const args = process.argv.slice(2);
const msgLimit = Number(args[args.indexOf('--messages') + 1] ?? 20);
const hoursBack = Number(args[args.indexOf('--hours') + 1] ?? 24);

// Credentials come from the environment, never from this file. An earlier
// version inlined a live MCP secret here and it reached origin/main, where a
// repo-read grant became a renewable admin session on the dev deployment. That
// value has since been rotated out of both deployments, but the shape is the
// hazard: verify-live.mjs and verify-ports.mjs next door have always read
// process.env, and this script is the one that did not.
const CONVEX_URL = process.env.ORBIT_CONVEX_URL;
const SECRET = process.env.ORBIT_MCP_SECRET;

if (!CONVEX_URL || !SECRET) {
  console.error(
    'Set ORBIT_CONVEX_URL and ORBIT_MCP_SECRET.\n' +
      '  export ORBIT_MCP_SECRET=$(env -u CONVEX_DEPLOY_KEY npx convex env get MCP_SERVER_SECRET)',
  );
  process.exit(1);
}

const env = {
  ...process.env,
  ORBIT_CONVEX_URL: CONVEX_URL,
  ORBIT_MCP_SECRET: SECRET,
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env,
  stderr: 'pipe',
});

const client = new Client({ name: 'orbitops-poll', version: '1.0.0' });
await client.connect(transport);
transport.stderr?.on('data', () => {});

const call = (name, a) => client.callTool({ name, arguments: a });
const body = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
const parse = (r) => JSON.parse(body(r));

const out = {};
try {
  out.messages = parse(await call('list_agent_messages', { unread_only: true, limit: msgLimit }));
} catch (e) {
  out.messagesError = String(e?.message ?? e);
}
try {
  out.mentions = parse(await call('check_mentions', { hours_back: hoursBack, limit: 50 }));
} catch (e) {
  out.mentionsError = String(e?.message ?? e);
}

await client.close();
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
