/**
 * Configuration.
 *
 * Two variables, down from five, and neither is a database credential.
 *
 * The Supabase build required `ORBIT_SUPABASE_SERVICE_ROLE_KEY` — a key that
 * bypasses RLS on a database shared with four other applications. Anything able
 * to read this process's environment held full read/write access to every table
 * in that project, ORBIT's and everyone else's. The replacement secret buys
 * exactly one thing: a 15-minute session on one named ORBIT account.
 *
 * `ORBIT_MCP_USER_EMAIL` and `ORBIT_MCP_USER_ID` are deliberately gone. Which
 * account the server acts as is now the deployment's decision (`MCP_ACTOR_EMAIL`
 * in the Convex environment), not the client's — otherwise the secret is a
 * "become any admin" credential rather than a "become the agent" one.
 */

export interface Config {
  convexUrl: string;
  secret: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing env var ${name}. Set ORBIT_CONVEX_URL (e.g. https://your-dev-deployment.convex.cloud) ` +
        `and ORBIT_MCP_SECRET (must match MCP_SERVER_SECRET on the deployment).`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const convexUrl = required('ORBIT_CONVEX_URL');
  const secret = required('ORBIT_MCP_SECRET');

  if (!/^https:\/\/[^/]+\.convex\.cloud\/?$/.test(convexUrl)) {
    throw new Error(
      `ORBIT_CONVEX_URL does not look like a Convex deployment URL: ${convexUrl}`,
    );
  }

  // Mirrors the floor the deployment enforces in mcp.authenticate, so a weak
  // secret fails here with a clear message rather than as a generic
  // "Unauthorized" from the server.
  if (secret.length < 32) {
    throw new Error('ORBIT_MCP_SECRET must be at least 32 characters.');
  }

  return { convexUrl: convexUrl.replace(/\/$/, ''), secret };
}
