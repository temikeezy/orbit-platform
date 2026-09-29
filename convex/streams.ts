import { query, mutation } from './_generated/server';
import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { QueryCtx, MutationCtx } from './_generated/server';
import { requireUser, requireAdmin, requireModerator, hasRole } from './lib/auth';
import {
  activeMembership,
  canModerateStream,
  endMemberships,
  startMembership,
} from './lib/membership';

/**
 * privacy and joinType decide who can see a stream and who can walk into it, so
 * they are closed unions rather than the free-text columns Postgres had. An
 * unrecognised value in an authorization input is a hole waiting for a typo.
 */
const PRIVACY = v.union(v.literal('public'), v.literal('private'));
const JOIN_TYPE = v.union(v.literal('open'), v.literal('invite'));

/**
 * Streams and memberships.
 *
 * memberCount is DERIVED here, never stored. The Postgres counter was maintained
 * by trg_update_stream_member_count (INSERT/UPDATE/DELETE), which does handle
 * deletes — but the app never deletes a membership, it sets is_active = false
 * (`src/lib/api/streams.ts:131-140,170-179`), and the trigger's UPDATE branch
 * ignores that flip. So the stored count never decremented, and every
 * reassignment double-counted. A derived count cannot drift.
 */

async function activeMemberCount(
  ctx: QueryCtx | MutationCtx,
  streamId: Id<'streams'>,
): Promise<number> {
  const memberships = await ctx.db
    .query('streamMemberships')
    .withIndex('by_stream', (q) => q.eq('streamId', streamId))
    .collect();

  // The is_active filter is the whole point — counting every row reproduces a
  // different wrong number, since deactivated memberships are never removed.
  return memberships.filter((m) => m.isActive).length;
}

/** The stream's own fields. No count — callers decide how to derive it. */
function shapeSync(s: Doc<'streams'>) {
  return {
    id: s._id,
    name: s.name,
    description: s.description,
    emoji: s.emoji,
    coverImageUrl: s.coverImageUrl,
    displayPhotoUrl: s.displayPhotoUrl,
    privacy: s.privacy,
    joinType: s.joinType,
    isActive: s.isActive,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
  };
}

async function shape(ctx: QueryCtx | MutationCtx, s: Doc<'streams'>) {
  return { ...shapeSync(s), memberCount: await activeMemberCount(ctx, s._id) };
}

export async function isStreamModerator(
  ctx: QueryCtx | MutationCtx,
  streamId: Id<'streams'>,
  userId: Id<'users'>,
): Promise<boolean> {
  const row = await ctx.db
    .query('streamModerators')
    .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
    .first();
  return row !== null;
}

/**
 * The viewer's own relationship to every stream, resolved in two index reads.
 *
 * `list` needs these per stream — AddTaskPage and EditTaskPage filter the full
 * list down to the streams the caller moderates, and StreamDetailPage swaps its
 * primary button on `isMember`. Asking per stream would be two reads per row;
 * the viewer's memberships and moderator rows are both small and indexed by
 * user, so read them once and look up by id.
 */
async function viewerRelation(ctx: QueryCtx | MutationCtx, user: Doc<'users'>) {
  const [memberships, moderatorRows] = await Promise.all([
    ctx.db
      .query('streamMemberships')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect(),
    ctx.db
      .query('streamModerators')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect(),
  ]);

  const memberOf = new Set(memberships.filter((m) => m.isActive).map((m) => m.streamId));
  const moderatorOf = new Set(moderatorRows.map((m) => m.streamId));
  const staff = hasRole(user, 'admin', 'super_admin');

  return {
    isMember: (id: Id<'streams'>) => memberOf.has(id),
    // Admins moderate everything, which is what the old client-side check did by
    // testing the role before consulting stream_moderators at all.
    isModerator: (id: Id<'streams'>) => staff || moderatorOf.has(id),
  };
}

/**
 * How many streams an intern may put themselves in.
 *
 * Three is a working number, not a principle: enough to follow a second
 * interest and a third out of curiosity, few enough that the task list stays
 * readable. Admins are not bound by it.
 */
