import { mutation, query, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { requireAdmin } from './lib/auth';
import { recomputeUserPoints } from './lib/points';

/**
 * The admin dashboard's counters.
 *
 * Replaces `orbit_get_admin_stats`. Nothing changed about who may see them —
 * that RPC validated the token and required an admin role too — but the counts
 * are now derived the same way every other read in this codebase is, rather
 * than by a SQL function that has to be kept in step with the schema by hand.
 *
 * `activeMembers` counts users with an ACTIVE STREAM MEMBERSHIP, which is what
 * the label means and what the RPC computed. It is deliberately not the same
 * number as `totalUsers` minus the deactivated: someone can hold an account and
 * be in no stream.
 */
export const stats = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    /**
     * BOUNDED, and honest about it when the bound bites.
     *
     * These were four unbounded whole-table `.collect()` calls on every
     * dashboard load. Invisible at a few hundred rows, and on a collision
     * course with Convex's per-transaction read ceiling (~16k documents) as
     * `users` and `streamMemberships` grow with each cohort — at which point
     * the ADMIN DASHBOARD is the screen that stops loading.
     *
     * Four tables x 3000 keeps the worst case at 12k, comfortably under the
     * ceiling. `securityDashboard` below already reads this way; the only new
     * thing here is that a counter must not quietly under-report, so when a cap
     * bites the screen is told rather than shown a wrong number confidently.
     * Same idiom as `emailDispatch.status`'s `queuedIsCapped`.
     */
    const STATS_CAP = 3000;

    const [users, streams, tasks, memberships] = await Promise.all([
      ctx.db.query('users').take(STATS_CAP + 1),
      ctx.db.query('streams').take(STATS_CAP + 1),
      ctx.db.query('tasks').take(STATS_CAP + 1),
      ctx.db.query('streamMemberships').take(STATS_CAP + 1),
    ]);

    const capped =
      users.length > STATS_CAP ||
      streams.length > STATS_CAP ||
      tasks.length > STATS_CAP ||
      memberships.length > STATS_CAP;

    const live = users.filter((u) => !u.isDeleted);
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;

    // A user with duplicate membership rows would otherwise be counted twice.
    const inAStream = new Set(memberships.filter((m) => m.isActive).map((m) => m.userId));

    return {
      totalUsers: live.length,
      activeStreams: streams.filter((s) => s.isActive).length,
      totalTasks: tasks.filter((t) => t.isActive).length,
      activeMembers: live.filter((u) => u.isActive && inAStream.has(u._id)).length,
      recentUsers: live.filter((u) => u.createdAt >= thirtyDaysAgo).length,
      recentStreams: streams.filter((s) => s.createdAt >= thirtyDaysAgo).length,
      recentTasks: tasks.filter((t) => t.createdAt >= thirtyDaysAgo).length,
      /**
       * True when at least one table hit the cap, so every figure above is a
       * floor rather than a total. The screen should render "3,000+" rather
       * than a precise-looking number that is quietly wrong.
       */
      capped,
    };
  },
});

/**
 * The security panel: currently-blocked IPs and the rate-limit buckets that are
 * filling up.
 *
 * `blockedIps` and `rateLimits` had no reader at all on the Convex side — the
 * limiter wrote to them and nothing ever looked, which is the state a security
 * control should never be in. This is that reader.
 *
 * "Recent failed logins" is what the Postgres dashboard called it, and it is
 * really the login rate-limit buckets: the limiter counts ATTEMPTS per account
 * and per IP, so a bucket with several requests in the current window is the
 * signal. Only login-related endpoints are returned; a bucket for file uploads
 * is not a security event and would drown the ones that are.
 */
