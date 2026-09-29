import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { QueryCtx, MutationCtx } from './_generated/server';
import { randomToken, requireUser, hasRole } from './lib/auth';

/**
 * The MCP server's way in.
 *
 * BEFORE: `mcp-server/src/index.ts` held the Supabase SERVICE ROLE KEY and wrote
 * raw table rows — bypassing RLS, bypassing every check the app performs, and
 * reimplementing trigger logic by hand. That is how it ended up awarding zero
 * points on `score_submission` (it patched orbit_submissions and relied on a
 * Postgres trigger that only ever fired for the browser path) and notifying
 * three times on `create_task` (its own inserts, plus orbit_notify_new_task).
 *
 * NOW: the MCP server holds no database credential at all. It exchanges a shared
 * secret for an ORDINARY SESSION belonging to a real ORBIT user, and then calls
 * the same public functions a browser calls. `requireModerator`, stream
 * membership, rate limits, notification preferences and the points ledger all
 * apply unchanged, because it is the same code path. Nothing here can grant the
 * MCP server a capability an admin signed in at a keyboard would not have.
 *
 * Three properties this file is responsible for:
 *
 *  1. The session is SHORT-LIVED (15 minutes). An MCP token is a full admin
 *     session, and it sits in an agent's environment rather than a browser, so
 *     it must age out fast. The server re-mints transparently.
 *  2. Revoking MCP access takes effect NOW, not at expiry — see
 *     `users.adminSetMcpAccess`, which deletes `isMcp` sessions.
 *  3. Every failed exchange is written to `auditLogs`. A shared secret with no
 *     record of who tried it is a secret you cannot reason about after the fact.
 */

/** Deliberately far shorter than the 7-day human session. */
const MCP_SESSION_TTL_MS = 15 * 60 * 1000;

/** Rejects a configured secret too short to be worth comparing. */
const MIN_SECRET_LENGTH = 32;

/**
 * Enough for the handful of clients one operator runs at once (Cursor, Claude
 * Desktop, a scheduled job), low enough that a crash-looping server cannot
 * accumulate live admin sessions.
 *
 * Counted PER CREDENTIAL. Several credentials share one actor, so counting per
 * account let one client's reconnects revoke another's session.
 */
const MAX_CONCURRENT_MCP_SESSIONS = 5;

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** One failure row per window, plus a count of what it suppressed. */
const AUTH_FAILURE_LOG_WINDOW_MS = 5 * 60 * 1000;

/**
 * Records a failed exchange, at most once per window.
 *
 * `authenticate` is a public mutation on a URL that ships in the frontend
 * bundle, so an unauthenticated caller can invoke it as fast as they like. When
 * every failure wrote a row, that made it an anonymous unbounded INSERT: storage
 * and function-call billing driven by a stranger, and — worse — the genuine
 * MCP_AUTH_FAILED signal buried under however many synthetic rows they cared to
 * generate. Rate limiting the exchange itself buys nothing (the secret is 256
 * bits and is not being guessed); bounding the WRITE is the actual fix.
 *
 * Collapsing into one row per window keeps the signal — a burst still shows up,
 * with a count — while capping the cost at 12 rows an hour.
 */
async function recordAuthFailure(ctx: MutationCtx, reason: string, subject?: string) {
  const now = Date.now();

  const recent = await ctx.db
    .query('auditLogs')
    .withIndex('by_action', (q) => q.eq('action', 'MCP_AUTH_FAILED'))
    .order('desc')
    .first();

  if (recent && recent.createdAt > now - AUTH_FAILURE_LOG_WINDOW_MS) {
    const seen = ((recent.metadata as { suppressed?: number } | undefined)?.suppressed ?? 0) + 1;
    await ctx.db.patch(recent._id, {
      metadata: { suppressed: seen, lastReason: reason, lastAt: now },
    });
    return;
  }

  await ctx.db.insert('auditLogs', {
    action: 'MCP_AUTH_FAILED',
    userEmail: subject,
    success: false,
    errorMessage: reason,
    userAgent: 'ORBIT MCP Server',
    metadata: { suppressed: 0 },
    createdAt: now,
  });
}

