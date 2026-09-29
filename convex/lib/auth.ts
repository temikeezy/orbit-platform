import { QueryCtx, MutationCtx } from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { watISODate } from './datetime';
import bcrypt from 'bcryptjs';

/**
 * Session handling for ORBIT.
 *
 * Deliberately the same bearer-token model the Supabase build used, so the
 * behaviour the app depends on — including the Zoho SSO flow — carries over
 * unchanged. The difference is where the token lives: Postgres kept it in
 * orbit_users.jwt_token, one column per user, which meant signing in anywhere
 * silently invalidated every other device. Sessions are now rows, so a user can
 * hold several at once.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, as before
/**
 * 24 hours, raised from 1.
 *
 * The acceptance email now carries a working sign-in link rather than telling
 * someone to go and request one, so this window is how long that email stays
 * usable. An hour was fine for a link you asked for thirty seconds ago and
 * useless for one that arrives while you are asleep — the applicant would open
 * it the next morning, hit an expired link, and be worse off than if it had
 * never been included.
 *
 * The exposure is bounded by design rather than by the clock: a link is
 * SINGLE-USE (consumeMagicLink deletes the row before issuing a session), only
 * one is ever live per user (requesting a new one deletes the old), redemption
 * is rate-limited per IP, and the token travels in the URL FRAGMENT so it never
 * reaches a web server log.
 */
const MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** 32 bytes of CSPRNG output, hex encoded. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mints a magic link for a user and returns the token to embed in an email.
 *
 * Extracted from `auth.requestMagicLink` so the approval email can carry a
 * working link instead of instructions for requesting one. Same shape either
 * way: a readable SELECTOR stored alongside a bcrypt-hashed VERIFIER, so
 * redemption looks the row up by a value that is not itself a credential.
 *
 * Deletes any live link for that user first — one at a time, so a re-issued
 * invitation invalidates the previous one rather than leaving two valid.
 */
export async function mintMagicLink(
  ctx: MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<string> {
  const existing = await ctx.db
    .query('magicLinks')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  for (const l of existing) await ctx.db.delete(l._id);

  const selector = randomToken().slice(0, 24);
  const verifier = randomToken();

  await ctx.db.insert('magicLinks', {
    userId,
    selector,
    verifierHash: bcrypt.hashSync(verifier, 8),
    expiresAt: magicLinkExpiry(now),
    sentAt: now,
  });

  return `${selector}.${verifier}`;
}

export function sessionExpiry(now: number): number {
  return now + SESSION_TTL_MS;
}

export function magicLinkExpiry(now: number): number {
  return now + MAGIC_LINK_TTL_MS;
}

/**
 * Resolves a bearer token to its user, or null.
 *
 * Returns null for expired sessions rather than deleting them — queries cannot
 * write. Expired rows are swept by a cron.
 */
export async function userFromToken(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
): Promise<Doc<'users'> | null> {
  if (!token) return null;

  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();

  if (!session || session.expiresAt <= Date.now()) return null;

  const user = await ctx.db.get(session.userId);
  if (!user || !user.isActive || user.isDeleted) return null;

  return user;
}

/**
 * Whether this call arrives over an MCP (agent) session rather than a browser.
 *
 * The agent signs in as a real ORBIT account with real permissions, which is
 * what makes it useful and also what makes "who created this task" the wrong
 * question to ask — `createdBy` would say ORBIT Agent either way. The session
 * is the only place the distinction is recorded, so anything that must treat
 * agent actions differently reads it from here rather than guessing from the
 * actor's name or roles.
 */
export async function isMcpSession(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token) return false;

  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();

  /**
   * EXPIRY CHECKED, like every other read of this table.
   *
   * It was not, and the consequence was subtle rather than dramatic: an expired
   * agent token still answered "yes, MCP" here, while requireUser refused it a
   * line later. The two disagreeing about the same token is the kind of gap that
   * only matters once someone adds a caller that asks this question WITHOUT
   * having already authenticated — at which point a long-dead token starts
   * being treated as the agent. Cheap to close now, expensive to notice later.
   */
  if (!session || session.expiresAt <= Date.now()) return false;

  return Boolean(session.isMcp);
}

export async function requireUser(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
): Promise<Doc<'users'>> {
  const user = await userFromToken(ctx, token);
  if (!user) throw new Error('Unauthorized');
  return user;
}

export function hasRole(user: Doc<'users'>, ...roles: string[]): boolean {
  return user.roles.some((r) => roles.includes(r));
}

export async function requireAdmin(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
): Promise<Doc<'users'>> {
  const user = await requireUser(ctx, token);
  if (!hasRole(user, 'admin', 'super_admin')) {
    throw new Error('Admin access required');
  }
  return user;
}

export async function requireModerator(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
): Promise<Doc<'users'>> {
  const user = await requireUser(ctx, token);
  if (!hasRole(user, 'admin', 'super_admin', 'moderator')) {
    throw new Error('Moderator access required');
  }
  return user;
}

/**
 * The only user shape that may cross the wire.
 *
 * passwordHash and tempPassword exist on the document and must never reach a
 * client — returning whole user docs is how the Supabase build ended up serving
 * password hashes to anyone holding the anon key. Every user-returning function
 * goes through here.
 */