export const securityDashboard = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    const now = Date.now();

    /**
     * BOUNDED. `rateLimits` is the fastest-growing table in the deployment and
     * this read had no cap, so the security panel was on course to become the
     * first screen that stops loading — the one whose job is to tell you
     * something is wrong. A page is enough: the panel shows the top fifty
     * buckets and every currently-active block, not a complete history.
     */
    const DASHBOARD_PAGE = 2000;

    /**
     * NEWEST FIRST. `.take(n)` without an order returns the n rows with the
     * lowest creation time, which on this screen is precisely backwards: an
     * attacker minting fresh buckets creates the NEWEST rows, so a page taken
     * from the oldest end truncates them away before the sort below ever sees
     * them. The panel would have been bounded in the one direction that blinds
     * it to the thing it exists to show.
     */
    const [blocked, limits] = await Promise.all([
      ctx.db.query('blockedIps').order('desc').take(DASHBOARD_PAGE),
      ctx.db.query('rateLimits').order('desc').take(DASHBOARD_PAGE),
    ]);

    // An expired block is not a block. The row is left in place for the audit
    // trail, but reporting it as active would misstate the current posture.
    const active = blocked.filter((b) => b.isPermanent || (b.expiresAt ?? 0) > now);

    const LOGIN_ENDPOINTS = ['login', 'login_ip', 'magic_link', 'magic_link_ip', 'oauth_callback'];

    const recent = limits
      .filter((r) => LOGIN_ENDPOINTS.some((e) => r.endpoint.startsWith(e)))
      .filter((r) => r.requestCount > 1)
      .sort((a, b) => b.lastRequest - a.lastRequest)
      .slice(0, 50);

    return {
      blockedIps: active
        .sort((a, b) => b.blockedAt - a.blockedAt)
        .map((b) => ({
          ipAddress: b.ipAddress,
          reason: b.reason,
          blockedUntil: b.isPermanent ? null : (b.expiresAt ?? null),
          blockedAt: b.blockedAt,
        })),
      recentFailedLogins: recent.map((r) => ({
        // The bucket key is an account or an address depending on the endpoint;
        // the column is named ipAddress because the limiter is generic.
        ipAddress: r.ipAddress,
        endpoint: r.endpoint,
        requestCount: r.requestCount,
        windowStart: r.windowStart,
      })),
      totalBlocked: active.length,
    };
  },
});

/**
 * Blocks an address, or lifts a block.
 *
 * `blockedIps` was consulted on EVERY rate-limit check and written by nothing.
 * A block list with no writer is not a control that has not been used yet — it
 * is a read on the hot path that can only ever return nothing, and a panel that
 * reports "0 blocked" whether or not anyone is under attack. This is the writer
 * it was missing.
 *
 * Manual rather than automatic on purpose. Auto-blocking on repeated limit
 * breaches sounds appealing and is how you lock out the whole Ilorin hub: an
 * address at ORBIT is routinely a building behind one NAT, which is the same
 * reason every per-address limit here is deliberately loose. A human looking at
 * the security panel can tell a campus lab from an attacker; a counter cannot.
 *
 * The key space is the limiter's, not strictly IPs — checkRateLimit looks up
 * whatever bucket key it was given, so blocking `email:someone@example.com`
 * works and is sometimes what you want.
 */