/**
 * Every actor this deployment will issue an MCP session for.
 *
 * ONE SECRET PER AGENT, and the secret IS the identity: which credential you
 * present decides which account you act as. The caller never names an actor.
 * An earlier draft took the email as an argument, which turned the secret into
 * a "become any admin" credential; an allowlist plus one shared secret has the
 * same flaw more quietly, because a single leak yields every identity on it.
 *
 * Configured as a NAMED ROSTER plus one pair per name:
 *
 *   MCP_CREDENTIALS    = CLAWDIA,FEMI
 *   MCP_ACTOR_CLAWDIA  = orbit.agent@iih.ng
 *   MCP_SECRET_CLAWDIA = <32+ chars, unique to that caller>
 *
 * The roster is explicit because CONVEX'S `process.env` DOES NOT ENUMERATE —
 * `Object.keys(process.env)` returns 0 entries while direct and dynamic reads
 * both work. Discovering the pairs by scanning for an `MCP_SECRET_` prefix
 * therefore found nothing and every exchange was refused, with the audit row
 * reporting a plain secret mismatch. Verified against a live deployment; no
 * amount of reading the runtime docs says this.
 *
 * Several names may point at the SAME actor. That is the intended shape here:
 * the orchestrators share one platform identity (the ORBIT Agent account) but
 * hold separate credentials, so one can be revoked without disturbing the other
 * and the audit row still records which was used.
 *
 * `MCP_SERVER_SECRET` + `MCP_ACTOR_EMAIL` remain supported as the unnamed
 * default pair, so existing configurations keep working.
 */
