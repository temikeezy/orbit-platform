import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';

export interface AdminStats {
  totalUsers: number;
  activeStreams: number;
  totalTasks: number;
  activeMembers: number;
  recentUsers: number;
  recentStreams: number;
  recentTasks: number;
}

export const adminApi = {
  /**
   * The dashboard counters.
   *
   * No fallback to a zeroed object. The old version returned `data?.data || {…0}`,
   * so an authorization failure, a dropped connection or a renamed RPC all
   * rendered as a platform with no users — an admin looking at a dashboard of
   * zeroes could not tell "nothing here yet" from "this call failed". A refusal
   * throws now, and the page shows an error.
   */
  async getStats(): Promise<AdminStats> {
    const token = authService.getToken();
    if (!token) throw new Error('Not authenticated');

    return convex.query(api.admin.stats, { token });
  },
};
