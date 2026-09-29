import { query, mutation } from './_generated/server';
import { v } from 'convex/values';
import { requireUser } from './lib/auth';
import { isIntern } from './lib/internProfile';

/**
 * The three things a new member does before their first real task.
 *
 * WHY THIS IS NOT A `tasks` ROW. Every one of these steps is either already
 * observable or trivially recordable, and none of them is a deliverable anyone
 * should have to read:
 *
 *   1. sign in            -> `lastLoginAt`
 *   2. set a password     -> `passwordHash`
 *   3. read the manual    -> `orientationReadAt`
 *
 * Made into tasks, all three would need a submission type that does not fit
 * ("I logged in"), a deadline they could miss, points that would distort the
 * leaderboard before anyone has done real work, and — worst — 246 submissions
 * for a supervisor to review that say nothing. The platform can simply check
 * them. So it checks them.
 *
 * The second reason is a display one. An unsubmitted task sits in the queue
 * looking like a missed deadline, and week 1 has no real tasks in it — so a
 * placeholder would be the ONLY thing in an intern's queue, reading as a
 * failure on day one. The checklist lives on the home page instead and
 * disappears once it is done.
 *
 * INTERNS ONLY, like tasks, points and levels. Staff arrive through Zoho with a
 * password already set and do not have an onboarding flow; `status` reports
 * `applicable: false` for them and the UI renders nothing. This is the same
 * boundary `awardPoints` draws (convex/lib/points.ts) and it is drawn here
 * rather than in the component so a future caller cannot miss it.
 */

export interface OnboardingStep {
  key: 'signIn' | 'password' | 'manual';
  title: string;
  description: string;
  done: boolean;
  /** Where the member goes to do it, or null when there is nothing to click. */
  href: string | null;
}

export interface OnboardingStatus {
  /** False for staff, who have no onboarding checklist at all. */
  applicable: boolean;
  steps: OnboardingStep[];
  complete: boolean;
}

/**
 * The steps, derived from a member's own record. PURE — no context, no reads.
 *
 * Extracted so the rules can be tested without a Convex harness, which matters
 * because the integration suite needs a secret CI does not have. The interesting
 * cases are the boundaries: staff get nothing, a partially-done member gets the
 * right subset, and completion is decided ONLY by observed state.
 *
 * That last point is the whole design. These steps complete because the member
 * did the thing, not because anything marked them done — so there is no
 * completion to write, nothing to backfill for members who already acted, and
 * no function anywhere that could mark one person's step done on behalf of
 * another.
 */
export function deriveOnboardingSteps(user: {
  roles?: string[];
  passwordHash?: string;
  orientationReadAt?: number;
}): OnboardingStatus {
  if (!isIntern(user)) {
    return { applicable: false, steps: [], complete: true };
  }

  const steps: OnboardingStep[] = [
      {
        key: 'signIn',
        title: 'Sign in to ORBIT',
        // Reaching this query at all proves it, so it is never shown undone.
        description: 'You are here — this one is done.',
        done: true,
        href: null,
      },
      {
        key: 'password',
        title: 'Set your password',
        description:
          'Your sign-in link expires. A password is how you get back in after it does.',
        done: Boolean(user.passwordHash),
        // The password form is on the Security tab; `/settings` alone opens on
        // Profile and hides the thing they were sent here to do.
        href: '/settings?tab=security',
      },
      {
        key: 'manual',
        title: 'Read the orientation manual',
        description:
          'How streams, tasks and reviews work, and what is expected of you each week.',
        done: Boolean(user.orientationReadAt),
        href: '/orientation',
      },
    ];

  return { applicable: true, steps, complete: steps.every((s) => s.done) };
}

export const status = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<OnboardingStatus> => {
    return deriveOnboardingSteps(await requireUser(ctx, args.token));
  },
});

/**
 * Records that the member reached the end of the orientation manual.
 *
 * Idempotent and first-write-wins: re-reading the manual must not reset the
 * date to today, or "when did this member onboard" stops being answerable.
 * Deliberately carries no points — see the module note on why onboarding sits
 * outside gamification.
 */
export const markOrientationRead = mutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const user = await requireUser(ctx, args.token);

    // Staff have no checklist, so there is nothing to record for them.
    if (!isIntern(user)) return { recorded: false };
    if (user.orientationReadAt) return { recorded: false };

    await ctx.db.patch(user._id, { orientationReadAt: Date.now() });
    return { recorded: true };
  },
});
