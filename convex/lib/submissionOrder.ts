/**
 * How a reviewer's list of submissions is ordered.
 *
 * One rule, in one place, because getting it wrong is invisible. The review
 * screen reads through two different backends — `tasks.reviewQueue` for the
 * pending queue, `tasks.listSubmissions` for every other status filter — and
 * they disagreed for a while: the queue was fixed to order by `submittedAt`
 * while the filters still sorted on `createdAt`. Nothing failed. The list still
 * rendered, still looked complete, and simply left recently resubmitted work
 * off the end of it.
 *
 * PURE, and in lib/ so the rule can be asserted without a deployment. Same
 * reasoning as lib/acceptanceLetter.ts.
 */

/** The fields the ordering actually depends on. Anything wider is noise. */
export interface OrderableSubmission {
  createdAt: number;
  /** Optional in the schema: a draft that was never submitted has none. */
  submittedAt?: number;
}

/**
 * When a submission last asked for attention.
 *
 * `submittedAt`, not `createdAt`. Resubmission PATCHES the existing row rather
 * than inserting a new one — `submittedAt` moves, `createdAt` does not — so
 * work that was sent back for changes and then redone still carries the
 * creation time of its first attempt, sometimes weeks earlier. Ordering on that
 * puts the item a reviewer is most likely waiting for at the bottom of the
 * list, and past the row cap it drops off entirely: the intern redoes the work,
 * and the reviewer who asked for it never sees it come back.
 *
 * Falls back to `createdAt` so a never-submitted draft sorts by when it was
 * started rather than at the epoch.
 */
export function submissionRecency(submission: OrderableSubmission): number {
  return submission.submittedAt ?? submission.createdAt;
}

/**
 * Newest attention first.
 *
 * A comparator rather than a sorted copy, so callers keep control of when the
 * sort happens relative to their own filtering and capping.
 */
export function byMostRecentlySubmitted(
  a: OrderableSubmission,
  b: OrderableSubmission,
): number {
  return submissionRecency(b) - submissionRecency(a);
}
