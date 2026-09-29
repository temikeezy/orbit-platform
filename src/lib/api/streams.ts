import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { usersApi } from './users';
import { OrbitStream, OrbitStreamMembership, OrbitUser } from '../../types/database';
import { storageUtils } from '../utils/storage';
import { toStream, ConvexStream } from '../convexAdapters';

/**
 * Streams and memberships, on Convex.
 *
 * `member_count` is DERIVED from active memberships on every read, never stored.
 * The Postgres counter was maintained by a trigger that fired on INSERT and
 * DELETE — but the app never deleted a membership, it flipped `is_active`, and
 * the trigger's UPDATE branch ignored that. So the count never decremented and
 * every reassignment double-counted. It was correct only because nobody had
 * left a stream yet.
 *
 * `assignMemberToStream` used to do the one-active-stream rule in the browser:
 * read the existing membership, deactivate it, insert a new one, patch the user.
 * Four unrelated writes with no transaction, from a client that checked none of
 * the results. `streams.addMember` is one mutation, and it REACTIVATES an
 * existing row rather than inserting a second — which is the other reason the
 * old counter double-counted.
 */

/**
 * privacy and join_type are closed unions, not free text. They are inputs to an
 * authorization decision — `streams.join` opens a stream to walk-ins only when
 * both say so — and the Postgres columns were unconstrained varchars.
 */
export type StreamPrivacy = 'public' | 'private';
export type StreamJoinType = 'open' | 'invite';

export interface CreateStreamData {
  name: string;
  description?: string;
  emoji?: string;
  privacy?: StreamPrivacy;
  join_type?: StreamJoinType;
}

export interface UpdateStreamData {
  name?: string;
  description?: string;
  emoji?: string;
  is_active?: boolean;
  privacy?: StreamPrivacy;
  join_type?: StreamJoinType;
}

/**
 * A roster entry. Deliberately NOT an OrbitUser: that type declares
 * `total_points` and `current_level` as always present, and the whole point of
 * the roster shape is that they are withheld for members who opted out.
 */
