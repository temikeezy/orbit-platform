import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { readFileSync } from 'node:fs';
import type { ConvexUser } from '../../src/lib/convexAdapters';

/**
 * Server-side helpers for the E2E harness.
 *
 * These talk to Convex directly rather than through the UI. Driving fixture
 * creation through the browser would make every spec depend on the admin screens
 * working, which is precisely what the specs are meant to be testing.
 */

export const CONVEX_URL = process.env.E2E_CONVEX_URL ?? '';
export const MCP_SECRET = process.env.ORBIT_TEST_MCP_SECRET ?? '';

/** httpActions live on .convex.site; queries and mutations on .convex.cloud. */
export const SITE_URL = CONVEX_URL.replace('.convex.cloud', '.convex.site');

/**
 * The deployment guard.
 *
 * The vitest live suite pins itself to the dev deployment (ORBIT_DEV_DEPLOYMENT, default `your-dev-deployment`) so it can never be
 * pointed at production. This layer writes far more — users, streams, tasks,
 * submissions, applications — so it carries the same guard, louder: a
 * misconfigured CI variable pointing this at prod would create real accounts and
 * permanently unremovable rows on a live platform.
 */
export const DEV_DEPLOYMENT = process.env.ORBIT_DEV_DEPLOYMENT || 'your-dev-deployment';

/**
 * The deployment name is the URL's first hostname label, compared EXACTLY. A
 * substring test let a vague ORBIT_DEV_DEPLOYMENT (`eu-west-1`, `convex`)
 * match every deployment, production included.
 */
export function deploymentOf(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return '';
  }
}

export function assertDevDeployment(): void {
  if (deploymentOf(CONVEX_URL) !== DEV_DEPLOYMENT) {
    throw new Error(
      `E2E refuses to run against ${CONVEX_URL || '(unset)'} — it is not the dev deployment (${DEV_DEPLOYMENT}; set ORBIT_DEV_DEPLOYMENT to your own). ` +
        'These specs create users and content that cannot all be deleted.',
    );
  }
}

export function client(): ConvexHttpClient {
  assertDevDeployment();
  return new ConvexHttpClient(CONVEX_URL);
}

/**
 * A super_admin session, used only to build and tear down fixtures.
 *
 * ONE PER RUN, reused from the manifest. `mcp.authenticate` caps concurrent MCP
 * sessions at five and evicts the OLDEST when a sixth is minted — deliberately,
 * to bound how many standing API sessions an actor can accumulate. A suite that
 * authenticates per spec therefore starts revoking its own earlier tokens once
 * more than five specs are in flight, and the failure surfaces as an unrelated
 * `Unauthorized` in whichever spec happens to be holding the oldest one.
 *
 * Exactly the same shape of problem as signing in per spec against the 15-per-15
 * -minutes login limit, and the same fix.
 */
export async function adminToken(convex: ConvexHttpClient): Promise<string> {
  const cached = cachedAdminToken();
  if (cached) return cached;

  return mintAdminToken(convex);
}

/** Reads the token global setup already minted, if the manifest exists yet. */
function cachedAdminToken(): string | null {
  try {
    const path = `${process.cwd()}/e2e/.auth/manifest.json`;
    const raw = readFileSync(path, 'utf8');
    return (JSON.parse(raw) as { adminToken?: string }).adminToken ?? null;
  } catch {
    // Global setup itself runs before the manifest exists.
    return null;
  }
}

export async function mintAdminToken(convex: ConvexHttpClient): Promise<string> {
  const auth = await convex.mutation(anyApi.mcp.authenticate, { secret: MCP_SECRET });
  if (!auth?.success) {
    throw new Error(
      `MCP authenticate failed: ${auth?.error ?? 'unknown'}. ` +
        'ORBIT_TEST_MCP_SECRET must match MCP_SERVER_SECRET on the dev deployment.',
    );
  }
  return auth.token as string;
}

export interface SeededUser {
  id: string;
  email: string;
  /** Stamped with the run id, so it identifies this actor in any list. */
  fullName: string;
  password: string;
  role: Role;
}

export type Role = 'intern' | 'moderator' | 'admin' | 'super_admin';

/**
 * Creates a disposable actor.
 *
 * Every fixture user is stamped with the run id so a failed run's leftovers are
 * identifiable, and so the per-account login limit (15/15min) starts fresh each
 * run rather than accumulating across re-runs.
 */
export async function createUser(
  convex: ConvexHttpClient,
  token: string,
  role: Role,
  runId: string,
  /** Interns default to SIWES; pass another to make a non-SIWES member. */
  programmeType?: string,
): Promise<SeededUser> {
  const email = `e2e-${runId}-${role}@iih.ng`;
  const fullName = `E2E ${role} ${runId}`;

  const created = await convex.mutation(anyApi.users.adminCreateUser, {
    token,
    email,
    fullName,
    roles: [role],
    // Interns in the fixtures are SIWES interns: the logbook specs exercise the
    // SIWES logbook, and without a programme type the account correctly carries
    // no logbook at all. Specs about non-SIWES members create their own actor.
    ...(role === 'intern' ? { programmeType: programmeType ?? 'siwes' } : {}),
  });

  if (!created?.success) throw new Error(`adminCreateUser(${role}): ${created?.error}`);

  return {
    id: created.id as string,
    email,
    fullName,
    password: created.tempPassword as string,
    role,
  };
}

/**
 * Signs in over the HTTP route and returns the session the app would store.
 *
 * Deliberately NOT by driving the login form: the form is one spec's subject,
 * not every spec's prerequisite, and the `login` limit is 15 per account per 15
 * minutes — a form login per spec would exhaust it and fail in a way that looks
 * exactly like a wrong password.
 */
export async function signIn(email: string, password: string) {
  const response = await fetch(`${SITE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const data = (await response.json()) as {
    success: boolean;
    token?: string;
    user?: ConvexUser;
    error?: string;
  };

  if (!data.success || !data.token || !data.user) {
    throw new Error(`sign-in failed for ${email}: ${data.error}`);
  }
  return { token: data.token, user: data.user };
}

/**
 * Removes an actor and everything that cascades from it.
 *
 * This is the ONLY way to clean up submissions, points-ledger rows, daily logs,
 * weekly summaries, attendance and posts — none of those have a delete of their
 * own. It refuses for anyone who authored a stream or a task, which is why
 * scaffold content is authored by the long-lived MCP actor and never by these.
 */
export async function destroyUser(
  convex: ConvexHttpClient,
  token: string,
  userId: string,
): Promise<void> {
  await convex.mutation(anyApi.users.adminTrashUser, { token, userId }).catch(() => {});
  await convex
    .mutation(anyApi.users.adminPermanentlyDeleteUser, { token, userId })
    .catch(() => {
      // Left in the trash. Better than a failed teardown aborting the run — the
      // account is already invisible and cannot sign in.
    });
}