export function publicUser(user: Doc<'users'>) {
  return {
    id: user._id,
    email: user.email,
    fullName: user.fullName,
    profileSlug: user.profileSlug,
    profilePhotoUrl: user.profilePhotoUrl,
    coverPhotoUrl: user.coverPhotoUrl,
    bio: user.bio,
    location: user.location,
    socialLinks: user.socialLinks,
    roles: user.roles,
    currentStreamId: user.currentStreamId,
    totalPoints: user.totalPoints,
    currentLevel: user.currentLevel,
    loginStreakCount: user.loginStreakCount,
    isActive: user.isActive,
    mcpEnabled: user.mcpEnabled,
    profileVisibility: user.profileVisibility,
    showEmail: user.showEmail,
    showActivityOnFeed: user.showActivityOnFeed,
    showOnLeaderboard: user.showOnLeaderboard,
    lastLoginAt: user.lastLoginAt,
    /**
     * WHETHER a password exists, never the hash.
     *
     * Accounts converted from the intake have none — they arrive by magic link —
     * and the settings screen had no way to know, so it demanded a current
     * password they had never had and offered no way past it. This is a UX fact,
     * not a secret: it says "you can set one", and reveals nothing about what it
     * might be.
     */
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
  };
}

/** Issues a session and records the login. */
export async function startSession(
  ctx: MutationCtx,
  userId: Id<'users'>,
  meta?: { userAgent?: string; ipAddress?: string },
): Promise<string> {
  const now = Date.now();
  const token = randomToken();

  await ctx.db.insert('sessions', {
    userId,
    token,
    expiresAt: sessionExpiry(now),
    createdAt: now,
    userAgent: meta?.userAgent,
    ipAddress: meta?.ipAddress,
  });

  /**
   * The login streak — consecutive DAYS with a sign-in.
   *
   * `loginStreakCount` and `loginStreakLastDate` have been in the schema since
   * the migration and are rendered in three places (the flame badge in
   * Navigation, MyOrbitPage, and the admin users table), but nothing has ever
   * written them: `startSession` recorded only `lastLoginAt`. Every account
   * created since the migration therefore showed 0 forever, and accounts
   * imported from Postgres showed whatever number they arrived with, frozen.
   *
   * Counted in WAT, not UTC. The boundary a member experiences as "a new day"
   * is their local midnight, and Nigeria is UTC+1 — a UTC day boundary would
   * break a streak for anyone signing in between 00:00 and 01:00 local, and
   * credit two days to someone signing in either side of 01:00.
   *
   * Signing in twice in one day changes nothing; a gap of more than one day
   * restarts at 1.
   */
  const user = await ctx.db.get(userId);
  const today = watISODate(now);
  const yesterday = watISODate(now - 86_400_000);
  const lastDate = user?.loginStreakLastDate;

  const streak =
    lastDate === today
      ? (user?.loginStreakCount ?? 1)
      : lastDate === yesterday
        ? (user?.loginStreakCount ?? 0) + 1
        : 1;

  await ctx.db.patch(userId, {
    lastLoginAt: now,
    loginStreakCount: streak,
    loginStreakLastDate: today,
    updatedAt: now,
  });

  return token;
}

/**
 * Records a failed authentication attempt.
 *
 * The Postgres build wrote these to orbit_audit_logs and the port dropped them,
 * which meant a deployment could be under a credential-stuffing run and the only
 * evidence would be a rate-limit counter nobody reads. Bounded the same way
 * mcp.ts bounds its own: one row per window per action, with a count of what it
 * stood in for, because the endpoints that call this are unauthenticated and an
 * unbounded insert is an anonymous write primitive.
 */
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export async function recordAuthFailure(
  ctx: MutationCtx,
  args: { action: string; reason: string; subject?: string; ipAddress?: string },
): Promise<void> {
  const now = Date.now();
  const action = `auth.${args.action}_failed`;

  const recent = await ctx.db
    .query('auditLogs')
    .withIndex('by_action_and_time', (q) => q.eq('action', action))
    .order('desc')
    .first();

  if (recent && recent.createdAt > now - AUTH_FAILURE_WINDOW_MS) {
    const meta = (recent.metadata ?? {}) as {
      suppressed?: number;
      subjects?: string[];
      reasons?: string[];
    };

    // The suppressed attempts' SUBJECTS are accumulated, not discarded. Keeping
    // only a count and a `lastReason` meant that during a credential-stuffing
    // run the one surviving row named a single account and threw away every
    // other address that had been tried — which is the part an investigation
    // actually needs. Capped so one row cannot grow without bound.
    const subjects = new Set(meta.subjects ?? []);
    if (args.subject && subjects.size < 50) subjects.add(args.subject);

    const reasons = new Set(meta.reasons ?? []);
    reasons.add(args.reason);

    await ctx.db.patch(recent._id, {
      metadata: {
        suppressed: (meta.suppressed ?? 0) + 1,
        subjects: [...subjects],
        reasons: [...reasons],
        lastReason: args.reason,
        lastAt: now,
      },
    });
    return;
  }

  await ctx.db.insert('auditLogs', {
    action,
    userEmail: args.subject,
    ipAddress: args.ipAddress,
    success: false,
    errorMessage: args.reason,
    metadata: { suppressed: 0, subjects: args.subject ? [args.subject] : [], reasons: [args.reason] },
    createdAt: now,
  });
}
