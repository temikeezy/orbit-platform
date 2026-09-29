import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';

/**
 * The switch that holds every outgoing email.
 *
 * See `convex/emailDispatch.ts` for why it holds rather than discards, and why
 * there is a second, environment-variable brake beside it.
 */

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export interface EmailDispatchStatus {
  /** True if EITHER brake is on. */
  paused: boolean;
  /** The setting, which this screen can toggle. */
  pausedBySetting?: boolean;
  /** The EMAIL_PAUSED environment variable, which it cannot. */
  pausedByEnv?: boolean;
  reason?: string;
  pausedByName?: string;
  pausedAt?: number;
  /** How much mail is waiting behind the pause. */
  queued: number;
  /** True when `queued` hit its display ceiling and the real figure is higher. */
  queuedIsCapped: boolean;
}

export const emailDispatchApi = {
  async status(): Promise<EmailDispatchStatus> {
    return convex.query(api.emailDispatch.status, { token: requireToken() });
  },

  async setPaused(paused: boolean, reason?: string): Promise<void> {
    const result = await convex.mutation(api.emailDispatch.setPaused, {
      token: requireToken(),
      paused,
      reason,
    });
    if (!result.success) throw new Error(result.error);
  },
};