export interface StreamMember {
  id: string;
  email: string;
  full_name: string;
  roles: OrbitUser['roles'];
  profile_photo_url?: string;
  profile_slug?: string;
  total_points?: number;
  current_level?: number;
  is_active: boolean;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

export interface AssignMemberToStreamData {
  user_id: string;
  stream_id: string;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export const streamsApi = {
  /**
   * Active streams. Under Supabase this selected every row including
   * deactivated ones, because there was no filter — and deactivation is now the
   * delete path, so "all" would mean showing deleted streams in the task and
   * community pickers. Admin screens that genuinely need the deleted ones ask
   * for them explicitly below.
   */
  async getAllStreams(): Promise<OrbitStream[]> {
    return this.getActiveStreams();
  },

  async getActiveStreams(): Promise<OrbitStream[]> {
    const rows = await convex.query(api.streams.list, { token: requireToken() });
    return (rows as ConvexStream[]).map(toStream);
  },

  /** Admin only — `list` rejects the flag from anyone else. */
  async getAllStreamsIncludingInactive(): Promise<OrbitStream[]> {
    const rows = await convex.query(api.streams.list, {
      token: requireToken(),
      includeInactive: true,
    });
    return (rows as ConvexStream[]).map(toStream);
  },

  async getStreamById(id: string): Promise<OrbitStream | null> {
    const row = await convex.query(api.streams.getById, {
      token: requireToken(),
      streamId: id as never,
    });
    return row ? toStream(row as unknown as ConvexStream) : null;
  },

  /** The caller's own streams — what the sidebar and dashboards need. */
  async getMyStreams(): Promise<OrbitStream[]> {
    const rows = await convex.query(api.streams.myStreams, { token: requireToken() });
    return (rows as ConvexStream[]).map(toStream);
  },

  async createStream(streamData: CreateStreamData, _createdBy?: string): Promise<OrbitStream> {
    const result = await convex.mutation(api.streams.create, {
      token: requireToken(),
      name: streamData.name,
      description: streamData.description,
      emoji: streamData.emoji,
      privacy: streamData.privacy,
      joinType: streamData.join_type,
    });

    const created = await this.getStreamById(result.id as string);
    if (!created) throw new Error('Stream not found after creation');
    return created;
  },

  /**
   * Updates a stream.
   *
   * `is_active` is NOT passed through to `streams.update`: reactivating and
   * deactivating are admin-only, and accepting the flag there would let a stream
   * moderator reach a path admins have no dedicated route for. Deactivation goes
   * via `deleteStream` below.
   */
  async updateStream(id: string, streamData: UpdateStreamData): Promise<OrbitStream> {
    if (streamData.is_active === false) {
      await this.deleteStream(id);
    } else if (streamData.is_active === true) {
      // Reactivation is admin-only and has its own mutation. Folding it into
      // `update` would let a stream moderator undo an admin's removal.
      await convex.mutation(api.streams.reactivate, {
        token: requireToken(),
        streamId: id as never,
      });
    }

    const { is_active: _ignored, ...editable } = streamData;

    if (Object.values(editable).some((v) => v !== undefined)) {
      await convex.mutation(api.streams.update, {
        token: requireToken(),
        streamId: id as never,
        name: editable.name,
        description: editable.description,
        emoji: editable.emoji,
        privacy: editable.privacy,
        joinType: editable.join_type,
      });
    }

    // A deactivated stream reads as null to everyone but an admin, and the only
    // caller that deactivates IS an admin — but the re-read is a courtesy, not
    // the write, so a null here must not turn a successful update into an error.
    const updated = await this.getStreamById(id);
    if (updated) return updated;

    return {
      id,
      name: streamData.name ?? '',
      is_active: streamData.is_active ?? false,
      created_by: '',
      created_at: new Date(0).toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  /**
   * Deactivates. Named `deleteStream` so call sites do not move.
   *
   * The old one hard-deleted the row, orphaning its tasks, memberships, chat and
   * every submission underneath them.
   */
  async deleteStream(id: string): Promise<void> {
    await convex.mutation(api.streams.deactivate, {
      token: requireToken(),
      streamId: id as never,
    });
  },

  /**
   * The roster.
   *
   * `total_points` and `current_level` are OPTIONAL here and absent for anyone
   * who opted off the leaderboard — the server omits them rather than sending a
   * zero, because a zero renders as a real score. `email` is never included at
   * all: the roster is readable by every member of the stream, and an address
   * is not.
   */
  async getStreamMembers(streamId: string): Promise<StreamMember[]> {
    const rows = await convex.query(api.streams.members, {
      token: requireToken(),
      streamId: streamId as never,
    });

    return (rows as Record<string, unknown>[]).map((m) => ({
      id: m.id as string,
      email: '',
      full_name: m.fullName as string,
      roles: (m.roles as OrbitUser['roles']) ?? [],
      profile_photo_url: m.profilePhotoUrl as string | undefined,
      profile_slug: m.profileSlug as string | undefined,
      total_points: m.totalPoints as number | undefined,
      current_level: m.currentLevel as number | undefined,
      is_active: true,
      joined_at: new Date((m.joinedAt as number) ?? 0).toISOString(),
      created_at: new Date((m.joinedAt as number) ?? 0).toISOString(),
      updated_at: new Date((m.joinedAt as number) ?? 0).toISOString(),
    }));
  },

  async getStreamMemberships(streamId: string): Promise<OrbitStreamMembership[]> {
    const rows = await convex.query(api.streams.memberships, {
      token: requireToken(),
      streamId: streamId as never,
    });

    return (rows as Record<string, unknown>[]).map((m) => ({
      id: m.id as string,
      user_id: m.userId as string,
      stream_id: m.streamId as string,
      is_active: m.isActive as boolean,
      started_at: new Date(m.startedAt as number).toISOString(),
      ended_at: m.endedAt ? new Date(m.endedAt as number).toISOString() : undefined,
      assigned_by: '',
      created_at: new Date(m.startedAt as number).toISOString(),
    })) as OrbitStreamMembership[];
  },

  async assignMemberToStream(
    assignmentData: AssignMemberToStreamData,
    _assignedBy?: string,
  ): Promise<void> {
    const result = await convex.mutation(api.streams.addMember, {
      token: requireToken(),
      streamId: assignmentData.stream_id as never,
      userId: assignmentData.user_id as never,
    });
    if (!result.success) throw new Error('Could not assign the member.');
  },

  /**
   * Moderator action: takes someone else out of a stream.
   *
   * The old signature took only a userId, because the browser looked the
   * membership row up first. The mutation needs both ids, so an omitted stream
   * falls back to the one the user is recorded as being in — a single read
   * rather than the roster scan the browser used to do.
   */
  async removeMemberFromStream(userId: string, streamId?: string): Promise<void> {
    let stream = streamId;

    if (!stream) {
      const user = await usersApi.getUserById(userId);
      stream = user?.current_stream_id;
    }
    if (!stream) return;

    await convex.mutation(api.streams.removeMember, {
      token: requireToken(),
      streamId: stream as never,
      userId: userId as never,
    });
  },

  /**
   * Self-service join/leave, behind their own mutations.
   *
   * These cannot go through addMember/removeMember: those are moderator-gated,
   * and the Join button on a stream page exists precisely for people who are
   * not moderators. `streams.join` authorises against the stream's joinType and
   * `streams.leave` takes no userId at all, so neither can be aimed at another
   * member.
   */
  async joinStream(streamId: string): Promise<void> {
    await convex.mutation(api.streams.join, {
      token: requireToken(),
      streamId: streamId as never,
    });
  },

  async leaveStream(streamId: string): Promise<void> {
    await convex.mutation(api.streams.leave, {
      token: requireToken(),
      streamId: streamId as never,
    });
  },

  /** Counts for the stream card. One call; the client used to do three. */
  async getStreamStats(streamId: string) {
    return convex.query(api.streams.stats, {
      token: requireToken(),
      streamId: streamId as never,
    });
  },

  async uploadStreamCoverPhoto(streamId: string, file: File): Promise<string> {
    const { url } = await storageUtils.uploadStreamCoverPhoto(streamId, file);
    return url;
  },

  async uploadStreamDisplayPhoto(streamId: string, file: File): Promise<string> {
    const { url } = await storageUtils.uploadStreamDisplayPhoto(streamId, file);
    return url;
  },
};
