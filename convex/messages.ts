import { query, mutation, internalQuery } from './_generated/server';
import { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { requireUser, hasRole } from './lib/auth';
import { checkRateLimit, LIMITS } from './lib/rateLimit';
import { FIELD, optionalHttpUrl, text, validate } from './lib/input';

/**
 * Direct messages.
 *
 * The whole feature lived inline in `src/pages/MessagesPage.tsx` — eight direct
 * queries, a hard delete and a realtime channel, with no API module. That channel
 * subscribed to orbit_messages with NO filter (`:57`), so every client received
 * every message row in the system, including other people's conversations. Here
 * the queries are scoped server-side and `useQuery` replaces the subscription.
 */

export const conversations = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    /**
     * BOUNDED, on the timestamp indexes rather than the plain ones.
     *
     * This used to `.collect()` every message the user had ever sent AND every
     * one they had ever received, on every open of the inbox — O(lifetime
     * volume) for a list that only ever shows the latest message per
     * counterparty. Scoped to one user, so never a whole-table scan, but
     * unbounded in the dimension that actually grows.
     *
     * `by_sender_time` / `by_recipient_time` and not `by_sender` /
     * `by_recipient`: the plain indexes sort by `_creationTime` after the index
     * fields, and every imported row shares roughly the same `_creationTime` in
     * importer batch order. A `.take()` from those returns the most recently
     * IMPORTED messages, not the newest — so bounding on them would quietly
     * drop live conversations off the list. The schema says so at the index
     * definitions; this is the first read to depend on it.
     */
    const RECENT = 500;

    const [sent, received] = await Promise.all([
      ctx.db
        .query('messages')
        .withIndex('by_sender_time', (q) => q.eq('senderId', user._id))
        .order('desc')
        .take(RECENT),
      ctx.db
        .query('messages')
        .withIndex('by_recipient_time', (q) => q.eq('recipientId', user._id))
        .order('desc')
        .take(RECENT),
    ]);

    /**
     * Unread is counted EXACTLY, from its own index, rather than from the
     * bounded window above.
     *
     * The window decides which conversations are recent enough to list; it must
     * not decide the badge number. An unread count that silently drops messages
     * older than the window is worse than a slow one — the member sees a badge
     * that never clears and has no way to find what is behind it. Unread mail
     * is naturally small, so this stays cheap.
     */
    const unreadRows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_unread', (q) => q.eq('recipientId', user._id).eq('isRead', false))
      .take(2_000);

    const unreadByPartner = new Map<string, number>();
    for (const m of unreadRows) {
      const key = String(m.senderId);
      unreadByPartner.set(key, (unreadByPartner.get(key) ?? 0) + 1);
    }

    // One entry per counterparty, carrying the latest message and unread count.
    const byPartner = new Map<
      string,
      { partnerId: Id<'users'>; lastMessage: string; lastAt: number; unread: number }
    >();

    for (const m of [...sent, ...received]) {
      const partnerId = m.senderId === user._id ? m.recipientId : m.senderId;
      const key = String(partnerId);
      const entry =
        byPartner.get(key) ?? { partnerId, lastMessage: '', lastAt: 0, unread: 0 };

      if (m.createdAt > entry.lastAt) {
        entry.lastAt = m.createdAt;
        entry.lastMessage = m.content.slice(0, 120);
      }
      byPartner.set(key, entry);
    }

    // From the exact index count above, not from the bounded window.
    for (const [key, entry] of byPartner) {
      entry.unread = unreadByPartner.get(key) ?? 0;
    }

    /**
     * Partner lookups in parallel. This was a sequential `await` inside the
     * loop — one round trip per conversation, serialised, on every inbox open.
     */
    const entries = [...byPartner.values()];
    const partners = await Promise.all(entries.map((e) => ctx.db.get(e.partnerId)));

    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const partner = partners[i];
      if (!partner || partner.isDeleted) continue;
      out.push({
        partner: {
          id: partner._id,
          fullName: partner.fullName,
          profileSlug: partner.profileSlug,
          profilePhotoUrl: partner.profilePhotoUrl,
        },
        lastMessage: e.lastMessage,
        lastAt: e.lastAt,
        unread: e.unread,
      });
    }

    return out.sort((a, b) => b.lastAt - a.lastAt);
  },
});