export const MAX_SELF_JOINED_STREAMS = 3;

export const list = query({
  args: {
    token: v.string(),
    includeInactive: v.optional(v.boolean()),
    /**
     * Exact-name lookup, served from an index instead of the capped page.
     *
     * The cap below trims the OLDEST streams, which is right for a list screen
     * and wrong for finding one stream you already know the name of: the e2e
     * fixtures look their streams up by fixed name, and once the deployment
     * grew past the cap the originals aged out of the page, so the lookup
     * missed and a duplicate was created under the same name. The fixture then
     * pointed at an empty stream while its tasks stayed in the first one.
     */
    name: v.optional(v.string()),
  },
  handler: async (ctx, { token, includeInactive, name }) => {
    const user = await requireUser(ctx, token);

    // Deactivation IS the delete path (`deleteStream` in the client calls it),
    // so an unguarded flag hands every authenticated user the streams an admin
    // believes they removed, names and rosters included.
    if (includeInactive && !hasRole(user, 'admin', 'super_admin')) {
      throw new Error('Admin access required');
    }

    const rel = await viewerRelation(ctx, user);

    /**
     * Bounded, and NEWEST FIRST.
     *
     * `.take(n)` on an unordered query returns the OLDEST rows — the trap this
     * codebase has hit before, and hit again here: a bounded read without an
     * order silently dropped every recently created stream, so a newly made
     * stream was simply absent from the list. Ordering by creation descending
     * means the bound trims the oldest, which is the right end to lose.
     */
    /**
     * The cap is applied WITHIN the set being returned, never before the filter.
     *
     * This used to take the newest 500 rows and only then drop the inactive
     * ones, which is fine until a deployment accumulates deactivated streams —
     * and deactivation is the delete path here, so they accumulate permanently.
     * On the dev deployment, where an integration suite had left roughly 1,900
     * inactive rows at the newest end, the page was almost entirely spent on
     * them: the whole platform returned two active streams, and every screen
     * built on this list quietly lost the rest. The edit-task form was the one
     * that failed loudest, because a task whose own stream was missing from the
     * options rendered as "Select a stream" and refused to save at all — an
     * unfixable form with no error message on it.
     *
     * Reading through `by_active` means the cap trims the oldest ACTIVE streams,
     * which is the same "lose the right end" reasoning as the ordering below.
     */
    const STREAM_CAP = 500;

    // Active and inactive are paged SEPARATELY, then concatenated, so the two
    // can never crowd each other out. One unordered page over the whole table
    // spends itself on whichever kind happens to be newest — which on a
    // deployment carrying old deactivated rows is all of them.
    const activeRows = name
      ? []
      : await ctx.db
          .query('streams')
          .withIndex('by_active', (q) => q.eq('isActive', true))
          .order('desc')
          .take(STREAM_CAP);

    const streams = name
      ? await ctx.db
          .query('streams')
          .withIndex('by_name', (q) => q.eq('name', name))
          .order('desc')
          .take(STREAM_CAP)
      : includeInactive
        ? [
            ...activeRows,
            // Ordered by updatedAt, NOT by creation: deactivation is this
            // platform's delete, so the row an admin wants back is the one they
            // just removed, and ordering by creation buries it under every
            // older stream that happens to be inactive. On a deployment with
            // more than a page of them the stream vanished from the screen the
            // instant it was deactivated, leaving no way to reactivate it.
            ...(await ctx.db
              .query('streams')
              .withIndex('by_active_and_updated', (q) => q.eq('isActive', false))
              .order('desc')
              .take(STREAM_CAP)),
          ]
        : activeRows;

    if (!name && streams.length === STREAM_CAP) {
      // Logged rather than swallowed: a list silently missing its oldest rows
      // is indistinguishable from a complete one, and that is how a truncation
      // survives for months.
      console.warn(`streams.list hit its ${STREAM_CAP}-row cap; oldest streams omitted.`);
    }
    const visible = streams.filter((s) => includeInactive || s.isActive);

    // One scan of streamMemberships for the whole list. Calling
    // activeMemberCount per stream was a full per-stream collect on a page that
    // renders every stream — 152 of them in this deployment, so 152 index scans
    // for one screen.
    const counts = new Map<string, number>();
    for (const m of await ctx.db.query('streamMemberships').collect()) {
      if (m.isActive) counts.set(m.streamId, (counts.get(m.streamId) ?? 0) + 1);
    }

    return visible.map((s) => ({
      ...shapeSync(s),
      memberCount: counts.get(s._id) ?? 0,
      isMember: rel.isMember(s._id),
      isModerator: rel.isModerator(s._id),
    }));
  },
});

