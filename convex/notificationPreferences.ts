import { query, mutation } from './_generated/server';
import { v } from 'convex/values';
import { requireUser } from './lib/auth';

/**
 * Per-user notification preferences.
 *
 * `UserSettingsPage.tsx` reads and upserts `orbit_user_notification_preferences`
 * straight from the browser with the anon key — there is no API module and no
 * RPC, so this is the first server-side implementation rather than a port. The
 * upsert is keyed on user_id supplied by the CLIENT, which is to say the page
 * could write anyone's preferences; here the row is always the caller's.
 *
 * `notificationsInternal.prefersNotification` already reads this table, so
 * everything written here takes effect immediately across new-task, new-message
 * and review notifications.
 */

const KEYS = [
  'newTaskEnabled',
  'deadlineReminderEnabled',
  'newMessageEnabled',
  'taskSubmittedEnabled',
  'taskApprovedEnabled',
  'taskRejectedEnabled',
  'streamUpdateEnabled',
  'levelUpEnabled',
  'badgeEarnedEnabled',
] as const;

type Key = (typeof KEYS)[number];

/** Everything on, matching the Postgres column defaults. */
function defaults(): Record<Key, boolean> {
  return Object.fromEntries(KEYS.map((k) => [k, true])) as Record<Key, boolean>;
}

/**
 * The caller's preferences, defaulted where no row exists.
 *
 * Returns the defaults rather than null so the settings page renders the same
 * whether or not a row has ever been written. The old page handled the missing
 * row by leaving its local state at its own hardcoded defaults, which is the
 * same behaviour by accident.
 */
export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const row = await ctx.db
      .query('notificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .first();

    if (!row) return { ...defaults(), isDefault: true as const };

    return {
      newTaskEnabled: row.newTaskEnabled,
      deadlineReminderEnabled: row.deadlineReminderEnabled,
      newMessageEnabled: row.newMessageEnabled,
      taskSubmittedEnabled: row.taskSubmittedEnabled,
      taskApprovedEnabled: row.taskApprovedEnabled,
      taskRejectedEnabled: row.taskRejectedEnabled,
      streamUpdateEnabled: row.streamUpdateEnabled,
      levelUpEnabled: row.levelUpEnabled,
      badgeEarnedEnabled: row.badgeEarnedEnabled,
      isDefault: false as const,
    };
  },
});

export const save = mutation({
  args: {
    token: v.string(),
    newTaskEnabled: v.optional(v.boolean()),
    deadlineReminderEnabled: v.optional(v.boolean()),
    newMessageEnabled: v.optional(v.boolean()),
    taskSubmittedEnabled: v.optional(v.boolean()),
    taskApprovedEnabled: v.optional(v.boolean()),
    taskRejectedEnabled: v.optional(v.boolean()),
    streamUpdateEnabled: v.optional(v.boolean()),
    levelUpEnabled: v.optional(v.boolean()),
    badgeEarnedEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, ...patch }) => {
    const user = await requireUser(ctx, token);
    const now = Date.now();

    // There is no userId argument. The browser upsert supplied one, so the page
    // was one edited request away from rewriting another member's preferences —
    // and silencing their notifications is a quiet way to make them miss
    // deadlines.
    const supplied = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<Record<Key, boolean>>;

    // collect(), not first(): Convex has no unique constraint, so two concurrent
    // first-time saves can both find nothing and both insert. Any duplicate is
    // collapsed here rather than left for `prefersNotification` to pick between
    // arbitrarily — the importer has already produced duplicate rows in this
    // exact table once (see schema.ts).
    const rows = await ctx.db
      .query('notificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    const [existing, ...duplicates] = rows;
    for (const dupe of duplicates) await ctx.db.delete(dupe._id);

    if (existing) {
      await ctx.db.patch(existing._id, { ...supplied, updatedAt: now });
      return { success: true as const, created: false };
    }

    // Absent keys fall back to "on", so a partial save cannot silently disable
    // the eight settings the caller did not mention.
    await ctx.db.insert('notificationPreferences', {
      userId: user._id,
      ...defaults(),
      ...supplied,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, created: true };
  },
});
