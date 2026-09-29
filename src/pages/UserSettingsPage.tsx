import { useState, useEffect } from 'react';
import { Settings, Bell, User, Lock, Save, CheckCircle, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { convexHttp as convex } from '../lib/convex';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { useAuth } from '../contexts/AuthContext';
import { logError } from '../lib/monitoring';

interface NotificationPreferences {
  new_task_enabled: boolean;
  deadline_reminder_enabled: boolean;
  new_message_enabled: boolean;
  task_submitted_enabled: boolean;
  task_approved_enabled: boolean;
  task_rejected_enabled: boolean;
  stream_update_enabled: boolean;
  level_up_enabled: boolean;
  badge_earned_enabled: boolean;
}

type Tab = 'profile' | 'notifications' | 'security';

interface ProfileSettings {
  profile_visibility: 'public' | 'stream_only' | 'private';
  show_email: boolean;
  show_activity_on_feed: boolean;
  show_on_leaderboard: boolean;
}

export function UserSettingsPage() {
  const { user: authUser, refreshUser } = useAuth();

  /**
   * The tab is deep-linkable: `/settings?tab=security`.
   *
   * The onboarding checklist sends a new member here to set their first
   * password, and the password form is on the Security tab — so without this
   * the link landed them on Profile with no sign of what they came for, on the
   * single step that decides whether they can get back in after their magic
   * link expires. Unknown values fall back to Profile rather than rendering
   * nothing.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<Tab>(
    requestedTab === 'security' || requestedTab === 'notifications' ? requestedTab : 'profile',
  );

  /** Keeps the URL honest as the member moves between tabs, so it stays shareable. */
  const selectTab = (tab: Tab) => {
    setActiveTab(tab);
    setSearchParams(tab === 'profile' ? {} : { tab }, { replace: true });
  };
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    new_task_enabled: true,
    deadline_reminder_enabled: true,
    new_message_enabled: true,
    task_submitted_enabled: true,
    task_approved_enabled: true,
    task_rejected_enabled: true,
    stream_update_enabled: true,
    level_up_enabled: true,
    badge_earned_enabled: true,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  /**
   * Accounts converted from the intake arrive by magic link and have no
   * password, so there is nothing to confirm and demanding one locks them out
   * of ever setting one. `hasPassword` comes from publicUser.
   */
  const hasPassword = Boolean((authUser as { has_password?: boolean } | null)?.has_password);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const [profileSettings, setProfileSettings] = useState<ProfileSettings>({
    profile_visibility: 'public',
    show_email: false,
    show_activity_on_feed: true,
    show_on_leaderboard: true,
  });
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    loadPreferences();
  }, []);

  const loadPreferences = async () => {
    try {
      // Both halves come from Convex now. This screen read and wrote
      // `orbit_users` and `orbit_user_notification_preferences` directly from
      // the browser — the preferences upsert was keyed on a CLIENT-SUPPLIED
      // user_id, so it was one edited request away from silencing somebody
      // else's notifications. And once auth moved to Convex it stopped working
      // at all, which mattered because `leaderboard.top` ENFORCES
      // showOnLeaderboard: the opt-out was being applied from a table the
      // settings screen could no longer reach.
      const [notif, me] = await Promise.all([
        convex.query(api.notificationPreferences.get, { token: authService.getToken()! }),
        convex.query(api.users.me, { token: authService.getToken()! }),
      ]);

      setPreferences({
        new_task_enabled: notif.newTaskEnabled,
        deadline_reminder_enabled: notif.deadlineReminderEnabled,
        new_message_enabled: notif.newMessageEnabled,
        task_submitted_enabled: notif.taskSubmittedEnabled,
        task_approved_enabled: notif.taskApprovedEnabled,
        task_rejected_enabled: notif.taskRejectedEnabled,
        stream_update_enabled: notif.streamUpdateEnabled,
        level_up_enabled: notif.levelUpEnabled,
        badge_earned_enabled: notif.badgeEarnedEnabled,
      });

      setProfileSettings({
        profile_visibility: (me?.profileVisibility as ProfileSettings['profile_visibility']) ?? 'public',
        show_email: me?.showEmail ?? false,
        show_activity_on_feed: me?.showActivityOnFeed ?? true,
        show_on_leaderboard: me?.showOnLeaderboard ?? true,
      });
    } catch (error) {
      logError(error, { context: 'UserSettingsPage.loadPreferences' });
    }
  };

  const savePreferences = async () => {
    try {
      setSaving(true);
      setSaved(false);

      // No userId argument exists on the mutation — the row is always the
      // caller's.
      await convex.mutation(api.notificationPreferences.save, {
        token: authService.getToken()!,
        newTaskEnabled: preferences.new_task_enabled,
        deadlineReminderEnabled: preferences.deadline_reminder_enabled,
        newMessageEnabled: preferences.new_message_enabled,
        taskSubmittedEnabled: preferences.task_submitted_enabled,
        taskApprovedEnabled: preferences.task_approved_enabled,
        taskRejectedEnabled: preferences.task_rejected_enabled,
        streamUpdateEnabled: preferences.stream_update_enabled,
        levelUpEnabled: preferences.level_up_enabled,
        badgeEarnedEnabled: preferences.badge_earned_enabled,
      });

      setSaved(true);
      toast.success('Notification preferences saved');
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      logError(error, { context: 'UserSettingsPage.savePreferences' });
      toast.error('Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (key: keyof NotificationPreferences) => {
    setPreferences(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordChanged(false);

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters long');
      return;
    }

    try {
      setChangingPassword(true);
      const token = authService.getToken();
      if (!token) throw new Error('Not authenticated');

      // On Convex. Changing a password now also REVOKES every other session —
      // the Postgres version left them all alive, so a stolen session survived
      // the very remedy for it.
      const result = await convex.mutation(api.users.changePassword, {
        token,
        currentPassword: hasPassword ? currentPassword : undefined,
        newPassword,
      });

      if (!result.success) throw new Error(result.error);

      setPasswordChanged(true);
        // Without this the cached user still says hasPassword=false, so a second
        // change in the same session omits currentPassword and is refused.
        void refreshUser?.();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPasswordChanged(false), 5000);
    } catch (error) {
      logError(error, { context: 'UserSettingsPage.handlePasswordChange' });
      setPasswordError(error instanceof Error ? error.message : 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  const tabs = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Lock },
  ];

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3 mb-2">
            <Settings className="w-8 h-8 text-iih-green" />
            Settings
          </h1>
          <p className="text-slate-600">Manage your account preferences and settings</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="border-b border-slate-200">
            <div className="flex">
              {tabs.map(tab => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => selectTab(tab.id as Tab)}
                    className={`flex items-center gap-2 px-6 py-4 font-medium transition-colors ${
                      activeTab === tab.id
                        ? 'text-iih-green border-b-2 border-iih-green'
                        : 'text-slate-600 hover:text-slate-800'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-8">
            {activeTab === 'profile' && (
              <div className="max-w-2xl">
                <h2 className="text-xl font-bold text-slate-800 mb-2">Profile Settings</h2>
                <p className="text-slate-600 mb-6">
                  Manage your profile visibility and privacy preferences
                </p>

                <div className="space-y-4">
                  <div className="p-4 bg-slate-50 rounded-lg">
                    <label htmlFor="settings-profile-visibility" className="block font-semibold text-slate-800 mb-2">Profile Visibility</label>
                    <select
                      id="settings-profile-visibility"
                      value={profileSettings.profile_visibility}
                      onChange={(e) => setProfileSettings(prev => ({ ...prev, profile_visibility: e.target.value as ProfileSettings['profile_visibility'] }))}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent bg-white"
                    >
                      <option value="public">Public — visible to all members</option>
                      <option value="stream_only">Stream Only — visible to your stream members</option>
                      <option value="private">Private — visible only to admins</option>
                    </select>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Display Email Address</h3>
                      <p className="text-sm text-slate-600">Show your email on your public profile</p>
                    </div>
                    <button
                      onClick={() => setProfileSettings(prev => ({ ...prev, show_email: !prev.show_email }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${profileSettings.show_email ? 'bg-iih-green' : 'bg-slate-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${profileSettings.show_email ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Show Activity on Feed</h3>
                      <p className="text-sm text-slate-600">Display your activity (task completions, badge unlocks) in the community feed</p>
                    </div>
                    <button
                      onClick={() => setProfileSettings(prev => ({ ...prev, show_activity_on_feed: !prev.show_activity_on_feed }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${profileSettings.show_activity_on_feed ? 'bg-iih-green' : 'bg-slate-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${profileSettings.show_activity_on_feed ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Show on Leaderboard</h3>
                      <p className="text-sm text-slate-600">Include your name on public leaderboard rankings</p>
                    </div>
                    <button
                      onClick={() => setProfileSettings(prev => ({ ...prev, show_on_leaderboard: !prev.show_on_leaderboard }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${profileSettings.show_on_leaderboard ? 'bg-iih-green' : 'bg-slate-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${profileSettings.show_on_leaderboard ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-between">
                  <Link
                    to="/profile/edit"
                    className="text-sm text-iih-green-darker hover:underline flex items-center gap-1"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Edit full profile (name, bio, photo, social links)
                  </Link>
                  <button
                    onClick={async () => {
                      try {
                        setSavingProfile(true);
                        const token = authService.getToken();
                        if (!token) throw new Error('Not authenticated');
                        // updateMyProfile takes no userId — the row is always
                        // the caller's — and validates profile_visibility, so an
                        // unrecognised value cannot silently render a private
                        // profile public.
                        const result = await convex.mutation(api.users.updateMyProfile, {
                          token,
                          profileVisibility: profileSettings.profile_visibility,
                          showEmail: profileSettings.show_email,
                          showActivityOnFeed: profileSettings.show_activity_on_feed,
                          showOnLeaderboard: profileSettings.show_on_leaderboard,
                        });
                        if (!result.success) throw new Error(result.error);

                        // The cached user carries these flags, so it has to move
                        // with them or the next render reads the old values.
                        await authService.refreshUser();
                        toast.success('Profile settings saved');
                      } catch (err) {
                        logError(err, { context: 'UserSettingsPage.saveProfileSettings' });
                        toast.error('Failed to save profile settings');
                      } finally {
                        setSavingProfile(false);
                      }
                    }}
                    disabled={savingProfile}
                    className="bg-iih-green hover:bg-iih-green-dark text-white font-medium px-6 py-2 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" />
                    {savingProfile ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>

                {authUser && (
                  <div className="mt-8 p-4 bg-slate-50 rounded-lg">
                    <h3 className="font-semibold text-slate-800 mb-3">Account Info</h3>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Name</dt>
                        <dd className="text-slate-800 font-medium">{authUser.full_name}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Email</dt>
                        <dd className="text-slate-800 font-medium">{authUser.email}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Role</dt>
                        <dd className="text-slate-800 font-medium capitalize">{authUser.roles?.join(', ') || 'Member'}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="max-w-2xl">
                <h2 className="text-xl font-bold text-slate-800 mb-2">Notifications</h2>
                <p className="text-slate-600 mb-6">
                  Choose which emails you'd like to receive
                </p>

                <div className="space-y-4">
                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">New Task Available</h3>
                      <p className="text-sm text-slate-600">
                        Get notified when a new task is available in your streams
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('new_task_enabled')}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        preferences.new_task_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.new_task_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Deadline Reminders</h3>
                      <p className="text-sm text-slate-600">
                        Get reminded when task deadlines are approaching
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('deadline_reminder_enabled')}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        preferences.deadline_reminder_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.deadline_reminder_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">New Messages</h3>
                      <p className="text-sm text-slate-600">
                        Get notified when you receive new messages
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('new_message_enabled')}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        preferences.new_message_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.new_message_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Task Accepted</h3>
                      <p className="text-sm text-slate-600">
                        Get notified when you accept a task
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('task_submitted_enabled')}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        preferences.task_submitted_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.task_submitted_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Task Approved</h3>
                      <p className="text-sm text-slate-600">
                        Get notified when your task submission is approved
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('task_approved_enabled')}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        preferences.task_approved_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.task_approved_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Task Rejected</h3>
                      <p className="text-sm text-slate-600">
                        Get notified when your task submission is rejected
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('task_rejected_enabled')}
                      className={`relative inline-flex h-6 w-11 items-centers rounded-full transition-colors ${
                        preferences.task_rejected_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.task_rejected_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Stream Updates</h3>
                      <p className="text-sm text-slate-600">
                        Get notified about updates in your streams
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle('stream_update_enabled')}
                      className={`relative inline-flex h-6 w-11 items-centers rounded-full transition-colors ${
                        preferences.stream_update_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.stream_update_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Level Up</h3>
                      <p className="text-sm text-slate-600">
                        Shown in the app when you reach a new level
                      </p>
                      <p className="text-xs text-orbit-muted mt-1">In the app only — no email</p>
                    </div>
                    <button
                      onClick={() => handleToggle('level_up_enabled')}
                      className={`relative inline-flex h-6 w-11 items-centers rounded-full transition-colors ${
                        preferences.level_up_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.level_up_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1">Badge Earned</h3>
                      <p className="text-sm text-slate-600">
                        Shown in the app when you earn a new badge
                      </p>
                      <p className="text-xs text-orbit-muted mt-1">In the app only — no email</p>
                    </div>
                    <button
                      onClick={() => handleToggle('badge_earned_enabled')}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        preferences.badge_earned_enabled ? 'bg-iih-green' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          preferences.badge_earned_enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="mt-8 flex items-center justify-end gap-3">
                  <button
                    onClick={savePreferences}
                    disabled={saving}
                    className="bg-iih-green hover:bg-iih-green-dark text-white font-medium px-6 py-2 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {saved ? (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        Saved!
                      </>
                    ) : saving ? (
                      'Saving...'
                    ) : (
                      <>
                        <Save className="w-4 h-4" />
                        Save Preferences
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="max-w-2xl">
                <h2 className="text-xl font-bold text-slate-800 mb-2">Security Settings</h2>
                <p className="text-slate-600 mb-6">
                  Manage your password and security preferences
                </p>

                <form onSubmit={handlePasswordChange} className="space-y-6">
                  <div className="bg-slate-50 rounded-lg p-6">
                    <h3 className="font-semibold text-slate-800 mb-4">Change Password</h3>

                    {passwordError && (
                      <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                        {passwordError}
                      </div>
                    )}

                    {passwordChanged && (
                      <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm flex items-center gap-2">
                        <CheckCircle className="w-4 h-4" />
                        Password changed successfully!
                      </div>
                    )}

                    <div className="space-y-4">
                      {hasPassword && (
                      <div>
                        <label htmlFor="settings-current-password" className="block text-sm font-medium text-slate-700 mb-2">
                          Current Password
                        </label>
                        <div className="relative">
                          <input
                            id="settings-current-password"
                            type={showCurrentPassword ? 'text' : 'password'}
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            className="w-full px-4 py-2 pr-10 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                            required
                            disabled={changingPassword}
                          />
                          <button
                            type="button"
                            onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                            aria-label={showCurrentPassword ? 'Hide current password' : 'Show current password'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            {showCurrentPassword ? (
                              <EyeOff className="w-5 h-5" />
                            ) : (
                              <Eye className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                      </div>

                      )}
                      <div>
                        <label htmlFor="settings-new-password" className="block text-sm font-medium text-slate-700 mb-2">
                          New Password
                        </label>
                        <div className="relative">
                          <input
                            id="settings-new-password"
                            type={showNewPassword ? 'text' : 'password'}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="w-full px-4 py-2 pr-10 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                            required
                            disabled={changingPassword}
                            minLength={8}
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            {showNewPassword ? (
                              <EyeOff className="w-5 h-5" />
                            ) : (
                              <Eye className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          Must be at least 8 characters long
                        </p>
                      </div>

                      <div>
                        <label htmlFor="settings-confirm-password" className="block text-sm font-medium text-slate-700 mb-2">
                          Confirm New Password
                        </label>
                        <div className="relative">
                          <input
                            id="settings-confirm-password"
                            type={showConfirmPassword ? 'text' : 'password'}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="w-full px-4 py-2 pr-10 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                            required
                            disabled={changingPassword}
                          />
                          <button
                            type="button"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            aria-label={showConfirmPassword ? 'Hide password confirmation' : 'Show password confirmation'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            {showConfirmPassword ? (
                              <EyeOff className="w-5 h-5" />
                            ) : (
                              <Eye className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 flex items-center justify-end">
                      <button
                        type="submit"
                        disabled={changingPassword || (hasPassword && !currentPassword) || !newPassword || !confirmPassword}
                        className="bg-iih-green hover:bg-iih-green-dark text-white font-medium px-6 py-2 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {changingPassword ? (
                          <>
                            <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
                            Changing Password...
                          </>
                        ) : (
                          <>
                            <Lock className="w-4 h-4" />
                            Change Password
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </form>

                <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                    <Lock className="w-4 h-4" />
                    Password Requirements
                  </h4>
                  <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                    <li>Minimum 8 characters</li>
                    <li>Must enter current password to change</li>
                    <li>New password and confirmation must match</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
