import { internalMutation, mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { requireUser, requireAdmin } from './lib/auth';
import { isSafeActionUrl } from './lib/html';

/**
 * Notifications.
 *
 * On Supabase, mark-as-read never worked: orbit_notifications' only UPDATE
 * policy was scoped to auth.uid(), but ORBIT authenticates with its own bearer
 * token over the anon key, so the connection role was `anon` and auth.uid() was
 * always null. RLS silently denied the write, the client's .update() matched
 * zero rows, and the UI reported success.
 *
 * That whole class of failure is gone here: there is no ambient policy layer to
 * disagree with, and the userId predicate below IS the authorization — a caller
 * can only ever touch their own rows.
 */

/**
 * Caller-supplied limits are clamped, matching posts.ts. Unclamped, a negative
 * value reached `.take(-1)` and threw, and a huge one scanned to Convex's
 * transaction limits. Self-scoped either way, but a query that throws on a
 * number the client can pass is a bug regardless of who pays for it.
 */
function clampLimit(v: number | undefined, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(Math.floor(v), 200);
}

/**
 * Keeps the notification inbox useful without treating it as a permanent
 * audit log. Read items are retained for a month; unread items get six months
 * so an infrequent member does not lose unseen platform activity.
 */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const SWEEP_PAGE = 500;
    const now = Date.now();

    // Separate indexed pages prevent a large unread backlog from hiding read
    // rows that are already safe to remove, and vice versa. Repeated cron runs
    // drain either backlog without approaching a transaction-sized scan.
    const read = await ctx.db
      .query('notifications')
      .withIndex('by_read_and_time', (q) =>
        q.eq('isRead', true).lt('createdAt', now - 30 * DAY_MS),
      )
      .take(SWEEP_PAGE);
    const unread = await ctx.db
      .query('notifications')
      .withIndex('by_read_and_time', (q) =>
        q.eq('isRead', false).lt('createdAt', now - 180 * DAY_MS),
      )
      .take(SWEEP_PAGE);

    for (const row of [...read, ...unread]) {
      await ctx.db.delete(row._id);
    }

    return { removed: read.length + unread.length };
  },
});

export const list = query({
  args: {
    token: v.string(),
    limit: v.optional(v.number()),
    unreadOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, limit, unreadOnly }) => {
    const user = await requireUser(ctx, token);

    // by_user_and_time for the general case: `by_user` falls through to
    // _creationTime, which for imported rows is the time the importer ran, so
    // "newest first" would mean "imported last" after cutover. The unread index
    // has no time component, so that branch is sorted after the fact — it is
    // bounded by how many notifications one person can have unread.
    const rows = unreadOnly
      ? (
          await ctx.db
            .query('notifications')
            .withIndex('by_user_unread', (q) => q.eq('userId', user._id).eq('isRead', false))
            .collect()
        )
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, clampLimit(limit, 50))
      : await ctx.db
          .query('notifications')
          .withIndex('by_user_and_time', (q) => q.eq('userId', user._id))
          .order('desc')
          .take(clampLimit(limit, 50));

    return rows.map((n) => ({
      id: n._id,
      type: n.type,
      title: n.title,
      content: n.content,
      actionUrl: n.actionUrl,
      referenceType: n.referenceType,
      referenceId: n.referenceId,
      relatedTaskId: n.relatedTaskId,
      relatedStreamId: n.relatedStreamId,
      relatedUserId: n.relatedUserId,
      relatedMessageId: n.relatedMessageId,
      isRead: n.isRead,
      readAt: n.readAt,
      createdAt: n.createdAt,
    }));
  },
});

export const unreadCount = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const unread = await ctx.db
      .query('notifications')
      .withIndex('by_user_unread', (q) => q.eq('userId', user._id).eq('isRead', false))
      .collect();

    return unread.length;
  },
});

