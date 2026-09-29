import { query, mutation } from './_generated/server';
import { MutationCtx } from './_generated/server';
import { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { requireUser, requireAdmin } from './lib/auth';

/**
 * Levels.
 *
 * Level thresholds are public reference data — every user needs them to render
 * their own progress — so `list` is UNAUTHENTICATED, and takes no token at all.
 *
 * It used to declare `token: v.optional(v.string())` and never read it. That
 * argument was vestigial and was not a check, but it read as one to anyone
 * skimming — which is the precise failure mode
 * src/test/unit/convex-authz-surface.test.ts exists to catch. It was removed so
 * that rule can hold with NO exemptions: in this codebase, declaring a token now
 * means resolving it, always. Being genuinely public is expressed by taking no
 * token, which is honest and unmistakable.
 *
 * Listed in SECURITY.md alongside `infoForPoints` as deliberate. The CRUD
 * mutations are admin-only, matching orbit_create_level/update_level/
 * delete_level, which all called orbit_require_admin.
 */

function shape(l: {
  _id: string; levelNumber: number; name: string; description: string;
  pointsRequired: number; iconEmoji?: string; colorHex?: string;
}) {
  return {
    id: l._id,
    levelNumber: l.levelNumber,
    name: l.name,
    description: l.description,
    pointsRequired: l.pointsRequired,
    iconEmoji: l.iconEmoji,
    colorHex: l.colorHex,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const levels = await ctx.db.query('levels').withIndex('by_levelNumber').collect();
    return levels.sort((a, b) => a.levelNumber - b.levelNumber).map(shape);
  },
});

/**
 * Level for a given point total, plus progress toward the next one.
 *
 * Computed from the ladder rather than read from users.currentLevel, so a stale
 * denormalised value cannot make the UI disagree with the ledger. That drift is
 * one of the things this migration is meant to eliminate.
 */
export const infoForPoints = query({
  args: { points: v.number() },
  handler: async (ctx, { points }) => {
    const levels = (await ctx.db.query('levels').withIndex('by_levelNumber').collect())
      .sort((a, b) => a.levelNumber - b.levelNumber);

    if (levels.length === 0) return null;

    let current = levels[0];
    for (const l of levels) if (points >= l.pointsRequired) current = l;

    const next = levels.find((l) => l.levelNumber === current.levelNumber + 1) ?? null;

    const span = next ? next.pointsRequired - current.pointsRequired : 0;
    const gained = points - current.pointsRequired;

    return {
      current: shape(current),
      next: next ? shape(next) : null,
      pointsIntoLevel: gained,
      pointsToNext: next ? Math.max(0, next.pointsRequired - points) : 0,
      progressPercent: next && span > 0 ? Math.min(100, Math.round((gained / span) * 100)) : 100,
    };
  },
});

/** Level number for a point total. Used by mutations that recompute a user. */
export function levelForPoints(
  levels: Array<{ levelNumber: number; pointsRequired: number }>,
  points: number,
): number {
  let n = 1;
  for (const l of levels.sort((a, b) => a.levelNumber - b.levelNumber)) {
    if (points >= l.pointsRequired) n = l.levelNumber;
  }
  return n;
}


/**
 * The ladder must stay monotonic: level N+1 requires more points than level N.
 *
 * `levelForPoints` walks the ladder and takes the highest level whose threshold
 * a total clears. A ladder where level 4 needs fewer points than level 3 makes
 * that walk skip a level for some totals and not others — every user's rank
 * becomes a function of iteration order.
 *
 * The client checked this before calling; the server did not, so anything that
 * was not that one form could break it.
 */
async function ordersCorrectly(
  ctx: MutationCtx,
  levelNumber: number,
  pointsRequired: number,
  ignoreId?: Id<'levels'>,
): Promise<string | null> {
  const levels = (await ctx.db.query('levels').withIndex('by_levelNumber').collect())
    .filter((l) => l._id !== ignoreId)
    .sort((a, b) => a.levelNumber - b.levelNumber);

  const below = levels.filter((l) => l.levelNumber < levelNumber).pop();
  const above = levels.find((l) => l.levelNumber > levelNumber);

  if (below && pointsRequired < below.pointsRequired) {
    return `Level ${levelNumber} must require at least ${below.pointsRequired} points, ` +
      `the threshold for level ${below.levelNumber}.`;
  }
  if (above && pointsRequired > above.pointsRequired) {
    return `Level ${levelNumber} must require at most ${above.pointsRequired} points, ` +
      `the threshold for level ${above.levelNumber}.`;
  }
  return null;
}

export const create = mutation({
  args: {
    token: v.string(),
    levelNumber: v.number(),
    name: v.string(),
    description: v.string(),
    pointsRequired: v.number(),
    iconEmoji: v.optional(v.string()),
    colorHex: v.optional(v.string()),
  },
  handler: async (ctx, { token, ...fields }) => {
    await requireAdmin(ctx, token);

    const clash = await ctx.db
      .query('levels')
      .withIndex('by_levelNumber', (q) => q.eq('levelNumber', fields.levelNumber))
      .first();

    // Convex has no unique constraints, so the check has to be explicit. Two
    // levels sharing a number would make levelForPoints non-deterministic.
    if (clash) {
      return { success: false as const, error: `Level ${fields.levelNumber} already exists.` };
    }

    const disorder = await ordersCorrectly(ctx, fields.levelNumber, fields.pointsRequired);
    if (disorder) return { success: false as const, error: disorder };

    const id = await ctx.db.insert('levels', { ...fields, createdAt: Date.now() });
    return { success: true as const, id };
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    id: v.id('levels'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    pointsRequired: v.optional(v.number()),
    iconEmoji: v.optional(v.string()),
    colorHex: v.optional(v.string()),
  },
  handler: async (ctx, { token, id, ...patch }) => {
    await requireAdmin(ctx, token);

    const existing = await ctx.db.get(id);
    if (!existing) return { success: false as const, error: 'Level not found' };

    if (patch.pointsRequired !== undefined) {
      const disorder = await ordersCorrectly(ctx, existing.levelNumber, patch.pointsRequired, id);
      if (disorder) return { success: false as const, error: disorder };
    }

    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await ctx.db.patch(id, clean);
    return { success: true as const };
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id('levels') },
  handler: async (ctx, { token, id }) => {
    await requireAdmin(ctx, token);

    const levels = await ctx.db.query('levels').collect();
    // Deleting the last level would leave levelForPoints with nothing to resolve
    // against and every user unrankable.
    if (levels.length <= 1) {
      return { success: false as const, error: 'Cannot delete the only level.' };
    }

    await ctx.db.delete(id);
    return { success: true as const };
  },
});

/** Admin listing — same data, but actually requires the role its name claims. */
export const listForAdmin = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);
    await requireUser(ctx, token);
    const levels = await ctx.db.query('levels').withIndex('by_levelNumber').collect();
    return levels.sort((a, b) => a.levelNumber - b.levelNumber).map(shape);
  },
});
