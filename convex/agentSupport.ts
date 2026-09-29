import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { agentAccount } from './lib/agent';

/**
 * ANSWERING INTERNS, WITHOUT A PERSON AT THE OTHER END.
 *
 * Interns message the ORBIT Agent — "why is there no task this week", "my link
 * is shared, why can't you open it", "I was ill, can I submit late". Until now
 * someone drove the agent account by hand to reply; with nobody operating the
 * portal those messages would go unanswered for good.
 *
 * `scripts/agent/support.py` drafts each reply with no tools, grounded in
 * scripts/agent/SUPPORT_FAQ.md and in the intern's own ORBIT state returned
 * here, and has a second model check the draft makes no claim the facts do not
 * support before it is sent. Replies come from the agent's own account, so the
 * thread shows plainly who is answering.
 */

const LOOKBACK_MS = 14 * 86_400_000;

/** Conversations whose newest message is the intern's, with context to answer it. */
export const pendingConversations = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      internId: v.string(),
      firstName: v.string(),
      latestMessageId: v.string(),
      thread: v.array(v.object({ from: v.string(), content: v.string(), at: v.number() })),
      context: v.object({
        programmeType: v.string(),
        streams: v.array(v.string()),
        submissions: v.array(
          v.object({ task: v.string(), status: v.string(), score: v.union(v.number(), v.null()), note: v.string() }),
        ),
        liveTasks: v.number(),
      }),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const agent = await agentAccount(ctx);
    if (!agent) return [];
    const since = Date.now() - LOOKBACK_MS;

    const inbound = await ctx.db
      .query('messages')
      .withIndex('by_recipient_time', (q) => q.eq('recipientId', agent._id).gte('createdAt', since))
      .collect();

    // Newest inbound per intern.
    const latest = new Map<string, (typeof inbound)[number]>();
    for (const m of inbound) {
      const k = String(m.senderId);
      if (!latest.has(k) || latest.get(k)!.createdAt < m.createdAt) latest.set(k, m);
    }

    // Live-task counts per stream, computed once per call: interns share
    // streams, and re-reading a stream's whole task history per conversation
    // is the path to this query's read limit.
    const liveByStream = new Map<string, number>();
    const out = [];
    for (const [senderKey, last] of latest) {
      if (out.length >= Math.max(1, Math.min(limit ?? 15, 40))) break;
      const senderId = senderKey as Id<'users'>;
      // Answered already if the agent has written to them since.
      const replied = await ctx.db
        .query('messages')
        .withIndex('by_pair_and_time', (q) =>
          q.eq('senderId', agent._id).eq('recipientId', senderId).gt('createdAt', last.createdAt),
        )
        .first();
      if (replied) continue;

      const sender = await ctx.db.get(senderId);
      if (!sender || !sender.isActive || sender.isDeleted) continue;
      // Staff do not need the helpdesk, and an agent replying to an admin's
      // instruction as though it were a question would be worse than silence.
      if (sender.roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'moderator')) continue;

      const mine = await ctx.db
        .query('messages')
        .withIndex('by_pair_and_time', (q) => q.eq('senderId', senderId).eq('recipientId', agent._id))
        .order('desc')
        .take(6);
      const theirs = await ctx.db
        .query('messages')
        .withIndex('by_pair_and_time', (q) => q.eq('senderId', agent._id).eq('recipientId', senderId))
        .order('desc')
        .take(6);
      const thread = [...mine.map((m) => ({ m, from: 'intern' })), ...theirs.map((m) => ({ m, from: 'agent' }))]
        .sort((a, b) => a.m.createdAt - b.m.createdAt)
        .slice(-8)
        .map(({ m, from }) => ({ from, content: m.content.slice(0, 2000), at: m.createdAt }));

      const subs = await ctx.db
        .query('submissions')
        .withIndex('by_user', (q) => q.eq('userId', senderId))
        .order('desc')
        .take(8);
      const submissions = [];
      for (const s of subs) {
        const t = await ctx.db.get(s.taskId);
        submissions.push({
          task: t?.title ?? '(task removed)',
          status: s.status,
          score: s.score ?? null,
          note: s.agentAssessment && s.status === 'submitted'
            ? `set aside by the marker: ${s.agentAssessment.outcome}${s.agentAssessment.detail ? ` (${s.agentAssessment.detail})` : ''}`
            : '',
        });
      }

      const memberships = await ctx.db
        .query('streamMemberships')
        .withIndex('by_user', (q) => q.eq('userId', senderId))
        .collect();
      const streams = [];
      let liveTasks = 0;
      for (const m of memberships.filter((x) => x.isActive)) {
        const st = await ctx.db.get(m.streamId);
        if (!st) continue;
        streams.push(st.name);
        const key = String(st._id);
        if (!liveByStream.has(key)) {
          const recent = await ctx.db
            .query('tasks')
            .withIndex('by_stream', (q) => q.eq('streamId', st._id))
            .order('desc')
            .take(50);
          liveByStream.set(key, recent.filter(
            (t) => t.isActive && t.approvalStatus === 'approved' && (t.deadline ?? 0) > Date.now(),
          ).length);
        }
        liveTasks += liveByStream.get(key) ?? 0;
      }

      out.push({
        internId: senderKey,
        firstName: (sender.fullName ?? '').split(' ')[0] || 'there',
        latestMessageId: String(last._id),
        thread,
        context: { programmeType: sender.programmeType ?? 'internship', streams, submissions, liveTasks },
      });
    }
    return out;
  },
});

/** Sends the agent's reply, unless someone already answered since. */
export const reply = internalMutation({
  args: { internId: v.id('users'), inReplyTo: v.id('messages'), content: v.string() },
  returns: v.object({ sent: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { internId, inReplyTo, content }) => {
    const agent = await agentAccount(ctx);
    if (!agent) return { sent: false, reason: 'ORBIT Agent account not found' };
    const original = await ctx.db.get(inReplyTo);
    if (!original) return { sent: false, reason: 'message gone' };
    const already = await ctx.db
      .query('messages')
      .withIndex('by_pair_and_time', (q) =>
        q.eq('senderId', agent._id).eq('recipientId', internId).gt('createdAt', original.createdAt),
      )
      .first();
    if (already) return { sent: false, reason: 'already answered' };
    // They wrote again while this was being drafted. Replying now would mark
    // the NEWER message answered too; the next cycle answers the whole thread.
    const newer = await ctx.db
      .query('messages')
      .withIndex('by_pair_and_time', (q) =>
        q.eq('senderId', internId).eq('recipientId', agent._id).gt('createdAt', original.createdAt),
      )
      .first();
    if (newer) return { sent: false, reason: 'a newer message arrived' };
    const text = content.trim().slice(0, 2000);
    if (text.length < 5) return { sent: false, reason: 'empty reply' };

    const id = await ctx.db.insert('messages', {
      senderId: agent._id,
      recipientId: internId,
      content: text,
      parentMessageId: inReplyTo,
      isRead: false,
      isDummy: false,
      createdAt: Date.now(),
    });
    await ctx.db.patch(inReplyTo, { isRead: true });
    await ctx.runMutation(internal.notificationsInternal.notifyNewMessage, { messageId: id });
    return { sent: true };
  },
});
