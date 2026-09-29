import { query, mutation } from './_generated/server';
import { QueryCtx, MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { requireUser, hasRole } from './lib/auth';
import { activeMembership, canModerateStream } from './lib/membership';

/**
 * Comments and emoji reactions on submissions.
 *
 * Both lived inline in `src/pages/TaskDetailPage.tsx` (:237-318) with no API
 * module. Both tables are empty in production today, but the write paths are
 * live, which is why they must be ported rather than skipped.
 *
 * Both `comments` and `reactions` key on targetType/targetId rather than a typed
 * id. The only live consumer comments on SUBMISSIONS — TaskDetailPage.tsx:317
 * inserts post_id = submissionId — so a v.id('posts') would have rejected every
 * real comment at the validator and stranded the legacy rows on import.
 */

/**
 * Whether the caller may see the thing being commented on or reacted to.
 *
 * `requireUser` was the only check, and targetType/targetId are free strings —
 * so any authenticated caller could read the comment thread on any submission
 * id, which is reviewer commentary on someone else's coursework, or on any post
 * id including one in a private stream.
 *
 * Unrecognised target types are refused rather than allowed. The two live ones
 * are `submission` (what TaskDetailPage writes) and `post`; a third arriving
 * later should have to declare its own rule here, not inherit "readable by
 * everyone" by default.
 */
async function canAccessTarget(
  ctx: QueryCtx | MutationCtx,
  targetType: string,
  targetId: string,
  user: Doc<'users'>,
): Promise<boolean> {
  if (hasRole(user, 'admin', 'super_admin')) return true;

  if (targetType === 'submission') {
    const submission = await ctx.db.get(targetId as Id<'submissions'>).catch(() => null);
    if (!submission) return false;

    if (submission.userId === user._id) return true;

    const task = await ctx.db.get(submission.taskId);
    if (!task) return false;

    if (await canModerateStream(ctx, task.streamId, user)) return true;

    // Peers in the same stream, but only once the work has been SUBMITTED —
    // which is what TaskDetailPage's showcase renders. A draft, an in-progress
    // row or a rejection is not something the rest of the stream gets to
    // discuss.
    const shared = submission.status === 'submitted' || submission.status === 'approved';
    return shared && (await activeMembership(ctx, task.streamId, user._id)) !== null;
  }

  if (targetType === 'post') {
    const post = await ctx.db.get(targetId as Id<'posts'>).catch(() => null);
    if (!post) return false;
    if (!post.streamId) return true;
    return (await activeMembership(ctx, post.streamId, user._id)) !== null;
  }

  return false;
}

async function assertTargetAccess(
  ctx: QueryCtx | MutationCtx,
  targetType: string,
  targetId: string,
  user: Doc<'users'>,
) {
  if (!(await canAccessTarget(ctx, targetType, targetId, user))) {
    throw new Error('Not found');
  }
}

export const listComments = query({
  args: { token: v.string(), targetType: v.string(), targetId: v.string() },
  handler: async (ctx, { token, targetType, targetId }) => {
    const user = await requireUser(ctx, token);
    await assertTargetAccess(ctx, targetType, targetId, user);

    const rows = await ctx.db
      .query('comments')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .collect();

    const out = [];
    for (const c of rows.filter((c) => c.isActive).sort((a, b) => a.createdAt - b.createdAt)) {
      const author = await ctx.db.get(c.userId);
      out.push({
        id: c._id,
        content: c.content,
        parentCommentId: c.parentCommentId,
        createdAt: c.createdAt,
        author: author
          ? { id: author._id, fullName: author.fullName, profileSlug: author.profileSlug, profilePhotoUrl: author.profilePhotoUrl }
          : null,
      });
    }
    return out;
  },
});

export const addComment = mutation({
  args: {
    token: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    content: v.string(),
    parentCommentId: v.optional(v.id('comments')),
  },
  handler: async (ctx, { token, targetType, targetId, content, parentCommentId }) => {
    const user = await requireUser(ctx, token);
    await assertTargetAccess(ctx, targetType, targetId, user);

    const trimmed = content.trim();
    if (!trimmed) return { success: false as const, error: 'Comment cannot be empty' };

    const now = Date.now();
    const id = await ctx.db.insert('comments', {
      targetType,
      targetId,
      userId: user._id,
      content: trimmed,
      parentCommentId,
      isActive: true,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

/** Soft delete, so reply threads hanging off a comment do not lose their parent. */
export const removeComment = mutation({
  args: { token: v.string(), commentId: v.id('comments') },
  handler: async (ctx, { token, commentId }) => {
    const user = await requireUser(ctx, token);

    const comment = await ctx.db.get(commentId);
    if (!comment) return { success: true as const };

    if (comment.userId !== user._id && !hasRole(user, 'admin', 'super_admin')) {
      throw new Error('You can only delete your own comments');
    }

    await ctx.db.patch(commentId, { isActive: false, updatedAt: Date.now() });
    return { success: true as const };
  },
});

export const listReactions = query({
  args: { token: v.string(), targetType: v.string(), targetId: v.string() },
  handler: async (ctx, { token, targetType, targetId }) => {
    const user = await requireUser(ctx, token);
    await assertTargetAccess(ctx, targetType, targetId, user);

    const rows = await ctx.db
      .query('reactions')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .collect();

    // Grouped server-side; TaskDetailPage counted them in the component after
    // fetching every row.
    const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const r of rows) {
      const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
      entry.count++;
      if (r.userId === user._id) entry.mine = true;
      byEmoji.set(r.emoji, entry);
    }

    return Array.from(byEmoji.values()).sort((a, b) => b.count - a.count);
  },
});

export const toggleReaction = mutation({
  args: {
    token: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, { token, targetType, targetId, emoji }) => {
    const user = await requireUser(ctx, token);

    // Free strings from the client: bound them so a caller cannot store a
    // megabyte 'emoji' or accumulate junk targetTypes forever.
    if (emoji.length > 16) return { success: false as const, error: 'Invalid reaction' };
    if (!['post', 'submission', 'comment'].includes(targetType)) {
      return { success: false as const, error: 'Invalid target' };
    }

    // A reaction is a write against someone else's content, so it needs the
    // same gate the read does. 'comment' is accepted by the bound above but has
    // no rule in canAccessTarget, so it refuses — which is the right default
    // until comment-level reactions have a defined visibility.
    await assertTargetAccess(ctx, targetType, targetId, user);

    // Indexed on (targetType, targetId, userId) rather than collecting every
    // reaction on the target and filtering in JS.
    const mineAll = await ctx.db
      .query('reactions')
      .withIndex('by_target_and_user', (q) =>
        q.eq('targetType', targetType).eq('targetId', targetId).eq('userId', user._id),
      )
      .collect();

    const mine = mineAll.find((r) => r.emoji === emoji);

    if (mine) {
      await ctx.db.delete(mine._id);
      return { success: true as const, reacted: false };
    }

    await ctx.db.insert('reactions', {
      userId: user._id,
      targetType,
      targetId,
      emoji,
      createdAt: Date.now(),
    });

    return { success: true as const, reacted: true };
  },
});
