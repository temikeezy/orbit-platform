/**
 * What each programme type actually obliges someone to do.
 *
 * ORBIT is not a SIWES platform with other programmes bolted on — on the dev
 * deployment two thirds of applications are internships and volunteers. But the
 * logbook half of the product was built SIWES-shaped and applied to everyone,
 * because `programmeType` was recorded on the application and then thrown away
 * at conversion: no downstream screen could tell a volunteer from a SIWES intern
 * even where it wanted to. The consequence was not cosmetic. Volunteers were
 * emailed every weekday to submit a logbook they do not keep, through a
 * notification path that deliberately consults no preference key, so they could
 * not turn it off.
 *
 * One predicate, in one place, so the answer cannot drift between the cron that
 * sends the reminder, the query that counts what is missing, and the screen that
 * shows the card.
 */

export const PROGRAMME_TYPES = ['siwes', 'internship', 'nysc', 'volunteer'] as const;

export type ProgrammeType = (typeof PROGRAMME_TYPES)[number];

/** Human-readable, for anything a member or an admin reads. */
export const PROGRAMME_LABELS: Record<ProgrammeType, string> = {
  siwes: 'SIWES',
  internship: 'Internship',
  nysc: 'NYSC',
  volunteer: 'Volunteer',
};

/**
 * The logbook is a SIWES artefact and nothing else.
 *
 * A SIWES logbook exists to be inspected by a university's Industrial Liaison
 * Unit; it is the reason daily logs, weekly summaries and supervisor sign-off
 * exist in ORBIT at all. Nobody else in the programme has an institution
 * expecting one, so nobody else is asked for one, reminded about one, or
 * counted as missing one.
 *
 * UNKNOWN COUNTS AS NOT SIWES. Accounts converted before the programme type was
 * persisted carry none, and the backfill fills in what it can from the
 * application it came from. For anything it cannot resolve, silence is the safe
 * failure: a SIWES intern who stops receiving a reminder still has a supervisor
 * and a visible logbook tab, while a volunteer wrongly assumed to be SIWES gets
 * chased daily by email for something that will never apply to them.
 */
export function carriesLogbook(programmeType?: string | null): boolean {
  return programmeType === 'siwes';
}

/** The label for a programme type, tolerating anything stored. */
export function programmeLabel(programmeType?: string | null): string {
  const key = programmeType as ProgrammeType | undefined;
  return (key && PROGRAMME_LABELS[key]) || 'Programme';
}

/**
 * The same question, asked of a whole account rather than a bare string.
 *
 * WHAT SOMEONE SELECTED ON THE APPLICATION FORM IS THE ONLY AUTHORITY. If they
 * did not choose SIWES, they are not a SIWES student: no logbook, no daily-log
 * reminders, no missing-log counts, no acceptance letter.
 *
 * This used to fall back, for accounts carrying no `programmeType`, to treating
 * a matric number or SIWES placement dates as proof of SIWES. The comment
 * justifying that said those fields "are only ever collected from SIWES
 * applicants". Measured against the live intake, that is simply not true — of
 * the 246 applications on production, 21 non-SIWES applicants supplied a matric
 * number and 12 supplied SIWES dates. Students on ordinary internships have
 * matric numbers too, and the form does not stop anyone filling a field in.
 * So the fallback did not identify SIWES students; it identified students, and
 * would have put up to 23 volunteers and interns on a daily reminder for a
 * logbook their institution will never ask for.
 *
 * `backfillProgrammeType` in convex/users.ts already takes the correct line for
 * exactly this reason — it recovers the value from the application it came from
 * and LEAVES UNRESOLVABLE ACCOUNTS ALONE rather than guessing, because "a wrong
 * 'siwes' would put someone back on the daily reminder list this work exists to
 * get them off". This predicate now agrees with it instead of contradicting it.
 *
 * The cost is real and accepted: an account with no `programmeType` gets no
 * logbook, even if it should have one. The remedy is to stamp it — via the
 * backfill, or by correcting the account — not to infer it. Conversion has
 * recorded `programmeType` since before any intern existed on this deployment,
 * so the unstamped case is a migration artefact rather than a live path.
 */
export function userCarriesLogbook(user: {
  programmeType?: string | null;
}): boolean {
  return carriesLogbook(user.programmeType);
}

/**
 * The weekday of a `YYYY-MM-DD` log date.
 *
 * Derived FROM THE DATE STRING, never from a timestamp. `logDate` is written as
 * a UTC date everywhere, so pairing one with a WAT weekday — as the missing-log
 * window once did — disagrees for the hour before midnight UTC, and a
 * Tuesday-to-Thursday cadence silently becomes Monday-to-Wednesday.
 */
export function logDateDayOfWeek(logDate: string): number {
  return new Date(`${logDate}T00:00:00Z`).getUTCDay();
}

/**
 * The `YYYY-MM-DD` dates of the `days` days before `now`, newest first, each
 * with the weekday that belongs to it.
 */
export function recentLogDates(now: number, days = 7): { date: string; dow: number }[] {
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10);
    return { date, dow: logDateDayOfWeek(date) };
  });
}

/**
 * When someone's own obligations start: the LATER of the cohort's start and
 * their own.
 *
 * `cohortStart ?? personalStart` was wrong and quietly dead — a cohort always
 * has a start date, so the personal one was never consulted and a late joiner
 * was reported as missing the week before they arrived. Both are `YYYY-MM-DD`,
 * which orders correctly as text.
 */
export function obligationsStart(cohortStart?: string | null, personalStart?: string | null): string {
  const starts = [cohortStart, personalStart].filter((d): d is string => Boolean(d)).sort();
  return starts.length ? starts[starts.length - 1] : '';
}