function configuredActors(): { slug: string; email: string; secret: string }[] {
  const out: { slug: string; email: string; secret: string }[] = [];

  const legacySecret = process.env.MCP_SERVER_SECRET;
  const legacyEmail = process.env.MCP_ACTOR_EMAIL;
  if (legacySecret && legacyEmail) {
    out.push({ slug: 'default', email: legacyEmail, secret: legacySecret });
  }

  const roster = (process.env.MCP_CREDENTIALS ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  for (const name of roster) {
    const secret = process.env[`MCP_SECRET_${name}`];
    const email = process.env[`MCP_ACTOR_${name}`];

    // A name on the roster with a missing half is a half-finished
    // configuration, not a reason to fall back to some other identity.
    if (secret && email) out.push({ slug: name.toLowerCase(), email, secret });
  }

  return out;
}

/**
 * Exchanges an agent's own secret for a session on that agent's account.
 *
 * The actor is chosen by the DEPLOYMENT, never by the caller.
 */
export const authenticate = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    // Every pre-authentication failure returns the SAME string. Distinct
    // messages told an anonymous caller whether MCP was configured here at all,
    // and whether the operator had configured it weakly — free targeting
    // information, and a signal to keep probing during a misconfiguration
    // window. The real reason goes to the audit row, where it belongs.
    const denied = { success: false as const, error: 'Unauthorized.' };

    const actors = configuredActors();
    if (actors.length === 0) {
      await recordAuthFailure(ctx, 'No MCP actor is configured on this deployment');
      return denied;
    }

    // EVERY candidate is compared, with no early exit. Returning as soon as one
    // matches would make the response time depend on the agent's position in
    // the list, which leaks how many are configured and narrows which one a
    // probe just hit.
    let matched: { slug: string; email: string } | null = null;
    let sawShortSecret = false;

    for (const candidate of actors) {
      if (candidate.secret.length < MIN_SECRET_LENGTH) {
        // Refused rather than warned. A 6-character shared secret that still
        // works is the configuration mistake nobody notices until it is used.
        sawShortSecret = true;
        continue;
      }
      if (constantTimeEquals(secret, candidate.secret) && !matched) {
        matched = { slug: candidate.slug, email: candidate.email };
      }
    }

    if (!matched) {
      await recordAuthFailure(
        ctx,
        sawShortSecret
          ? 'Secret mismatch (and at least one configured secret is shorter than 32 characters)'
          : 'Secret mismatch',
      );
      return denied;
    }

    const actorEmail = matched.email.trim().toLowerCase();

    const actor = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', actorEmail))
      .unique();

    // Same four gates the Supabase version applied at startup — but re-applied on
    // every exchange rather than once when the process booted. The old server
    // held its privileges for as long as it stayed running, so disabling the
    // account changed nothing until someone restarted it.
    if (!actor || actor.isDeleted || !actor.isActive) {
      await recordAuthFailure(ctx, 'Actor missing or inactive', actorEmail);
      return { success: false as const, error: 'Unauthorized.' };
    }
    if (!actor.mcpEnabled) {
      await recordAuthFailure(ctx, 'MCP access disabled for actor', actorEmail);
      // Named, unlike the pre-authentication failures above: reaching here
      // required the correct secret, so the caller is the operator and the
      // actionable message costs nothing.
      return {
        success: false as const,
        error: `MCP access is disabled for ${actor.email}. Enable it in Admin > Users.`,
      };
    }
    if (!hasRole(actor, 'admin', 'super_admin')) {
      await recordAuthFailure(ctx, 'Actor is not an admin', actorEmail);
      return {
        success: false as const,
        error: `${actor.email} is not an admin, so MCP access cannot be used.`,
      };
    }

    const now = Date.now();

    // Evict expired sessions, then cap the live ones — rather than deleting them
    // all.
    //
    // Deleting every MCP session on each exchange looked tidier and was wrong:
    // the connection guide configures this server in BOTH Cursor and Claude
    // Desktop, and running both meant each one's re-mint revoked the other's
    // token. They do not fail — the client retries once and re-authenticates —
    // they just take turns evicting each other forever, doubling the auth
    // traffic and filling the audit log. Found by running a second client
    // against a live deployment; no amount of reading the function shows it.
    //
    // The cap still bounds a crash-looping server, which is what the original
    // eviction was actually for.
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', actor._id))
      .collect();

    const mcpSessions = existing.filter((s) => s.isMcp);
    const live = [];

    for (const s of mcpSessions) {
      if (s.expiresAt <= now) await ctx.db.delete(s._id);
      else live.push(s);
    }

    /**
     * The cap is PER CREDENTIAL, not per account.
     *
     * Several credentials resolve to the same actor — that is the point of the
     * roster — so a per-account cap meant one client signing in repeatedly
     * evicted another client's long-held session. The victim is always the
     * longest-running one, which is exactly the agent or test run you least
     * want to kill, and it surfaces as an unrelated `Unauthorized` in the middle
     * of unrelated work. Sessions predating `mcpCredential` count against their
     * own null bucket rather than everyone else's.
     */
    const sameCredential = live.filter((s) => s.mcpCredential === matched.slug);

    // Oldest first, so the ones dropped are the ones least likely to be in use.
    sameCredential.sort((a, b) => a.createdAt - b.createdAt);
    for (const s of sameCredential.slice(
      0,
      Math.max(0, sameCredential.length - (MAX_CONCURRENT_MCP_SESSIONS - 1)),
    )) {
      await ctx.db.delete(s._id);
    }

    const token = randomToken();
    await ctx.db.insert('sessions', {
      userId: actor._id,
      token,
      expiresAt: now + MCP_SESSION_TTL_MS,
      createdAt: now,
      userAgent: 'ORBIT MCP Server',
      isMcp: true,
      mcpCredential: matched.slug,
    });

    // NOT startSession: that stamps `lastLoginAt`, and a re-mint every 15 minutes
    // would overwrite the actor's real last-sign-in with a machine timestamp,
    // making the account look permanently active to anyone auditing it.

    await ctx.db.insert('auditLogs', {
      userId: actor._id,
      userEmail: actor.email,
      userRoles: actor.roles,
      action: 'MCP_AUTHENTICATED',
      // WHICH credential was used, not just which account it resolved to.
      //
      // Several orchestrators share one platform identity — the ORBIT Agent
      // account — so `userEmail` alone cannot answer "who ran this". The slug
      // is the env-var suffix of the secret presented, so an action is
      // attributable to the orchestrator holding it, and one can be revoked
      // without disturbing the others.
      metadata: { credential: matched.slug },
      success: true,
      userAgent: 'ORBIT MCP Server',
      createdAt: now,
    });

    return {
      success: true as const,
      token,
      expiresAt: now + MCP_SESSION_TTL_MS,
      actor: { id: actor._id, email: actor.email, fullName: actor.fullName, roles: actor.roles },
    };
  },
});

