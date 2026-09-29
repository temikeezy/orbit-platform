/**
 * The agent era's start. The absolute safety net below counts from here rather
 * than from submission, because on the day the fallback was armed the backlog
 * held work weeks old that the agent had never been given a chance to read —
 * measuring from `submittedAt` would have paid all of it in full on the first
 * run, which is exactly the "score = who submitted" outcome the fallback's
 * design exists to avoid.
 */
export const AGENT_ERA_START = Date.UTC(2026, 8, 29);

/** However the runner is doing, nothing waits longer than this for a mark. */
export const ABSOLUTE_SETTLE_MS = 14 * 24 * 60 * 60 * 1000;

/** Outcomes the fallback settles once their window has passed. */
const SET_ASIDE = new Set(['contested', 'unreadable', 'unsupported', 'anomaly']);

/**
 * Whether the scheduled fallback may settle a submission.
 *
 * Two routes, and the split is what keeps points meaning something:
 *  - The agent TRIED and set it aside (its readers disagreed, could not read
 *    it, or it is a format nothing here reads) and five days have passed SINCE
 *    IT WAS SET ASIDE. Counting from the set-aside, not from submission, is
 *    what gives a reshare prompt time to work: on the day this was armed every
 *    row in the backlog was already older than five days, and counting from
 *    submission would have paid each one within hours of its first set-aside.
 *  - Or it has waited two weeks no matter what — the runner is a machine that
 *    can be switched off, and an outage must delay marks, not strand them.
 *
 * NEVER `empty`. A note with no work in it ("done, please check") is not an
 * unreadable submission, it is no submission, and paying it in full would make
 * the cheapest possible entry worth more than honest work marked on its merits.
 * The intern is told and can resubmit; nothing settles it.
 */
export function settledByFallback(
  outcome: string | undefined,
  submittedAt: number,
  setAsideSince: number | undefined,
  cutoff: number,
  now: number,
): boolean {
  if (outcome === 'empty') return false;
  if (outcome && SET_ASIDE.has(outcome) && Math.max(submittedAt, setAsideSince ?? now) < cutoff) {
    return true;
  }
  return now - Math.max(submittedAt, AGENT_ERA_START) > ABSOLUTE_SETTLE_MS;
}

/**
 * What the intern is told when the window closes with no mark.
 *
 * Says WHY in plain words. "Not reviewed" and "our markers could not open your
 * file" are different facts, and the second one tells the intern what to do
 * differently next time.
 */
export function autoApprovalFeedback(outcome: string | undefined): string {
  const tail =
    'ORBIT has awarded the full points rather than leave your work waiting. ' +
    'It has not been individually assessed.';
  if (outcome === 'unreadable' || outcome === 'unsupported') {
    return (
      "Approved automatically. ORBIT's markers could not open or read this submission, " +
      'and it was not reshared within the window, so ' + tail +
      ' Next time, submit a PDF, a plain document, or a link anyone can open.'
    );
  }
  if (outcome === 'anomaly') {
    return (
      'Approved automatically. An earlier automatic mark for this work looked wrong ' +
      "alongside others for the same task, so it was withdrawn rather than left to stand, and " + tail
    );
  }
  if (outcome === 'contested') {
    return (
      "Approved automatically. ORBIT's independent markers could not agree on a score " +
      'for this submission, so ' + tail
    );
  }
  return 'Approved automatically. This was not marked within the review window, so ' + tail;
}
