import { query } from './_generated/server';
import { v } from 'convex/values';
import { requireUser, hasRole } from './lib/auth';

/**
 * Reading the audit log.
 *
 * Nothing could. Rows are written from a dozen places — role changes, MCP
 * actions, password resets, permanent deletions, failed sign-ins — and there was
 * no query anywhere in `convex/` that read one back, and no page in the app that
 * showed them. An audit trail nobody can read is a compliance artefact, not a
 * control: it tells you nothing until someone exports the table by hand, which
 * is exactly when you least want to be doing that.
 *
 * Admin-gated, because the rows carry other people's email addresses, IP
 * addresses and the before/after of privileged changes.
 */

export const list = query({
  args: {
    token: v.string(),
    action: v.optional(v.string()),
    userId: v.optional(v.id('users')),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, action, userId, limit }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin')) throw new Error('Admin access required');

    const cap = Math.min(Math.max(limit ?? 100, 1), 500);

    // Indexes that CARRY createdAt. by_action and by_user alone fall through to
    // _creationTime, so `.take(cap)` took the wrong rows and the sort afterwards
    // just ordered the wrong set — for imported rows, whose _creationTime is
    // importer batch order, a filtered read could omit the newest entry.
    const rows = action
      ? await ctx.db
          .query('auditLogs')
          .withIndex('by_action_and_time', (q) => q.eq('action', action))
          .order('desc')
          .take(cap)
      : userId
        ? await ctx.db
            .query('auditLogs')
            .withIndex('by_user_and_time', (q) => q.eq('userId', userId))
            .order('desc')
            .take(cap)
        : await ctx.db.query('auditLogs').withIndex('by_time').order('desc').take(cap);

    return rows.map((r) => ({
      id: r._id,
      action: r.action,
      userEmail: r.userEmail,
      userRoles: r.userRoles,
      tableName: r.tableName,
      recordId: r.recordId,
      oldValues: r.oldValues,
      newValues: r.newValues,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      success: r.success,
      errorMessage: r.errorMessage,
      metadata: r.metadata,
      createdAt: r.createdAt,
    }));
  },
});

/** Distinct actions present, so a filter UI has something to offer. */
export const actions = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin')) throw new Error('Admin access required');

    // Bounded to the recent window rather than the whole table: a filter list
    // that requires reading every audit row ever written defeats the point of
    // having indexed the table.
    const recent = await ctx.db.query('auditLogs').withIndex('by_time').order('desc').take(1000);
    return [...new Set(recent.map((r) => r.action))].sort();
  },
});
