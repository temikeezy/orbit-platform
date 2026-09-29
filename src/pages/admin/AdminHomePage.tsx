import { useState, useEffect } from 'react';
import { Users, Layers, CheckSquare, Activity, UserCheck, BarChart3 } from 'lucide-react';
import { adminApi, AdminStats } from '../../lib/api/admin';
import { SkeletonStats } from '../../components/common/SkeletonLoader';
import { authService } from '../../lib/auth';
import { logError } from '../../lib/monitoring';


interface AdminHomePageProps {
  onTabChange: (tab: string) => void;
}

export function AdminHomePage({ onTabChange }: AdminHomePageProps) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const data = await adminApi.getStats();
      setStats(data);
    } catch (error) {
      logError(error, { context: 'AdminHomePage.loadStats' });
    } finally {
      setLoading(false);
    }
  };

  const statsDisplay = stats
    ? [
        {
          label: 'Total Users',
          value: stats.totalUsers.toString(),
          icon: Users,
          color: 'bg-orbit-mint text-iih-green-dark',
          trend: `+${stats.recentUsers} this month`,
        },
        {
          label: 'Active Streams',
          value: stats.activeStreams.toString(),
          icon: Layers,
          color: 'bg-orbit-sky-soft text-orbit-sky',
          trend: `+${stats.recentStreams} this quarter`,
        },
        {
          label: 'Active Tasks',
          value: stats.totalTasks.toString(),
          icon: CheckSquare,
          color: 'bg-orbit-amber-soft text-orbit-amber',
          trend: `+${stats.recentTasks} this week`,
        },
        {
          label: 'Active Members',
          value: stats.activeMembers.toString(),
          icon: UserCheck,
          color: 'bg-orbit-violet-soft text-orbit-violet',
          trend: stats.totalUsers > 0 ? `${Math.round((stats.activeMembers / stats.totalUsers) * 100)}% active` : '0% active',
        },
      ]
    : [];

  // Cards whose destination needs a role the viewer lacks are not shown. An
  // admin pressing one only learns it was never for them after four steps.
  const quickActions = ([
    {
      label: 'Manage Streams',
      description: 'Create and configure learning streams',
      icon: Layers,
      color: 'bg-orbit-sky-soft hover:bg-blue-100 text-orbit-sky',
      action: () => onTabChange?.('streams'),
    },
    {
      label: 'Manage Users',
      description: 'View and manage user accounts',
      icon: Users,
      color: 'bg-orbit-mint hover:bg-green-100 text-iih-green-dark',
      action: () => onTabChange?.('users'),
    },
    {
      label: 'Bulk Import',
      description: 'Import users and data in bulk',
      icon: Activity,
      color: 'bg-orbit-amber-soft hover:bg-amber-100 text-orbit-amber',
      // 'bulk-import', not 'import'. AdminDashboard's switch has no 'import'
      // case, so this fell through to default and silently re-rendered Overview
      // — the quick action looked like it did nothing at all.
      action: () => onTabChange?.('bulk-import'),
      // Everything behind this card ends at a super-admin-only mutation.
      superAdminOnly: true,
    },
    {
      label: 'Manage Tasks',
      description: 'Create and manage learning tasks',
      icon: CheckSquare,
      color: 'bg-orbit-violet-soft hover:bg-purple-100 text-orbit-violet',
      action: () => onTabChange?.('tasks'),
    },
  ] as { label: string; description: string; icon: typeof Layers; color: string; action: () => void; superAdminOnly?: boolean }[])
    .filter((a) => !a.superAdminOnly || authService.isSuperAdmin());

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-orbit-ink flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-iih-green" />
            Admin Overview
          </h1>
          <p className="text-orbit-muted mt-1">Monitor ORBIT cohorts, stream work, and review throughput.</p>
        </div>

        {loading ? (
          <SkeletonStats />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {statsDisplay.map((stat) => {
              const Icon = stat.icon;
              return (
                <div key={stat.label} className="orbit-panel p-5">
                  <div
                    className={`w-11 h-11 rounded-lg ${stat.color} flex items-center justify-center mb-4`}
                  >
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="text-3xl font-bold orbit-data mb-1">{stat.value}</div>
                  <div className="text-sm font-semibold text-orbit-graphite mb-2">{stat.label}</div>
                  <div className="text-xs text-orbit-muted">{stat.trend}</div>
                </div>
              );
            })}
          </div>
        )}

        <div className="orbit-panel p-6 mb-8">
          <h2 className="text-xl font-bold text-orbit-ink mb-6">Quick Actions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.label}
                  onClick={action.action}
                  className={`${action.color} p-4 rounded-lg font-medium transition-colors text-left`}
                >
                  <Icon className="w-6 h-6 mb-2" />
                  <div className="font-bold text-sm">{action.label}</div>
                  <div className="text-xs opacity-80 mt-1">{action.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
