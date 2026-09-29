import { describe, it, expect } from 'vitest';
import {
  autoPublishAt,
  isPublished,
  readWindowHours,
  EXPIRED,
  DEFAULT_APPROVAL_WINDOW_HOURS,
} from '../../../convex/lib/taskApproval';

/**
 * The window is what stops supervisor approval becoming a single point of
 * failure for the whole programme, so "0 means never" has to hold — a bug that
 * turned it into "publish immediately" would push every agent draft straight to
 * interns, which is exactly what the gate exists to prevent.
 */
describe('autoPublishAt', () => {
  const created = Date.UTC(2026, 8, 11, 9, 0);

  it('adds the window to the creation time', () => {
    expect(autoPublishAt(created, 48)).toBe(created + 48 * 3_600_000);
  });

  it('returns null when the window is zero, meaning never publish on its own', () => {
    expect(autoPublishAt(created, 0)).toBeNull();
  });

  it('returns null for a negative window rather than a time in the past', () => {
    expect(autoPublishAt(created, -5)).toBeNull();
  });

  it('defaults to two working days', () => {
    expect(DEFAULT_APPROVAL_WINDOW_HOURS).toBe(48);
  });
});

/**
 * `isPublished` is the single predicate four surfaces consult — the task list,
 * the per-task gate, the file-attachment path and the deadline-reminder cron.
 * It was private to tasks.ts, which is exactly how the cron came to email
 * unapproved proposals to entire streams.
 */
describe('isPublished', () => {
  it('treats a task with no approvalStatus as published', () => {
    // Every task predating the agent. Backfilling them would have been writing
    // down a decision nobody made.
    expect(isPublished({})).toBe(true);
  });

  it('publishes an approved task', () => {
    expect(isPublished({ approvalStatus: 'approved' })).toBe(true);
  });

  it('withholds a pending proposal', () => {
    expect(isPublished({ approvalStatus: 'pending' })).toBe(false);
  });

  it('withholds an expired proposal', () => {
    // The terminal state that lets a dead proposal leave the pending index
    // without ever becoming visible to a stream.
    expect(isPublished({ approvalStatus: EXPIRED })).toBe(false);
  });

  it('withholds anything it does not recognise', () => {
    // Fail closed: an unknown status must never publish to a stream.
    expect(isPublished({ approvalStatus: 'something-new' })).toBe(false);
  });
});

/**
 * The stored row is `{ enabled, value }`, not a bare number — that is the shape
 * `seedTaskApprovalWindow` writes and the shape the settings screen renders for
 * every sibling setting. Reading only a scalar made the whole setting inert:
 * the row could say 24 while the cron went on publishing at 48, with both
 * halves reporting success and nothing comparing them.
 */
describe('readWindowHours', () => {
  it('reads the object shape the setting is actually stored in', () => {
    expect(readWindowHours({ enabled: true, value: 24 })).toBe(24);
  });

  it('still reads a bare number', () => {
    expect(readWindowHours(12)).toBe(12);
  });

  it('still reads a numeric string', () => {
    expect(readWindowHours('36')).toBe(36);
  });

  it('keeps zero, which means never auto-publish', () => {
    expect(readWindowHours({ enabled: true, value: 0 })).toBe(0);
  });

  /**
   * The one reading this must never take. Zero parks every agent draft behind a
   * human who may not come; switching an override off means "no deliberate
   * override", so the default governs and the queue keeps moving.
   */
  it('falls back to the default when the override is switched off, not to zero', () => {
    expect(readWindowHours({ enabled: false, value: 24 })).toBe(DEFAULT_APPROVAL_WINDOW_HOURS);
  });

  it.each([
    ['an absent row', undefined],
    ['a null value', null],
    ['a blanked string', ''],
    ['a non-numeric string', 'soon'],
    ['an object with no value', { enabled: true }],
    ['a negative window', -5],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(readWindowHours(raw)).toBe(DEFAULT_APPROVAL_WINDOW_HOURS);
  });
});
