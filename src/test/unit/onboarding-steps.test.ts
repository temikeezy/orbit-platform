import { describe, it, expect } from 'vitest';
import { deriveOnboardingSteps } from '../../../convex/onboarding';

/**
 * The onboarding steps, and the property the whole design rests on.
 *
 * These steps complete because the member DID the thing — a password exists, the
 * manual was marked read — not because anything wrote a completion. That is what
 * makes them retroactively correct for members who acted before the feature
 * existed, and it is why there is no mutation anywhere that could mark one
 * person's step done on behalf of another.
 *
 * Tested here rather than through the integration suite because that suite
 * skips without ORBIT_TEST_MCP_SECRET, which CI does not have. These run on
 * every change.
 */
describe('deriveOnboardingSteps', () => {
  const intern = { roles: ['intern'] };

  it('gives an intern three steps in order', () => {
    const s = deriveOnboardingSteps(intern);
    expect(s.applicable).toBe(true);
    expect(s.steps.map((x) => x.key)).toEqual(['signIn', 'password', 'manual']);
  });

  it('treats signing in as already done', () => {
    // Reaching any of this requires a session, so it can never be pending.
    expect(deriveOnboardingSteps(intern).steps[0].done).toBe(true);
  });

  it('completes the password step from the password itself', () => {
    expect(deriveOnboardingSteps(intern).steps[1].done).toBe(false);
    expect(deriveOnboardingSteps({ ...intern, passwordHash: '$2b$10$abc' }).steps[1].done).toBe(true);
  });

  it('completes the manual step from the read timestamp', () => {
    expect(deriveOnboardingSteps(intern).steps[2].done).toBe(false);
    expect(deriveOnboardingSteps({ ...intern, orientationReadAt: 1 }).steps[2].done).toBe(true);
  });

  it('is retroactively true for someone who acted before the feature existed', () => {
    // The point of deriving rather than recording: a member who already set a
    // password and read the manual is complete the first time this is asked,
    // with nothing backfilled and nothing written.
    const done = deriveOnboardingSteps({
      ...intern,
      passwordHash: '$2b$10$abc',
      orientationReadAt: 1,
    });
    expect(done.complete).toBe(true);
    expect(done.steps.every((s) => s.done)).toBe(true);
  });

  it('gives staff nothing at all', () => {
    // Tasks, points and levels are interns-only, and so is this. `complete` is
    // true so no caller renders a checklist that can never be finished.
    for (const role of ['admin', 'super_admin', 'moderator']) {
      const s = deriveOnboardingSteps({ roles: [role] });
      expect(s.applicable, `${role} should have no checklist`).toBe(false);
      expect(s.steps).toEqual([]);
      expect(s.complete).toBe(true);
    }
  });

  it('treats someone holding both intern and staff roles as staff', () => {
    // isIntern is "carries no staff role", so a promoted member stops being
    // asked to onboard rather than keeping a half-finished list forever.
    expect(deriveOnboardingSteps({ roles: ['intern', 'moderator'] }).applicable).toBe(false);
  });

  it('sends the password step to the tab that actually holds the form', () => {
    // /settings alone opens on Profile and hides it — the one step that decides
    // whether a member can get back in after their sign-in link expires.
    expect(deriveOnboardingSteps(intern).steps[1].href).toBe('/settings?tab=security');
  });
});