export const thread = query({
  args: { token: v.string(), partnerId: v.id('users'), limit: v.optional(v.number()) },
  handler: async (ctx, { token, partnerId, limit }) => {
    const user = await requireUser(ctx, token);

    const [a, b] = await Promise.all([
      ctx.db
        .query('messages')
        .withIndex('by_pair', (q) => q.eq('senderId', user._id).eq('recipientId', partnerId))
        .collect(),
      ctx.db
        .query('messages')
        .withIndex('by_pair', (q) => q.eq('senderId', partnerId).eq('recipientId', user._id))
        .collect(),
    ]);

    return [...a, ...b]
      .sort((x, y) => x.createdAt - y.createdAt)
      .slice(-(limit ?? 200))
      .map((m) => ({
        id: m._id,
        content: m.content,
        attachmentUrl: m.attachmentUrl,
        senderId: m.senderId,
        isMine: m.senderId === user._id,
        isRead: m.isRead,
        readAt: m.readAt,
        createdAt: m.createdAt,
      }));
  },
});

export const unreadCount = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const unread = await ctx.db
      .query('messages')
      .withIndex('by_recipient_unread', (q) => q.eq('recipientId', user._id).eq('isRead', false))
      .collect();

    return unread.length;
  },
});

/**
 * The one path a direct message is written on.
 *
 * Shared by `send` and `replyTo` as a plain function rather than duplicated:
 * both must rate-limit, both must validate the recipient, and both must notify
 * exactly once. A second hand-rolled insert somewhere else is precisely how the
 * MCP server ended up producing a third notification per message.
 */
async function insertMessage(
  ctx: MutationCtx,
  sender: Doc<'users'>,
  args: {
    recipientId: Id<'users'>;
    content: string;
    attachmentUrl?: string;
    parentMessageId?: Id<'messages'>;
  },
) {
  // Every send queues an email to the recipient, so an unthrottled loop is an
  // email-bombing primitive against every user in the system. Keyed on the
  // SENDER, which is the authenticated identity actually being limited.
  //
  // It used to read `args.ipAddress || String(sender._id)` — preferring a value
  // the CALLER supplied, with no validation. Passing a fresh random string on
  // every call created a fresh bucket every time, so the cap never engaged and
  // `rateLimits` grew a row per request. The comment already said "keyed on the
  // sender"; the code did not. There is now no way for the caller to influence
  // the key.
  const limit = await checkRateLimit(
    ctx, String(sender._id), 'message_send',
    LIMITS.messageSend.max, LIMITS.messageSend.windowMs,
  );
  if (!limit.allowed) {
    return { success: false as const, error: 'You are sending messages too quickly.' };
  }

  /**
   * Bounded. Message content is interpolated into the notification email sent
   * to the recipient, so an unbounded message is also an unbounded outbound
   * email from ORBIT's own domain — which is the sort of thing that costs a
   * sending reputation rather than a database row.
   */
  const clean = validate(() => ({
    content: text(args.content, 'Message', FIELD.message),
    attachmentUrl: optionalHttpUrl(args.attachmentUrl, 'Attachment link'),
  }));
  if (!clean.ok) return { success: false as const, error: clean.error };

  const recipient = await ctx.db.get(args.recipientId);
  if (!recipient || !recipient.isActive || recipient.isDeleted) {
    return { success: false as const, error: 'Recipient is unavailable' };
  }

  const id = await ctx.db.insert('messages', {
    senderId: sender._id,
    recipientId: args.recipientId,
    content: clean.value.content,
    attachmentUrl: clean.value.attachmentUrl,
    parentMessageId: args.parentMessageId,
    isRead: false,
    isDummy: false,
    createdAt: Date.now(),
  });

  // The caller notifyNewMessage was written for. Two Postgres triggers fired
  // here and produced two notification rows per message; this is the one path.
  await ctx.runMutation(internal.notificationsInternal.notifyNewMessage, { messageId: id });

  return { success: true as const, id };
}

export const send = mutation({
  args: {
    token: v.string(),
    recipientId: v.id('users'),
    content: v.string(),
    attachmentUrl: v.optional(v.string()),
  },
  handler: async (ctx, { token, ...args }) => {
    const user = await requireUser(ctx, token);
    return insertMessage(ctx, user, args);
  },
});