/** Resolves an MCP session token, refusing tokens that are not MCP sessions. */
async function requireMcpSession(
  ctx: QueryCtx | MutationCtx,
  token: string,
): Promise<{ session: Doc<'sessions'>; actor: Doc<'users'> }> {
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();

  if (!session || !session.isMcp || session.expiresAt <= Date.now()) {
    throw new Error('Unauthorized');
  }

  const actor = await ctx.db.get(session.userId);
  if (!actor || !actor.isActive || actor.isDeleted || !actor.mcpEnabled) {
    throw new Error('Unauthorized');
  }

  return { session, actor };
}

/**
 * Writes an MCP action to the audit log.
 *
 * The actor comes from the SESSION, never from the arguments. The Supabase
 * version built the row client-side, including `user_id`, `user_email` and
 * `user_roles` — so the audit trail recorded whatever the caller claimed.
 */
export const recordAudit = mutation({
  args: {
    token: v.string(),
    action: v.string(),
    tableName: v.optional(v.string()),
    recordId: v.optional(v.string()),
    values: v.optional(v.any()),
    success: v.optional(v.boolean()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, { token, action, tableName, recordId, values, success, errorMessage }) => {
    const { session, actor } = await requireMcpSession(ctx, token);

    await ctx.db.insert('auditLogs', {
      userId: actor._id,
      userEmail: actor.email,
      userRoles: actor.roles,
      action: `MCP_${action}`,
      tableName,
      recordId,
      newValues: values,
      // Carried from the SESSION, so every action is attributable to the
      // credential that opened it — not just the authentication event.
      metadata: session.mcpCredential ? { credential: session.mcpCredential } : undefined,
      success: success ?? true,
      errorMessage,
      userAgent: 'ORBIT MCP Server',
      createdAt: Date.now(),
    });

    return { success: true as const };
  },
});

/**
 * Maps a pre-migration Postgres uuid to its Convex id.
 *
 * Agents hold uuids in notes, prior transcripts and pasted links, and every
 * ORBIT url a human has ever shared embeds one. Without this, the first thing
 * an agent does after cutover — reuse an id it already had — fails with a
 * validator error it cannot act on.
 *
 * Restricted to the tables the MCP tools address, so this cannot be used to walk
 * arbitrary tables by legacy key.
 */
const INDEXED = ['users', 'streams', 'tasks', 'submissions', 'posts'] as const;
const SCANNED = ['postReplies', 'messages'] as const;

export const resolveLegacyId = query({
  args: { token: v.string(), table: v.string(), legacyId: v.string() },
  handler: async (ctx, { token, table, legacyId }) => {
    await requireMcpSession(ctx, token);

    const indexed = (INDEXED as readonly string[]).includes(table);
    const scanned = (SCANNED as readonly string[]).includes(table);

    if (!indexed && !scanned) {
      throw new Error(`Not a resolvable table: ${table}`);
    }

    // Five of these DO carry by_legacyId (schema.ts) and an earlier version of
    // this function scanned all seven anyway — loading an entire table into the
    // transaction on every uuid an agent passed. That is invisible at 348 rows
    // and becomes a hard read-limit failure as posts and messages grow, at which
    // point ids.ts would report the id as "predating the import", which is the
    // wrong diagnosis entirely.
    // The table name is a runtime string an agent passed, checked against an
    // allow-list above. Convex's generated types describe a LITERAL table name
    // and cannot describe this; the allow-list is what makes it safe, not the
    // type.
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const dynamic = (name: string) => ctx.db.query(name as any);

    if (indexed) {
      const hit = await dynamic(table)
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        .withIndex('by_legacyId', (q: any) => q.eq('legacyId', legacyId))
        .first();
      return hit ? (hit._id as string) : null;
    }

    // messages and postReplies genuinely have no such index. legacyId is dropped
    // at cutover, so adding two throwaway indexes is the wrong trade — but this
    // branch is the one that will eventually hit the read limit, and it is
    // deliberately the branch nothing routine uses.
    const rows = await dynamic(table).collect();
    const hit = rows.find((r) => (r as { legacyId?: string }).legacyId === legacyId);

    return hit ? (hit._id as string) : null;
  },
});

/**
 * Kills every MCP session on the deployment, for any actor. Admin only.
 *
 * The incident this exists for: the shared secret leaks. Rotating
 * MCP_SERVER_SECRET stops new exchanges but leaves live tokens — full admin
 * sessions — valid for up to 15 minutes, and `adminSetMcpAccess` needs the actor
 * id, which is only discoverable by reading the deployment's environment
 * variables. Nothing in the database says which account MCP_ACTOR_EMAIL names.
 *
 * This needs neither.
 */
export const revokeAllSessions = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'admin', 'super_admin')) {
      throw new Error('Admin access required');
    }

    const sessions = await ctx.db.query('sessions').collect();
    let revoked = 0;

    for (const s of sessions) {
      if (s.isMcp) {
        await ctx.db.delete(s._id);
        revoked++;
      }
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.mcp_sessions_revoked',
      newValues: { revoked },
      success: true,
      createdAt: Date.now(),
    });

    return { success: true as const, revoked };
  },
});

