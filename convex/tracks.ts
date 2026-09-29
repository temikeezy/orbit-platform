import { query, mutation, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { MutationCtx } from './_generated/server';
import { requireUser, requireAdmin } from './lib/auth';
import { TRACK_SEED, TRACK_LEAD_GRANT } from './lib/tracks';

/**
 * Programme tracks, and the thing that makes a track lead actually work.
 *
 * ORBIT has two entirely separate authority systems: `streamModerators` decides
 * who can set tasks and post announcements in a stream, and
 * `departments.leadUserId` decides who can review an intern's logbook. They
 * share no table and no code path, so "the lead of the Design track" had to be
 * granted twice, by two different admin screens, with nothing keeping them in
 * step — and half a grant looks exactly like a working one until someone tries
 * to publish a task or sign off a week.
 *
 * `setLead` below is one action that does both.
 */

/** The roster, with the resolved department, lead and stream count. */
export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);

    const tracks = await ctx.db.query('tracks').collect();
    const out = [];

    for (const track of tracks.sort((a, b) => a.displayOrder - b.displayOrder)) {
      const department = track.departmentId ? await ctx.db.get(track.departmentId) : null;
      const lead = department?.leadUserId ? await ctx.db.get(department.leadUserId) : null;

      const streams = await ctx.db
        .query('streams')
        .withIndex('by_track', (q) => q.eq('trackId', track._id))
        .collect();

      out.push({
        id: track._id,
        slug: track.slug,
        name: track.name,
        shortName: track.shortName ?? null,
        description: track.description ?? null,
        isActive: track.isActive,
        displayOrder: track.displayOrder,
        departmentId: track.departmentId ?? null,
        departmentName: department?.name ?? null,
        leadUserId: department?.leadUserId ?? null,
        leadName: lead?.fullName ?? null,
        streams: streams
          .filter((s) => s.isActive)
          .map((s) => ({ id: s._id, name: s.name, emoji: s.emoji ?? null })),
      });
    }

    return out;
  },
});

