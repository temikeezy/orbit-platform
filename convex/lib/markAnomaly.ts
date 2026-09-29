/**
 * When a set of marks looks wrong rather than merely low.
 *
 * Extracted from the cron so it can be tested against the numbers that actually
 * happened. On 2026-09-07 twelve interns were marked at a mean of 8% because
 * their Google Docs links served a sign-in page to the assessor, which scored
 * the absence of visible work as failed work. Every score was confident and
 * every one was wrong; no error was raised anywhere, because nothing had
 * failed — the wrong thing had been read.
 *
 * The only signal that distinguished it from harsh marking was the SHAPE of the
 * distribution, so the shape is what these rules test.
 */

/** A whole task below this mean is more likely broken than badly done. */
export const OUTLIER_MEAN = 0.25;

/** Under this many marks, a low mean is a small sample, not a signal. */
export const OUTLIER_MIN_SAMPLE = 4;

/**
 * How far below the overall mean an evidence source may sit before it reads as
 * unreadable rather than weaker. Half is deliberately generous: a source really
 * can be worse (first-time GitHub users genuinely score lower than essayists),
 * and a rule that fires on ordinary variation gets muted like any other alarm.
 */
export const EVIDENCE_RATIO = 0.5;

export interface Bucket {
  /** Task title, or evidence host. */
  label: string;
  n: number;
  /** Mean fraction of available points, 0..1. */
  mean: number;
}

/** A task whose whole cohort scored near zero. */
export function taskLooksBroken(b: Bucket): boolean {
  return b.n >= OUTLIER_MIN_SAMPLE && b.mean <= OUTLIER_MEAN;
}

/**
 * An evidence source scoring far below every OTHER source.
 *
 * The baseline excludes the bucket being tested, and that is the whole point.
 * Comparing against an average the suspect bucket is part of makes the rule
 * weakest exactly where it matters most: if a marking failure is systemic, the
 * bad marks dominate the average and drag the threshold down below themselves.
 *
 * Concretely — 90 marks at 10% against 10 at 60% gives an all-in mean of 15%,
 * so the 10% bucket is not "below half" and never flags. The rule would have
 * caught the twelve-intern Google failure (a small bucket against a healthy
 * average) and silently missed the version of it that hit most of the cohort.
 *
 * `othersN`/`othersMean` describe every mark NOT in this bucket. With no other
 * evidence to compare against there is no comparison to make, so it returns
 * false rather than inventing a baseline.
 */
export function evidenceLooksUnreadable(
  b: Bucket,
  others: { n: number; mean: number },
): boolean {
  if (b.n < OUTLIER_MIN_SAMPLE) return false;
  if (others.n === 0) return false;
  return b.mean < others.mean * EVIDENCE_RATIO;
}