export const setIpBlock = mutation({
  args: {
    token: v.string(),
    ipAddress: v.string(),
    /** Absent or false lifts an existing block. */
    blocked: v.boolean(),
    reason: v.optional(v.string()),
    /** Hours from now. Omit for a permanent block. */
    durationHours: v.optional(v.number()),
  },
  handler: async (ctx, { token, ipAddress, blocked, reason, durationHours }) => {
    const admin = await requireAdmin(ctx, token);

    const key = ipAddress.trim();
    if (!key) return { success: false as const, error: 'An address is required.' };

    const now = Date.now();

    const existing = await ctx.db
      .query('blockedIps')
      .withIndex('by_ip', (q) => q.eq('ipAddress', key))
      .first();

    if (!blocked) {
      // Deleted rather than expired: an expired row is still read on every
      // check, and the audit row below is the durable record of what happened.
      if (existing) await ctx.db.delete(existing._id);
    } else {
      const row = {
        ipAddress: key,
        reason: reason?.trim() || 'Blocked by an administrator',
        blockedBy: admin._id,
        blockedAt: now,
        expiresAt:
          durationHours && durationHours > 0 ? now + durationHours * 60 * 60 * 1000 : undefined,
        isPermanent: !durationHours || durationHours <= 0,
      };

      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert('blockedIps', row);
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: blocked ? 'admin.ip_blocked' : 'admin.ip_unblocked',
      tableName: 'blockedIps',
      recordId: key,
      newValues: { ipAddress: key, reason, durationHours: durationHours ?? null },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * Repairs a user's points total and level from the ledger.
 *
 * `recomputeUserPoints` has existed in lib/points.ts since the migration as the
 * documented way to fix drift, with no caller anywhere — a repair tool nobody
 * can run. This is that caller.
 *
 * It adds nothing: it sums the existing ledger and writes the result, so it is
 * safe to run on anyone at any time and is idempotent. `awardPoints` already
 * recomputes from the ledger on every write for exactly this reason, so drift
 * should not occur — but "should not" and "cannot" are different, and the
 * cheapest moment to have the fix wired is before a real cohort is using it.
 *
 * Audited like every other admin write that changes someone else's record.
 */
export const recomputePoints = mutation({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const admin = await requireAdmin(ctx, token);

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    const before = { total: target.totalPoints, level: target.currentLevel };
    const after = await recomputeUserPoints(ctx, userId);

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.points_recomputed',
      tableName: 'users',
      recordId: userId,
      oldValues: before,
      newValues: after,
      success: true,
      createdAt: Date.now(),
    });

    // Level too, not just the total: a repair that only corrects a stale level
    // — the exact drift a partially-applied write leaves behind — would
    // otherwise report `changed: false` and read as a no-op.
    const changed = before.total !== after.total || before.level !== after.level;

    return { success: true as const, before, after, changed };
  },
});

/**
 * What demo and seed content is still on this deployment.
 *
 * REPORTS FIRST. Run with `{ dryRun: true }` and read the output before letting
 * it delete anything — the last sweep of this kind marked six posts and was
 * reported as done, while the feed went on rendering every one of them because
 * the query never filtered the flag. Counting what a sweep TOUCHED is not the
 * same as checking what a member SEES.
 *
 * "Demo" is defined narrowly and conservatively:
 *  - tasks that predate the current bank AND carry no submissions
 *  - anything already flagged `isDummy`
 * Content a person wrote in earnest is never in scope, which is why this refuses
 * to touch a task with any submission against it, whatever its age.
 */
export const demoContentReport = internalMutation({
  args: { dryRun: v.optional(v.boolean()), bankTitles: v.array(v.string()) },
  handler: async (ctx, { dryRun, bankTitles }) => {
    const bank = new Set(bankTitles);

    const tasks = await ctx.db.query('tasks').collect();
    const submissions = await ctx.db.query('submissions').collect();
    const withWork = new Set(submissions.map((s) => String(s.taskId)));

    /**
     * Legacy: not in the current bank, and nobody has submitted against it.
     * The submission check is the safety rail — a task someone has worked on is
     * their record as much as it is ours, whatever it looks like to us.
     */
    const legacy = tasks.filter(
      (t) => !bank.has(t.title) && !withWork.has(String(t._id)) && !t.isDummy,
    );

    const dummyTasks = tasks.filter((t) => t.isDummy);
    const dummyPosts = (await ctx.db.query('posts').collect()).filter((p) => p.isDummy);
    const dummyStreams = (await ctx.db.query('streams').collect()).filter((s) => s.isDummy);
    const dummyUsers = (await ctx.db.query('users').collect()).filter((u) => u.isDummy);

    let removed = 0;
    let notificationsRemoved = 0;
    if (!dryRun) {
      /**
       * Notifications read ONCE, not once per task.
       *
       * The obvious shape — re-reading them inside the delete loop — is O(n*m)
       * and would read the same 500 rows twenty-eight times over. Notifications
       * pointing at a task that no longer exists render as a dead link in
       * someone's list, so they go with it.
       */
      const doomed = new Set(legacy.map((t) => String(t._id)));
      const notes = await ctx.db.query('notifications').order('desc').take(1000);
      for (const n of notes) {
        if (n.referenceId && doomed.has(n.referenceId)) {
          await ctx.db.delete(n._id);
          notificationsRemoved++;
        }
      }

      for (const t of legacy) {
        await ctx.db.delete(t._id);
        removed++;
      }
    }

    return {
      dryRun: Boolean(dryRun),
      totals: {
        tasks: tasks.length,
        submissions: submissions.length,
      },
      legacyTasks: {
        count: legacy.length,
        removed,
        notificationsRemoved,
        sample: legacy.slice(0, 8).map((t) => ({
          title: t.title,
          points: t.points,
          approvalStatus: t.approvalStatus,
          createdAt: t.createdAt,
        })),
      },
      alreadyFlaggedDummy: {
        tasks: dummyTasks.length,
        posts: dummyPosts.length,
        streams: dummyStreams.length,
        users: dummyUsers.length,
      },
    };
  },
});
