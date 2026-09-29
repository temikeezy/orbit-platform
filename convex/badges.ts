import { query, mutation, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { MutationCtx } from './_generated/server';
import { requireUser, requireAdmin, hasRole } from './lib/auth';
import { awardPoints } from './lib/points';
import { internal } from './_generated/api';

/**
 * Badges.
 *
 * Awarding is deliberately split in two:
 *  - `awardManually` is the admin action (was admin_award_badge).
 *  - `checkAndAward` is internal, called by mutations that change the things
 *    badges key off. On Postgres those were AFTER-INSERT/UPDATE triggers on
 *    submissions, points and activity; Convex has no triggers, so the calls must
 *    be explicit. If a caller forgets one, badges simply stop being awarded and
 *    nothing errors — which is exactly the silent drift this migration is meant
 *    to avoid, so every mutation that moves points MUST call this.
 */

function shape(b: {
  _id: Id<'badges'>; name: string; description: string; iconUrl?: string;
  criteriaType: string; criteriaValue: number; pointsBonus: number; isActive: boolean;
}) {
  return {
    id: b._id,
    name: b.name,
    description: b.description,
    iconUrl: b.iconUrl,
    criteriaType: b.criteriaType,
    criteriaValue: b.criteriaValue,
    pointsBonus: b.pointsBonus,
    isActive: b.isActive,
  };
}

/**
 * Badge point bonuses.
 *
 * award_badge_to_user also inserted a 'bonus' ledger row and bumped the user's
 * total; admin_revoke_badge deducted it. This port originally inserted only the
 * userBadges row, so every badge with pointsBonus > 0 silently under-paid — and
 * because totals are recomputed from the ledger, the bonus had no other way to
 * survive.
 */
async function grantBonus(
  ctx: MutationCtx,
  userId: Id<'users'>,
  badgeId: Id<'badges'>,
  createdBy: Id<'users'>,
) {
  const badge = await ctx.db.get(badgeId);
  if (!badge || badge.pointsBonus <= 0) return;

  await awardPoints(ctx, {
    userId,
    points: badge.pointsBonus,
    reason: 'badge_bonus',
    referenceId: badgeId,
    referenceType: 'badge',
    createdBy,
  });
}

/** Negative ledger entry, matching the codebase's own clawback convention. */
async function clawBackBonus(
  ctx: MutationCtx,
  userId: Id<'users'>,
  badgeId: Id<'badges'>,
  createdBy: Id<'users'>,
) {
  const badge = await ctx.db.get(badgeId);
  if (!badge || badge.pointsBonus <= 0) return;

  await awardPoints(ctx, {
    userId,
    points: -badge.pointsBonus,
    reason: 'badge_bonus_revoked',
    referenceId: badgeId,
    referenceType: 'badge',
    createdBy,
  });
}

export const list = query({
  args: { token: v.string(), includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { token, includeInactive }) => {
    await requireUser(ctx, token);
    const badges = await ctx.db.query('badges').collect();
    return badges.filter((b) => includeInactive || b.isActive).map(shape);
  },
});

/** Replaces get_badges_with_user_status: every badge plus whether it is earned. */
export const listWithUserStatus = query({
  args: { token: v.string(), userId: v.optional(v.id('users')) },
  handler: async (ctx, { token, userId }) => {
    const viewer = await requireUser(ctx, token);
    const subject = userId ?? viewer._id;

    const [badges, earned] = await Promise.all([
      ctx.db.query('badges').collect(),
      ctx.db.query('userBadges').withIndex('by_user', (q) => q.eq('userId', subject)).collect(),
    ]);

    const earnedAt = new Map(earned.map((e) => [e.badgeId, e.earnedAt]));

    return badges
      .filter((b) => b.isActive)
      .map((b) => ({ ...shape(b), earned: earnedAt.has(b._id), earnedAt: earnedAt.get(b._id) }));
  },
});

export const listForUser = query({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    await requireUser(ctx, token);

    const earned = await ctx.db
      .query('userBadges')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();

    const out = [];
    for (const e of earned) {
      const badge = await ctx.db.get(e.badgeId);
      if (badge) out.push({ ...shape(badge), earnedAt: e.earnedAt });
    }
    return out.sort((a, b) => b.earnedAt - a.earnedAt);
  },
});

