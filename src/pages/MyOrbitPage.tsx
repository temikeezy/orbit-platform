import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { badgesApi, UserBadge } from '../lib/api/badges';
import { convexHttp as convex } from '../lib/convex';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { levelsApi } from '../lib/api/levels';
import { SiwesStatusCard } from '../components/logbook/SiwesStatusCard';
import { Award, TrendingUp, Target, Trophy, Rocket, Loader2, Flame } from 'lucide-react';

interface WeeklyPoint {
  day: string;
  points: number;
  date: string;
}

interface ActivitySummary {
  posts: number;
  comments: number;
  likesReceived: number;
  streamMemberships: number;
}

interface LevelInfo {
  current: { name: string; min_points: number };
  next: { name: string; min_points: number } | null;
}

export function MyOrbitPage() {
  const { user } = useAuth();
  const [userBadges, setUserBadges] = useState<UserBadge[]>([]);
  const [tasksCompleted, setTasksCompleted] = useState<number>(0);
  const [weeklyActivity, setWeeklyActivity] = useState<WeeklyPoint[]>([]);
  const [activitySummary, setActivitySummary] = useState<ActivitySummary>({
    posts: 0,
    comments: 0,
    likesReceived: 0,
    streamMemberships: 0,
  });
  const [levelInfo, setLevelInfo] = useState<LevelInfo | null>(null);
  const [weeklyPoints, setWeeklyPoints] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.id) {
      loadAllData();
    }
  }, [user?.id]);

  const loadAllData = async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      await Promise.all([
        loadUserBadges(),
        loadStats(),
        loadLevelInfo(),
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadUserBadges = async () => {
    if (!user?.id) return;
    try {
      const badges = await badgesApi.getUserBadges(user.id);
      setUserBadges(badges);
    } catch (_e) { /* empty */ }
  };

  /**
   * One call for the whole dashboard.
   *
   * The page assembled this from six reads the browser ran directly against the
   * tables — a submissions count, the points ledger, and four `head: true`
   * counts over posts, replies, likes and memberships. Every one was a filter
   * the browser chose on a table without RLS, so any of them could be aimed at
   * another user by changing an id: the dashboard was a general-purpose reader
   * for anyone's activity. `users.myStats` is scoped to the session, so there
   * is no id left to change.
   */
  const loadStats = async () => {
    const token = authService.getToken();
    if (!token) return;

    try {
      const stats = await convex.query(api.users.myStats, { token });

      setTasksCompleted(stats.tasksCompleted);
      setWeeklyPoints(stats.weekly.reduce((sum, w) => sum + w.points, 0));
      setActivitySummary({
        posts: stats.posts,
        comments: stats.comments,
        likesReceived: stats.likesReceived,
        streamMemberships: stats.streamMemberships,
      });

      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      setWeeklyActivity(
        stats.weekly.map((w) => ({
          // Parsed as UTC deliberately: the buckets are UTC calendar days, and
          // `new Date('YYYY-MM-DD')` already parses as UTC, so reading the
          // local day back out would shift the labels west of Greenwich.
          day: days[new Date(`${w.date}T00:00:00Z`).getUTCDay()],
          date: w.date,
          points: w.points,
        })),
      );
    } catch (_e) { /* empty */ }
  };

  const loadLevelInfo = async () => {
    try {
      // levelsApi already resolves the caller's level and the next one, points
      // needed included. The page fetched the whole levels table and worked it
      // out in a loop — and read `min_points`, a column that does not exist
      // (it is `points_required`), so every comparison was against undefined
      // and the progress bar was pinned to the first level.
      const info = await levelsApi.getLevelInfo(user?.total_points ?? 0);
      if (!info) return;

      setLevelInfo({
        current: { name: info.current_level.name, min_points: info.current_level.points_required },
        next: info.next_level
          ? { name: info.next_level.name, min_points: info.next_level.points_required }
          : null,
      });
    } catch (_e) { /* empty */ }
  };

  const currentPoints = user?.total_points ?? 0;
  const levelProgress = levelInfo?.next
    ? Math.min(
        100,
        Math.round(
          ((currentPoints - levelInfo.current.min_points) /
            (levelInfo.next.min_points - levelInfo.current.min_points)) *
            100
        )
      )
    : 100;
  const ptsToNextLevel = levelInfo?.next
    ? levelInfo.next.min_points - currentPoints
    : 0;

  const maxPoints = weeklyActivity.length > 0 ? Math.max(...weeklyActivity.map((d) => d.points), 1) : 1;

  const recentAchievements = userBadges.slice(0, 3).map((ub) => ({
    title: ub.badge?.name || 'Badge',
    description: ub.badge?.description || '',
    date: new Date(ub.earned_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
  }));

  const activitySummaryItems = [
    { label: 'Posts Created', value: activitySummary.posts },
    { label: 'Comments Made', value: activitySummary.comments },
    { label: 'Likes Received', value: activitySummary.likesReceived },
    { label: 'Stream Memberships', value: activitySummary.streamMemberships },
  ];

  const streak = user?.login_streak_count ?? 0;

  const stats = [
    {
      label: 'Total Points',
      value: currentPoints.toLocaleString(),
      icon: Award,
      change: weeklyPoints > 0 ? `+${weeklyPoints} this week` : 'No points this week',
    },
    {
      label: 'Current Level',
      value: user?.current_level || 1,
      icon: TrendingUp,
      change: levelInfo?.current.name ?? `Level ${user?.current_level || 1}`,
    },
    {
      label: 'Tasks Completed',
      value: tasksCompleted,
      icon: Target,
      change: tasksCompleted === 1 ? '1 task approved' : `${tasksCompleted} tasks approved`,
    },
    {
      label: 'Login Streak',
      value: streak > 0 ? `${streak} 🔥` : '0',
      icon: Flame,
      change: streak > 1 ? `${streak} days in a row!` : streak === 1 ? 'Keep going!' : 'Log in daily to build a streak',
    },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Rocket className="w-8 h-8 text-iih-green" />
            My ORBIT
          </h1>
          <p className="text-slate-600 mt-1">Your personal dashboard and achievements</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
                <div
                  className="w-12 h-12 rounded-lg bg-white border border-slate-200 flex items-center justify-center mb-4"
                >
                  <Icon className="w-6 h-6 text-emerald-600" />
                </div>
                <div className="text-3xl font-bold text-slate-800 mb-1">{stat.value}</div>
                <div className="text-sm text-slate-600 mb-2">{stat.label}</div>
                <div className="text-xs text-slate-500">{stat.change}</div>
              </div>
            );
          })}
        </div>

        {/* SIWES internship summary (renders only when the user has a profile) */}
        <div className="mb-8">
          <SiwesStatusCard />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Weekly Activity Chart */}
          <div className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-bold text-slate-800 mb-6">Weekly Activity</h2>
            <div className="flex items-end justify-between gap-2 h-48">
              {weeklyActivity.map((day) => {
                const height = Math.max((day.points / maxPoints) * 100, day.points > 0 ? 4 : 0);
                return (
                  <div key={day.date} className="flex-1 flex flex-col items-center gap-2">
                    <div className="flex-1 flex items-end w-full">
                      <div
                        className="w-full bg-gradient-to-t from-iih-green to-iih-green-dark rounded-t-lg transition-all hover:opacity-80"
                        style={{ height: `${height}%`, minHeight: day.points > 0 ? '4px' : '0' }}
                        title={`${day.points} points`}
                      />
                    </div>
                    <span className="text-xs text-slate-600 font-medium">{day.day}</span>
                  </div>
                );
              })}
            </div>
            {weeklyActivity.every((d) => d.points === 0) && (
              <p className="text-center text-slate-500 text-sm mt-4">
                No points earned this week — submit a task to get started!
              </p>
            )}
            <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
              {activitySummaryItems.map((item) => (
                <div key={item.label} className="text-center p-3 bg-slate-50 rounded-lg">
                  <div className="text-2xl font-bold text-slate-800">{item.value}</div>
                  <div className="text-xs text-slate-600 mt-1">{item.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Badges */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-bold text-slate-800 mb-6">Recent Badges</h2>
            {recentAchievements.length > 0 ? (
              <div className="space-y-4">
                {recentAchievements.map((achievement) => (
                  <div
                    key={achievement.title}
                    className="flex gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    <div className="w-12 h-12 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0">
                      <Trophy className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-800 text-sm">{achievement.title}</h3>
                      <p className="text-xs text-slate-600 mt-1">{achievement.description}</p>
                      <p className="text-xs text-slate-500 mt-1">{achievement.date}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-slate-500">
                <Trophy className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No badges yet</p>
                <p className="text-xs mt-1">Complete tasks to earn your first badge!</p>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Level Progress */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-bold text-slate-800 mb-6">Progress to Next Level</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">
                  {levelInfo?.current.name ?? `Level ${user?.current_level || 1}`}
                </span>
                <span className="text-sm font-medium text-slate-700">
                  {levelInfo?.next?.name ?? 'Max Level'}
                </span>
              </div>
              <div className="h-4 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-iih-green to-iih-green-dark rounded-full transition-all duration-500"
                  style={{ width: `${levelProgress}%` }}
                />
              </div>
              <div className="flex justify-between items-center">
                <p className="text-sm text-slate-600">
                  {currentPoints.toLocaleString()} /{' '}
                  {levelInfo?.next
                    ? levelInfo.next.min_points.toLocaleString()
                    : '∞'}{' '}
                  pts
                </p>
                {levelInfo?.next && ptsToNextLevel > 0 && (
                  <p className="text-sm font-semibold text-iih-green-darker">
                    {ptsToNextLevel} pts to {levelInfo.next.name}
                  </p>
                )}
                {!levelInfo?.next && (
                  <p className="text-sm font-semibold text-amber-600">Max level reached! 🏆</p>
                )}
              </div>
            </div>
          </div>

          {/* Profile Summary */}
          <div className="bg-gradient-to-br from-iih-green to-iih-green-dark rounded-xl shadow-sm p-6 text-white">
            <h2 className="text-xl font-bold mb-4">Profile Summary</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-green-100">Name:</span>
                <span className="font-medium">{user?.full_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-100">Email:</span>
                <span className="font-medium">{user?.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-100">Role:</span>
                <span className="font-medium capitalize">
                  {user?.roles?.[0]?.replace('_', ' ') ?? 'Member'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-100">Member Since:</span>
                <span className="font-medium">
                  {user?.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
