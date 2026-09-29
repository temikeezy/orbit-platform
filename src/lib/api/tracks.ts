import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';

/**
 * Programme tracks.
 *
 * Direct `convex.mutation` calls rather than the `orbit_siwes_*` shim: there is
 * no legacy Postgres name for any of this, and inventing one would add to a
 * compatibility layer whose whole purpose is eventual deletion.
 */
function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export interface Track {
  id: string;
  slug: string;
  name: string;
  shortName: string | null;
  isActive: boolean;
  departmentId: string | null;
  departmentName: string | null;
  leadUserId: string | null;
  leadName: string | null;
  streams: { id: string; name: string; emoji: string | null }[];
}

export const tracksApi = {
  async list(): Promise<Track[]> {
    return (await convex.query(api.tracks.list, { token: requireToken() })) as Track[];
  },

  async setDepartment(trackId: string, name: string, departmentId: string | null): Promise<void> {
    const result = await convex.mutation(api.tracks.save, {
      token: requireToken(),
      trackId: trackId as never,
      name,
      departmentId: (departmentId || undefined) as never,
      // Convex omits an undefined field, so "Not assigned" has to say so.
      clearDepartment: !departmentId,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not update this track');
  },

  async setLead(trackId: string, userId: string): Promise<number> {
    const result = await convex.mutation(api.tracks.setLead, {
      token: requireToken(),
      trackId: trackId as never,
      userId: userId as never,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not set this lead');
    return result.streamsGranted ?? 0;
  },

  async attachStream(trackId: string, streamId: string): Promise<void> {
    const result = await convex.mutation(api.tracks.attachStream, {
      token: requireToken(),
      trackId: trackId as never,
      streamId: streamId as never,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not attach this stream');
  },

  async detachStream(streamId: string): Promise<void> {
    const result = await convex.mutation(api.tracks.detachStream, {
      token: requireToken(),
      streamId: streamId as never,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not detach this stream');
  },
};
