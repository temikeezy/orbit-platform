import { describe, it, expect } from 'vitest';
import {
  PROGRAMME_TYPES,
  carriesLogbook,
  logDateDayOfWeek,
  obligationsStart,
  programmeLabel,
  recentLogDates,
  userCarriesLogbook,
} from '../../../convex/lib/programme';

/**
 * Who keeps a logbook.
 *
 * The answer used to be "everyone", by omission rather than decision: the
 * programme type was recorded on the application and dropped at conversion, so
 * nothing downstream could tell a volunteer from a SIWES intern. Volunteers
 * were emailed every expected weekday about a logbook they do not keep, on a
 * notification path that consults no preference key — so they could not stop
 * it. These tests pin the rule that ends that.
 */

describe('carriesLogbook', () => {
  it('is true for SIWES and nothing else', () => {
    expect(carriesLogbook('siwes')).toBe(true);
    expect(carriesLogbook('internship')).toBe(false);
    expect(carriesLogbook('nysc')).toBe(false);
    expect(carriesLogbook('volunteer')).toBe(false);
  });

  /**
   * The safe direction for an unknown value.
   *
   * Accounts converted before the programme type was persisted carry none, and
   * the backfill cannot resolve every one of them. A SIWES intern wrongly
   * treated as non-SIWES loses a reminder but keeps a supervisor and a visible
   * logbook; a volunteer wrongly treated as SIWES is emailed daily, forever,
   * about something that will never apply to them.
   */
  it('treats an unknown or absent programme as carrying no logbook', () => {
    expect(carriesLogbook(undefined)).toBe(false);
    expect(carriesLogbook(null)).toBe(false);
    expect(carriesLogbook('')).toBe(false);
    expect(carriesLogbook('SIWES')).toBe(false);
    expect(carriesLogbook('something-else')).toBe(false);
  });

  it('covers every programme type the intake accepts', () => {
    expect([...PROGRAMME_TYPES].sort()).toEqual(
      ['internship', 'nysc', 'siwes', 'volunteer'].sort(),
    );
    // Exactly one of them carries the logbook today. If that changes, it should
    // be a decision someone made here rather than a drift somewhere else.
    expect(PROGRAMME_TYPES.filter(carriesLogbook)).toEqual(['siwes']);
  });
});

describe('programmeLabel', () => {
  it('names each programme as a person would', () => {
    expect(programmeLabel('siwes')).toBe('SIWES');
    expect(programmeLabel('internship')).toBe('Internship');
    expect(programmeLabel('nysc')).toBe('NYSC');
    expect(programmeLabel('volunteer')).toBe('Volunteer');
  });

  it('falls back rather than printing a raw key at someone', () => {
    expect(programmeLabel(null)).toBe('Programme');
    expect(programmeLabel('mystery')).toBe('Programme');
  });
});

describe('userCarriesLogbook', () => {
  /**
   * The stamped programme always wins.
   */
  it('trusts a recorded programme type over anything else on the account', () => {
    expect(userCarriesLogbook({ programmeType: 'siwes' })).toBe(true);
    // A volunteer who happens to carry institution data is still a volunteer.
    expect(userCarriesLogbook({ programmeType: 'volunteer' })).toBe(false);
  });

  /**
   * DOES NOT GUESS FROM ENROLMENT DATA.
   *
   * This used to return true for an unstamped account carrying a matric number
   * or SIWES dates, on the stated grounds that those fields "are only ever
   * collected from SIWES applicants". Measured against the live intake that is
   * false: of 246 applications on production, 21 non-SIWES applicants supplied a
   * matric number and 12 supplied SIWES dates. Students on ordinary internships
   * have matric numbers too.
   *
   * So the fallback did not identify SIWES students, it identified students —
   * and would have put up to 23 interns and volunteers on a daily reminder for a
   * logbook no institution will ever ask them for. What someone selected on the
   * application form is the only authority.
   */
  it('does not infer SIWES from a matric number or SIWES dates', () => {
    expect(userCarriesLogbook({ programmeType: 'internship' })).toBe(false);
    expect(userCarriesLogbook({ programmeType: 'nysc' })).toBe(false);
    // Unstamped is unknown, and unknown is not SIWES. The remedy is to stamp the
    // account (users.backfillProgrammeType), never to infer it.
    expect(userCarriesLogbook({})).toBe(false);
    expect(userCarriesLogbook({ programmeType: null })).toBe(false);
  });
});

/**
 * The two date rules the missing-logs count depends on.
 *
 * These import the SHIPPED helpers rather than reproducing the arithmetic — an
 * earlier version of this block copied it, which meant the tests would have
 * gone on passing if `reviewQueue` regressed. Both rules were wrong in ways
 * that only surface at an edge, which is exactly why they are pinned.
 */
describe('missing-logs date rules', () => {
  it('derives a weekday that matches its own date', () => {
    // 2026-08-17 is a Monday.
    expect(logDateDayOfWeek('2026-08-17')).toBe(1);
    expect(logDateDayOfWeek('2026-08-18')).toBe(2);
    expect(logDateDayOfWeek('2026-08-22')).toBe(6);
  });

  /**
   * The bug this replaces: a UTC date paired with a WAT (UTC+1) weekday. In the
   * hour before midnight UTC the two disagree, so a Tue-Thu cadence silently
   * expected Mon-Wed — flagging an intern who logged exactly as asked.
   */
  it('does not drift when evaluated late in the UTC day', () => {
    const lateInTheDay = Date.parse('2026-08-18T23:30:00Z');
    const [yesterday] = recentLogDates(lateInTheDay, 1);

    expect(yesterday.date).toBe('2026-08-17');
    expect(yesterday.dow).toBe(logDateDayOfWeek(yesterday.date));
    // What the old code used: the WAT weekday of the timestamp, a day ahead.
    expect(new Date(lateInTheDay - 86_400_000 + 3_600_000).getUTCDay()).not.toBe(yesterday.dow);
  });

  it('returns the requested number of days, newest first', () => {
    const days = recentLogDates(Date.parse('2026-08-18T12:00:00Z'));
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe('2026-08-17');
    expect(days[6].date).toBe('2026-08-11');
  });

  it('takes the later of the cohort start and the intern\u2019s own', () => {
    // A late joiner: their own start wins, so the week before they arrived is
    // not counted against them. `??` picked the cohort's date every time,
    // because cohorts always have one — the personal date was dead code.
    expect(obligationsStart('2026-08-01', '2026-09-15')).toBe('2026-09-15');
    // Someone who started before the cohort is still bounded by the cohort.
    expect(obligationsStart('2026-09-01', '2026-08-15')).toBe('2026-09-01');
    expect(obligationsStart('2026-08-01', undefined)).toBe('2026-08-01');
    expect(obligationsStart(undefined, undefined)).toBe('');
  });
});
