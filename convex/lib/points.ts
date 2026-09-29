import { MutationCtx } from '../_generated/server';
import { Id } from '../_generated/dataModel';
import { isIntern } from './internProfile';
import { levelForPoints } from '../levels';
import { internal } from '../_generated/api';

/**
 * The single place points are awarded.
 *
 * On Supabase this was three separate, non-transactional calls issued from the
 * BROWSER (`src/lib/api/tasks.ts:385,403,412`): update the submission, insert a
 * ledger row, then `rpc('increment_user_points')`. Any of the three could fail
 * independently, leaving a submission approved with no points, or a ledger entry
 * whose total was never applied — and the caller checked none of the results.
 *
 * Here it is one mutation. Ledger, total and level move together or not at all.
 *
 * NOTE: this does NOT re-evaluate badges — callers must invoke
 * badges.checkAndAward themselves. An earlier version of this comment claimed it
 * did, which is exactly how a future caller ends up silently skipping badges.
 */
export async function awardPoints(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>;
    points: number;
    reason: string;
    referenceId?: string;
    referenceType?: string;
    createdBy: Id<'users'>;
  },
): Promise<{ awarded: number; newTotal: number; newLevel: number; leveledUp: boolean }> {
  const user = await ctx.db.get(args.userId);
  if (!user) throw new Error('User not found');

  /**
   * SCORES BELONG TO INTERNS. Staff run the programme; they are not in it.
   *
   * Tasks are for interns and staff review them, so a score on a supervisor's
   * account can only have come from somewhere it should not have — and once
   * there it puts them on the leaderboard, gives them a level and a progress
   * bar, and quietly competes with the people the programme is for.
   *
   * Returns the account's existing figures rather than throwing: the callers
   * are review and badge paths in the middle of doing something else, and
   * failing a submission review because the reviewer turned out to be staff
   * would break the review, not protect the score.
   */
  if (!isIntern(user)) {
    return {
      awarded: 0,
      newTotal: user.totalPoints,
      newLevel: user.currentLevel,
      leveledUp: false,
    };
  }

  const now = Date.now();

  await ctx.db.insert('pointsLedger', {
    userId: args.userId,
    points: args.points,
    reason: args.reason,
    referenceId: args.referenceId,
    referenceType: args.referenceType,
    createdBy: args.createdBy,
    isDummy: false,
    createdAt: now,
  });

  // Recomputed from the ledger rather than incremented. An increment drifts
  // permanently the moment one write is lost or replayed; a sum cannot.
  const ledger = await ctx.db
    .query('pointsLedger')
    .withIndex('by_user', (q) => q.eq('userId', args.userId))
    .collect();

  const newTotal = ledger.reduce((sum, e) => sum + e.points, 0);

  const levels = await ctx.db.query('levels').withIndex('by_levelNumber').collect();
  const newLevel = levelForPoints(levels, newTotal);

  await ctx.db.patch(args.userId, {
    totalPoints: newTotal,
    currentLevel: newLevel,
    updatedAt: now,
  });

  const leveledUp = newLevel > user.currentLevel;

  /**
   * Scheduled, not awaited inline.
   *
   * The notification writes a row and queues an email, and this function sits
   * inside submission review and badge awarding — paths that must not fail
   * because a congratulation could not be composed. Scheduling puts it in its
   * own transaction, so a level-up that cannot be announced still counts.
   *
   * Fires only on an increase. `recomputeUserPoints` and `withdrawAssessment`
   * both move levels DOWN when a mark is corrected, and telling somebody they
   * have reached a level they just lost is the one message worse than silence.
   */
  if (leveledUp) {
    await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyLevelUp, {
      userId: args.userId,
      newLevel,
    });
  }

  return {
    awarded: args.points,
    newTotal,
    newLevel,
    leveledUp,
  };
}

/**
 * Recomputes a user's total and level from the ledger without adding anything.
 * Used to repair drift and after any ledger correction.
 */
export async function recomputeUserPoints(
  ctx: MutationCtx,
  userId: Id<'users'>,
): Promise<{ total: number; level: number }> {
  const ledger = await ctx.db
    .query('pointsLedger')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();

  const total = ledger.reduce((sum, e) => sum + e.points, 0);
  const levels = await ctx.db.query('levels').withIndex('by_levelNumber').collect();
  const level = levelForPoints(levels, total);

  await ctx.db.patch(userId, { totalPoints: total, currentLevel: level, updatedAt: Date.now() });
  return { total, level };
}