export const getById = query({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const user = await requireUser(ctx, token);
    const stream = await ctx.db.get(streamId);
    if (!stream) return null;

    const member = (await activeMembership(ctx, streamId, user._id)) !== null;
    const moderates = await canModerateStream(ctx, streamId, user);

    // A deactivated stream is a deleted one. Returning it to anyone with the id
    // is the same leak as an unguarded includeInactive, one row at a time.
    if (!stream.isActive && !hasRole(user, 'admin', 'super_admin')) return null;

    return {
      ...(await shape(ctx, stream)),
      isMember: member,
      isModerator: moderates,
    };
  },
});

/**
 * The roster.
 *
 * Point totals and identities here are subject to the same two privacy flags
 * the rest of the codebase honours — `users.list` hides non-public profiles from
 * non-staff, and `leaderboard` hides totals for anyone who opted out. Returning
 * both unconditionally would make the roster the way round those settings.
 */
export const members = query({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const viewer = await requireUser(ctx, token);
    const staff = hasRole(viewer, 'admin', 'super_admin');

    // A roster carries roles and point totals. Without this any authenticated
    // user could enumerate every stream's membership, which the port originally
    // allowed while streamChat deliberately guarded the same data.
    if (!staff && !(await canModerateStream(ctx, streamId, viewer))) {
      if (!(await activeMembership(ctx, streamId, viewer._id))) {
        throw new Error('Not a member of this stream');
      }
    }

    const memberships = await ctx.db
      .query('streamMemberships')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect();

    const seen = new Set<string>();
    const out = [];

    for (const m of memberships.filter((m) => m.isActive)) {
      // Duplicate membership rows from the Supabase client would otherwise list
      // the same person twice.
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);

      const u = await ctx.db.get(m.userId);
      if (!u || u.isDeleted || !u.isActive) continue;

      const self = u._id === viewer._id;
      const visible = staff || self || (u.profileVisibility ?? 'public') === 'public';
      if (!visible) continue;

      const showPoints = staff || self || u.showOnLeaderboard !== false;

      out.push({
        id: u._id,
        fullName: u.fullName,
        profileSlug: u.profileSlug,
        profilePhotoUrl: u.profilePhotoUrl,
        roles: u.roles,
        // Omitted rather than zeroed: a 0 would render as a real score.
        totalPoints: showPoints ? u.totalPoints : undefined,
        currentLevel: showPoints ? u.currentLevel : undefined,
        joinedAt: m.startedAt ?? m.createdAt,
      });
    }
    return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
  },
});

export const myStreams = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const memberships = await ctx.db
      .query('streamMemberships')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    const out = [];
    for (const m of memberships.filter((m) => m.isActive)) {
      const s = await ctx.db.get(m.streamId);
      if (s) out.push(await shape(ctx, s));
    }
    return out;
  },
});

