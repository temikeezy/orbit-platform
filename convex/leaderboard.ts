import { query } from './_generated/server';
import { v } from 'convex/values';
import { requireUser } from './lib/auth';
import { isIntern } from './lib/internProfile';

/**
 * Leaderboard, computed server-side.
 *
 * `LeaderboardPage.tsx:63` currently pulls the entire points ledger into the
 * browser and aggregates it there — which means every client downloads every
 * user's point history to render a top-N list, and the privacy flag
 * `showOnLeaderboard` is applied only after the data has already been sent.
 * Aggregating here fixes both: the client receives a ranked list and nothing else.
 */

const WINDOWS = {
  all: 0,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
} as const;

export const top = query({
  args: {
    token: v.string(),
    period: v.optional(v.union(v.literal('all'), v.literal('week'), v.literal('month'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, period, limit }) => {
    const viewer = await requireUser(ctx, token);

    const window = WINDOWS[period ?? 'all'];
    const since = window === 0 ? 0 : Date.now() - window;

    const users = await ctx.db.query('users').collect();
    const eligible = users.filter(
      (u) =>
        u.isActive &&
        !u.isDeleted &&
        !u.isDummy &&
        u.showOnLeaderboard &&
        // Staff run the programme rather than competing in it. A supervisor
        // with a score is a bug upstream in awardPoints; keeping them off the
        // board means that bug never becomes a visible ranking.
        isIntern(u),
    );

    const rows = [];

    for (const u of eligible) {
      // All-time uses the denormalised total; windowed periods must sum the
      // ledger, because totalPoints carries no time dimension.
      let points: number;

      if (since === 0) {
        points = u.totalPoints;
      } else {
        const entries = await ctx.db
          .query('pointsLedger')
          .withIndex('by_user_and_time', (q) => q.eq('userId', u._id).gte('createdAt', since))
          .collect();
        points = entries.reduce((sum, e) => sum + e.points, 0);
      }

      rows.push({
        userId: u._id,
        fullName: u.fullName,
        profileSlug: u.profileSlug,
        profilePhotoUrl: u.profilePhotoUrl,
        currentLevel: u.currentLevel,
        points,
        isViewer: u._id === viewer._id,
      });
    }

    rows.sort((a, b) => b.points - a.points || a.fullName.localeCompare(b.fullName));

    const ranked = rows.map((r, i) => ({ ...r, rank: i + 1 }));
    const top = ranked.slice(0, limit ?? 50);

    // The viewer's own row is always returned, even when outside the top N —
    // otherwise a user below the cut sees no position at all.
    const viewerRow = ranked.find((r) => r.isViewer) ?? null;
    const viewerInTop = top.some((r) => r.isViewer);

    return {
      period: period ?? 'all',
      entries: top,
      viewer: viewerInTop ? null : viewerRow,
      totalRanked: ranked.length,
    };
  },
});

/**
 * A single user's standing. Respects the same privacy flag, except that a user
 * may always see their own.
 */
export const standingFor = query({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const viewer = await requireUser(ctx, token);

    const target = await ctx.db.get(userId);
    if (!target) return null;
    if (!target.showOnLeaderboard && target._id !== viewer._id) return null;

    const users = await ctx.db.query('users').collect();
    const ahead = users.filter(
      (u) =>
        u.isActive && !u.isDeleted && !u.isDummy && u.showOnLeaderboard && isIntern(u) &&
        u.totalPoints > target.totalPoints,
    ).length;

    return { userId: target._id, points: target.totalPoints, rank: ahead + 1 };
  },
});
