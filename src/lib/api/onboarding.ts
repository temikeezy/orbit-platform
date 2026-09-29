import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';

/**
 * The new-member checklist.
 *
 * Thin on purpose — the server decides what the steps are, whether each is
 * done, and whether the reader has a checklist at all. Nothing here duplicates
 * that logic, so the rule "staff have no onboarding" cannot drift between the
 * two halves of the app. See convex/onboarding.ts for why these are not tasks.
 */

export interface OnboardingStep {
  key: 'signIn' | 'password' | 'manual';
  title: string;
  description: string;
  done: boolean;
  href: string | null;
}

export interface OnboardingStatus {
  applicable: boolean;
  steps: OnboardingStep[];
  complete: boolean;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export const onboardingApi = {
  async status(): Promise<OnboardingStatus> {
    return (await convex.query(api.onboarding.status, {
      token: requireToken(),
    })) as OnboardingStatus;
  },

  /** Idempotent; safe to call every time the manual is opened to the end. */
  async markOrientationRead(): Promise<boolean> {
    const result = (await convex.mutation(api.onboarding.markOrientationRead, {
      token: requireToken(),
    })) as { recorded: boolean };
    return result.recorded;
  },
};
