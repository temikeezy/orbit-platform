import { describe, it, expect } from 'vitest';
import {
  cadenceFor,
  weekStartUtc,
  normalizeWeekStart,
  weekEndFor,
  watDayOfWeek,
  weeklySummaryDueAt,
  signoffDueAt,
  programmeHasCommenced,
  usableWeeklyTaskDeadline,
  DEFAULT_WEEKLY_SUMMARY_DUE_DAY,
} from '../../../convex/lib/cadence';
import type { Cadence } from '../../../convex/lib/cadence';
import { formatWat } from '../../../convex/lib/datetime';

/**
 * The programme's clock. Deadlines stated in an email come from here, so an
 * off-by-one day silently tells thirty people the wrong date.
 */
describe('week anchoring', () => {
  it('anchors to Monday', () => {
    // A Wednesday.
    expect(weekStartUtc(Date.UTC(2026, 7, 19, 10, 0))).toBe('2026-08-17');
  });

  it('treats Sunday as the END of its week, not the start', () => {
    // The bug the client had: local midnight in WAT is 23:00 UTC the previous
    // day, so a naive toISOString() produced the Sunday and every deadline
    // computed from it landed a day early.
    expect(weekStartUtc(Date.UTC(2026, 7, 23, 10, 0))).toBe('2026-08-17');
  });

  it('normalises any day of the week to its Monday', () => {
    for (const d of [17, 18, 19, 20, 21, 22, 23]) {
      expect(normalizeWeekStart(`2026-08-${d}`)).toBe('2026-08-17');
    }
  });

  it('closes the week on Sunday', () => {
    expect(weekEndFor('2026-08-17')).toBe('2026-08-23');
  });
});

describe('due instants', () => {
  const cadence = cadenceFor(null);

  it('defaults the weekly summary to Thursday', () => {
    expect(DEFAULT_WEEKLY_SUMMARY_DUE_DAY).toBe(4);
  });

  it('falls due at the END of Thursday in WAT, not the start of the hour', () => {
    // Asserted through formatWat because that is the string the reminder email
    // shows — testing the rendering tests the arithmetic and the copy at once.
    const due = weeklySummaryDueAt('2026-08-17', cadence);
    expect(formatWat(due)).toBe('Thursday 20 August 2026, 11:59 PM WAT');
  });

  it('puts sign-off on Friday afternoon', () => {
    expect(formatWat(signoffDueAt('2026-08-17', cadence))).toBe(
      'Friday 21 August 2026, 5:59 PM WAT',
    );
  });

  it('reads a cohort override', () => {
    const custom = cadenceFor({ weeklySummaryDueDay: 5, dailyLogDays: [2, 3, 4] } as never);
    expect(custom.weeklySummaryDueDay).toBe(5);
    expect(custom.dailyLogDays).toEqual([2, 3, 4]);
  });

  it('falls back rather than producing an invalid date', () => {
    // A malformed setting must not become NaN — that surfaces to a participant
    // as "Invalid Date" in an email about a deadline.
    const broken = cadenceFor({ weeklySummaryDueDay: 99, weeklySummaryDueHourWat: -3 } as never);
    expect(broken.weeklySummaryDueDay).toBe(4);
    expect(Number.isFinite(weeklySummaryDueAt('2026-08-17', broken))).toBe(true);
  });

  it('treats attendance as required unless explicitly switched off', () => {
    expect(cadenceFor(null).physicalAttendanceRequired).toBe(true);
    expect(cadenceFor({ physicalAttendanceRequired: false } as never).physicalAttendanceRequired).toBe(false);
  });
});

describe('watDayOfWeek', () => {
  it('uses the WAT day, which can differ from UTC late at night', () => {
    // 23:30 UTC Sunday is 00:30 Monday in Lagos.
    expect(watDayOfWeek(Date.UTC(2026, 7, 16, 23, 30))).toBe(1);
  });
});

describe('usableWeeklyTaskDeadline', () => {
  const cadence = cadenceFor(null);

  it('uses the current programme week on Wednesday', () => {
    const now = Date.UTC(2026, 7, 19, 9, 0); // Wednesday 10:00 WAT.

    expect(formatWat(usableWeeklyTaskDeadline(now, cadence))).toBe(
      'Thursday 20 August 2026, 11:59 PM WAT',
    );
  });

  it('uses the current programme week immediately before the configured due hour', () => {
    const now = Date.UTC(2026, 7, 20, 21, 59, 59, 999); // Thursday 22:59:59.999 WAT.

    expect(formatWat(usableWeeklyTaskDeadline(now, cadence))).toBe(
      'Thursday 20 August 2026, 11:59 PM WAT',
    );
  });

  it('rolls exactly when the configured due hour begins', () => {
    const now = Date.UTC(2026, 7, 20, 22, 0); // Thursday 23:00 WAT.

    expect(formatWat(usableWeeklyTaskDeadline(now, cadence))).toBe(
      'Thursday 27 August 2026, 11:59 PM WAT',
    );
  });

  it('rolls to the next programme week after the configured due hour begins', () => {
    const now = Date.UTC(2026, 7, 20, 22, 30); // Thursday 23:30 WAT.

    expect(formatWat(usableWeeklyTaskDeadline(now, cadence))).toBe(
      'Thursday 27 August 2026, 11:59 PM WAT',
    );
  });

  it('uses the next programme week on Friday', () => {
    const now = Date.UTC(2026, 7, 21, 9, 0); // Friday 10:00 WAT.

    expect(formatWat(usableWeeklyTaskDeadline(now, cadence))).toBe(
      'Thursday 27 August 2026, 11:59 PM WAT',
    );
  });

  it('uses the cohort cadence override for both weekday and due hour', () => {
    const custom = {
      ...cadence,
      weeklySummaryDueDay: 2,
      weeklySummaryDueHourWat: 14,
    } satisfies Cadence;
    const now = Date.UTC(2026, 7, 18, 13, 30); // Tuesday 14:30 WAT.

    expect(formatWat(usableWeeklyTaskDeadline(now, custom))).toBe(
      'Tuesday 25 August 2026, 2:59 PM WAT',
    );
  });
});

describe('programmeHasCommenced', () => {
  it('rejects a calendar date that Date.parse would normalize', () => {
    expect(programmeHasCommenced('2026-02-30', Date.UTC(2026, 2, 2))).toBe(false);
  });

  it('is false immediately before 00:00 WAT on the programme start date', () => {
    const immediatelyBefore = Date.UTC(2026, 7, 16, 22, 59, 59, 999);

    expect(programmeHasCommenced('2026-08-17', immediatelyBefore)).toBe(false);
  });

  it('is true exactly at 00:00 WAT on the programme start date', () => {
    const commencement = Date.UTC(2026, 7, 16, 23, 0);

    expect(programmeHasCommenced('2026-08-17', commencement)).toBe(true);
  });
});
