import { query, mutation, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { requireUser } from './lib/auth';

/**
 * Friendships.
 *
 * Had no API module — three inline queries plus a hard delete in
 * `src/pages/UserProfilePage.tsx:60-118`, none of which checked that the caller
 * was party to the relationship. The table is empty in production today, but the
 * write paths are live, so it must be ported rather than skipped.
 *
 * A friendship is stored as ONE row (userId = requester, friendId = addressee).
 * Every read therefore has to look in both directions.
 */

async function edgeBetween(
  ctx: QueryCtx,
  a: Id<'users'>,
  b: Id<'users'>,
): Promise<Doc<'friendships'> | null> {
  const forward = await ctx.db
    .query('friendships')
    .withIndex('by_pair', (q) => q.eq('userId', a).eq('friendId', b))
    .first();
  if (forward) return forward;

  return await ctx.db
    .query('friendships')
    .withIndex('by_pair', (q) => q.eq('userId', b).eq('friendId', a))
    .first();
}

export const statusWith = query({
  args: { token: v.string(), otherUserId: v.id('users') },
  handler: async (ctx, { token, otherUserId }) => {
    const user = await requireUser(ctx, token);
    const edge = await edgeBetween(ctx, user._id, otherUserId);

    if (!edge) return { status: 'none' as const, isRequester: false };

    return {
      status: edge.status as 'pending' | 'accepted' | 'blocked',
      isRequester: edge.userId === user._id,
      id: edge._id,
    };
  },
});

export const listMine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const [outgoing, incoming] = await Promise.all([
      ctx.db.query('friendships').withIndex('by_user', (q) => q.eq('userId', user._id)).collect(),
      // Indexed, not filtered. `.filter()` reads every friendship row on the
      // deployment to find this caller's incoming ones — the `by_friend` index
      // was added for precisely this query (see its comment in schema.ts) and
      // then never wired up here.
      ctx.db
        .query('friendships')
        .withIndex('by_friend', (q) => q.eq('friendId', user._id))
        .collect(),
    ]);

    const out = [];
    for (const e of [...outgoing, ...incoming]) {
      const otherId = e.userId === user._id ? e.friendId : e.userId;
      const other = await ctx.db.get(otherId);
      if (!other || other.isDeleted) continue;

      out.push({
        id: e._id,
        status: e.status,
        isRequester: e.userId === user._id,
        user: {
          id: other._id,
          fullName: other.fullName,
          profileSlug: other.profileSlug,
          profilePhotoUrl: other.profilePhotoUrl,
        },
      });
    }
    return out;
  },
});

export const request = mutation({
  args: { token: v.string(), friendId: v.id('users') },
  handler: async (ctx, { token, friendId }) => {
    const user = await requireUser(ctx, token);

    if (friendId === user._id) {
      return { success: false as const, error: 'You cannot add yourself.' };
    }

    const other = await ctx.db.get(friendId);
    if (!other || !other.isActive || other.isDeleted) {
      return { success: false as const, error: 'User is unavailable.' };
    }

    // Checked in both directions, so a second request cannot create a duplicate
    // edge — Convex has no unique constraint to catch it.
    const existing = await edgeBetween(ctx, user._id, friendId);
    if (existing) return { success: true as const, status: existing.status, alreadyExists: true };

    const now = Date.now();
    await ctx.db.insert('friendships', {
      userId: user._id,
      friendId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, status: 'pending', alreadyExists: false };
  },
});

export const respond = mutation({
  args: {
    token: v.string(),
    friendshipId: v.id('friendships'),
    accept: v.boolean(),
  },
  handler: async (ctx, { token, friendshipId, accept }) => {
    const user = await requireUser(ctx, token);

    const edge = await ctx.db.get(friendshipId);
    if (!edge) return { success: false as const, error: 'Request not found' };

    // Only the ADDRESSEE may accept. The inline version updated by id with no
    // check at all, so a requester could accept their own request — or anyone
    // holding an id could accept someone else's.
    if (edge.friendId !== user._id) {
      throw new Error('Only the recipient can respond to this request');
    }

    // Only a pending request can be answered; otherwise a blocked edge could be
    // flipped to accepted.
    if (edge.status !== 'pending') {
      return { success: false as const, error: 'This request is no longer pending.' };
    }

    if (accept) {
      await ctx.db.patch(friendshipId, { status: 'accepted', updatedAt: Date.now() });
      return { success: true as const, status: 'accepted' };
    }

    await ctx.db.delete(friendshipId);
    return { success: true as const, status: 'declined' };
  },
});

export const remove = mutation({
  args: { token: v.string(), otherUserId: v.id('users') },
  handler: async (ctx, { token, otherUserId }) => {
    const user = await requireUser(ctx, token);

    const edge = await edgeBetween(ctx, user._id, otherUserId);
    if (!edge) return { success: true as const };

    // Either party may unfriend, but only a party. UserProfilePage.tsx:117
    // deleted by id with no ownership check.
    if (edge.userId !== user._id && edge.friendId !== user._id) {
      throw new Error('Not your friendship');
    }

    await ctx.db.delete(edge._id);
    return { success: true as const };
  },
});
