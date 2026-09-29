/**
 * Shows a modal when the user has earned new badges since their last login.
 * Badge count is persisted in localStorage and compared against the current
 * count from the API on each app mount.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { badgesApi, UserBadge } from '../../lib/api/badges';
import { Trophy, X } from 'lucide-react';

/** Scoped to the account — see LevelUpCelebration for why a shared key misfires. */
const lastBadgeCountKey = (userId: string) => `orbit_last_badge_count:${userId}`;

export function BadgeUnlockCelebration() {
  const { user } = useAuth();
  const hasChecked = useRef(false);
  const [showModal, setShowModal] = useState(false);
  const [newBadges, setNewBadges] = useState<UserBadge[]>([]);

  useEffect(() => {
    if (!user?.id || hasChecked.current) return;
    hasChecked.current = true;
    checkForNewBadges();
  }, [user?.id]);

  const checkForNewBadges = async () => {
    if (!user?.id) return;
    try {
      const badges = await badgesApi.getUserBadges(user.id);
      const currentCount = badges.length;
      const storedCount = parseInt(localStorage.getItem(lastBadgeCountKey(user.id)) ?? '0', 10);

      if (storedCount > 0 && currentCount > storedCount) {
        const newest = badges.slice(0, currentCount - storedCount);
        setNewBadges(newest);
        setShowModal(true);
      }

      localStorage.setItem(lastBadgeCountKey(user.id), String(currentCount));
    } catch {
      // Non-critical — silently fail
    }
  };

  if (!showModal || newBadges.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9997]">
      {/* `relative`, so the close button below anchors to the CARD. Without it
          its nearest positioned ancestor is the fixed full-screen overlay, and
          the X rendered detached in the corner of the viewport over the scrim. */}
      <div className="relative bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full mx-4 text-center">
        <button
          onClick={() => setShowModal(false)}
          aria-label="Close"
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Trophy className="w-10 h-10 text-amber-500" />
        </div>

        <h2 className="text-2xl font-extrabold text-slate-800 mb-2">
          {newBadges.length === 1 ? 'New Badge Unlocked! 🏅' : `${newBadges.length} New Badges! 🏅`}
        </h2>

        <div className="space-y-3 mt-4 mb-6">
          {newBadges.map((ub) => (
            <div
              key={ub.id}
              className="flex items-center gap-3 bg-amber-50 rounded-lg p-3"
            >
              <div className="w-10 h-10 bg-amber-200 rounded-full flex items-center justify-center flex-shrink-0 text-lg overflow-hidden">
                {ub.badge?.icon_url ? (
                  <img src={ub.badge.icon_url} alt={ub.badge.name} className="w-10 h-10 object-cover" />
                ) : (
                  '🏆'
                )}
              </div>
              <div className="text-left">
                <div className="font-bold text-slate-800 text-sm">{ub.badge?.name}</div>
                {ub.badge?.description && (
                  <div className="text-xs text-slate-600">{ub.badge.description}</div>
                )}
                {(ub.badge?.points_bonus ?? 0) > 0 && (
                  <div className="text-xs text-iih-green font-semibold">
                    +{ub.badge?.points_bonus} pts
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => setShowModal(false)}
          className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-bold py-3 rounded-lg transition-colors"
        >
          Claim Glory! 🎉
        </button>
      </div>
    </div>
  );
}