/**
 * Messages addressed to the caller, newest first, with sender attached.
 *
 * Backs the MCP `list_agent_messages` tool. The Supabase version selected from
 * `orbit_messages` by recipient_id with the service key — correct by
 * construction only because the server hardcoded its own id into the filter.
 * Here the recipient IS the session, so it cannot read anyone else's inbox.
 */
export const inbox = query({
  args: { token: v.string(), unreadOnly: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, { token, unreadOnly, limit }) => {
    const user = await requireUser(ctx, token);

    // Ordered on indexes that carry `createdAt`. by_recipient / by_recipient_unread
    // would fall through to _creationTime, which for imported rows is the time
    // the importer ran — so "newest first" would mean "imported last".
    const take = Math.min(Math.max(limit ?? 20, 1), 100);

    const rows = unreadOnly
      ? await ctx.db
          .query('messages')
          .withIndex('by_recipient_unread_time', (q) =>
            q.eq('recipientId', user._id).eq('isRead', false),
          )
          .order('desc')
          .take(take)
      : await ctx.db
          .query('messages')
          .withIndex('by_recipient_time', (q) => q.eq('recipientId', user._id))
          .order('desc')
          .take(take);

    const out = [];
    for (const m of rows) {
      const sender = await ctx.db.get(m.senderId);
      out.push({
        id: m._id,
        content: m.content,
        isRead: m.isRead,
        createdAt: m.createdAt,
        parentMessageId: m.parentMessageId,
        sender: sender
          ? { id: sender._id, fullName: sender.fullName, profileSlug: sender.profileSlug }
          : null,
      });
    }
    return out;
  },
});

/**
 * Replies to a message the caller received, threading it to the original.
 *
 * The recipient is resolved from the parent SERVER-SIDE. The MCP version read
 * the original row, took `sender_id` from it and passed that back in as the new
 * message's recipient — two round trips over the service key, with the
 * ownership check ("Cannot reply to own message") done in the client.
 */
export const replyTo = mutation({
  args: { token: v.string(), messageId: v.id('messages'), content: v.string() },
  handler: async (ctx, { token, messageId, content }) => {
    const user = await requireUser(ctx, token);

    const parent = await ctx.db.get(messageId);
    if (!parent) return { success: false as const, error: 'Message not found' };

    // Only the person the message was SENT to may reply to it. Without this a
    // caller holding any message id could inject a reply into a conversation
    // they are not part of.
    if (parent.recipientId !== user._id) {
      return { success: false as const, error: 'You are not the recipient of that message.' };
    }

    return insertMessage(ctx, user, {
      recipientId: parent.senderId,
      content,
      parentMessageId: messageId,
    });
  },
});

/**
 * Marks one received message read, and clears its notification with it.
 *
 * `markThreadRead` covers the UI's flow; this exists because the MCP server
 * acknowledges individual messages. The Supabase tool patched by id with no
 * recipient check, so anyone could mark anyone's mail as read.
 */
export const markRead = mutation({
  args: { token: v.string(), messageId: v.id('messages') },
  handler: async (ctx, { token, messageId }) => {
    const user = await requireUser(ctx, token);

    const message = await ctx.db.get(messageId);

    // Same result for "missing" and "not yours", so this cannot confirm that a
    // given message id exists.
    if (!message || message.recipientId !== user._id) return { success: true as const, updated: 0 };
    if (message.isRead) return { success: true as const, updated: 0 };

    const now = Date.now();
    await ctx.db.patch(messageId, { isRead: true, readAt: now });

    const linked = await ctx.db
      .query('notifications')
      .withIndex('by_user_unread', (q) => q.eq('userId', user._id).eq('isRead', false))
      .collect();

    for (const n of linked.filter((n) => n.relatedMessageId === messageId)) {
      await ctx.db.patch(n._id, { isRead: true, readAt: now });
    }

    return { success: true as const, updated: 1 };
  },
});

/**
 * Marks a received message unread again.
 *
 * The page offers this beside "mark read", and the Supabase version patched by
 * id with no recipient predicate — so anyone holding a message id could flip
 * anyone's mail back to unread and relight their badge.
 */
