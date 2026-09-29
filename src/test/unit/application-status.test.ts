import { describe, it, expect } from 'vitest';
import {
  STATUSES,
  canTransition,
  isTerminal,
  refusalReason,
} from '../../../convex/lib/applicationStatus';

/**
 * The admissions rule, tested directly.
 *
 * It is enforced in three places — the single-status mutation, the bulk action
 * and the sheet sync — and all three call this. A rule that lives in one
 * function is a rule that cannot be enforced in two of them and forgotten in
 * the third.
 */

describe('application status', () => {
  it('has exactly two states', () => {
    expect([...STATUSES]).toEqual(['submitted', 'approved']);
  });

  it('allows the one transition that exists', () => {
    expect(canTransition('submitted', 'approved')).toBe(true);
  });

  it('REFUSES to un-approve, which is the whole point', () => {
    // Approval is communicated to a person. Reversing it silently un-admits
    // them, and the sheet — where a stray paste can rewrite a column — is now
    // one of the things that can try.
    expect(canTransition('approved', 'submitted')).toBe(false);
    expect(refusalReason('approved', 'submitted')).toMatch(/cannot be changed/i);
  });

  it('treats a no-op as allowed, so re-sending the same status is not an error', () => {
    // The sheet sync sends whatever the column says on every pass; if "already
    // approved" were a refusal it would log an error every five minutes forever.
    expect(canTransition('approved', 'approved')).toBe(true);
    expect(canTransition('submitted', 'submitted')).toBe(true);
  });

  it('refuses a status outside the vocabulary', () => {
    // Someone will type "Approved!" or "yes" into the sheet.
    expect(canTransition('submitted', 'yes')).toBe(false);
    expect(canTransition('submitted', 'Approved')).toBe(false);
    expect(refusalReason('submitted', 'yes')).toMatch(/must be one of/i);
  });

  it('marks approved as terminal so the UI can render it read-only', () => {
    expect(isTerminal('approved')).toBe(true);
    expect(isTerminal('submitted')).toBe(false);
  });
});
