import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { badgesApi, Badge } from '../lib/api/badges';
import { Award, Lock, CheckCircle, Trophy, Star, Zap, Target } from 'lucide-react';
import { logError } from '../lib/monitoring';

export function BadgesPage() {
  const { user } = useAuth();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'earned' | 'locked'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  useEffect(() => {
    loadBadges();
  }, [user]);

  const loadBadges = async () => {
    try {
      if (user?.id) {
        const data = await badgesApi.getBadgesWithUserStatus(user.id);
        setBadges(data);
      } else {
        const data = await badgesApi.getAllBadges();
        setBadges(data.map(b => ({ ...b, earned: false })));
      }
    } catch (error) {
      logError(error, { context: 'BadgesPage.loadBadges' });
    } finally {
      setLoading(false);
    }
  };

  const getBadgeTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      tasks: 'from-blue-500 to-blue-600',
      streak: 'from-orange-500 to-orange-600',
      quality: 'from-yellow-500 to-yellow-600',
      consistency: 'from-green-500 to-green-600',
      points: 'from-purple-500 to-purple-600'
    };
    return colors[type] || 'from-slate-500 to-slate-600';
  };

  const getHowToEarn = (type: string, value: number) => {
    const guides: Record<string, string> = {
      tasks: `Complete ${value} task${value > 1 ? 's' : ''} and get them approved by moderators`,
      streak: `Submit tasks on time for ${value} consecutive week${value > 1 ? 's' : ''}`,
      quality: `Receive ${value} high-quality rating${value > 1 ? 's' : ''} (90%+ score) from moderators`,
      consistency: `Help ${value} teammate${value > 1 ? 's' : ''} by commenting and giving feedback`,
      points: `Accumulate ${value} total points through task completions and badges`
    };
    return guides[type] || 'Complete the requirements to unlock this badge';
  };

  const filteredBadges = badges.filter((badge) => {
    if (filter === 'earned') return badge.earned;
    if (filter === 'locked') return !badge.earned;
    return true;
  }).filter((badge) => {
    if (categoryFilter === 'all') return true;
    return badge.criteria_type === categoryFilter;
  });

  const earnedCount = badges.filter((b) => b.earned).length;
  const totalCount = badges.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-slate-600">Loading badges...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Award className="w-8 h-8 text-iih-green" />
            Achievement Badges
          </h1>
          <p className="text-slate-600 mt-1">Unlock badges by completing tasks and reaching milestones. Each badge shows you exactly what you need to do to earn it!</p>
        </div>

        {user && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-white rounded-xl shadow-sm p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-green-500 to-green-600 flex items-center justify-center">
                  <Trophy className="w-6 h-6 text-white" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-slate-800">{earnedCount}</div>
                  <div className="text-sm text-slate-600">Badges Earned</div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                  <Award className="w-6 h-6 text-white" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-slate-800">{totalCount}</div>
                  <div className="text-sm text-slate-600">Total Badges</div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center">
                  <Star className="w-6 h-6 text-white" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-slate-800">
                    {totalCount > 0 ? Math.round((earnedCount / totalCount) * 100) : 0}%
                  </div>
                  <div className="text-sm text-slate-600">Completion</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm p-4 mb-6 space-y-4">
          {user && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-slate-700 mr-2">Status:</span>
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  filter === 'all'
                    ? 'bg-green-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                All ({totalCount})
              </button>
              <button
                onClick={() => setFilter('earned')}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  filter === 'earned'
                    ? 'bg-green-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Earned ({earnedCount})
              </button>
              <button
                onClick={() => setFilter('locked')}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  filter === 'locked'
                    ? 'bg-green-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Locked ({totalCount - earnedCount})
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-700 mr-2">Category:</span>
            <button
              onClick={() => setCategoryFilter('all')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                categoryFilter === 'all'
                  ? 'bg-green-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              All Categories
            </button>
            <button
              onClick={() => setCategoryFilter('tasks')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                categoryFilter === 'tasks'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Task Completion
            </button>
            <button
              onClick={() => setCategoryFilter('streak')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                categoryFilter === 'streak'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Streaks
            </button>
            <button
              onClick={() => setCategoryFilter('quality')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                categoryFilter === 'quality'
                  ? 'bg-yellow-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Quality
            </button>
            <button
              onClick={() => setCategoryFilter('consistency')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                categoryFilter === 'consistency'
                  ? 'bg-green-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Team Work
            </button>
            <button
              onClick={() => setCategoryFilter('points')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                categoryFilter === 'points'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Milestones
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBadges.map((badge) => {
            const isEarned = badge.earned;
            const gradientColor = getBadgeTypeColor(badge.criteria_type);

            return (
              <div
                key={badge.id}
                className={`bg-white rounded-xl shadow-sm overflow-hidden transition-all hover:shadow-md ${
                  isEarned ? 'ring-2 ring-green-500 ring-opacity-50' : 'opacity-75'
                }`}
              >
                <div className={`h-2 bg-gradient-to-r ${gradientColor}`} />

                <div className="p-6">
                  <div className="flex items-start gap-4 mb-4">
                    <div
                      className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl flex-shrink-0 ${
                        isEarned
                          ? `bg-gradient-to-br ${gradientColor}`
                          : 'bg-slate-200'
                      }`}
                    >
                      {isEarned ? (
                        <span className="text-white">{badgesApi.getCriteriaIcon(badge.criteria_type)}</span>
                      ) : (
                        <Lock className="w-8 h-8 text-slate-400" />
                      )}
                    </div>

                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-bold text-slate-800">{badge.name}</h3>
                        {isEarned && (
                          <CheckCircle className="w-5 h-5 text-green-500" />
                        )}
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        isEarned ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {badge.criteria_type}
                      </span>
                    </div>
                  </div>

                  <p className="text-sm text-slate-600 mb-4">
                    {badge.description}
                  </p>

                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
                    <div className="flex items-start gap-2">
                      <Target className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <div className="text-xs font-medium text-blue-900 mb-1">How to Earn:</div>
                        <div className="text-xs text-blue-800">{getHowToEarn(badge.criteria_type, badge.criteria_value)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Requirement:</span>
                      <span className="font-medium text-slate-800">
                        {badge.criteria_value} {badgesApi.getCriteriaLabel(badge.criteria_type)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Reward:</span>
                      <span className="font-bold text-green-600">
                        +{badge.points_bonus} points
                      </span>
                    </div>

                    {isEarned && badge.earned_at && (
                      <div className="pt-3 mt-3 border-t border-slate-200">
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <Zap className="w-4 h-4" />
                          <span>
                            Earned {new Date(badge.earned_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric'
                            })}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {filteredBadges.length === 0 && (
          <div className="text-center py-12">
            <Award className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-600 text-lg">
              {filter === 'earned' && 'You haven\'t earned any badges yet. Keep completing tasks!'}
              {filter === 'locked' && 'You\'ve earned all available badges! Amazing work!'}
              {filter === 'all' && 'No badges available at the moment.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
