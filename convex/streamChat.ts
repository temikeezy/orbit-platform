import { query, mutation, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { requireUser, hasRole } from './lib/auth';
import { isStreamModerator } from './streams';
import { activeMembership } from './lib/membership';
import { FIELD, optionalHttpUrl, text, validate } from './lib/input';

/**
 * Stream chat.
 *
 * Had no API module at all — every query lived inline in
 * `src/components/activity/StreamChat.tsx`, including a realtime subscription
 * whose callback then issued a second Supabase read per message to hydrate the
 * sender (`:56`). Here the sender is joined server-side, so the client receives
 * complete rows and `useQuery` keeps them live with no follow-up fetch.
 */

async function assertMember(
  ctx: QueryCtx,
  streamId: Id<'streams'>,
  user: Doc<'users'>,
): Promise<void> {
  if (hasRole(user, 'admin', 'super_admin')) return;

  // Stream chat was readable by anyone who knew a stream id, since the inline
  // query had no membership check and RLS did not cover this table.
  //
  // activeMembership, not .first() — see convex/lib/membership.ts. Here the
  // stale-row case fails CLOSED, locking a legitimate member out of their own
  // stream's chat, which is how the duplicate-row problem first showed up.
  if (!(await activeMembership(ctx, streamId, user._id))) {
    throw new Error('Not a member of this stream');
  }
}

/**
 * The client asks for 100. The bound exists because the argument is
 * caller-controlled and each row costs a document read to join its sender, so
 * an unclamped value is a cheap way to make the deployment do unbounded work.
 */
const MAX_MESSAGES = 200;

export const list = query({
  args: { token: v.string(), streamId: v.id('streams'), limit: v.optional(v.number()) },
  handler: async (ctx, { token, streamId, limit }) => {
    const user = await requireUser(ctx, token);
    await assertMember(ctx, streamId, user);

    const rows = await ctx.db
      .query('streamChat')
      .withIndex('by_stream_and_time', (q) => q.eq('streamId', streamId))
      .order('desc')
      .take(Math.min(Math.max(Math.trunc(limit ?? 100), 1), MAX_MESSAGES));

    const out = [];
    for (const m of rows.reverse()) {
      const sender = await ctx.db.get(m.userId);
      out.push({
        id: m._id,
        content: m.content,
        attachmentUrl: m.attachmentUrl,
        isAnnouncement: m.isAnnouncement,
        createdAt: m.createdAt,
        sender: sender
          ? {
              id: sender._id,
              fullName: sender.fullName,
              profileSlug: sender.profileSlug,
              profilePhotoUrl: sender.profilePhotoUrl,
            }
          : null,
      });
    }
    return out;
  },
});

export const send = mutation({
  args: {
    token: v.string(),
    streamId: v.id('streams'),
    content: v.string(),
    attachmentUrl: v.optional(v.string()),
    isAnnouncement: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, streamId, content, attachmentUrl, isAnnouncement }) => {
    const user = await requireUser(ctx, token);
    await assertMember(ctx, streamId, user);

    const clean = validate(() => ({
      content: text(content, 'Message', FIELD.chatMessage),
      attachmentUrl: optionalHttpUrl(attachmentUrl, 'Attachment link'),
    }));
    if (!clean.ok) return { success: false as const, error: clean.error };

    // Announcements are a moderator affordance; the inline version let any
    // member set the flag because it passed the field straight through.
    const announce =
      isAnnouncement === true &&
      (hasRole(user, 'admin', 'super_admin') || (await isStreamModerator(ctx, streamId, user._id)));

    const id = await ctx.db.insert('streamChat', {
      streamId,
      userId: user._id,
      content: clean.value.content,
      attachmentUrl: clean.value.attachmentUrl,
      isAnnouncement: announce,
      isDummy: false,
      createdAt: Date.now(),
    });

    return { success: true as const, id };
  },
});
