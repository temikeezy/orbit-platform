import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_SETTLE_MS,
  AGENT_ERA_START,
  settledByFallback,
} from '../../../convex/lib/agentFallback';

const DAY = 24 * 60 * 60 * 1000;
const now = AGENT_ERA_START + 30 * DAY;
const cutoff = now - 5 * DAY;

describe('settledByFallback', () => {
  it('settles work the agent set aside once the window has passed', () => {
    for (const outcome of ['contested', 'unreadable', 'unsupported']) {
      expect(settledByFallback(outcome, now - 6 * DAY, now - 6 * DAY, cutoff, now)).toBe(true);
    }
  });

  it('leaves set-aside work alone inside the window', () => {
    expect(settledByFallback('contested', now - 2 * DAY, now - 2 * DAY, cutoff, now)).toBe(false);
  });

  it('does not settle work the agent has not reached yet', () => {
    expect(settledByFallback(undefined, now - 6 * DAY, undefined, cutoff, now)).toBe(false);
    expect(settledByFallback('no-quorum', now - 6 * DAY, now - 6 * DAY, cutoff, now)).toBe(false);
  });

  it('settles anything after two weeks, so a runner outage cannot strand work', () => {
    expect(settledByFallback(undefined, now - ABSOLUTE_SETTLE_MS - DAY, undefined, cutoff, now)).toBe(true);
  });

  it('counts the two weeks from the agent era, not from an old submission', () => {
    const early = AGENT_ERA_START + 3 * DAY;
    const ancient = AGENT_ERA_START - 60 * DAY;
    expect(settledByFallback(undefined, ancient, undefined, early - 5 * DAY, early)).toBe(false);
  });

  it('counts the five days from the set-aside, not from an old submission', () => {
    // The backlog case: submitted weeks before the agent era, first set aside an
    // hour ago, ten days into the era (so the two-week net is not yet due).
    const t = AGENT_ERA_START + 10 * DAY;
    const submitted = AGENT_ERA_START - 20 * DAY;
    expect(settledByFallback('unreadable', submitted, t - 3600_000, t - 5 * DAY, t)).toBe(false);
    expect(settledByFallback('unreadable', submitted, t - 6 * DAY, t - 5 * DAY, t)).toBe(true);
  });

  it('never settles an empty submission, not even through the two-week net', () => {
    expect(settledByFallback('empty', now - 6 * DAY, now - 6 * DAY, cutoff, now)).toBe(false);
    expect(settledByFallback('empty', now - 29 * DAY, now - 29 * DAY, cutoff, now)).toBe(false);
  });
});