export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    description: v.string(),
    iconUrl: v.optional(v.string()),
    criteriaType: v.string(),
    criteriaValue: v.number(),
    pointsBonus: v.optional(v.number()),
  },
  handler: async (ctx, { token, pointsBonus, ...fields }) => {
    await requireAdmin(ctx, token);
    const id = await ctx.db.insert('badges', {
      ...fields,
      pointsBonus: pointsBonus ?? 0,
      isActive: true,
      createdAt: Date.now(),
    });
    return { success: true as const, id };
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    id: v.id('badges'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    iconUrl: v.optional(v.string()),
    criteriaValue: v.optional(v.number()),
    pointsBonus: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, id, ...patch }) => {
    await requireAdmin(ctx, token);
    await ctx.db.patch(id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return { success: true as const };
  },
});

/**
 * Deactivates rather than deletes.
 *
 * `badges.ts:97` hard-deleted the row, which orphaned every userBadges record
 * pointing at it — earned history simply vanished from users' profiles. Marking
 * inactive hides it from the catalogue while preserving what people earned.
 */
export const deactivate = mutation({
  args: { token: v.string(), id: v.id('badges') },
  handler: async (ctx, { token, id }) => {
    await requireAdmin(ctx, token);
    await ctx.db.patch(id, { isActive: false });
    return { success: true as const };
  },
});

/**
 * Records who moved a badge, and therefore who moved the points behind it.
 *
 * Awarding and revoking both change a member's total, which changes their level,
 * which changes their standing on the leaderboard. That is a discretionary
 * decision by one person about another, and none of it was audited — the ledger
 * recorded that points moved but not that an administrator chose to move them,
 * so a disputed badge had no answer to "who did this, and when".
 */
async function recordBadgeAudit(
  ctx: MutationCtx,
  caller: { _id: Id<'users'>; email: string; roles: string[] },
  action: string,
  userId: Id<'users'>,
  badgeId: Id<'badges'>,
  now: number,
) {
  const badge = await ctx.db.get(badgeId);
  await ctx.db.insert('auditLogs', {
    userId: caller._id,
    userEmail: caller.email,
    userRoles: caller.roles,
    action,
    tableName: 'userBadges',
    recordId: userId,
    newValues: { badgeId, badgeName: badge?.name, pointsBonus: badge?.pointsBonus ?? 0 },
    success: true,
    createdAt: now,
  });
}

export const awardManually = mutation({
  args: { token: v.string(), userId: v.id('users'), badgeId: v.id('badges') },
  handler: async (ctx, { token, userId, badgeId }) => {
    // admin_award_badge raised unless admin/super_admin. An earlier draft of
    // this port quietly widened it to moderators; revoke stayed admin-only, so
    // the pair was asymmetric too.
    const caller = await requireAdmin(ctx, token);
    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    // prevent_admin_badges: admins did not accrue badges on Postgres either.
    if (hasRole(target, 'admin', 'super_admin')) {
      return { success: false as const, error: 'Admins do not earn badges.' };
    }

    const existing = await ctx.db
      .query('userBadges')
      .withIndex('by_user_and_badge', (q) => q.eq('userId', userId).eq('badgeId', badgeId))
      .first();

    if (existing) return { success: true as const, alreadyHeld: true };

    const now = Date.now();
    await ctx.db.insert('userBadges', { userId, badgeId, earnedAt: now, isDummy: false, createdAt: now });
    await grantBonus(ctx, userId, badgeId, caller._id);

    await recordBadgeAudit(ctx, caller, 'admin.badge_awarded', userId, badgeId, now);

    /**
     * A manual award moves points, so it can cross another badge's threshold.
     *
     * Convex has no triggers: every points-moving path has to re-evaluate
     * badges itself, and this one did not. `grantBonus` above can push a member
     * past a points-criteria badge, and nothing would notice until some
     * unrelated approval happened to run `checkAndAward` — silent drift, which
     * is exactly the failure mode this module's header warns about.
     *
     * The two omissions elsewhere are deliberate and stay that way: the
     * review-reversal path (`tasks.ts`) and `revoke` below both DECREASE
     * points, and `checkAndAward` is additive-only, so a decrease can never
     * newly qualify anyone.
     */
    const cascaded = await evaluateBadges(ctx, userId, false);

    /**
     * The badge the admin actually chose is announced HERE, not by
     * `evaluateBadges`.
     *
     * Its `userBadges` row is inserted above, before the cascade runs, so by the
     * time `evaluateBadges` builds `heldIds` the manual badge is already held
     * and never enters `awarded`. Left to the cascade alone, the recipient is
     * emailed about a side-effect badge earned from the bonus points and told
     * nothing about the one a person deliberately gave them.
     *
     * Prepended into one batch rather than sent separately, per this module's
     * one-message-per-moment rule.
     */
    const badge = await ctx.db.get(badgeId);
    const announce = [...(badge ? [badge.name] : []), ...cascaded.awarded];
    if (announce.length > 0) {
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyBadgesEarned, {
        userId,
        badgeNames: announce,
      });
    }

    return { success: true as const, alreadyHeld: false, alsoAwarded: cascaded.awarded };
  },
});