/** Who the MCP session belongs to, and how long it has left. */
export const whoami = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { session, actor } = await requireMcpSession(ctx, token);
    return {
      id: actor._id,
      email: actor.email,
      fullName: actor.fullName,
      roles: actor.roles,
      expiresAt: session.expiresAt,
    };
  },
});

/**
 * Counts behind the `orbit://stats` resource.
 *
 * Admin-gated rather than open: it is a platform-wide census, and the Supabase
 * version served it with the service key to anything that could reach the
 * process.
 */
export const platformStats = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin')) {
      throw new Error('Admin access required');
    }

    /**
     * BOUNDED. `submissions` is the one that matters here: it grows as interns
     * x tasks x resubmissions, and `tasks.listSubmissions` was already given a
     * READ_CAP for exactly that reason. This query reproduced the unbounded
     * pattern that fix existed to remove.
     *
     * Five tables x 3000 stays well under Convex's per-transaction read ceiling.
     * `capped` is returned so a census that has outgrown the cap says so rather
     * than quietly reporting a floor as a total.
     */
    const CENSUS_CAP = 3000;

    const [users, streams, tasks, submissions, mirror] = await Promise.all([
      ctx.db.query('users').take(CENSUS_CAP + 1),
      ctx.db.query('streams').take(CENSUS_CAP + 1),
      ctx.db.query('tasks').take(CENSUS_CAP + 1),
      ctx.db.query('submissions').take(CENSUS_CAP + 1),
      ctx.db.query('applicationMirror').take(CENSUS_CAP + 1),
    ]);

    const capped = [users, streams, tasks, submissions, mirror].some(
      (rows) => rows.length > CENSUS_CAP,
    );

    return {
      activeUsers: users.filter((u) => u.isActive && !u.isDeleted).length,
      activeStreams: streams.filter((s) => s.isActive).length,
      activeTasks: tasks.filter((t) => t.isActive).length,
      pendingSubmissions: submissions.filter((s) => s.status === 'submitted').length,

      /**
       * True when at least one table hit the read cap, so every figure here is
       * a floor. The agent should report it as "3,000+" rather than quoting a
       * precise-looking number that is quietly wrong.
       */
      capped,

      /**
       * Health of the Google Sheet mirror of applications.
       *
       * Surfaced HERE, on the stats the agent already reads, rather than as its
       * own tool: nothing else needs to poll it, and a check that has to be
       * remembered separately is a check that stops happening. `failing` and
       * `abandoned` are the two the agent should raise — the first is retrying,
       * the second has given up and needs someone to look at the endpoint.
       */
      applicationMirror: {
        pending: mirror.filter((m) => m.status === 'pending').length,
        sent: mirror.filter((m) => m.status === 'sent' || m.status === 'duplicate').length,
        failing: mirror.filter((m) => m.status === 'failed').length,
        abandoned: mirror.filter((m) => m.status === 'abandoned').length,
        lastError:
          mirror
            .filter((m) => m.lastError)
            .sort((a, b) => (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0))[0]?.lastError ?? null,
      },
    };
  },
});

