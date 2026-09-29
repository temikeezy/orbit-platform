import { describe, it, expect } from 'vitest';
import {
  taskLooksBroken,
  evidenceLooksUnreadable,
  OUTLIER_MIN_SAMPLE,
} from '../../../convex/lib/markAnomaly';

/**
 * The check that was missing on the day it was needed.
 *
 * These are regression tests in the literal sense: the first case is the real
 * distribution from 2026-09-07, when twelve interns were told they had failed
 * because the assessor read a Google sign-in page instead of their work. If
 * this rule had been running, it would have said so on day one.
 */
describe('mark anomaly detection', () => {
  it('catches the Google Docs failure that actually happened', () => {
    // The real numbers: 12 marks averaging 8%, against 59% everywhere else.
    const googleLinks = { label: 'docs.google.com', n: 12, mean: 0.08 };
    expect(evidenceLooksUnreadable(googleLinks, { n: 500, mean: 0.59 })).toBe(true);
    expect(taskLooksBroken(googleLinks)).toBe(true);
  });

  it('leaves genuinely harsh marking alone', () => {
    // The worst real task on prod: 53% across 14 submissions. Low, and correct.
    expect(taskLooksBroken({ label: 'Ship something small end to end', n: 14, mean: 0.53 })).toBe(
      false,
    );
    expect(
      evidenceLooksUnreadable({ label: 'github.com', n: 30, mean: 0.62 }, { n: 400, mean: 0.73 }),
    ).toBe(false);
  });

  it('does not fire on a source that is merely weaker', () => {
    /**
     * Load-bearing. First-time GitHub users really do score below essayists,
     * and a rule that flags ordinary variation gets ignored like any alarm that
     * cries wolf — including on the day it is right.
     */
    expect(
      evidenceLooksUnreadable({ label: 'github.com', n: 20, mean: 0.5 }, { n: 400, mean: 0.73 }),
    ).toBe(false);
  });

  it('refuses to judge a sample too small to mean anything', () => {
    // Two people scoring 10% is two people having a bad week.
    const tiny = { label: 'Storyboard a short lesson', n: OUTLIER_MIN_SAMPLE - 1, mean: 0.1 };
    expect(taskLooksBroken(tiny)).toBe(false);
    expect(evidenceLooksUnreadable(tiny, { n: 400, mean: 0.73 })).toBe(false);
  });

  it('fires the moment the sample is large enough to trust', () => {
    const atThreshold = { label: 'drive.google.com', n: OUTLIER_MIN_SAMPLE, mean: 0.1 };
    expect(taskLooksBroken(atThreshold)).toBe(true);
  });

  it('catches a SYSTEMIC failure, where the bad marks are the majority', () => {
    /**
     * The case the first version of this rule missed, and the one that matters
     * most. When a marking failure hits most of the cohort, an all-in average is
     * dragged down by the very marks under suspicion: 90 marks at 10% against 10
     * at 60% averages 15%, so 10% is not "below half" and nothing flags.
     *
     * The baseline is therefore every mark NOT in the bucket being tested.
     */
    expect(
      evidenceLooksUnreadable({ label: 'docs.google.com', n: 90, mean: 0.1 }, { n: 10, mean: 0.6 }),
    ).toBe(true);
  });

  it('makes no comparison when there is nothing to compare against', () => {
    // Every mark came from one source. There is no "everywhere else".
    expect(
      evidenceLooksUnreadable({ label: 'file', n: 40, mean: 0.05 }, { n: 0, mean: 0 }),
    ).toBe(false);
  });
});
