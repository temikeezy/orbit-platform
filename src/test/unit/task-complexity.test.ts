import { describe, it, expect } from 'vitest';
import {
  pointsFor,
  suggestPoints,
  SCOPE,
  MATURITY,
  SKILL,
  CHECKABLE,
} from '../../../convex/lib/taskComplexity';
import { TASK_POINTS } from '../../../convex/lib/input';

/**
 * The complexity rubric.
 *
 * The point of writing it down was that the previous scheme had no rule behind
 * it — three buckets assigned by hand, which put a one-page summary of figures
 * supplied in the prompt at the same 20 as shipping a deployed product. These
 * tests pin the properties that make the rubric worth having: that it spans the
 * range, that its extremes land where the bank's extremes actually are, and
 * that a caller cannot produce a task the server would then refuse.
 */
describe('pointsFor', () => {
  it('reaches the ceiling only for a full-week delivery-grade build', () => {
    expect(
      pointsFor({
        scope: SCOPE.week,
        maturity: MATURITY.delivery,
        skill: SKILL.advanced,
        checkable: CHECKABLE.falsifiable,
      }),
    ).toBe(TASK_POINTS.max);
  });

  it('lands a reflective piece near the floor', () => {
    // "Summarise your own week in one page" — the lightest shape in the bank.
    expect(
      pointsFor({
        scope: SCOPE.small,
        maturity: MATURITY.analysis,
        skill: SKILL.none,
        checkable: CHECKABLE.coherence,
      }),
    ).toBe(4);
  });

  it('never returns a value the server would reject', () => {
    // `tasks.create` validates against TASK_POINTS and throws — a suggestion
    // outside the bound would surface to the author as a validation error they
    // cannot act on, so this clamps rather than trusting its inputs.
    expect(pointsFor({ scope: 99, maturity: 99, skill: 99, checkable: 99 })).toBe(TASK_POINTS.max);
    expect(pointsFor({ scope: -5, maturity: -5, skill: 0, checkable: 0 })).toBe(TASK_POINTS.min);
  });

  it('does not pay for publication over substance', () => {
    /**
     * The defect the rubric was revised to remove. A trivial deployed page used
     * to outrank a rigorous engineering design, because the old ladder reserved
     * its top band for "live URL" and separately paid for hosting friction.
     */
    const trivialButDeployed = pointsFor({
      scope: SCOPE.modest,
      maturity: MATURITY.delivery,
      skill: SKILL.familiar,
      checkable: CHECKABLE.coherence,
    });
    const rigorousOnPaper = pointsFor({
      scope: SCOPE.heavy,
      maturity: MATURITY.document,
      skill: SKILL.advanced,
      checkable: CHECKABLE.itemised,
    });
    expect(rigorousOnPaper).toBeGreaterThan(trivialButDeployed);
  });

  it('lets non-software work reach delivery grade', () => {
    // A tracker a stranger can run is delivery-grade without any deploy —
    // the whole reason maturity is publication-neutral.
    const tracker = pointsFor({
      scope: SCOPE.substantial,
      maturity: MATURITY.delivery,
      skill: SKILL.familiar,
      checkable: CHECKABLE.falsifiable,
    });
    expect(tracker).toBe(13);
  });
});

describe('suggestPoints', () => {
  it('recognises a full-week deployed build', () => {
    const s = suggestPoints({
      description:
        'Build something small in a week and put it in front of one real user. It must be reachable at a URL with a README and three checks that prove it works.',
      submissionType: 'link',
    });
    expect(s.points).toBeGreaterThanOrEqual(18);
    expect(s.confident).toBe(true);
    expect(s.support).toContain('hosting');
  });

  it('keeps a reflective task low', () => {
    const s = suggestPoints({
      description: 'Summarise your own week in one page: what you did, what stalled, what you need.',
      submissionType: 'text',
    });
    expect(s.points).toBeLessThanOrEqual(8);
  });

  it('admits when it is guessing', () => {
    /**
     * Load-bearing honesty. Nothing can read intent out of prose reliably, so
     * an unremarkable description lands on the median shape — and the caller is
     * told that, rather than being handed a confident-looking number.
     */
    const s = suggestPoints({
      description: 'Do some work related to your stream and write it up.',
      submissionType: 'text',
    });
    expect(s.confident).toBe(false);
    expect(s.points).toBeGreaterThanOrEqual(TASK_POINTS.min);
    expect(s.points).toBeLessThanOrEqual(TASK_POINTS.max);
  });

  it('flags bandwidth needs without paying for them', () => {
    /**
     * The two descriptions must differ ONLY in the upload. An earlier version
     * of this test compared "shoot and edit" against "produce", which is not
     * the same work — "edit" implies a practiced craft and legitimately scores
     * higher. That made the test look like a bandwidth premium when it was
     * measuring skill.
     */
    const a = suggestPoints({
      description: 'Shoot and edit a 30-second reel, then upload it.',
      submissionType: 'link',
    });
    const b = suggestPoints({
      description: 'Shoot and edit a 30-second reel.',
      submissionType: 'link',
    });
    // The support need is recorded...
    expect(a.support).toContain('bandwidth');
    // ...but buys no points over the same work without the upload.
    expect(a.points).toBe(b.points);
  });

  it('always suggests something the server will accept', () => {
    for (const description of ['', 'x', 'deploy '.repeat(50), 'cite '.repeat(50)]) {
      const s = suggestPoints({ description, submissionType: 'text' });
      expect(s.points).toBeGreaterThanOrEqual(TASK_POINTS.min);
      expect(s.points).toBeLessThanOrEqual(TASK_POINTS.max);
      expect(Number.isInteger(s.points)).toBe(true);
    }
  });
});
