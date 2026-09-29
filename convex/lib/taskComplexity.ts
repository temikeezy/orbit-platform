import { TASK_POINTS } from './input';

/**
 * What a task is worth, from what it asks for.
 *
 * WHY THIS EXISTS. The seeded bank was priced in three buckets — 10, 15 and 20 —
 * assigned by hand with no rule behind them. It put "write the post-event
 * report", whose every figure is supplied in the prompt, at the same 20 as
 * shipping a deployed product; and "explain your stack choice", a reflective
 * paragraph, at the same 10 as documenting a runnable process. Points that do
 * not track work make a leaderboard that does not either.
 *
 * The rubric below is the one a scoring pass settled on after review. It is
 * written down, and applied by code, so that a task written next month is
 * priced the same way as one written today — and so that a supervisor who
 * disagrees is disagreeing with something stated rather than with a number
 * somebody picked.
 *
 * SCORE = E + M + S + V, bounded to TASK_POINTS (1..20). The ranges ARE the
 * weights and are deliberately unequal: scope carries roughly 45% of the
 * ceiling, maturity and checkable correctness 20% each, assumed skill 15%.
 *
 * WHAT IS DELIBERATELY NOT HERE. An earlier draft added a fifth dimension for
 * "access and friction" — hosting accounts, upload bandwidth, a dev machine.
 * It was dropped because it paid an intern MORE for having worse internet,
 * which inverts the fairness argument used to justify it, and because render
 * and upload time is already scope and deployment skill is already skill.
 * Those needs are real, so they are recorded as `support` below and used to
 * decide who gets a data stipend or device time — never to buy points.
 *
 * PUBLICATION IS NOT MATURITY. The same draft scored anything with a live URL
 * above everything without one, so a trivial deployed page outranked a rigorous
 * test plan or a network design. `M` now asks whether a stranger could use the
 * thing without the author in the room, which a spreadsheet or a publish-ready
 * asset set can satisfy as well as a website.
 */

/** Scope of work. Anchored to what the task demands, not to hours claimed. */
export const SCOPE = {
  /** One short piece, a single sitting. */
  minimal: 1,
  /** One small deliverable, single component. */
  small: 2,
  /** One deliverable with two or three components, or modest research. */
  modest: 3,
  /** Multi-component, or a sustained research burden. */
  substantial: 4,
  /** Multi-component plus an execution or production cycle. */
  executed: 5,
  /** Broad multi-part deliverable with heavy research or production. */
  heavy: 6,
  /** A multi-day build. */
  multiDay: 7,
  /** A several-day project. */
  project: 8,
  /** A full-week arc. */
  week: 9,
} as const;

/**
 * Artifact maturity. PUBLICATION-NEUTRAL — the test is "could this be used
 * tomorrow without its author present", not "is it on the internet".
 */
export const MATURITY = {
  /** Reflection or opinion on one's own experience. No artifact. */
  reflection: 0,
  /** Analysis or synthesis prose: critique, summary, fact-check, essay. */
  analysis: 1,
  /** A structured working document: plan, spec, rubric, budget, storyboard. */
  document: 2,
  /** Executed or crafted work: an executed audit, a finished design, a draft tool. */
  crafted: 3,
  /** Delivery-grade: complete to a stated spec and operable by a third party. */
  delivery: 4,
} as const;

/** Prior skill the task assumes of someone in that stream. */
export const SKILL = {
  /** Any careful, literate person. */
  none: 0,
  /** First-month familiarity with the stream. */
  familiar: 1,
  /** A practiced craft — design tools, editing, test technique, debugging. */
  practiced: 2,
  /** Advanced for this cohort — deployment, capacity engineering, deep audit. */
  advanced: 3,
} as const;

/**
 * How independently checkable the submission's correctness is.
 *
 * Rewarding this is deliberate: work a grader can verify cannot be blagged, and
 * a reviewer with forty submissions and an afternoon needs the difference.
 * Execution alone does NOT earn the top band — stating the checks does.
 */
export const CHECKABLE = {
  /** Plausibility only. */
  none: 0,
  /** Internal coherence only. */
  coherence: 1,
  /** Key claims spot-checkable against external evidence. */
  spotCheck: 2,
  /** Itemised: every claim traceable, every price dated, every step followable. */
  itemised: 3,
  /** States pass/fail checks a grader can run directly against the artifact. */
  falsifiable: 4,
} as const;

