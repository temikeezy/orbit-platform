import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { toBadge, ConvexBadge } from '../convexAdapters';

/**
 * Badges, on Convex.
 *
 * Two behaviour corrections come with the swap, both from the server side:
 *
 *  - DELETING A BADGE NOW DEACTIVATES IT. The old `deleteBadge` issued a hard
 *    DELETE on `orbit_badges`, which orphaned every `orbit_user_badges` row
 *    pointing at it — people's earned badges vanished from their profile with no
 *    record of what they had been. `badges.deactivate` keeps the row and its
 *    history.
 *  - AWARDING A BADGE PAYS ITS BONUS. `admin_award_badge` inserted a ledger row
 *    and bumped the user's total; the first draft of the Convex port inserted
 *    only the userBadges row, so every badge with `points_bonus > 0` silently
 *    under-paid. Fixed in `convex/badges.ts` before this module ever called it.
 *
 * `adminId` arguments are accepted and ignored: the session already identifies
 * the caller, and trusting the client to name the acting admin is how an audit
 * trail records whatever it is told.
 */

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon_url: string | null;
  criteria_type: 'tasks' | 'streak' | 'quality' | 'consistency' | 'points';
  criteria_value: number;
  points_bonus: number;
  is_active: boolean;
  earned?: boolean;
  earned_at?: string;
  created_at?: string;
}

export interface UserBadge {
  id: string;
  user_id: string;
  badge_id: string;
  earned_at: string;
  badge?: Badge;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export const badgesApi = {
  async getAllBadges(): Promise<Badge[]> {
    const badges = (await convex.query(api.badges.list, {
      token: requireToken(),
    })) as ConvexBadge[];
    return badges.map(toBadge);
  },

  async getAllBadgesAdmin(): Promise<Badge[]> {
    const badges = (await convex.query(api.badges.list, {
      token: requireToken(),
      includeInactive: true,
    })) as ConvexBadge[];
    return badges.map(toBadge);
  },

  async getBadgesWithUserStatus(userId: string): Promise<Badge[]> {
    const badges = (await convex.query(api.badges.listWithUserStatus, {
      token: requireToken(),
      userId: userId as never,
    })) as ConvexBadge[];
    return badges.map(toBadge);
  },

  async getUserBadges(userId: string): Promise<UserBadge[]> {
    const earned = (await convex.query(api.badges.listForUser, {
      token: requireToken(),
      userId: userId as never,
    })) as ConvexBadge[];

    return earned.map((b) => ({
      id: b.id,
      user_id: userId,
      badge_id: b.id,
      earned_at: b.earnedAt ? new Date(b.earnedAt).toISOString() : '',
      badge: toBadge(b),
    }));
  },

  async createBadge(badge: Omit<Badge, 'id' | 'created_at'>): Promise<Badge> {
    const result = await convex.mutation(api.badges.create, {
      token: requireToken(),
      name: badge.name,
      description: badge.description,
      iconUrl: badge.icon_url ?? undefined,
      criteriaType: badge.criteria_type,
      criteriaValue: badge.criteria_value,
      pointsBonus: badge.points_bonus,
    });

    // No failure branch to check — badges.create returns `{ success: true, id }`
    // unconditionally, and TypeScript says so.
    return { ...badge, id: result.id as string };
  },

  async updateBadge(id: string, updates: Partial<Badge>): Promise<Badge> {
    await convex.mutation(api.badges.update, {
      token: requireToken(),
      id: id as never,
      name: updates.name,
      description: updates.description,
      iconUrl: updates.icon_url ?? undefined,
      criteriaValue: updates.criteria_value,
      pointsBonus: updates.points_bonus,
      isActive: updates.is_active,
    });

    const all = await this.getAllBadgesAdmin();
    const updated = all.find((b) => b.id === id);
    if (!updated) throw new Error('Badge not found after update');
    return updated;
  },

  /**
   * Deactivates. The name is kept so call sites do not move, but nothing is
   * destroyed — see the header.
   */
  async deleteBadge(id: string): Promise<void> {
    const result = await convex.mutation(api.badges.deactivate, {
      token: requireToken(),
      id: id as never,
    });
    if (!result.success) throw new Error('Failed to deactivate badge');
  },

  async awardBadgeToUser(userId: string, badgeId: string, _adminId?: string): Promise<boolean> {
    const result = await convex.mutation(api.badges.awardManually, {
      token: requireToken(),
      userId: userId as never,
      badgeId: badgeId as never,
    });

    if (!result.success) throw new Error(result.error);
    return true;
  },

  async revokeBadgeFromUser(userId: string, badgeId: string, _adminId?: string): Promise<boolean> {
    await convex.mutation(api.badges.revoke, {
      token: requireToken(),
      userId: userId as never,
      badgeId: badgeId as never,
    });
    return true;
  },

  async getBadgeHolders(badgeId: string): Promise<Record<string, unknown>[]> {
    const holders = await convex.query(api.badges.holders, {
      token: requireToken(),
      badgeId: badgeId as never,
    });
    return holders as unknown as Record<string, unknown>[];
  },

  getCriteriaLabel(type: string): string {
    const labels: Record<string, string> = {
      tasks: 'Tasks Completed',
      streak: 'Consecutive Weeks',
      quality: 'High-Quality Submissions',
      consistency: 'Helpful Comments',
      points: 'Total Points',
    };
    return labels[type] || type;
  },

  getCriteriaIcon(type: string): string {
    const icons: Record<string, string> = {
      tasks: '✓',
      streak: '🔥',
      quality: '⭐',
      consistency: '🤝',
      points: '🏆',
    };
    return icons[type] || '🎖️';
  },
};
