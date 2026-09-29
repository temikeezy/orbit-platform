import { Doc } from '../_generated/dataModel';
import { WAT_OFFSET_MS } from './datetime';

/**
 * The programme's weekly clock.
 *
 * Cohort 1 runs a fixed rhythm: stream leads set tasks Monday, participants
 * work and log Tuesday to Thursday, deliverables and the weekly summary are due
 * Thursday, and leads review and sign off Friday so everyone starts the next
 * week with clear standing.
 *
 * None of that existed in the data model. `cohorts` carried `dailyLogsRequired`,
 * `weeklySummaryRequired` and `signoffRequired` — booleans for *whether*, never
 * for *when* — so nothing in the platform knew a weekly summary was due at all,
 * nothing could be late, and no reminder could be sent for it.
 *
 * Pure functions, no `ctx`. That is deliberate: the Convex modules under
 * `convex/` are not covered by the vitest config, but a plain module here can be
 * imported directly by a test, which is the only way any of this date maths gets
 * exercised.
 */

/** Sunday = 0, matching `getUTCDay()`, `users.physicalDay` and `cohorts.defaultPhysicalDay`. */
export const DEFAULT_WEEKLY_SUMMARY_DUE_DAY = 4; // Thursday
export const DEFAULT_WEEKLY_SUMMARY_DUE_HOUR_WAT = 23;
export const DEFAULT_SIGNOFF_DUE_DAY = 5; // Friday
export const DEFAULT_SIGNOFF_DUE_HOUR_WAT = 17;
/** Mon–Fri, which reproduces the previous weekday-only behaviour exactly. */
export const DEFAULT_DAILY_LOG_DAYS = [1, 2, 3, 4, 5];

export interface Cadence {
  weeklySummaryDueDay: number;
  weeklySummaryDueHourWat: number;
  signoffDueDay: number;
  signoffDueHourWat: number;
  dailyLogDays: number[];
  physicalAttendanceRequired: boolean;
}

const day = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
    ? value
    : fallback;

const hour = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23
    ? value
    : fallback;

/**
 * Reads a cohort's cadence, falling back per field.
 *
 * Defensive in the shape of `approvalWindowHours`: a malformed setting must
 * produce the default, never a NaN that turns every computed deadline into an
 * invalid date nobody notices until a reminder says "Invalid Date".
 */
export function cadenceFor(cohort: Doc<'cohorts'> | null | undefined): Cadence {
  const days = cohort?.dailyLogDays;

  return {
    weeklySummaryDueDay: day(cohort?.weeklySummaryDueDay, DEFAULT_WEEKLY_SUMMARY_DUE_DAY),
    weeklySummaryDueHourWat: hour(
      cohort?.weeklySummaryDueHourWat,
      DEFAULT_WEEKLY_SUMMARY_DUE_HOUR_WAT,
    ),
    signoffDueDay: day(cohort?.signoffDueDay, DEFAULT_SIGNOFF_DUE_DAY),
    signoffDueHourWat: hour(cohort?.signoffDueHourWat, DEFAULT_SIGNOFF_DUE_HOUR_WAT),
    dailyLogDays:
      Array.isArray(days) && days.length > 0
        ? days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : DEFAULT_DAILY_LOG_DAYS,
    physicalAttendanceRequired: cohort?.physicalAttendanceRequired !== false,
  };
}

/**
 * The Monday of the week containing `now`, as `YYYY-MM-DD`, in UTC.
 *
 * THE ONE COPY. This arithmetic existed in four places — siwes.ts, the weekly
 * leaderboard cron, the badge evaluator, and the weekly-summary composer in the
 * browser. The browser copy used local `setHours(0,0,0,0)` before calling
 * `toISOString()`, which in WAT is 23:00 UTC the previous day — so it wrote
 * SUNDAY-anchored weeks while everything server-side was Monday-anchored.
 *
 * Kept UTC-anchored rather than WAT-anchored: re-anchoring would move every
 * existing `weekStart` label and every `by_user_and_week` lookup for a one-hour
 * difference. WAT is applied to the DUE INSTANT below, where it matters.
 */
export function weekStartUtc(now: number): string {
  const d = new Date(now);
  const monday = d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

/** Any date string to the Monday of its UTC week. */
export function normalizeWeekStart(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? weekStartUtc(parsed) : date;
}

/** The Sunday that closes a week beginning on `weekStart`. */
export function weekEndFor(weekStart: string): string {
  const parsed = Date.parse(`${weekStart}T00:00:00.000Z`);
  return new Date(parsed + 6 * 86_400_000).toISOString().slice(0, 10);
}

/** The weekday in WAT, 0–6, for an instant. */
export function watDayOfWeek(ms: number): number {
  return new Date(ms + WAT_OFFSET_MS).getUTCDay();
}

/**
 * The instant a thing is due: the END of `dueDay` at `dueHourWat`, in WAT.
 *
 * Thursday at hour 23 means 23:59:59.999 WAT — the last moment of the day
 * someone can submit — not 23:00, which would quietly cost people an hour.
 */
function dueAt(weekStart: string, dueDay: number, dueHourWat: number): number {
  const monday = Date.parse(`${weekStart}T00:00:00.000Z`);
  // Monday is 0 days in; Sunday is 6. The week runs Monday-first.
  const offset = (dueDay + 6) % 7;

  return (
    monday + offset * 86_400_000 + (dueHourWat + 1) * 3_600_000 - 1 - WAT_OFFSET_MS
  );
}

export function weeklySummaryDueAt(weekStart: string, cadence: Cadence): number {
  return dueAt(weekStart, cadence.weeklySummaryDueDay, cadence.weeklySummaryDueHourWat);
}

export function signoffDueAt(weekStart: string, cadence: Cadence): number {
  return dueAt(weekStart, cadence.signoffDueDay, cadence.signoffDueHourWat);
}

/** Whether the programme's date-only start has arrived in WAT. */
export function programmeHasCommenced(startDate: string, now: number): boolean {
  // A UTC parse would open the programme one hour late, despite every cohort
  // date and participant-facing clock being defined in WAT.
  const parsed = Date.parse(`${startDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  // Date.parse normalizes impossible dates such as February 30 into March;
  // accepting that would silently commence a malformed cohort on another day.
  if (new Date(parsed).toISOString().slice(0, 10) !== startDate) return false;

  return now >= parsed - WAT_OFFSET_MS;
}

/** The next weekly deadline that still leaves time in its configured due hour. */
export function usableWeeklyTaskDeadline(now: number, cadence: Cadence): number {
  const weekStart = weekStartUtc(now);
  const deadline = weeklySummaryDueAt(weekStart, cadence);
  // Once the due hour starts, a same-week default leaves only minutes of useful
  // work time and makes a lead responsible for noticing and correcting it.
  const rolloverAt = deadline - 3_600_000 + 1;
  if (now < rolloverAt) return deadline;

  const followingWeek = new Date(
    Date.parse(`${weekStart}T00:00:00.000Z`) + 7 * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return weeklySummaryDueAt(followingWeek, cadence);
}
