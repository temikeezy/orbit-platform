/**
 * Whether a level-up is worth announcing.
 *
 * Extracted from `notifyLevelUp` so the two rules can be tested, because both
 * exist because of something that actually happened rather than something
 * imagined.
 *
 * The notification is SCHEDULED by `awardPoints` and runs in a later
 * transaction, which is where both problems come from.
 */

export interface LevelAnnounceInput {
  /** The level the user holds right now, read at send time. */
  currentLevel: number;
  /** The level that was crossed when this was scheduled. */
  scheduledLevel: number;
  /** Titles of level-up notifications this user has already received. */
  priorTitles: readonly string[];
  /** The title this announcement would carry. */
  title: string;
}

export function shouldAnnounceLevel(input: LevelAnnounceInput): boolean {
  /**
   * One review calls `awardPoints` up to three times — score, badge bonus, then
   * reconciliation — so a single approval can cross two boundaries and schedule
   * an announcement for each. Every one re-reads the user for its points figure,
   * so the lower announcement would quote the higher total and contradict
   * itself. A withdrawal landing in the same gap drops the level before the
   * email leaves, which would congratulate somebody on a level they just lost.
   */
  if (input.currentLevel !== input.scheduledLevel) return false;

  /**
   * Withdrawing a mark and re-applying it reverses the points, drops the level,
   * then re-crosses the same boundary — so the second crossing is legitimately a
   * level-up and would send the same congratulation twice for one achievement.
   * This happened to twelve interns whose links could not be opened and nine
   * more sent back for re-review.
   */
  if (input.priorTitles.includes(input.title)) return false;

  return true;
}
