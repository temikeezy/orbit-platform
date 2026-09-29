import { internalQuery, mutation } from './_generated/server';
import { v } from 'convex/values';
import { requireUser, randomToken } from './lib/auth';
import { isPublished } from './lib/taskApproval';

/**
 * Data behind the ICS feed.
 *
 * The Supabase edge function had NO auth: it built its client with the anon key,
 * served `Access-Control-Allow-Origin: *`, and returned any user's feed to
 * anyone who passed their uuid. Worse, when the user had no stream memberships
 * the membership filter was skipped entirely (`calendar-ics/index.ts:120`) and
 * it returned EVERY task in the system.
 *
 * A calendar URL is a bearer credential — it is pasted into Google/Apple
 * Calendar and polled forever by third-party servers — so it cannot carry a
 * session token that expires. Instead the URL carries an opaque per-user feed
 * token, and the zero-membership case now returns nothing rather than everything.
 */

export const feedForToken = internalQuery({
  args: { feedToken: v.string() },
  handler: async (ctx, { feedToken }) => {
    // Its own credential, not a session token: revoking a session must not break
    // a calendar subscription the user still wants, and the URL lives outside
    // the app forever once pasted into Google or Apple Calendar.
    let user = await ctx.db
      .query('users')
      .withIndex('by_calendarToken', (q) => q.eq('calendarFeedToken', feedToken))
      .unique();

    /**
     * Transitional: feeds subscribed before cutover carry the Supabase uuid
     * (TaskCalendarPage.tsx:35 built `?user_id=<uuid>`).
     *
     * This is a WEAK credential — the same uuid appears in notification
     * action_urls, so anyone who has ever received a link from ORBIT holds a key
     * to that user's calendar, and there is no way to revoke it short of
     * changing the uuid. It is accepted only for users who have never issued a
     * real feed token, which makes it self-retiring: the moment someone opens
     * the calendar page and gets a `calendarFeedToken`, their uuid stops
     * working. Delete this branch once no active user is missing one.
     */
    if (!user) {
      const legacy = await ctx.db
        .query('users')
        .withIndex('by_legacyId', (q) => q.eq('legacyId', feedToken))
        .unique();

      user = legacy && !legacy.calendarFeedToken ? legacy : null;
    }

    if (!user || !user.isActive || user.isDeleted) return null;

    const memberships = await ctx.db
      .query('streamMemberships')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    /**
     * Keyed by the stringified id so a user in the same stream twice is read
     * once, but holding the real `Id<'streams'>` so it can be handed back to
     * `db.get` and `withIndex` without a cast.
     */
    const streamIds = new Map(
      memberships.filter((m) => m.isActive).map((m) => [String(m.streamId), m.streamId] as const),
    );

    // No memberships means no tasks. The edge function skipped the filter here
    // and leaked the entire task table.
    if (streamIds.size === 0) return { user: user.fullName, tasks: [] };

    const now = Date.now();

    /**
     * Read PER STREAM, not across the whole platform.
     *
     * The previous shape walked `by_deadline` over every future task in the
     * system and discarded the ones the user could not see. That is unbounded
     * work on an endpoint that is unauthenticated by design and polled forever
     * by Google and Apple's servers: as the task table grows, every subscriber's
     * feed crosses Convex's read limit at the same moment and the endpoint 500s
     * for everyone at once, with no user action that could have caused it.
     *
     * Reading by membership makes the cost proportional to the streams the user
     * is actually in, and fetches each stream once instead of once per task.
     */
    const visible: Array<{
      id: string;
      title: string;
      description: string;
      deadline: number;
      points: number;
      streamName: string;
      streamEmoji: string;
    }> = [];

    for (const streamId of streamIds.values()) {
      const stream = await ctx.db.get(streamId);
      if (!stream) continue;

      /**
       * BOUNDED, newest first.
       *
       * `by_stream` has no deadline component, so this cannot ask the index for
       * future tasks only — it reads the stream's tasks and filters below. Left
       * as a `.collect()` that is every task the stream has ever had, which for
       * a long-running stream is mostly past ones: more work than the query this
       * replaced, on the endpoint least able to afford it.
       *
       * Newest first because a calendar shows what is coming: if the cap ever
       * bites, the tasks it drops are the oldest, which are the ones already
       * filtered out for being in the past.
       */
      const STREAM_TASK_CAP = 500;
      const tasks = await ctx.db
        .query('tasks')
        .withIndex('by_stream', (q) => q.eq('streamId', streamId))
        .order('desc')
        .take(STREAM_TASK_CAP);

      for (const t of tasks) {
        if (t.deadline < now || !t.isActive) continue;

        /**
         * PUBLISHED ONLY — the fifth surface that has to agree.
         *
         * lib/taskApproval.ts names four places that must apply `isPublished`;
         * this feed was not one of them and should have been. Without it, a task
         * the ORBIT agent proposed and no supervisor has approved appears in
         * every stream member's calendar, with its title, deadline and points —
         * the approval gate defeated by an ICS file. Worse, declining the
         * proposal deletes the task, and a calendar client that has already
         * cached the event keeps showing something that never existed.
         */
        if (!isPublished(t)) continue;

        visible.push({
          id: t._id,
          title: t.title,
          description: t.description,
          deadline: t.deadline,
          points: t.points,
          streamName: stream.name,
          streamEmoji: stream.emoji ?? '',
        });
      }
    }

    visible.sort((a, b) => a.deadline - b.deadline);

    return { user: user.fullName, tasks: visible };
  },
});

/** Issues or rotates the caller's calendar feed token. */
export const myFeedToken = mutation({
  args: { token: v.string(), rotate: v.optional(v.boolean()) },
  handler: async (ctx, { token, rotate }) => {
    const user = await requireUser(ctx, token);

    if (user.calendarFeedToken && !rotate) {
      return { feedToken: user.calendarFeedToken };
    }

    const feedToken = randomToken();
    await ctx.db.patch(user._id, { calendarFeedToken: feedToken, updatedAt: Date.now() });
    return { feedToken };
  },
});
