import { QueryCtx, MutationCtx } from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { hasRole } from './auth';

/**
 * The single definition of "is this user in this stream".
 *
 * There were two, and they disagreed. Read guards used
 * `.withIndex('by_stream_and_user').first()` then tested `?.isActive`; list and
 * count code used `.collect()` then `.filter(m => m.isActive)`. Those are the
 * same query only when there is exactly one membership row per (stream, user).
 *
 * There is not. The Supabase client inserted a membership unconditionally on
 * every assignment instead of reactivating the existing row, so any user who
 * was ever reassigned has duplicates. `.first()` returns the OLDEST row, so a
 * user with a stale inactive row and a live active one reads as "not a member"
 * to every guard and "a member" to every listing — and, worse, removal patched
 * the stale row and returned success while the live one kept granting access.
 *
 * Everything goes through here now, and the write side deactivates ALL matching
 * rows rather than the first.
 */

/** The user's live membership of this stream, whichever row carries it. */
export async function activeMembership(
  ctx: QueryCtx | MutationCtx,
  streamId: Id<'streams'>,
  userId: Id<'users'>,
): Promise<Doc<'streamMemberships'> | null> {
  const rows = await ctx.db
    .query('streamMemberships')
    .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
    .collect();

  return rows.find((m) => m.isActive) ?? null;
}

export async function isMember(
  ctx: QueryCtx | MutationCtx,
  streamId: Id<'streams'>,
  userId: Id<'users'>,
): Promise<boolean> {
  return (await activeMembership(ctx, streamId, userId)) !== null;
}

/**
 * Ends every active membership of this stream for this user.
 *
 * Returns how many rows it closed, so callers can tell a real revocation from a
 * no-op. Deactivating only the first row is how a removal could report success
 * while leaving the user in the stream.
 */
export async function endMemberships(
  ctx: MutationCtx,
  streamId: Id<'streams'>,
  userId: Id<'users'>,
  now: number,
): Promise<number> {
  const rows = await ctx.db
    .query('streamMemberships')
    .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
    .collect();

  let closed = 0;
  for (const row of rows) {
    if (!row.isActive) continue;
    await ctx.db.patch(row._id, { isActive: false, endedAt: now });
    closed++;
  }
  return closed;
}

/**
 * Puts the user in the stream and leaves exactly one active row behind.
 *
 * Collapsing duplicates here is what stops them accumulating further: a user
 * reassigned twice under the old client has two rows, and reactivating "the
 * first" would leave the second to be found by a different query later.
 */
export async function startMembership(
  ctx: MutationCtx,
  streamId: Id<'streams'>,
  userId: Id<'users'>,
  assignedBy: Id<'users'>,
  now: number,
): Promise<void> {
  const rows = await ctx.db
    .query('streamMemberships')
    .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
    .collect();

  const [keep, ...rest] = rows;

  if (keep) {
    await ctx.db.patch(keep._id, { isActive: true, startedAt: now, endedAt: undefined });
    for (const dup of rest) {
      if (dup.isActive) await ctx.db.patch(dup._id, { isActive: false, endedAt: now });
    }
  } else {
    await ctx.db.insert('streamMemberships', {
      userId,
      streamId,
      assignedBy,
      isActive: true,
      startedAt: now,
      isDummy: false,
      createdAt: now,
    });
  }
}

/**
 * Ends every active membership the user holds in any OTHER stream.
 *
 * NO LONGER THE DEFAULT. Interns may now belong to several streams — see
 * `MAX_SELF_JOINED_STREAMS` in streams.ts. This is kept for the one case that
 * still means "move", not "add": an admin reassigning someone out of a stream
 * rather than widening what they work on.
 *
 * The original rule existed because a user active in two streams "is counted
 * twice, appears on both rosters and is notified twice for every task". Those
 * are all still true — they are simply what belonging to two streams means, and
 * each is now correct rather than a bug. Everything that matters already reads
 * `streamMemberships` rather than the `currentStreamId` pointer, so nothing had
 * to change for a second membership to work.
 */
export async function leaveOtherStreams(
  ctx: MutationCtx,
  keepStreamId: Id<'streams'>,
  userId: Id<'users'>,
  now: number,
): Promise<void> {
  const rows = await ctx.db
    .query('streamMemberships')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();

  for (const row of rows) {
    if (row.isActive && row.streamId !== keepStreamId) {
      await ctx.db.patch(row._id, { isActive: false, endedAt: now });
    }
  }
}

/**
 * Per-stream moderator authority, which is what every write on a stream should
 * check. The global `moderator` role is NOT sufficient: it is granted broadly,
 * and streamChat deliberately does not trust it, so accepting it on addMember
 * would let any moderator self-grant membership and read any stream's chat.
 */
export async function canModerateStream(
  ctx: QueryCtx | MutationCtx,
  streamId: Id<'streams'>,
  user: Doc<'users'>,
): Promise<boolean> {
  if (hasRole(user, 'admin', 'super_admin')) return true;

  const row = await ctx.db
    .query('streamModerators')
    .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', user._id))
    .first();

  return row !== null;
}