/** Editable presentation and ownership. `slug` is never patched — see lib/tracks.ts. */
export const save = mutation({
  args: {
    token: v.string(),
    trackId: v.optional(v.id('tracks')),
    slug: v.optional(v.string()),
    name: v.string(),
    shortName: v.optional(v.string()),
    description: v.optional(v.string()),
    departmentId: v.optional(v.id('departments')),
    /**
     * Explicit, because `departmentId: undefined` is OMITTED by Convex's
     * serialisation — the server cannot tell "clear the owner" from "I did not
     * mention it". Choosing "Not assigned" in the admin form silently left the
     * old department and its grants in place.
     */
    clearDepartment: v.optional(v.boolean()),
    displayOrder: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, trackId, slug, clearDepartment, ...fields }) => {
    await requireAdmin(ctx, token);
    const now = Date.now();

    if (trackId) {
      const existing = await ctx.db.get(trackId);
      if (!existing) return { success: false as const, error: 'Track not found' };

      await ctx.db.patch(trackId, {
        ...fields,
        ...(clearDepartment ? { departmentId: undefined } : {}),
        updatedAt: now,
      });

      // Ownership moved: re-materialise so the new department's lead holds the
      // stream grants and the old one does not. Clearing counts as a move — it
      // must take the grants with it.
      const moved = clearDepartment
        ? existing.departmentId !== undefined
        : fields.departmentId !== undefined && fields.departmentId !== existing.departmentId;

      if (moved) await materialiseLeadGrants(ctx, trackId);

      return { success: true as const, id: trackId };
    }

    if (!slug) return { success: false as const, error: 'A new track needs a slug' };

    const clash = await ctx.db
      .query('tracks')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .first();
    if (clash) return { success: false as const, error: 'That slug is already in use' };

    const id = await ctx.db.insert('tracks', {
      slug,
      name: fields.name,
      shortName: fields.shortName,
      description: fields.description,
      departmentId: fields.departmentId,
      displayOrder: fields.displayOrder ?? 99,
      isActive: fields.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

/**
 * Names the track lead, and grants them everything that implies.
 *
 * Refuses a track with no department, because a lead of a departmentless track
 * gets no logbook-review authority — and half a grant is the exact failure this
 * exists to end.
 */
export const setLead = mutation({
  args: { token: v.string(), trackId: v.id('tracks'), userId: v.id('users') },
  handler: async (ctx, { token, trackId, userId }) => {
    const admin = await requireAdmin(ctx, token);

    const track = await ctx.db.get(trackId);
    if (!track) return { success: false as const, error: 'Track not found' };
    if (!track.departmentId) {
      return {
        success: false as const,
        error: `Give ${track.name} an owning department first — the lead is the department's.`,
      };
    }

    const lead = await ctx.db.get(userId);
    if (!lead || lead.isDeleted || !lead.isActive) {
      return { success: false as const, error: 'That person is not an active member of staff' };
    }

    const now = Date.now();

    /**
     * The MODERATOR role, not just the per-stream rows.
     *
     * `requireStreamModerator` calls `requireModerator` first, so a
     * `streamModerators` row alone lets someone edit a stream and NOT create a
     * task in it. A track lead who cannot publish Monday's tasks is exactly the
     * split-authority failure this feature exists to remove.
     */
    if (!lead.roles.some((r) => ['admin', 'super_admin', 'moderator'].includes(r))) {
      await ctx.db.patch(lead._id, { roles: [...lead.roles, 'moderator'], updatedAt: now });
    }

    const previousLeadId = (await ctx.db.get(track.departmentId))?.leadUserId ?? null;

    await ctx.db.patch(track.departmentId, { leadUserId: lead._id, updatedAt: now });

    /**
     * EVERY track this department owns, not just the one named.
     *
     * The lead lives on the department and a department can own several tracks
     * — IT & Marketing owned two. Re-materialising only the selected track left
     * the old lead holding grants on the sibling track's streams and gave the
     * new lead none of them, which is a half-transfer that looks complete.
     */
    const siblings = await ctx.db
      .query('tracks')
      .withIndex('by_department', (q) => q.eq('departmentId', track.departmentId))
      .collect();

    let grants = 0;
    for (const t of siblings) grants += await materialiseLeadGrants(ctx, t._id);

    /**
     * Take the moderator role back off the person replaced.
     *
     * The role is platform-wide: it carries visibility of every application and
     * its passport photograph and SIWES letter. Granting it on appointment and
     * never removing it meant a former lead kept that access indefinitely,
     * after their stream grants had been cleaned up — the least visible half of
     * the change outliving the visible half.
     *
     * Only removed when nothing else justifies it: they lead no other
     * department, moderate no stream directly, and are not an admin.
     */
    if (previousLeadId && previousLeadId !== lead._id) {
      await revokeStaleModeratorRole(ctx, previousLeadId, now);
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.track_lead_set',
      tableName: 'tracks',
      recordId: trackId,
      newValues: { track: track.name, lead: lead.email, streamsGranted: grants },
      success: true,
      createdAt: now,
    });

    return { success: true as const, streamsGranted: grants };
  },
});

/** Puts a stream under a track, and hands the lead authority over it. */
export const attachStream = mutation({
  args: { token: v.string(), trackId: v.id('tracks'), streamId: v.id('streams') },
  handler: async (ctx, { token, trackId, streamId }) => {
    await requireAdmin(ctx, token);

    const track = await ctx.db.get(trackId);
    const stream = await ctx.db.get(streamId);
    if (!track || !stream) return { success: false as const, error: 'Track or stream not found' };

    await ctx.db.patch(streamId, { trackId, updatedAt: Date.now() });
    await materialiseLeadGrants(ctx, trackId);

    return { success: true as const };
  },
});

/** Removes a stream from its track, taking the materialised grants with it. */
export const detachStream = mutation({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    await requireAdmin(ctx, token);

    const stream = await ctx.db.get(streamId);
    if (!stream) return { success: false as const, error: 'Stream not found' };

    await ctx.db.patch(streamId, { trackId: undefined, updatedAt: Date.now() });

    // Only the grants this system created. A row an admin added by hand stays.
    for (const row of await ctx.db
      .query('streamModerators')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect()) {
      if (row.source === TRACK_LEAD_GRANT) await ctx.db.delete(row._id);
    }

    return { success: true as const };
  },
});

/**
 * Creates the seven tracks. Idempotent, and never overwrites an edit.
 *
 * Re-runnable on purpose: it is the recovery path if a track is deleted, and it
 * must not undo a department assignment or a renamed label made afterwards.
 */
export const seedTracks = internalMutation({
  args: {},
  returns: v.object({ created: v.number(), existing: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let created = 0;
    let existing = 0;

    for (const seed of TRACK_SEED) {
      const found = await ctx.db
        .query('tracks')
        .withIndex('by_slug', (q) => q.eq('slug', seed.slug))
        .first();

      if (found) {
        existing++;
        continue;
      }

      await ctx.db.insert('tracks', {
        slug: seed.slug,
        name: seed.name,
        shortName: seed.shortName,
        displayOrder: seed.displayOrder,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      created++;
    }

    return { created, existing };
  },
});

/** Re-applies every track's lead grants. Safe to re-run; reports what it fixed. */
export const reconcileLeadGrants = internalMutation({
  args: {},
  returns: v.object({ tracks: v.number(), granted: v.number() }),
  handler: async (ctx) => {
    const tracks = await ctx.db.query('tracks').collect();
    let granted = 0;

    for (const track of tracks) {
      granted += await materialiseLeadGrants(ctx, track._id);
    }

    return { tracks: tracks.length, granted };
  },
});

/**
 * Gives the track's lead a moderator row on every stream the track owns, and
 * removes the rows belonging to whoever held it before.
 *
 * MATERIALISED rather than resolved at check time. Resolving "is this user the
 * lead of the track that owns this stream" inside `requireStreamModerator`
 * would add three reads to the hot path of every task write, would hide the
 * authority from the `by_stream_and_user` index those guards are built on, and
 * would quietly widen per-stream scoping into per-track scoping in three places
 * at once. Rows keep the guards exact; this function is the answer to drift.
 */
/**
 * Removes the platform-wide `moderator` role from someone who no longer needs
 * it, leaving admins and anyone with a live grant alone.
 */
async function revokeStaleModeratorRole(
  ctx: MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;
  if (user.roles.some((r) => r === 'admin' || r === 'super_admin')) return;
  if (!user.roles.includes('moderator')) return;

  // Still leads a department somewhere?
  const departments = await ctx.db.query('departments').collect();
  if (departments.some((d) => d.leadUserId === userId)) return;

  // Still holds a moderator row on any stream, however it was granted?
  const rows = await ctx.db
    .query('streamModerators')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  if (rows.length > 0) return;

  await ctx.db.patch(userId, {
    roles: user.roles.filter((r) => r !== 'moderator'),
    updatedAt: now,
  });
}

async function materialiseLeadGrants(ctx: MutationCtx, trackId: Id<'tracks'>): Promise<number> {
  const track = await ctx.db.get(trackId);
  if (!track) return 0;

  const department = track.departmentId ? await ctx.db.get(track.departmentId) : null;
  const leadId = department?.leadUserId ?? null;

  const streams = await ctx.db
    .query('streams')
    .withIndex('by_track', (q) => q.eq('trackId', trackId))
    .collect();

  const now = Date.now();
  let granted = 0;

  for (const stream of streams) {
    const rows = await ctx.db
      .query('streamModerators')
      .withIndex('by_stream', (q) => q.eq('streamId', stream._id))
      .collect();

    for (const row of rows) {
      // Never touch a hand-granted row, whoever holds it.
      if (row.source !== TRACK_LEAD_GRANT) continue;
      if (leadId && row.userId === leadId) continue;
      await ctx.db.delete(row._id);
    }

    if (!leadId) continue;
    if (rows.some((r) => r.userId === leadId)) continue;

    await ctx.db.insert('streamModerators', {
      streamId: stream._id,
      userId: leadId,
      assignedBy: leadId,
      assignedAt: now,
      source: TRACK_LEAD_GRANT,
    });
    granted++;
  }

  return granted;
}
