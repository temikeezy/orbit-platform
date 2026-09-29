import { internalQuery, mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { requireAdmin, hasRole } from './lib/auth';

/**
 * The switch that holds every outgoing email.
 *
 * ORBIT sends real mail to real people — magic links, application receipts,
 * approvals, logbook reminders. During a change to who should receive what, the
 * safe position is to stop sending and decide afterwards, rather than discover
 * afterwards that a cohort was emailed something wrong. That is not a thing
 * anyone should need a terminal to do, so it lives here.
 *
 * HOLDS, NEVER DISCARDS. Paused, `email.processQueue` returns before claiming
 * anything: rows stay `pending`, no retry budget is spent, nothing is marked
 * failed, and releasing the pause drains the backlog in order on the next
 * two-minute run. Deliberately unlike `EMAIL_ALLOWLIST`, which throws per
 * recipient and eventually abandons the message it refused.
 *
 * The `EMAIL_PAUSED` environment variable remains as a second, independent
 * brake — it works without a database read and without an admin session, which
 * is what you want when something is going wrong. EITHER holds the queue.
 */

export const EMAIL_DISPATCH_SETTING = 'email_dispatch_paused';

/** The stored shape. An object, so a reason can travel with the decision. */
export interface EmailDispatchState {
  paused: boolean;
  /** Why, for whoever finds the queue stopped and did not stop it. */
  reason?: string;
  pausedByName?: string;
  pausedAt?: number;
}

function readState(raw: unknown): EmailDispatchState {
  if (typeof raw !== 'object' || raw === null) return { paused: false };
  const value = raw as Record<string, unknown>;
  return {
    paused: value.paused === true,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    pausedByName: typeof value.pausedByName === 'string' ? value.pausedByName : undefined,
    pausedAt: typeof value.pausedAt === 'number' ? value.pausedAt : undefined,
  };
}

/**
 * Read by the queue drain. Internal: the cron has no session to authenticate.
 *
 * Fails OPEN on a missing row — mail flowing is the normal state, and a
 * deployment that has never had this setting written should not sit silently
 * not sending.
 */
export const dispatchState = internalQuery({
  args: {},
  handler: async (ctx): Promise<EmailDispatchState> => {
    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', EMAIL_DISPATCH_SETTING))
      .unique();

    return readState(row?.settingValue);
  },
});

/** What the Settings screen shows. Admins may look; only super admins may change. */
export const status = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', EMAIL_DISPATCH_SETTING))
      .unique();

    const state = readState(row?.settingValue);

    // How much is waiting behind the pause, so the decision to release it is
    // made knowing what will go out. Capped: the number is for a human to read.
    const pending = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_sent_at', (q) => q.eq('status', 'pending'))
      .take(501);

    /**
     * The screen must not claim mail is flowing when it is not.
     *
     * There are two brakes and only one of them is a setting. If the screen
     * reported the setting alone, an `EMAIL_PAUSED` deployment would show
     * "sending normally" while the queue sat still — the most misleading thing
     * this page could say, and the toggle would appear to do nothing. So the
     * environment brake is reported too, and named separately because it
     * cannot be released from here.
     */
    const pausedByEnv = Boolean(process.env.EMAIL_PAUSED);

    return {
      ...state,
      paused: state.paused || pausedByEnv,
      pausedBySetting: state.paused,
      pausedByEnv,
      queued: Math.min(pending.length, 500),
      queuedIsCapped: pending.length > 500,
    };
  },
});

/**
 * Stops or resumes all outgoing mail. SUPER ADMIN ONLY, and audited.
 *
 * A tighter gate than most settings carry: this one can silently stop every
 * password reset and application receipt in the platform, and the symptom
 * — mail simply not arriving — is the hardest kind to trace back to a cause.
 * Recording who, when and why is most of what makes it safe to have at all.
 *
 * CREATES the row when absent, unlike `adminSettings.set`, whose keys come from
 * migrations. This key belongs to this feature, so refusing to create it would
 * leave the switch unusable on a fresh deployment.
 */
export const setPaused = mutation({
  args: { token: v.string(), paused: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { token, paused, reason }) => {
    const admin = await requireAdmin(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can pause or resume email.' };
    }

    /**
     * A pause must say why.
     *
     * Recording who and when is most of what makes this safe to have; without
     * the why, the next person finds a stopped queue and an audit row that
     * tells them nothing they could not already see. Required on the server
     * rather than only in the form, because the form is not the gate.
     */
    const why = reason?.trim() ?? '';
    if (paused && !why) {
      return { success: false as const, error: 'Give a reason for holding email.' };
    }

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', EMAIL_DISPATCH_SETTING))
      .unique();

    const now = Date.now();
    const value: EmailDispatchState = paused
      ? {
          paused: true,
          reason: why.slice(0, 300),
          pausedByName: admin.fullName,
          pausedAt: now,
        }
      : // Resuming clears the note with it: a stale "paused for the migration"
        // sitting beside a running queue is worse than no note.
        { paused: false };

    if (row) {
      await ctx.db.patch(row._id, { settingValue: value, updatedBy: admin._id, updatedAt: now });
    } else {
      await ctx.db.insert('adminSettings', {
        settingKey: EMAIL_DISPATCH_SETTING,
        settingValue: value,
        category: 'general',
        description: 'Holds all outgoing email when on',
        updatedBy: admin._id,
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.setting_changed',
      tableName: 'adminSettings',
      recordId: row?._id,
      oldValues: row ? { settingValue: row.settingValue } : undefined,
      newValues: { settingValue: value },
      success: true,
      createdAt: now,
    });

    return { success: true as const, paused };
  },
});
