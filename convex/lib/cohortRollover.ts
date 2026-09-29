/**
 * The cohort calendar, kept without anyone keeping it.
 *
 * ORBIT's only cohort ("ORBIT 2.0") ends on 2026-11-06, and everything keys off
 * the newest ACTIVE cohort: task creation (lib/taskProgramme.ts), enrolment on
 * conversion (lib/internProfile.ts), attendance and reminders (scheduled.ts).
 * Before this, the day after an end date nobody extended, the platform would
 * have stopped creating tasks and every new admission would have sat in
 * "No cohort to enrol into" for ever. So the agent runs the calendar:
 *
 *   - OPEN: 21 days before the newest active cohort ends, if nothing follows
 *     it, create the next as a DRAFT — starting the Monday after, the same
 *     length, the same weekly rhythm. Draft, not active, because
 *     `selectCurrentTaskProgramme` picks the newest active cohort even before
 *     it has started, which would block tasks for everyone in between.
 *   - ACTIVATE: a draft whose start date has arrived becomes active.
 *   - COMPLETE: an active cohort past its end date is completed — once its
 *     successor has started, never before, so there is always an active one.
 *
 * Pure, so the whole calendar is testable without a database.
 */

export interface CohortLike {
  id: string;
  name: string;
  status: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  /** Opened by the agent. Only these are ever activated automatically. */
  byAgent?: boolean;
}

export interface CohortPlan {
  create: { name: string; startDate: string; endDate: string; copyFrom: string } | null;
  activate: string[];
  complete: string[];
}

export const OPEN_BEFORE_DAYS = 21;
const DAY = 86_400_000;

function toMs(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function toDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first Monday strictly after `d`. */
export function mondayAfter(d: string): string {
  let ms = toMs(d) + DAY;
  while (new Date(ms).getUTCDay() !== 1) ms += DAY;
  return toDate(ms);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function planCohorts(cohorts: readonly CohortLike[], today: string): CohortPlan {
  // Only drafts the agent opened. An old, forgotten draft someone made by hand
  // would otherwise become the active — possibly the newest — cohort overnight.
  const activate = cohorts
    .filter((c) => c.status === 'draft' && c.byAgent && c.startDate <= today)
    .map((c) => c.id);
  const activating = new Set(activate);

  /**
   * An ended cohort completes only once a SUCCESSOR HAS STARTED. Completing on
   * the day after the end date left every rollover weekend (Friday end, Monday
   * start) with no active cohort: the Saturday task seeding refused, and any
   * other long-lived active cohort would have silently become "current" and
   * taken the weekend's admissions for good.
   */
  const complete = cohorts
    .filter((c) => c.status === 'active' && c.endDate < today)
    .filter((c) =>
      cohorts.some(
        (n) =>
          n.id !== c.id &&
          n.startDate > c.startDate &&
          n.startDate <= today &&
          (n.status === 'active' || activating.has(n.id)),
      ),
    )
    .map((c) => c.id);

  const live = cohorts
    .filter((c) => c.status === 'active' || c.status === 'draft')
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const newest = live[0];

  let create: CohortPlan['create'] = null;
  if (newest && newest.status === 'active') {
    const daysLeft = (toMs(newest.endDate) - toMs(today)) / DAY;
    if (daysLeft <= OPEN_BEFORE_DAYS) {
      const startDate = mondayAfter(newest.endDate);
      const length = Math.max(28 * DAY, toMs(newest.endDate) - toMs(newest.startDate));
      const endDate = toDate(toMs(startDate) + length);
      const start = new Date(toMs(startDate));
      create = {
        name: `ORBIT ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
        startDate,
        endDate,
        copyFrom: newest.id,
      };
    }
  }
  return { create, activate, complete };
}

/**
 * The cohort a new admission should join: the incoming draft once the current
 * cohort has fewer than 14 days left, so nobody is enrolled into a cohort that
 * ends before they can do anything in it.
 */
export function cohortForNewAdmission(cohorts: readonly CohortLike[], today: string): string | null {
  const active = cohorts
    .filter((c) => c.status === 'active')
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const draft = cohorts
    .filter((c) => c.status === 'draft' && (!active || c.startDate > active.startDate))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (active && (toMs(active.endDate) - toMs(today)) / DAY >= 14) return active.id;
  return draft?.id ?? active?.id ?? null;
}