export const revoke = mutation({
  args: { token: v.string(), userId: v.id('users'), badgeId: v.id('badges') },
  handler: async (ctx, { token, userId, badgeId }) => {
    const caller = await requireAdmin(ctx, token);

    const row = await ctx.db
      .query('userBadges')
      .withIndex('by_user_and_badge', (q) => q.eq('userId', userId).eq('badgeId', badgeId))
      .first();

    if (row) {
      await ctx.db.delete(row._id);
      await clawBackBonus(ctx, userId, badgeId, caller._id);
      await recordBadgeAudit(ctx, caller, 'admin.badge_revoked', userId, badgeId, Date.now());
    }
    return { success: true as const };
  },
});

/**
 * Evaluates every badge for a user and awards any newly earned.
 *
 * Replaces check_task_completion_badges, check_point_milestone_badges,
 * check_quality_badges and check_streak_badges. Idempotent — re-running awards
 * nothing new — so callers may invoke it defensively.
 */
/**
 * The evaluation itself, as a plain function.
 *
 * Extracted from the `checkAndAward` mutation below so that in-module callers
 * (`awardManually`) can run it without `ctx.runMutation(internal.badges...)`.
 * That round trip is not just wasteful inside one transaction — referencing
 * this module's own `internal` entry from inside it makes the generated `api`
 * type circular, and TypeScript degrades `awardManually` to `any` and then
 * every module that touches the api type with it.
 */
