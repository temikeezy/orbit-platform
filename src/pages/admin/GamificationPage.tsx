import { useEffect, useState } from 'react';
import { Gamepad2, TrendingUp, Award } from 'lucide-react';
import { levelsApi } from '../../lib/api/levels';
import { badgesApi } from '../../lib/api/badges';

interface GamificationPageProps {
  onNavigate?: (page: string) => void;
}

export function GamificationPage({ onNavigate }: GamificationPageProps = {}) {
  /**
   * Real counts. The tiles below read a hardcoded "7" and "12" — numbers that
   * were true when they were typed and drifted the moment anyone added a level
   * or deactivated a badge. An admin screen reporting a constant as a metric is
   * worse than not reporting it.
   */
  const [counts, setCounts] = useState<{ levels: number; badges: number } | null>(null);

  useEffect(() => {
    void Promise.all([levelsApi.getAllLevels(), badgesApi.getAllBadges()])
      .then(([levels, badges]) =>
        setCounts({ levels: levels.length, badges: badges.filter((b) => b.is_active).length }),
      )
      .catch(() => setCounts(null));
  }, []);

  // Em dash while loading or on failure, never a plausible-looking number.
  const show = (n: number | undefined) => (typeof n === 'number' ? String(n) : '—');

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Gamepad2 className="w-8 h-8 text-iih-green" />
            Gamification Management
          </h1>
          <p className="text-slate-600 mt-1">Manage levels, badges, and rewards for the ORBIT platform</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 hover:shadow-md transition-shadow">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-blue-100 rounded-lg">
                <TrendingUp className="w-8 h-8 text-blue-600" />
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-slate-800 mb-2">Levels System</h2>
                <p className="text-slate-600 mb-6">
                  Configure the progression system for interns. Define level thresholds, names, descriptions, and visual themes.
                </p>
                <ul className="text-sm text-slate-600 space-y-2 mb-6">
                  <li>• Customize level names and icons</li>
                  <li>• Set points required for each level</li>
                  <li>• Configure Event Orbit Ilorin progression</li>
                  <li>• Define level colors and themes</li>
                </ul>
                <button
                  onClick={() => onNavigate?.('levels')}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium flex items-center gap-2 transition-colors"
                >
                  <TrendingUp className="w-5 h-5" />
                  Manage Levels
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 hover:shadow-md transition-shadow">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-amber-100 rounded-lg">
                <Award className="w-8 h-8 text-amber-600" />
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-slate-800 mb-2">Badges & Achievements</h2>
                <p className="text-slate-600 mb-6">
                  Create and manage badges that users can earn. Set up achievement criteria and recognition systems.
                </p>
                <ul className="text-sm text-slate-600 space-y-2 mb-6">
                  <li>• Create custom badges with icons</li>
                  <li>• Award badges to users manually</li>
                  <li>• View badge statistics</li>
                  <li>• Manage badge categories</li>
                </ul>
                <button
                  onClick={() => onNavigate?.('badges')}
                  className="bg-amber-600 hover:bg-amber-700 text-white px-6 py-3 rounded-lg font-medium flex items-center gap-2 transition-colors"
                >
                  <Award className="w-5 h-5" />
                  Manage Badges
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 bg-white border border-slate-200 rounded-xl shadow-sm p-6">
          <h3 className="text-lg font-bold text-slate-800 mb-4">Gamification Overview</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-blue-900">Total Levels</span>
                <TrendingUp className="w-5 h-5 text-blue-600" />
              </div>
              <p className="text-3xl font-bold text-blue-900">{show(counts?.levels)}</p>
              <p className="text-xs text-blue-700 mt-1">Astronaut to Orbit Legend</p>
            </div>

            <div className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-amber-900">Active Badges</span>
                <Award className="w-5 h-5 text-amber-600" />
              </div>
              <p className="text-3xl font-bold text-amber-900">{show(counts?.badges)}</p>
              <p className="text-xs text-amber-700 mt-1">Nigerian-themed achievements</p>
            </div>

            <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-green-900">Point System</span>
                <Gamepad2 className="w-5 h-5 text-green-600" />
              </div>
              <p className="text-3xl font-bold text-green-900">Active</p>
              <p className="text-xs text-green-700 mt-1">Based on task completion</p>
            </div>
          </div>
        </div>

        <div className="mt-8 bg-amber-50 border border-amber-200 rounded-lg p-6">
          <div className="flex items-start gap-4">
            <div className="text-2xl">💡</div>
            <div className="flex-1">
              <h4 className="font-semibold text-slate-800 mb-2">Gamification Best Practices</h4>
              <ul className="text-sm text-slate-700 space-y-2">
                <li>• Keep level progression balanced - not too easy, not too hard</li>
                <li>• Award badges for meaningful achievements and quality work</li>
                <li>• Regularly review and adjust point values for tasks</li>
                <li>• Celebrate user achievements in the community feed</li>
                <li>• Use the Event Orbit Ilorin level for special recognition</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
