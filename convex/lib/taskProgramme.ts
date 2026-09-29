import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
  cadenceFor,
  programmeHasCommenced,
  usableWeeklyTaskDeadline,
} from './cadence';

export type TaskProgrammeDecision =
  | {
      allowed: true;
      startDate: string;
      defaultDeadline: number;
    }
  | {
      allowed: false;
      startDate: string | null;
      error: string;
    };

/**
 * The platform programme that governs stream tasks.
 *
 * Tasks belong to streams, not cohorts. Resolving a programme from each
 * member's cohort would make one stream simultaneously started and unstarted,
 * and would give its single task conflicting weekly cadences. The least
 * surprising rule is therefore one platform-current active cohort: the latest
 * programme start, with the newest record breaking a tie deterministically.
 * Inactive cohorts never qualify; falling back to one would reopen task
 * assignment for a programme the owner has explicitly closed.
 */
export function selectCurrentTaskProgramme(
  cohorts: readonly Doc<'cohorts'>[],
): Doc<'cohorts'> | null {
  const active = cohorts.filter((cohort) => cohort.status === 'active');

  return (
    active.reduce<Doc<'cohorts'> | null>((selected, candidate) => {
      if (!selected) return candidate;
      const byStart = candidate.startDate.localeCompare(selected.startDate);
      if (byStart > 0) return candidate;
      if (byStart === 0 && candidate.createdAt > selected.createdAt) return candidate;
      return selected;
    }, null)
  );
}

export async function resolveCurrentTaskProgramme(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<'cohorts'> | null> {
  const active = await ctx.db
    .query('cohorts')
    .withIndex('by_status', (q) => q.eq('status', 'active'))
    .collect();

  return selectCurrentTaskProgramme(active);
}

/**
 * The programme decision is pure so queries can evaluate a caller-supplied
 * instant while mutations use their authoritative server time. Reading
 * `Date.now()` inside a Convex query would cache a result that silently becomes
 * false at commencement without a database change to make the query rerun.
 */
export function evaluateTaskProgramme(
  cohort: Doc<'cohorts'> | null,
  now: number,
): TaskProgrammeDecision {
  if (!cohort) {
    return {
      allowed: false,
      startDate: null,
      error: 'Tasks cannot be created or assigned because no active programme cohort is configured.',
    };
  }

  if (!programmeHasCommenced(cohort.startDate, now)) {
    return {
      allowed: false,
      startDate: cohort.startDate,
      error: `Tasks cannot be created or assigned until the programme starts on ${cohort.startDate}.`,
    };
  }

  return {
    allowed: true,
    startDate: cohort.startDate,
    defaultDeadline: usableWeeklyTaskDeadline(now, cadenceFor(cohort)),
  };
}

export async function taskProgrammeDecision(
  ctx: QueryCtx | MutationCtx,
  now: number,
): Promise<TaskProgrammeDecision> {
  return evaluateTaskProgramme(await resolveCurrentTaskProgramme(ctx), now);
}
