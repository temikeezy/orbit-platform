import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';

/**
 * Leaderboard.
 *
 * A NEW MODULE: this had none. `LeaderboardPage.tsx` queried Supabase inline —
 * and what it queried was the ENTIRE points ledger for the period, every row for
 * every user, aggregated in the browser to render a top-N list. Every client
 * downloaded every member's point history to draw twenty rows, and
 * `show_on_leaderboard` was applied after the data had already been sent, which
 * means it was not applied at all.
 *
 * `leaderboard.top` aggregates server-side and returns a ranked list. The
 * privacy flag is honoured before anything leaves the deployment.
 *
 * The period names differ from the old page's and the mapping is deliberate:
 * `weekly`/`monthly` are ROLLING windows (last 7 and 30 days) rather than
 * calendar week-to-date and month-to-date. The old page anchored the week to
 * Monday and the month to the 1st, so a leaderboard checked on the 1st of the
 * month showed almost nothing. Rolling is both more useful and what the weekly
 * cron already computes.
 */

export interface LeaderboardEntry {
  rank: number;
  id: string;
  full_name: string;
  total_points: number;
  profile_photo_url?: string;
  current_level: number;
}

export type LeaderboardPeriod = 'overall' | 'monthly' | 'weekly';

const PERIODS: Record<LeaderboardPeriod, 'all' | 'week' | 'month'> = {
  overall: 'all',
  weekly: 'week',
  monthly: 'month',
};

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  /** The viewer's own row when they fall outside the returned page. */
  viewer: LeaderboardEntry | null;
  totalRanked: number;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

interface ConvexEntry {
  userId: string;
  fullName: string;
  profilePhotoUrl?: string;
  currentLevel: number;
  points: number;
  rank: number;
}

function toEntry(e: ConvexEntry): LeaderboardEntry {
  return {
    rank: e.rank,
    id: e.userId,
    full_name: e.fullName,
    total_points: e.points,
    profile_photo_url: e.profilePhotoUrl,
    current_level: e.currentLevel,
  };
}

export const leaderboardApi = {
  async get(period: LeaderboardPeriod = 'overall', limit = 50): Promise<LeaderboardResult> {
    const result = await convex.query(api.leaderboard.top, {
      token: requireToken(),
      period: PERIODS[period],
      limit,
    });

    return {
      entries: (result.entries as ConvexEntry[]).map(toEntry),
      // Always returned, even when outside the top N — a member below the cut
      // otherwise sees no position at all, which is the one number they came for.
      viewer: result.viewer ? toEntry(result.viewer as ConvexEntry) : null,
      totalRanked: result.totalRanked,
    };
  },

  /** One member's standing, for a profile page. */
  async standingFor(userId: string): Promise<{ points: number; rank: number } | null> {
    const result = await convex.query(api.leaderboard.standingFor, {
      token: requireToken(),
      userId: userId as never,
    });
    return result ? { points: result.points, rank: result.rank } : null;
  },
};