async function evaluateBadges(
  ctx: MutationCtx,
  userId: Id<'users'>,
  /**
   * Whether to announce what it awards.
   *
   * `awardManually` sends its own combined message — the manual badge plus
   * anything cascaded — so letting this announce as well emailed every cascaded
   * badge TWICE, once in each batch. The caller that owns the message suppresses
   * this one rather than both trying to be polite about it.
   */
  announce = true,
): Promise<{ awarded: string[] }> {
  {
    const user = await ctx.db.get(userId);
    if (!user || hasRole(user, 'admin', 'super_admin') || user.isDummy) return { awarded: [] };

    const [badges, held, submissions] = await Promise.all([
      ctx.db.query('badges').collect(),
      ctx.db.query('userBadges').withIndex('by_user', (q) => q.eq('userId', userId)).collect(),
      ctx.db.query('submissions').withIndex('by_user', (q) => q.eq('userId', userId)).collect(),
    ]);

    const heldIds = new Set(held.map((h) => h.badgeId));
    const approved = submissions.filter((s) => s.status === 'approved');

    // Replies the user has written. The Postgres original counted
    // orbit_activity_feed rows WHERE parent_id IS NOT NULL — but that table has
    // no parent_id column, so consistency badges could never be awarded. This
    // uses postReplies, which is what "comments made by user (helping
    // teammates)" plainly meant.
    const replies = await ctx.db
      .query('postReplies')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();

    // Distinct ISO weeks containing an on-time approved submission, capped at 10
    // as the original was.
    const onTimeWeeks = new Set<string>();
    for (const s of approved) {
      if (!s.submittedAt) continue;
      const task = await ctx.db.get(s.taskId);
      if (!task || s.submittedAt > task.deadline) continue;
      const d = new Date(s.submittedAt);
      const monday = d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000;
      onTimeWeeks.add(new Date(monday).toISOString().slice(0, 10));
    }

    // The five criteria_type values actually present in the data. An earlier
    // draft of this used invented names ('tasks_completed', 'points_earned', …)
    // which matched nothing, so every badge silently failed to award — the exact
    // failure mode this whole port is trying to avoid. Verified against
    // orbit_badges: consistency, points, quality, streak, tasks.
    const measure = (criteriaType: string): number => {
      switch (criteriaType) {
        case 'tasks':
          return approved.length;
        case 'points':
          return user.totalPoints;
        case 'streak':
          // Uncapped. The SQL's LIMIT 10 sat AFTER COUNT(*), so it limited a
          // one-row aggregate and was a no-op — Postgres counted distinct
          // on-time weeks without a ceiling. Capping at 10 here would make any
          // badge with criteriaValue > 10 unreachable forever.
          return onTimeWeeks.size;
        case 'consistency':
          return replies.length;
        case 'quality':
          // Faithful to the original, which took
          // GREATEST(count(approved AND (score IS NULL OR score >= 80)) / 2,
          //          count(approved AND score IS NULL) / 2).
          // The second set is a subset of the first, so it reduces to floor(x/2).
          // The halving is placeholder logic from when scores did not exist and
          // is worth revisiting now that they do.
          //
          // ⚠️ THE `>= 80` IS A PERCENTAGE-ERA THRESHOLD AND NO LONGER FITS.
          // A task is worth at most 20 points (LEVELS_SYSTEM.md, and now
          // enforced in lib/input.ts TASK_POINTS), and a score cannot exceed
          // its task — so no SCORED submission can ever reach 80. Only unscored
          // approvals count toward this badge today.
          //
          // This is not new: the ceiling was always 20 on the main task form.
          // What changed is that the two callers which ignored it (the admin
          // modal and the MCP tool) no longer do, so the loophole that made
          // this occasionally reachable is closed rather than the rule broken.
          //
          // Fixing it properly means deciding what "quality" means on a 1-20
          // scale — most likely a PROPORTION of the task's points (>= 80% of
          // `task.points`), which needs the task fetched here, not just the
          // submission. That is a product decision, not a mechanical one.
          return Math.floor(
            approved.filter((s) => s.score === undefined || s.score === null || s.score >= 80)
              .length / 2,
          );
        default:
          return 0;
      }
    };

    const awarded: string[] = [];
    const now = Date.now();

    for (const badge of badges) {
      if (!badge.isActive || heldIds.has(badge._id)) continue;
      if (measure(badge.criteriaType) < badge.criteriaValue) continue;

      await ctx.db.insert('userBadges', {
        userId,
        badgeId: badge._id,
        earnedAt: now,
        isDummy: false,
        createdAt: now,
      });
      await grantBonus(ctx, userId, badge._id, userId);
      awarded.push(badge.name);
    }

    /**
     * Announced as one batch. `evaluateBadges` can award several in a single
     * pass — a review that completes a streak, a milestone and a quality
     * threshold awards three — and three separate emails about one moment
     * reads as a malfunction rather than three pieces of good news.
     *
     * Scheduled so a badge is still awarded if the announcement fails.
     */
    if (announce && awarded.length > 0) {
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyBadgesEarned, {
        userId,
        badgeNames: awarded,
      });
    }

    return { awarded };
  }
}

export const checkAndAward = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => evaluateBadges(ctx, userId),
});

/**
 * Who holds a badge. Staff only.
 *
 * The Supabase version selected `user:orbit_users(id, full_name, email,
 * avatar_url)` for every holder — an email address per row, to render a list of
 * names, readable by anyone with the anon key. This returns the name and the
 * date, which is what the admin screen shows.
 */
export const holders = query({
  args: { token: v.string(), badgeId: v.id('badges') },
  handler: async (ctx, { token, badgeId }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin', 'moderator')) {
      throw new Error('Moderator access required');
    }

    // Indexed on the badge, not a whole-table scan filtered in memory.
    const rows = await ctx.db
      .query('userBadges')
      .withIndex('by_badge', (q) => q.eq('badgeId', badgeId))
      .collect();

    const out = [];

    for (const row of rows) {
      const user = await ctx.db.get(row.userId);
      if (!user || user.isDeleted) continue;
      out.push({
        id: row._id,
        user_id: user._id,
        earned_at: new Date(row.earnedAt).toISOString(),
        user: { id: user._id, full_name: user.fullName, profile_slug: user.profileSlug },
      });
    }

    return out.sort((a, b) => b.earned_at.localeCompare(a.earned_at));
  },
});
