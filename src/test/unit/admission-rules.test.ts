import { describe, expect, it } from 'vitest';
import {
  ADMISSIONS_ERA_START,
  CONTESTED_ADMIT_MS,
  UNSCREENED_ADMIT_MS,
  admitByFallback,
} from '../../../convex/lib/admissionRules';

const DAY = 86_400_000;
const now = ADMISSIONS_ERA_START + 30 * DAY;

describe('admitByFallback', () => {
  it('admits a screened admit at once', () => {
    expect(admitByFallback('admit', now, now, now)).toBe(true);
  });

  it('never admits a hold or a duplicate, however old', () => {
    expect(admitByFallback('hold', now - 90 * DAY, now - 90 * DAY, now)).toBe(false);
    expect(admitByFallback('duplicate', now - 90 * DAY, now - 90 * DAY, now)).toBe(false);
  });

  it('admits a split verdict only after the waiting period', () => {
    expect(admitByFallback('contested', now - DAY, now - 5 * DAY, now)).toBe(false);
    expect(admitByFallback('contested', now - CONTESTED_ADMIT_MS - 1, now - 5 * DAY, now)).toBe(true);
  });

  it('admits unscreened work after a week, so a runner outage cannot strand anyone', () => {
    expect(admitByFallback(undefined, undefined, now - UNSCREENED_ADMIT_MS - 1, now)).toBe(true);
    expect(admitByFallback('no-quorum', now, now - 2 * DAY, now)).toBe(false);
  });

  it('gives the pre-agent backlog a screening before any timer reaches it', () => {
    const early = ADMISSIONS_ERA_START + 2 * DAY;
    expect(admitByFallback(undefined, undefined, ADMISSIONS_ERA_START - 30 * DAY, early)).toBe(false);
  });
});
