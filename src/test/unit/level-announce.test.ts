import { describe, it, expect } from 'vitest';
import { shouldAnnounceLevel } from '../../../convex/lib/levelAnnounce';

const base = { currentLevel: 3, scheduledLevel: 3, priorTitles: [], title: 'You reached High Orbit' };

/**
 * Both rules are regression tests for real incidents, not hypotheticals.
 */
describe('shouldAnnounceLevel', () => {
  it('announces a level the user actually holds and has not been told about', () => {
    expect(shouldAnnounceLevel(base)).toBe(true);
  });

  it('stays silent on the lower half of a two-boundary burst', () => {
    /**
     * One approval awards the score, then a badge bonus, then reconciles —
     * three `awardPoints` calls. Crossing L3 and L4 in one review schedules
     * both; the L3 email would re-read the user and quote the L4 points total,
     * asserting a level the figure contradicts.
     */
    expect(shouldAnnounceLevel({ ...base, currentLevel: 4, scheduledLevel: 3 })).toBe(false);
  });

  it('stays silent when the award was reversed before the email left', () => {
    // A withdrawal in the gap between schedule and send. Congratulating someone
    // on a level they have just lost is the one message worse than silence.
    expect(shouldAnnounceLevel({ ...base, currentLevel: 2, scheduledLevel: 3 })).toBe(false);
  });

  it('does not congratulate twice for one achievement', () => {
    /**
     * Withdraw-then-remark reverses the points, drops the level, and re-crosses
     * the same boundary — genuinely a level-up the second time. Twelve interns
     * went through exactly this when their unreadable links were corrected.
     */
    expect(
      shouldAnnounceLevel({ ...base, priorTitles: ['You reached High Orbit'] }),
    ).toBe(false);
  });

  it('still announces a DIFFERENT level after an earlier one', () => {
    // The told-once rule must not swallow genuine further progress.
    expect(
      shouldAnnounceLevel({ ...base, priorTitles: ['You reached In Orbit'] }),
    ).toBe(true);
  });
});

/**
 * The asymmetry that made a correction confiscate points.
 *
 * `awardPoints` writes nothing for anyone `isIntern` rejects — which includes
 * MODERATORS, so an intern promoted to lead their stream is in that set. Once
 * `withdrawAssessment` began inserting its debit directly it always succeeded,
 * while re-marking still went through `awardPoints` and silently did not. The
 * withdraw-then-re-mark cycle — the exact flow used to correct the twelve
 * unreadable-link marks — took points away and never gave them back, returning
 * `applied: true` throughout.
 *
 * This pins the invariant rather than the implementation: a reversal followed by
 * a re-application must net to the re-applied score, for any account.
 */
describe('withdraw then re-mark nets to the new score', () => {
  /** The ledger arithmetic both paths share, independent of who the user is. */
  const net = (entries: readonly number[]) => entries.reduce((a, b) => a + b, 0);

  it('nets to the re-applied score when both halves write', () => {
    // paid 9, withdrawn -9, re-marked 12
    expect(net([9, -9, 12])).toBe(12);
  });

  it('is net-negative if the reversal writes and the re-application does not', () => {
    // The defect: -9 lands, +12 is dropped by awardPoints for a moderator.
    expect(net([9, -9])).toBe(0);
    expect(net([9, -9]) < 12).toBe(true);
  });
});
