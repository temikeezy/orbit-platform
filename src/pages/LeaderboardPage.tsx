import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trophy, Medal, Award, TrendingUp, Calendar, Clock, Loader2 } from 'lucide-react';
import { leaderboardApi, LeaderboardEntry, LeaderboardPeriod } from '../lib/api/leaderboard';
import { logError } from '../lib/monitoring';

type ViewFilter = LeaderboardPeriod;

export function LeaderboardPage() {
  const navigate = useNavigate();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewFilter, setViewFilter] = useState<ViewFilter>('overall');

  useEffect(() => {
    loadLeaderboard();
  }, [viewFilter]);

  const loadLeaderboard = async () => {
    try {
      setLoading(true);

      // One call. This used to fetch every points-ledger row for the period and
      // aggregate them in the browser — every client downloading every member's
      // point history to render twenty rows, with the show_on_leaderboard
      // privacy flag applied only after the data had already been sent.
      const result = await leaderboardApi.get(viewFilter);

      // The viewer's own row is appended when they fall outside the page.
      // `leaderboard.top` returns it precisely so somebody below the cut sees a
      // position rather than nothing; discarding it wasted the round trip and
      // left the one number they came for off the screen.
      setLeaderboard(result.viewer ? [...result.entries, result.viewer] : result.entries);
    } catch (error) {
      logError(error, { context: 'LeaderboardPage.loadLeaderboard' });
      setLeaderboard([]);
    } finally {
      setLoading(false);
    }
  };

  const getRankIcon = (rank: number) => {
    if (rank === 1) return Trophy;
    if (rank === 2 || rank === 3) return Medal;
    return Award;
  };

  const getRankColor = (rank: number) => {
    if (rank === 1) return 'text-amber-500';
    if (rank === 2) return 'text-slate-400';
    if (rank === 3) return 'text-orange-400';
    return 'text-slate-300';
  };

  const getInitials = (name: string | null | undefined) =>
    (name ?? 'U').split(' ').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 2) || 'U';

  const periodLabel =
    viewFilter === 'overall'
      ? 'All-time points'
      : viewFilter === 'monthly'
      ? 'Points this month'
      : 'Points this week';

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-iih-green" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3 mb-2">
            <Trophy className="w-8 h-8 text-iih-green" />
            Leaderboard
          </h1>
          <p className="text-slate-600">Compete with fellow members and climb to the top!</p>
        </div>

        {/* Filter tabs */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                { id: 'overall', label: 'Overall', icon: TrendingUp },
                { id: 'monthly', label: 'Monthly', icon: Calendar },
                { id: 'weekly', label: 'This Week', icon: Clock },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setViewFilter(id)}
                className={`px-6 py-3 rounded-lg font-medium transition-all flex items-center gap-2 ${
                  viewFilter === id
                    ? 'bg-iih-green text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
                }`}
              >
                <Icon className="w-5 h-5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Top 3 podium */}
        {leaderboard.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            {leaderboard.slice(0, 3).map((entry) => {
              const Icon = getRankIcon(entry.rank);
              const iconColor = getRankColor(entry.rank);
              return (
                <div
                  key={entry.id}
                  className="bg-white rounded-xl shadow-sm border border-slate-200 p-6"
                >
                  <div className="flex flex-col items-center text-center">
                    <Icon className={`w-12 h-12 ${iconColor} mb-4`} />
                    <div className="text-3xl font-bold mb-2 text-slate-700">#{entry.rank}</div>
                    <div className="w-20 h-20 rounded-full bg-iih-green flex items-center justify-center text-white text-xl font-bold mb-3 overflow-hidden">
                      {entry.profile_photo_url ? (
                        <img
                          src={entry.profile_photo_url}
                          alt={entry.full_name}
                          className="w-20 h-20 object-cover"
                        />
                      ) : (
                        getInitials(entry.full_name)
                      )}
                    </div>
                    <button
                      onClick={() => navigate(`/users/${entry.id}`)}
                      className="text-lg font-bold text-slate-800 mb-2 hover:text-iih-green transition-colors hover:underline"
                    >
                      {entry.full_name}
                    </button>
                    <div className="text-2xl font-bold text-iih-green mb-1">
                      {entry.total_points.toLocaleString()}
                    </div>
                    <div className="text-sm text-slate-600">{periodLabel}</div>
                    <div className="mt-3 px-3 py-1 bg-slate-100 rounded-full text-xs font-medium text-slate-600">
                      Level {entry.current_level}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Full table */}
        {leaderboard.length > 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-4 text-left text-sm font-bold text-slate-700 uppercase">Rank</th>
                    <th className="px-6 py-4 text-left text-sm font-bold text-slate-700 uppercase">Name</th>
                    <th className="px-6 py-4 text-left text-sm font-bold text-slate-700 uppercase">Level</th>
                    <th className="px-6 py-4 text-right text-sm font-bold text-slate-700 uppercase">
                      {periodLabel}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {leaderboard.map((entry) => {
                    const Icon = getRankIcon(entry.rank);
                    const iconColor = getRankColor(entry.rank);
                    return (
                      <tr key={entry.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <Icon className={`w-6 h-6 ${iconColor}`} />
                            <span className="text-xl font-bold text-slate-700">#{entry.rank}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-iih-green flex items-center justify-center text-white text-sm font-bold overflow-hidden">
                              {entry.profile_photo_url ? (
                                <img
                                  src={entry.profile_photo_url}
                                  alt={entry.full_name}
                                  className="w-10 h-10 object-cover"
                                />
                              ) : (
                                getInitials(entry.full_name)
                              )}
                            </div>
                            <button
                              onClick={() => navigate(`/users/${entry.id}`)}
                              className="font-bold text-slate-800 hover:text-iih-green transition-colors hover:underline"
                            >
                              {entry.full_name}
                            </button>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center gap-2 px-3 py-1 bg-slate-100 rounded-full">
                            <Award className="w-4 h-4 text-slate-600" />
                            <span className="font-medium text-slate-700">Level {entry.current_level}</span>
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="text-xl font-bold text-iih-green">
                            {entry.total_points.toLocaleString()}
                          </div>
                          <div className="text-xs text-slate-500">pts</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
            <Trophy className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-800 mb-2">
              {viewFilter === 'overall' ? 'No rankings yet' : `No activity ${viewFilter === 'weekly' ? 'this week' : 'this month'}`}
            </h3>
            <p className="text-slate-600">
              Complete tasks and earn points to appear on the leaderboard!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