/**
 * Row counts for a fixed set of tables. Admin only, integers only.
 *
 * Exists because asserting "this action produced exactly one notification and
 * one email" needs a count, and the only thing that could produce one used to be
 * `migrations.countRows` — a public mutation gated on MIGRATION_SECRET, i.e. the
 * surface that has just been made internal. Reaching for an unauthenticated
 * table-reader to verify a security boundary was backwards.
 *
 * The allowlist is the point: no argument names a table this cannot already
 * summarise, and nothing here returns a row.
 */
const COUNTABLE = [
  'users',
  'streams',
  'tasks',
  'submissions',
  'notifications',
  'emailQueue',
  'auditLogs',
  'pointsLedger',
  'posts',
  'postReplies',
  'messages',
  'sessions',
  'applications',
] as const;

export const rowCounts = query({
  args: { token: v.string(), tables: v.array(v.string()) },
  handler: async (ctx, { token, tables }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin')) {
      throw new Error('Admin access required');
    }

    /**
     * BOUNDED. COUNTABLE deliberately includes the tables this codebase calls
     * its fastest-growing — notifications, emailQueue, auditLogs, pointsLedger,
     * posts, messages, sessions — and this counted them with an unbounded
     * `.collect()` per table, on demand, for any admin who asked. Convex has no
     * native count, so an exact figure means reading every row; a cap plus an
     * honest "there are more than this" is the version that keeps working.
     */
    const COUNT_CAP = 5000;

    const counts: Record<string, number> = {};
    const capped: string[] = [];

    for (const table of tables) {
      if (!(COUNTABLE as readonly string[]).includes(table)) {
        throw new Error(`Not a countable table: ${table}`);
      }
      // Same dynamic-table story as resolveLegacyId: `table` is a runtime
      // string, already checked against COUNTABLE just above.
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const rows = await ctx.db.query(table as any).take(COUNT_CAP + 1);
      counts[table] = Math.min(rows.length, COUNT_CAP);
      if (rows.length > COUNT_CAP) capped.push(table);
    }

    return { ...counts, _capped: capped };
  },
});

export type McpActorId = Id<'users'>;

/**
 * Whether this deployment is enforcing rate limits.
 *
 * Exists so the verification harness can say out loud that it is skipping the
 * throttle assertions, rather than passing them silently on a deployment where
 * the thing under test is switched off.
 */
export const deploymentFlags = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin')) throw new Error('Admin access required');

    return {
      rateLimitsEnforced: process.env.RATE_LIMITS_DISABLED !== 'true',
      // Derived from the whole roster, not just the legacy pair. Production
      // configures ONLY named credentials, so keying on MCP_SERVER_SECRET
      // reported MCP as unconfigured there and would have had the verification
      // harness skip its MCP checks on the one deployment that matters.
      mcpConfigured: configuredActors().length > 0,
      emailAllowlistActive: Boolean(process.env.EMAIL_ALLOWLIST),
    };
  },
});