export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    emoji: v.optional(v.string()),
    privacy: v.optional(PRIVACY),
    joinType: v.optional(JOIN_TYPE),
  },
  handler: async (ctx, { token, ...fields }) => {
    const user = await requireAdmin(ctx, token);
    const now = Date.now();

    const id = await ctx.db.insert('streams', {
      ...fields,
      // Written explicitly, never left absent. `join` fails shut on anything it
      // does not recognise, so an omitted joinType would silently produce a
      // stream nobody can join — and an omitted privacy would leave the
      // visibility of a new stream to whatever a reader happens to default to.
      // Every imported stream is public/open; new ones match unless told
      // otherwise, and the decision is recorded on the row.
      privacy: fields.privacy ?? 'public',
      joinType: fields.joinType ?? 'open',
      // Retained only because the column is non-optional in the schema; every
      // read derives the real figure. Never trust this value.
      memberCount: 0,
      isActive: true,
      createdBy: user._id,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('auditLogs', {
      userId: user._id,
      userEmail: user.email,
      userRoles: user.roles,
      action: 'stream.create',
      tableName: 'streams',
      recordId: id,
      newValues: { name: fields.name, privacy: fields.privacy ?? 'public' },
      success: true,
      createdAt: now,
    });

    return { success: true as const, id };
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    streamId: v.id('streams'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    emoji: v.optional(v.string()),
    privacy: v.optional(PRIVACY),
    joinType: v.optional(JOIN_TYPE),
    // coverImageUrl/displayPhotoUrl are NOT arguments. They are set by
    // files.setStreamPhoto from a storage id the server resolves itself;
    // accepting them here let a stream moderator point every viewer's browser
    // at an arbitrary host.
  },
  handler: async (ctx, { token, streamId, ...patch }) => {
    const user = await requireUser(ctx, token);
    const isAdmin = hasRole(user, 'admin', 'super_admin');

    if (!isAdmin && !(await isStreamModerator(ctx, streamId, user._id))) {
      throw new Error('Admin or stream moderator access required');
    }

    // isActive is deliberately NOT an argument here. Accepting it let a stream
    // moderator reach the admin-only deactivate path — and reactivate, which
    // admins have no dedicated route for. privacy/joinType are admin-only for
    // the same reason: they decide who can see the stream at all.
    if (!isAdmin && (patch.privacy !== undefined || patch.joinType !== undefined)) {
      throw new Error('Only an admin can change stream visibility');
    }

    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const now = Date.now();
    await ctx.db.patch(streamId, { ...clean, updatedAt: now });

    await ctx.db.insert('auditLogs', {
      userId: user._id,
      userEmail: user.email,
      userRoles: user.roles,
      action: 'stream.update',
      tableName: 'streams',
      recordId: streamId,
      newValues: clean,
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

export const deactivate = mutation({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const admin = await requireAdmin(ctx, token);
    const now = Date.now();
    await ctx.db.patch(streamId, { isActive: false, updatedAt: now });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'stream.deactivate',
      tableName: 'streams',
      recordId: streamId,
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * The inverse of deactivate. Admin-only for the same reason: `update` refuses
 * isActive precisely so a stream moderator cannot resurrect a stream an admin
 * removed, and without this there was no route back at all.
 */
export const reactivate = mutation({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const admin = await requireAdmin(ctx, token);
    const now = Date.now();
    await ctx.db.patch(streamId, { isActive: true, updatedAt: now });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'stream.reactivate',
      tableName: 'streams',
      recordId: streamId,
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * Moderator assignment.
 *
 * Scoped to THIS stream's moderators plus admins, not the global `moderator`
 * role. The global role is granted broadly and streamChat deliberately does not
 * trust it, so accepting it here was a one-call bypass: a moderator could
 * addMember(self) into any stream and then read its chat.
 */
export const addMember = mutation({
  args: { token: v.string(), streamId: v.id('streams'), userId: v.id('users') },
  handler: async (ctx, { token, streamId, userId }) => {
    const caller = await requireUser(ctx, token);
    if (!(await canModerateStream(ctx, streamId, caller))) {
      throw new Error('Moderator access required');
    }

    const now = Date.now();

    /**
     * ADDS a membership. It no longer ends the others.
     *
     * This used to call `leaveOtherStreams` first, enforcing one active stream
     * per person. That made placing someone in a second stream silently REMOVE
     * them from the first — and it is how four interns ended up in no stream at
     * all: they had applied twice, and the second application converted with no
     * stream assigned, deactivating the membership the first had created and
     * putting nothing in its place. They signed in to an empty task list with
     * nothing explaining why.
     *
     * To move someone rather than widen them, call `removeMember` for the old
     * stream — `leaveOtherStreams` in lib/membership.ts is still there for the
     * reassignment case.
     */
    await startMembership(ctx, streamId, userId, caller._id, now);

    // The MOST RECENT stream, not the only one. A denormalised pointer for
    // display; membership rows remain the truth — see users.ts:558.
    await ctx.db.patch(userId, { currentStreamId: streamId, updatedAt: now });

    await ctx.db.insert('auditLogs', {
      userId: caller._id,
      userEmail: caller.email,
      userRoles: caller.roles,
      action: 'stream.add_member',
      tableName: 'streamMemberships',
      recordId: streamId,
      newValues: { targetUserId: userId },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * Self-service join.
 *
 * `addMember` is moderator-gated, so routing StreamDetailPage's Join button
 * through it would deny every ordinary member — the one case the button exists
 * for. This is the same write, authorising the caller against the stream's own
 * visibility instead of against a role.
 *
 * It fails SHUT. Both fields must explicitly say the stream is open to walk-ins;
 * an absent or unrecognised value sends the caller to a moderator rather than
 * letting a missing column decide an authorization question. `create` writes
 * both explicitly for exactly this reason.
 */
export const join = mutation({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const user = await requireUser(ctx, token);

    const stream = await ctx.db.get(streamId);
    if (!stream || !stream.isActive) throw new Error('Stream not found');

    const open = stream.joinType === 'open' && stream.privacy === 'public';

    if (!open && !(await canModerateStream(ctx, streamId, user))) {
      throw new Error('This stream is invite-only. Ask a moderator to add you.');
    }

    const now = Date.now();

    /**
     * BOUNDED, not exclusive.
     *
     * Joining a second stream no longer leaves the first. It is capped anyway,
     * because every stream an intern joins adds its tasks to their list and its
     * notifications to their inbox: someone who joined all fourteen would face
     * every task on the platform and be mailed about each one, which is not
     * enthusiasm being rewarded but an unusable account.
     *
     * The cap is on SELF-SERVICE joining only. An admin placing someone through
     * `addMember` is a deliberate, audited act and is not limited — if the team
     * decides a particular intern belongs in four streams, that is a decision
     * someone made rather than a button someone kept pressing.
     */
    const active = (
      await ctx.db
        .query('streamMemberships')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .collect()
    ).filter((m) => m.isActive);

    if (active.some((m) => m.streamId === streamId)) {
      return { success: true as const, alreadyJoined: true };
    }

    if (active.length >= MAX_SELF_JOINED_STREAMS) {
      return {
        success: false as const,
        error: `You can be in ${MAX_SELF_JOINED_STREAMS} streams at once. Leave one before joining another.`,
      };
    }

    await startMembership(ctx, streamId, user._id, user._id, now);

    await ctx.db.patch(user._id, { currentStreamId: streamId, updatedAt: now });
    return { success: true as const, alreadyJoined: false };
  },
});

/** Self-service leave. Takes no userId, so it cannot be aimed at anyone else. */
export const leave = mutation({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const user = await requireUser(ctx, token);
    const now = Date.now();

    await endMemberships(ctx, streamId, user._id, now);

    /**
     * Repoint rather than clear.
     *
     * Leaving the stream the pointer happens to name used to blank it outright.
     * With one stream each that was harmless; with several it makes an intern
     * who is still in two streams look like they are in none, everywhere the
     * pointer is displayed.
     */
    if (user.currentStreamId === streamId) {
      const remaining = (
        await ctx.db
          .query('streamMemberships')
          .withIndex('by_user', (q) => q.eq('userId', user._id))
          .collect()
      ).filter((m) => m.isActive && m.streamId !== streamId);

      await ctx.db.patch(user._id, {
        currentStreamId: remaining[0]?.streamId,
        updatedAt: now,
      });
    }

    return { success: true as const };
  },
});

export const removeMember = mutation({
  args: { token: v.string(), streamId: v.id('streams'), userId: v.id('users') },
  handler: async (ctx, { token, streamId, userId }) => {
    const caller = await requireUser(ctx, token);
    if (!(await canModerateStream(ctx, streamId, caller))) {
      throw new Error('Moderator access required');
    }

    const now = Date.now();

    // Every active row, not the first. A user with a duplicate membership left
    // over from the Supabase client would otherwise keep the stream's tasks,
    // calendar and notifications while the mutation reported success.
    const closed = await endMemberships(ctx, streamId, userId, now);

    // Membership and moderator authority are separate rows, and only the first
    // was ever revoked — so someone removed from a stream kept the right to
    // edit it and its tasks.
    const modRow = await ctx.db
      .query('streamModerators')
      .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
      .first();
    if (modRow) await ctx.db.delete(modRow._id);

    // Clear the pointer only if it still points here, so removing someone from
    // an old stream cannot wipe their current one.
    const u = await ctx.db.get(userId);
    if (u?.currentStreamId === streamId) {
      await ctx.db.patch(userId, { currentStreamId: undefined, updatedAt: now });
    }

    await ctx.db.insert('auditLogs', {
      userId: caller._id,
      userEmail: caller.email,
      userRoles: caller.roles,
      action: 'stream.remove_member',
      tableName: 'streamMemberships',
      recordId: streamId,
      newValues: { targetUserId: userId, membershipsClosed: closed, moderatorRevoked: Boolean(modRow) },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * Per-stream moderator authority. There was no way to grant or revoke it: the
 * only writer was the Supabase import and the only remover was full account
 * deletion, so offboarding someone from a stream they moderated was impossible
 * short of deleting them.
 */
export const addModerator = mutation({
  args: { token: v.string(), streamId: v.id('streams'), userId: v.id('users') },
  handler: async (ctx, { token, streamId, userId }) => {
    const admin = await requireAdmin(ctx, token);
    const now = Date.now();

    const existing = await ctx.db
      .query('streamModerators')
      .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
      .first();

    if (!existing) {
      await ctx.db.insert('streamModerators', {
        streamId,
        userId,
        assignedBy: admin._id,
        assignedAt: now,
      });
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'stream.add_moderator',
      tableName: 'streamModerators',
      recordId: streamId,
      newValues: { targetUserId: userId },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

export const removeModerator = mutation({
  args: { token: v.string(), streamId: v.id('streams'), userId: v.id('users') },
  handler: async (ctx, { token, streamId, userId }) => {
    const admin = await requireAdmin(ctx, token);
    const now = Date.now();

    const existing = await ctx.db
      .query('streamModerators')
      .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', userId))
      .first();

    if (existing) await ctx.db.delete(existing._id);

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'stream.remove_moderator',
      tableName: 'streamModerators',
      recordId: streamId,
      newValues: { targetUserId: userId },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * Who supervises each stream.
 *
 * The platform could grant a moderator and could revoke one, and had no way to
 * ANSWER "who supervises this stream" — the mapping existed only as rows nobody
 * could read. That is fine while supervision is derived from something visible
 * elsewhere, and not fine once the staff-to-stream allocation IS the model:
 * an assignment nobody can see is one nobody can check, and the first time it
 * matters is when a supervisor cannot review work and no one can say why.
 *
 * Staff-only. It returns which member of staff is responsible for what, which
 * is roster information rather than anything an intern needs.
 */
export const moderators = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireModerator(ctx, token);

    const streams = await ctx.db
      .query('streams')
      .withIndex('by_active', (q) => q.eq('isActive', true))
      .collect();

    const out: Array<{
      streamId: Id<'streams'>;
      streamName: string;
      moderators: Array<{ userId: Id<'users'>; fullName: string; email: string; source?: string }>;
    }> = [];

    for (const stream of streams) {
      const rows = await ctx.db
        .query('streamModerators')
        .withIndex('by_stream', (q) => q.eq('streamId', stream._id))
        .collect();

      const people = [];
      for (const row of rows) {
        const user = await ctx.db.get(row.userId);
        if (!user || user.isDeleted) continue;
        people.push({
          userId: user._id,
          fullName: user.fullName,
          email: user.email,
          source: row.source,
        });
      }

      out.push({ streamId: stream._id, streamName: stream.name, moderators: people });
    }

    return out.sort((a, b) => a.streamName.localeCompare(b.streamName));
  },
});

export const stats = query({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const viewer = await requireUser(ctx, token);
    const staff = hasRole(viewer, 'admin', 'super_admin');

    // Same gate as `members`: the averages below are derived from point totals.
    if (!staff && !(await canModerateStream(ctx, streamId, viewer))) {
      if (!(await activeMembership(ctx, streamId, viewer._id))) {
        throw new Error('Not a member of this stream');
      }
    }

    const [memberships, tasks] = await Promise.all([
      ctx.db.query('streamMemberships').withIndex('by_stream', (q) => q.eq('streamId', streamId)).collect(),
      ctx.db.query('tasks').withIndex('by_stream', (q) => q.eq('streamId', streamId)).collect(),
    ]);

    const activeTasks = tasks.filter((t) => t.isActive);

    let submissionCount = 0;
    let approvedCount = 0;

    for (const task of activeTasks) {
      const subs = await ctx.db
        .query('submissions')
        .withIndex('by_task', (q) => q.eq('taskId', task._id))
        .collect();
      submissionCount += subs.length;
      approvedCount += subs.filter((sub) => sub.status === 'approved').length;
    }

    let totalPoints = 0;
    let memberCount = 0;
    const seen = new Set<string>();
    const members: Doc<'users'>[] = [];

    for (const m of memberships.filter((m) => m.isActive)) {
      // Duplicate rows would inflate both the count and the average.
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);

      const user = await ctx.db.get(m.userId);
      if (!user || user.isDeleted || !user.isActive) continue;
      totalPoints += user.totalPoints;
      memberCount++;
      members.push(user);
    }

    /**
     * The stats tab used to assemble these itself, in three queries the browser
     * ran directly against the tables — including one that selected every
     * member's id, name, photo and exact total from orbit_users, ordered by
     * points. That is a leaderboard of the stream, built client-side, with no
     * regard for who opted out of appearing on one.
     */
    const weekAgo = Date.now() - 7 * 86_400_000;
    let weeklyPoints = 0;

    for (const user of members) {
      // by_user_and_time, bounded at the index — by_user would read every
      // ledger entry the member has ever earned to sum the last seven days.
      const ledger = await ctx.db
        .query('pointsLedger')
        .withIndex('by_user_and_time', (q) => q.eq('userId', user._id).gte('createdAt', weekAgo))
        .collect();
      for (const entry of ledger) weeklyPoints += entry.points;
    }

    const topContributors = members
      // The same opt-out the leaderboard honours. A top-five by points IS a
      // leaderboard, whatever the tab is called.
      .filter((u) => staff || u.showOnLeaderboard !== false)
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, 5)
      .map((u) => ({
        id: u._id,
        fullName: u.fullName,
        profilePhotoUrl: u.profilePhotoUrl,
        points: u.totalPoints,
      }));

    return {
      memberCount,
      taskCount: activeTasks.length,
      submissionCount,
      approvedCount,
      weeklyPoints,
      topContributors,
      // An average over the whole stream does not identify anyone, so it is not
      // subject to showOnLeaderboard the way an individual total is. It IS
      // gated on membership above.
      averagePoints: memberCount > 0 ? totalPoints / memberCount : 0,
    };
  },
});

/** Memberships for a stream, for the admin roster view. */
export const memberships = query({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    const viewer = await requireUser(ctx, token);
    if (!(await canModerateStream(ctx, streamId, viewer))) {
      throw new Error('Moderator access required');
    }

    const rows = await ctx.db
      .query('streamMemberships')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect();

    return rows.map((m) => ({
      id: m._id,
      userId: m.userId,
      streamId: m.streamId,
      isActive: m.isActive,
      startedAt: m.startedAt ?? m.createdAt,
      endedAt: m.endedAt,
    }));
  },
});
