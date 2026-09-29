import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { StreamsManagementPage } from './StreamsManagementPage';
import { UsersManagementPage } from './UsersManagementPage';
import { TasksManagementPage } from './TasksManagementPage';
import { ImportPage } from './ImportPage';
import { SettingsPage } from './SettingsPage';
import { AdminHomePage } from './AdminHomePage';
import { LevelsManagementPage } from './LevelsManagementPage';
import { BadgesManagementPage } from './BadgesManagementPage';
import { EmailLogsPage } from './EmailLogsPage';
import { BackupManagementPage } from './BackupManagementPage';
import { GamificationPage } from './GamificationPage';
import { ApplicationsTab } from '../../components/admin/ApplicationsTab';
import { SiwesManagementPage } from './SiwesManagementPage';
import { ErrorReportsPage } from './ErrorReportsPage';
import { Users, GitBranch, BarChart3, Settings, CheckSquare, ArrowLeft, Gamepad2, GraduationCap, ClipboardList, AlertTriangle } from 'lucide-react';

type AdminTab = 'overview' | 'streams' | 'users' | 'tasks' | 'applications' | 'siwes' | 'settings' | 'gamification' | 'email-logs' | 'bulk-import' | 'levels' | 'badges' | 'backup-management' | 'error-reports';

export function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  const isSuperAdmin = user?.roles?.includes('super_admin');

  const allTabs: { id: AdminTab; label: string; icon: typeof BarChart3; superAdminOnly?: boolean }[] = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'streams', label: 'Streams', icon: GitBranch },
    { id: 'tasks', label: 'Tasks', icon: CheckSquare },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'applications', label: 'Applications', icon: ClipboardList },
    { id: 'siwes', label: 'SIWES', icon: GraduationCap },
    { id: 'gamification', label: 'Gamification', icon: Gamepad2 },
    { id: 'error-reports', label: 'Error Reports', icon: AlertTriangle },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const tabs = allTabs.filter(tab => !tab.superAdminOnly || isSuperAdmin);

  const handleNavigate = (page: string, id?: string) => {
    if (page === 'edit-task' && id) {
      navigate(`/tasks/${id}/edit`);
    } else if (page === 'task-detail' && id) {
      navigate(`/tasks/${id}`);
    } else if (page === 'user-profile' && id) {
      navigate(`/users/${id}`);
    } else if (page === 'tasks') {
      setActiveTab('tasks');
    } else if (page === 'email-logs') {
      setActiveTab('email-logs');
    } else if (page === 'bulk-import') {
      setActiveTab('bulk-import');
    } else if (page === 'levels') {
      setActiveTab('levels');
    } else if (page === 'badges') {
      setActiveTab('badges');
    } else if (page === 'backup-management') {
      setActiveTab('backup-management');
    } else if (page === 'add-task') {
      navigate('/admin');
      setActiveTab('tasks');
    } else {
      navigate(`/${page}`);
    }
  };


  const renderContent = () => {
    switch (activeTab) {
      case 'streams':
        return <StreamsManagementPage />;
      case 'users':
        return <UsersManagementPage onNavigate={handleNavigate} />;
      case 'tasks':
        return <TasksManagementPage onNavigate={handleNavigate} />;
      case 'bulk-import':
        return (
          <div>
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
              <button
                onClick={() => setActiveTab('users')}
                className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-4"
              >
                <ArrowLeft className="w-5 h-5" />
                Back to Users
              </button>
            </div>
            <ImportPage />
          </div>
        );
      case 'applications':
        return (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            {/* Every programme. The SIWES section shows only its own. */}
            <ApplicationsTab
              heading="All Applications"
              description="Every programme — SIWES, internship, NYSC and volunteer. Sort by programme to group them, or open Admin → SIWES for SIWES candidates alone."
            />
          </div>
        );
      case 'siwes':
        return (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <SiwesManagementPage />
          </div>
        );
      case 'gamification':
        return <GamificationPage onNavigate={handleNavigate} />;
      case 'error-reports':
        return <ErrorReportsPage />;
      case 'levels':
        return (
          <div>
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
              <button
                onClick={() => setActiveTab('gamification')}
                className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-4"
              >
                <ArrowLeft className="w-5 h-5" />
                Back to Gamification
              </button>
            </div>
            <LevelsManagementPage />
          </div>
        );
      case 'badges':
        return (
          <div>
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
              <button
                onClick={() => setActiveTab('gamification')}
                className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-4"
              >
                <ArrowLeft className="w-5 h-5" />
                Back to Gamification
              </button>
            </div>
            <BadgesManagementPage />
          </div>
        );
      case 'backup-management':
        return (
          <div>
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
              <button
                onClick={() => setActiveTab('settings')}
                className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-4"
              >
                <ArrowLeft className="w-5 h-5" />
                Back to Settings
              </button>
            </div>
            <BackupManagementPage />
          </div>
        );
      case 'settings':
        return <SettingsPage onNavigate={handleNavigate} />;
      case 'email-logs':
        return (
          <div>
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
              <button
                onClick={() => setActiveTab('settings')}
                className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-4"
              >
                <ArrowLeft className="w-5 h-5" />
                Back to Settings
              </button>
            </div>
            <EmailLogsPage />
          </div>
        );
      case 'overview':
      default:
        return <AdminHomePage onTabChange={(tab) => setActiveTab(tab as AdminTab)} />;
    }
  };

  return (
    <div className="min-h-screen bg-orbit-canvas">
      {(
        <div className="border-b border-slate-200 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex gap-2 overflow-x-auto">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as AdminTab)}
                    className={`flex items-center gap-2 px-6 py-4 border-b-3 font-medium transition-all whitespace-nowrap relative ${
                      activeTab === tab.id
                        ? 'border-iih-green text-slate-900 bg-green-50/50 font-semibold shadow-sm'
                        : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${activeTab === tab.id ? 'text-iih-green' : ''}`} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {renderContent()}
    </div>
  );
}
