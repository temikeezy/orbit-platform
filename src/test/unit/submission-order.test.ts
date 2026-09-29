import { describe, it, expect } from 'vitest';
import {
  byMostRecentlySubmitted,
  submissionRecency,
} from '../../../convex/lib/submissionOrder';

/**
 * The review list's ordering, pinned.
 *
 * This existed as a bug for as long as the review screen did, and it is the
 * kind that never announces itself: the list renders, the rows are real, and
 * the only symptom is that work sent back for changes and then redone is not in
 * it. It was caught by an e2e run against a deployment carrying hundreds of
 * submissions — which is precisely the condition that exposes it and precisely
 * the condition nobody reproduces by hand. Hence a unit test, so the rule holds
 * without needing a big enough database to notice.
 */

/** Weeks apart, so a wrong comparator cannot pass by coincidence. */
const OLD = Date.parse('2026-07-01T09:00:00Z');
const RECENT = Date.parse('2026-08-12T09:00:00Z');

describe('submissionRecency', () => {
  it('reports when the work was last submitted, not when it was started', () => {
    expect(submissionRecency({ createdAt: OLD, submittedAt: RECENT })).toBe(RECENT);
  });

  it('falls back to creation for a draft that was never submitted', () => {
    expect(submissionRecency({ createdAt: OLD })).toBe(OLD);
    expect(submissionRecency({ createdAt: OLD, submittedAt: undefined })).toBe(OLD);
  });
});

describe('byMostRecentlySubmitted', () => {
  /**
   * The case the whole rule exists for.
   *
   * A resubmission patches its row: `submittedAt` moves to now, `createdAt`
   * stays at the first attempt. Sorted on creation it lands beneath everything
   * filed since — and beneath the 200-row cap, which is the same as not
   * existing.
   */
  it('puts redone work above submissions filed after it was first created', () => {
    const redone = { createdAt: OLD, submittedAt: RECENT };
    const newerButUntouched = { createdAt: OLD + 86_400_000, submittedAt: OLD + 86_400_000 };

    expect([newerButUntouched, redone].sort(byMostRecentlySubmitted)[0]).toBe(redone);
  });

  it('orders a mixed list newest attention first', () => {
    const rows = [
      { createdAt: OLD, submittedAt: OLD },
      { createdAt: OLD, submittedAt: RECENT },
      { createdAt: RECENT - 1000 },
    ];

    expect(rows.sort(byMostRecentlySubmitted).map(submissionRecency)).toEqual([
      RECENT,
      RECENT - 1000,
      OLD,
    ]);
  });

  it('is a stable comparison for two submissions of the same age', () => {
    expect(byMostRecentlySubmitted({ createdAt: OLD }, { createdAt: OLD })).toBe(0);
  });
});
