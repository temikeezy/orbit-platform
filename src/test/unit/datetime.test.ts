import { describe, it, expect } from 'vitest';
import { formatWat, formatWatDate } from '../../../convex/lib/datetime';

/**
 * The deadline reminder states a time, so the arithmetic has to be right.
 *
 * WAT is UTC+1 with no daylight saving, applied by hand rather than through
 * Intl — see the note in convex/lib/datetime.ts. That is the kind of decision
 * that is correct until someone "simplifies" it, so these pin the boundaries.
 */
describe('formatWat', () => {
  it('shifts UTC forward by one hour', () => {
    expect(formatWat(Date.UTC(2026, 8, 11, 16, 0))).toBe('Friday 11 September 2026, 5:00 PM WAT');
  });

  it('rolls the date over when the offset crosses midnight', () => {
    // 23:30 UTC is 00:30 the next day in Lagos — the case a naive formatter
    // gets wrong, and the one that would misstate a deadline by a whole day.
    expect(formatWat(Date.UTC(2026, 8, 11, 23, 30))).toBe(
      'Saturday 12 September 2026, 12:30 AM WAT',
    );
  });

  it('renders noon and midnight as 12, not 0', () => {
    expect(formatWat(Date.UTC(2026, 8, 11, 11, 0))).toContain('12:00 PM');
    expect(formatWat(Date.UTC(2026, 8, 10, 23, 0))).toContain('12:00 AM');
  });

  it('pads minutes', () => {
    expect(formatWat(Date.UTC(2026, 8, 11, 16, 5))).toContain('5:05 PM');
  });

  it('formats a bare date without a time', () => {
    expect(formatWatDate(Date.UTC(2026, 0, 1, 12, 0))).toBe('1 January 2026');
  });
});
