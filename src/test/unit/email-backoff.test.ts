import { describe, it, expect } from 'vitest';
import { backoffFor } from '../../../convex/emailQueue';

/**
 * The retry schedule.
 *
 * `markFailed` used to document this as "roughly half an hour", which the
 * arithmetic below disproves: at MAX_RETRIES 3 the window is 2m + 4m, about six
 * minutes. The docstring has been corrected — this is the test that made the
 * discrepancy visible, which is the point of pinning a schedule stated in prose. The behaviour it replaced — immediate
 * retries, three attempts inside four minutes — lost real mail to a five-minute
 * provider outage, so the property that matters is not the exact numbers but
 * that the total window comfortably outlasts a short outage.
 *
 * Imported directly: `backoffFor` is a pure function with no Convex context, so
 * this costs nothing and does not pull the module graph into coverage.
 */
describe('backoffFor', () => {
  const MINUTE = 60 * 1000;

  it('doubles with each failure', () => {
    expect(backoffFor(1)).toBe(2 * MINUTE);
    expect(backoffFor(2)).toBe(4 * MINUTE);
    expect(backoffFor(3)).toBe(8 * MINUTE);
    expect(backoffFor(4)).toBe(16 * MINUTE);
  });

  it('caps at 16 minutes so a raised MAX_RETRIES cannot run away', () => {
    // Without the cap the tenth retry would wait about seventeen hours, and a
    // message waiting that long is indistinguishable from one abandoned.
    expect(backoffFor(5)).toBe(16 * MINUTE);
    expect(backoffFor(10)).toBe(16 * MINUTE);
    expect(backoffFor(100)).toBe(16 * MINUTE);
  });

  it('outlasts the outage that motivated it', () => {
    // MAX_RETRIES is 3, so a message survives failures at +2m and +4m before
    // its third and final attempt. The old behaviour gave up after four
    // minutes total; five minutes of provider downtime lost the mail.
    const windowMs = backoffFor(1) + backoffFor(2);
    expect(windowMs).toBeGreaterThan(5 * MINUTE);
  });

  it('never returns zero, so a failure cannot be retried instantly', () => {
    // A zero here would restore exactly the behaviour this replaced: the
    // two-minute cron picking the row straight back up.
    for (const n of [0, 1, 2, 3, 4, 5]) {
      expect(backoffFor(n)).toBeGreaterThan(0);
    }
  });
});
