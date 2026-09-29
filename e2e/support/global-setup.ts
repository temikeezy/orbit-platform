import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { anyApi } from 'convex/server';
import {
  mintAdminToken,
  assertDevDeployment,
  client,
  createUser,
  signIn,
  CONVEX_URL,
  MCP_SECRET,
  type Role,
  type SeededUser,
} from './orbit';
import { ensureScaffold, type Scaffold } from './scaffold';
import { toOrbitUser } from '../../src/lib/convexAdapters';

export const ROLES: Role[] = ['intern', 'moderator', 'admin', 'super_admin'];

export const STATE_DIR = path.join(process.cwd(), 'e2e', '.auth');
export const MANIFEST = path.join(STATE_DIR, 'manifest.json');

/**
 * Each actor's live session token accompanies the actor.
 *
 * Some assertions can only be made as the person themselves — an inbox is
 * scoped to its owner, so "did they receive it" cannot be answered with an admin
 * session. The same token is already inside the storageState file next to this
 * one, and the whole directory is gitignored and deleted in teardown, so
 * recording it here exposes nothing new and saves spending one of the account's
 * 15 sign-ins per 15 minutes.
 */
export type SeededActor = SeededUser & { token: string };

export interface Manifest {
  runId: string;
  users: SeededActor[];
  scaffold: Scaffold;
  /** The intern actor's SIWES profile. Everything in F3/F4 hangs off it. */
  userId: string;
  /** The one MCP session for this run — see adminToken() for why it is shared. */
  adminToken: string;
}

/**
 * Builds every fixture once, then hands each spec a pre-authenticated browser
 * state.
 *
 * ONE SIGN-IN PER ROLE PER RUN. The `login` limit is 15 per account per 15
 * minutes; a suite that signs in per spec would exhaust it partway through and
 * report "Too many sign-in attempts", which a naive assertion reads as a wrong
 * password. storageState is what keeps the whole matrix inside one login each.
 */
async function globalSetup() {
  if (!CONVEX_URL) throw new Error('E2E_CONVEX_URL is not set.');
  if (!MCP_SECRET) {
    throw new Error(
      'ORBIT_TEST_MCP_SECRET is not set — it is required to create fixture users. ' +
        'Get it with: npx convex env get MCP_SERVER_SECRET',
    );
  }
  assertDevDeployment();

  const convex = client();
  // Minted, not read: adminToken() prefers the manifest, and at this point the
  // manifest still describes the PREVIOUS run, whose session is long gone.
  const token = await mintAdminToken(convex);

  // Seconds, not milliseconds: the id lands in email addresses and is read by a
  // human cleaning up after a failed run.
  const runId = Math.floor(Date.now() / 1000).toString(36);

  const scaffold = await ensureScaffold(convex, token);

  mkdirSync(STATE_DIR, { recursive: true });

  const users: SeededActor[] = [];

  for (const role of ROLES) {
    const user = await createUser(convex, token, role, runId);
    const session = await signIn(user.email, user.password);

    // The exact shape src/lib/auth.ts persists: the raw token string under
    // orbit_auth_token_v2, and the snake_case OrbitUser JSON under
    // orbit_user_v2. AuthContext boots straight from these, so the app renders
    // authenticated on first paint with no login round-trip.
    //
    // The adapter is REUSED rather than reimplemented. /auth/login returns
    // Convex camelCase; the app caches snake_case. Writing the raw response here
    // put a user with no `full_name` into the cache, and Navigation renders
    // `user?.full_name.charAt(0)` on every page — so every route died in the
    // error boundary. Importing the real adapter means a field added to one
    // cannot drift out of the other.
    writeFileSync(
      path.join(STATE_DIR, `${role}.json`),
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: 'http://localhost:5173',
            localStorage: [
              { name: 'orbit_auth_token_v2', value: session.token },
              { name: 'orbit_user_v2', value: JSON.stringify(toOrbitUser(session.user)) },
            ],
          },
        ],
      }),
    );

    users.push({ ...user, token: session.token });
  }

  // The intern is the one actor that acts on the scaffold, so it needs to be in
  // the stream. The others reach it by role.
  const intern = users.find((u) => u.role === 'intern')!;
  const moderator = users.find((u) => u.role === 'moderator')!;

  await convex
    .mutation(anyApi.streams.addMember, {
      token,
      streamId: scaffold.streamId,
      userId: intern.id,
    })
    .catch(() => {});

  /**
   * The intern's SIWES profile, with the moderator as their IIH supervisor.
   *
   * Two mutations, not one. Editing your own institution details and being
   * ASSIGNED a supervisor are different authorizations — `assignProfile` is
   * admin-only precisely because letting a moderator set `iihSupervisorId` to
   * themselves on any intern is a privilege-escalation chain into that intern's
   * logs, attendance and private supervisor notes.
   *
   * The profile belongs to the disposable actor, so it goes when they do.
   */
  const profile = await convex.mutation(anyApi.siwes.saveProfile, {
    token,
    userId: intern.id,
    cohortId: scaffold.cohortId,
    participationMode: 'hybrid',
    institutionName: 'E2E Polytechnic',
    courseOfStudy: 'Computer Science',
    matricNumber: `E2E/${runId}`,
    physicalDay: 3,
  });

  const userId = profile.id as string;

  await convex.mutation(anyApi.siwes.assignProfile, {
    token,
    internUserId: userId,
    iihSupervisorId: moderator.id,
    departmentId: scaffold.departmentId,
    status: 'active',
  });

  writeFileSync(
    MANIFEST,
    JSON.stringify(
      { runId, users, scaffold, userId, adminToken: token } satisfies Manifest,
      null,
      2,
    ),
  );

  console.log(`[e2e] run ${runId}: ${users.length} actors, scaffold stream ${scaffold.streamId}`);
}

export default globalSetup;
