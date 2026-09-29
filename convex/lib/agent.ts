import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { agentEmail } from './org';

/** Re-exported so callers can import the agent identity from one place. */
export { agentEmail };

/**
 * The ORBIT Agent's own account — the name on every decision the platform now
 * makes without a person: admissions, logbook reviews, sign-offs. Looked up by
 * email because that is the identity CLAUDE.md fixes for platform-voice actions.
 */
export async function agentAccount(ctx: QueryCtx | MutationCtx): Promise<Doc<'users'> | null> {
  return ctx.db
    .query('users')
    .withIndex('by_email', (q) => q.eq('email', agentEmail()))
    .unique();
}