export const markUnread = mutation({
  args: { token: v.string(), messageId: v.id('messages') },
  handler: async (ctx, { token, messageId }) => {
    const user = await requireUser(ctx, token);

    const message = await ctx.db.get(messageId);
    if (!message || message.recipientId !== user._id) return { success: true as const, updated: 0 };
    if (!message.isRead) return { success: true as const, updated: 0 };

    // readAt is REMOVED, not zeroed: patch drops a field set to undefined, and
    // a message that is unread has no read time.
    await ctx.db.patch(messageId, { isRead: false, readAt: undefined });
    return { success: true as const, updated: 1 };
  },
});

/**
 * One message and its replies, for the inbox's thread pane.
 *
 * The page built this as `.or('id.eq.<x>,parent_message_id.eq.<x>')` — a filter
 * string interpolating a raw id, over a table with no RLS, so it returned any
 * thread whose root id the caller could name regardless of who it belonged to.
 * Here the root's parties are checked first and the replies are read from an
 * index.
 */
export const threadOf = query({
  args: { token: v.string(), messageId: v.id('messages') },
  handler: async (ctx, { token, messageId }) => {
    const user = await requireUser(ctx, token);

    const root = await ctx.db.get(messageId);
    if (!root) return [];

    // Selecting a reply opens the thread it belongs to, so resolve to the root
    // first — otherwise a reply's own id would return an empty thread.
    const rootId = root.parentMessageId ?? root._id;
    const actualRoot = rootId === root._id ? root : await ctx.db.get(rootId);
    if (!actualRoot) return [];

    if (actualRoot.senderId !== user._id && actualRoot.recipientId !== user._id) {
      // Empty rather than an error: the inbox lists ids the caller owns, so a
      // refusal here is either a stale row or someone guessing.
      return [];
    }

    const replies = await ctx.db
      .query('messages')
      .withIndex('by_parent', (q) => q.eq('parentMessageId', rootId))
      .collect();

    const withSender = [];
    for (const m of [actualRoot, ...replies].sort((a, b) => a.createdAt - b.createdAt)) {
      const sender = await ctx.db.get(m.senderId);
      withSender.push({
        id: m._id,
        content: m.content,
        attachmentUrl: m.attachmentUrl,
        senderId: m.senderId,
        recipientId: m.recipientId,
        isMine: m.senderId === user._id,
        isRead: m.isRead,
        readAt: m.readAt,
        parentMessageId: m.parentMessageId,
        createdAt: m.createdAt,
        sender: sender
          ? {
              id: sender._id,
              fullName: sender.fullName,
              profilePhotoUrl: sender.profilePhotoUrl,
            }
          : null,
      });
    }
    return withSender;
  },
});

export const markThreadRead = mutation({
  args: { token: v.string(), partnerId: v.id('users') },
  handler: async (ctx, { token, partnerId }) => {
    const user = await requireUser(ctx, token);
    const now = Date.now();

    const incoming = await ctx.db
      .query('messages')
      .withIndex('by_pair', (q) => q.eq('senderId', partnerId).eq('recipientId', user._id))
      .collect();

    // Collected ONCE, not per message: re-reading every unread notification
    // inside the loop made this O(messages x notifications).
    const unreadNotifications = await ctx.db
      .query('notifications')
      .withIndex('by_user_unread', (q) => q.eq('userId', user._id).eq('isRead', false))
      .collect();

    const notificationsByMessage = new Map<string, typeof unreadNotifications>();
    for (const n of unreadNotifications) {
      if (!n.relatedMessageId) continue;
      const key = String(n.relatedMessageId);
      notificationsByMessage.set(key, [...(notificationsByMessage.get(key) ?? []), n]);
    }

    let updated = 0;
    for (const m of incoming) {
      if (m.isRead) continue;
      await ctx.db.patch(m._id, { isRead: true, readAt: now });

      // sync_message_read_status kept the linked notification in step. Without
      // it the badge count stays lit after the thread has been read.
      for (const n of notificationsByMessage.get(String(m._id)) ?? []) {
        await ctx.db.patch(n._id, { isRead: true, readAt: now });
      }
      updated++;
    }

    return { success: true as const, updated };
  },
});