export const markRead = mutation({
  args: { token: v.string(), notificationId: v.id('notifications') },
  handler: async (ctx, { token, notificationId }) => {
    const user = await requireUser(ctx, token);

    const row = await ctx.db.get(notificationId);

    // Ownership is checked rather than assumed. Returning the same result for
    // "not found" and "belongs to someone else" keeps the endpoint from
    // confirming that a given notification id exists.
    if (!row || row.userId !== user._id) return { success: true, updated: 0 };
    if (row.isRead) return { success: true, updated: 0 };

    await ctx.db.patch(notificationId, { isRead: true, readAt: Date.now() });
    return { success: true, updated: 1 };
  },
});

/**
 * Deletes one of the caller's own notifications.
 *
 * The page did this with a direct `.delete().eq('id', ...)` and no user
 * predicate at all — it named only the row id. That it did not delete other
 * people's notifications was down to an RLS policy, and the same policy
 * mechanism is what silently broke mark-as-read for everyone (the connection
 * role was `anon`, so auth.uid() was null). Here the ownership check IS the
 * authorization, and it is in the same place as the write.
 */
export const remove = mutation({
  args: { token: v.string(), notificationId: v.id('notifications') },
  handler: async (ctx, { token, notificationId }) => {
    const user = await requireUser(ctx, token);

    const row = await ctx.db.get(notificationId);

    // Same result for "not found" and "not yours", so the endpoint cannot be
    // used to confirm that an id exists.
    if (!row || row.userId !== user._id) return { success: true as const, deleted: 0 };

    await ctx.db.delete(notificationId);
    return { success: true as const, deleted: 1 };
  },
});

/**
 * Sends an ad-hoc in-app notification to one user. Admin only.
 *
 * Backs the MCP `send_notification` tool. Notification ONLY — no email — which
 * is what the Supabase tool did, and is why `queue_email_alert` exists beside
 * it: the two are separate deliberate acts, not one with a flag.
 *
 * Unlike the trigger-derived notifications in `notificationsInternal.ts`, this
 * consults no preference key. There is no preference covering "an admin sent you
 * a message about something"; the closest keys all describe specific platform
 * events, and reusing one would silence this for anyone who muted that event.
 */
export const adminSend = mutation({
  args: {
    token: v.string(),
    userId: v.id('users'),
    title: v.string(),
    content: v.string(),
    type: v.optional(v.string()),
    actionUrl: v.optional(v.string()),
  },
  handler: async (ctx, { token, userId, title, content, type, actionUrl }) => {
    await requireAdmin(ctx, token);

    const target = await ctx.db.get(userId);
    if (!target || target.isDeleted || !target.isActive) {
      return { success: false as const, error: 'Recipient is unavailable' };
    }

    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (!trimmedTitle || !trimmedContent) {
      return { success: false as const, error: 'Title and content are required' };
    }

    // The client renders actionUrl as an href. Absolute URLs would let a caller
    // put an ORBIT-branded notification behind a link to their own host, and
    // `javascript:`/`data:` are worse still. Only in-app paths are accepted —
    // and this is the one notification path whose url comes from a caller
    // rather than from server code.
    if (actionUrl !== undefined && !isSafeActionUrl(actionUrl)) {
      return {
        success: false as const,
        error: 'actionUrl must be an app-relative path, e.g. /tasks/<id>',
      };
    }

    const id = await ctx.db.insert('notifications', {
      userId,
      type: type ?? 'general',
      title: trimmedTitle,
      content: trimmedContent,
      actionUrl,
      isRead: false,
      isDummy: false,
      createdAt: Date.now(),
    });

    return { success: true as const, id };
  },
});

export const markAllRead = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    const now = Date.now();

    const unread = await ctx.db
      .query('notifications')
      .withIndex('by_user_unread', (q) => q.eq('userId', user._id).eq('isRead', false))
      .collect();

    for (const n of unread) {
      await ctx.db.patch(n._id, { isRead: true, readAt: now });
    }

    return { success: true, updated: unread.length };
  },
});