export interface ComplexityVector {
  scope: number;
  maturity: number;
  skill: number;
  checkable: number;
}

/** Recorded, never scored — who needs a data stipend or device time. */
export type SupportNeed = 'hosting' | 'bandwidth' | 'devEnvironment';

/**
 * The points a task is worth.
 *
 * Clamped to TASK_POINTS rather than trusted: the dimensions are bounded by
 * construction, but a caller assembling a vector by hand can still hand this
 * something out of range, and `tasks.create` would then reject the task outright
 * with a validation error the author cannot act on.
 */
export function pointsFor(v: ComplexityVector): number {
  const raw = v.scope + v.maturity + v.skill + v.checkable;
  return Math.min(Math.max(Math.round(raw), TASK_POINTS.min), TASK_POINTS.max);
}

/**
 * A rough score for a task written by hand, from its own words.
 *
 * A FLOOR, NOT A VERDICT. Nobody can read intent out of a description reliably,
 * and this does not try: it looks for the few signals that are unambiguous when
 * present — a deliverable that must run, evidence that must be cited, a build
 * that must be deployed — and otherwise lands on the modest middle the bank's
 * median already occupies. The number is a starting point a supervisor edits,
 * which is why `tasks.update` accepts points and why editing them reconciles
 * anyone already scored.
 *
 * Deliberately conservative. Guessing high inflates the leaderboard on the
 * strength of a keyword; guessing low costs an edit.
 */
export function suggestPoints(input: { description: string; submissionType: string }): {
  points: number;
  vector: ComplexityVector;
  support: SupportNeed[];
  confident: boolean;
} {
  const d = input.description.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => d.includes(n));

  // Scope: only two signals are safe to read — an explicit week, and an
  // explicit build. Everything else defaults to the bank's median shape.
  const scope = has('in a week', 'over a week', 'full week')
    ? SCOPE.week
    : has('build and deploy', 'deploy', 'reachable at a url', 'live url')
      ? SCOPE.multiDay
      : has('build', 'produce', 'shoot', 'edit', 'execute it', 'then execute')
        ? SCOPE.executed
        : SCOPE.modest;

  const maturity = has('reachable at a url', 'live url', 'usable by someone', 'someone who did not build it')
    ? MATURITY.delivery
    : has('build', 'produce', 'shoot', 'render', 'execute')
      ? MATURITY.crafted
      : has('plan', 'rubric', 'budget', 'storyboard', 'checklist', 'test cases', 'process')
        ? MATURITY.document
        : has('explain', 'argue', 'critique', 'summarise', 'reflect')
          ? MATURITY.analysis
          : MATURITY.analysis;

  const skill = has('deploy', 'accessibility audit', 'capacity', 'redundancy', 'failover')
    ? SKILL.advanced
    : has('debug', 'reproduce', 'test case', 'animate', 'edit', 'design')
      ? SKILL.practiced
      : SKILL.familiar;

  const checkable = has('checks', 'pass/fail', 'reproduce the', 'steps that reproduce')
    ? CHECKABLE.falsifiable
    : has('cite', 'cited', 'source', 'dated', 'evidence')
      ? CHECKABLE.itemised
      : has('against the', 'compare')
        ? CHECKABLE.spotCheck
        : CHECKABLE.coherence;

  const support: SupportNeed[] = [];
  if (has('deploy', 'live url', 'reachable at a url')) support.push('hosting');
  if (has('shoot', 'render', 'upload', 'video', 'reel', 'animate')) support.push('bandwidth');
  if (has('clone', 'run the project', 'environment', 'repository')) support.push('devEnvironment');

  const vector = { scope, maturity, skill, checkable };

  return {
    points: pointsFor(vector),
    vector,
    support,
    // Only claimed where a decisive signal was actually found. Anything else is
    // the default middle wearing a number, and the caller should be told so.
    confident: has(
      'in a week', 'deploy', 'live url', 'reachable at a url',
      'cite', 'cited', 'checks', 'pass/fail',
    ),
  };
}