/**
 * Deletes a message the caller sent.
 *
 * `MessagesPage.tsx:221` hard-deleted by id with no ownership check at all —
 * anyone could delete anyone's message if they knew its id, since RLS did not
 * cover this table.
 */
export const remove = mutation({
  args: { token: v.string(), messageId: v.id('messages') },
  handler: async (ctx, { token, messageId }) => {
    const user = await requireUser(ctx, token);

    const message = await ctx.db.get(messageId);
    if (!message) return { success: true as const };

    // EITHER party may delete. The shipped delete button operates on messages
    // the user RECEIVED (MessagesPage.tsx:102-109 loads by recipient_id), so a
    // sender-only rule would break the primary flow. What the original lacked
    // was any check at all — anyone holding an id could delete anyone's message.
    const isParty = message.senderId === user._id || message.recipientId === user._id;
    if (!isParty && !hasRole(user, 'admin', 'super_admin')) {
      throw new Error('Not your message');
    }

    // Its notification would otherwise dangle unread against a row that no
    // longer exists.
    const linked = await ctx.db
      .query('notifications')
      .withIndex('by_user', (q) => q.eq('userId', message.recipientId))
      .collect();
    for (const n of linked.filter((n) => n.relatedMessageId === messageId)) {
      await ctx.db.delete(n._id);
    }

    await ctx.db.delete(messageId);
    return { success: true as const };
  },
});

/**
 * Threads where the last word was someone else's — i.e. awaiting a reply.
 *
 * `conversations` is built for an inbox screen and returns a shape geared to
 * rendering. This answers the operational question instead: who wrote to us and
 * has not been answered.
 */
export const awaitingReply = internalQuery({
  args: { userEmail: v.string(), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      otherUserId: v.string(),
      otherName: v.string(),
      lastFromThem: v.string(),
      lastAt: v.number(),
      unread: v.number(),
    }),
  ),
  handler: async (ctx, { userEmail, limit }) => {
    const me = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', userEmail.toLowerCase()))
      .unique();
    if (!me) return [];

    const inbound = await ctx.db
      .query('messages')
      .withIndex('by_recipient_time', (q) => q.eq('recipientId', me._id))
      .order('desc')
      .take(500);

    const byPerson = new Map<string, { last: number; body: string; unread: number }>();
    for (const m of inbound) {
      const k = String(m.senderId);
      const cur = byPerson.get(k);
      if (!cur) byPerson.set(k, { last: m.createdAt, body: m.content, unread: m.isRead ? 0 : 1 });
      else if (!m.isRead) cur.unread++;
    }

    const out = [];
    for (const [uid, v2] of byPerson) {
      // A busy sent inbox must not push this conversation's reply out of view.
      const reply = await ctx.db
        .query('messages')
        .withIndex('by_pair_and_time', (q) =>
          q.eq('senderId', me._id).eq('recipientId', uid as Id<'users'>).gt('createdAt', v2.last),
        )
        .first();
      if (reply) continue;
      const u = await ctx.db.get(uid as Id<'users'>);
      if (!u) continue;
      out.push({
        otherUserId: uid,
        otherName: u.fullName,
        lastFromThem: v2.body.slice(0, 400),
        lastAt: v2.last,
        unread: v2.unread,
      });
    }
    out.sort((a, b) => a.lastAt - b.lastAt);
    return out.slice(0, limit ?? 40);
  },
});

/** Raw inbound/outbound tallies, to sanity-check `awaitingReply`. */
export const trafficFor = internalQuery({
  args: { userEmail: v.string() },
  returns: v.object({ inbound: v.number(), outbound: v.number(), distinctSenders: v.number() }),
  handler: async (ctx, { userEmail }) => {
    const me = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', userEmail.toLowerCase()))
      .unique();
    if (!me) return { inbound: 0, outbound: 0, distinctSenders: 0 };
    const inb = await ctx.db.query('messages')
      .withIndex('by_recipient', (q) => q.eq('recipientId', me._id)).take(600);
    const outb = await ctx.db.query('messages')
      .withIndex('by_sender', (q) => q.eq('senderId', me._id)).take(600);
    return { inbound: inb.length, outbound: outb.length,
             distinctSenders: new Set(inb.map((m) => String(m.senderId))).size };
  },
});
