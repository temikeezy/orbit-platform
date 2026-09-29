import { useState, useEffect } from 'react';
import { usersApi } from '../../lib/api/users';
import { streamsApi } from '../../lib/api/streams';
import { emailDispatchApi, EmailDispatchStatus } from '../../lib/api/emailDispatch';
import { OrbitUser, OrbitStream } from '../../types/database';
import { Search, UserPlus, CreditCard as Edit2, UserX, Loader2, CheckSquare, Square, Mail, ExternalLink, Upload, Users, Trash2, Download, Cpu, UserCheck } from 'lucide-react';
import { SkeletonTableRow } from '../../components/common/SkeletonLoader';
import { logError } from '../../lib/monitoring';

interface UsersManagementPageProps {
  onNavigate?: (page: string, id?: string) => void;
}

export function UsersManagementPage({ onNavigate }: UsersManagementPageProps = {}) {
  const [users, setUsers] = useState<OrbitUser[]>([]);
  const [streams, setStreams] = useState<OrbitStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'moderator' | 'intern'>('all');
  /** Week one's only question, as a filter: who has not signed in yet? */
  const [signInFilter, setSignInFilter] = useState<'all' | 'never' | 'signed_in'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<OrbitUser | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [showBulkActions, setShowBulkActions] = useState(false);
  const [sendingPasswordReset, setSendingPasswordReset] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [trashedUsers, setTrashedUsers] = useState<OrbitUser[]>([]);
  /**
   * Whether mail is actually going out.
   *
   * Every "password reset" on this screen is a magic-link email, and while
   * either brake is on that email is HELD in the queue, not delivered
   * (`convex/emailDispatch.ts`). This page used to report "Password reset
   * emails sent to N users" regardless — the single most misleading thing it
   * could say, because the symptom of the pause is mail simply not arriving,
   * and staff would be left concluding the accounts were broken.
   *
   * Null while it is still loading, so nothing claims either state early.
   */
  const [emailStatus, setEmailStatus] = useState<EmailDispatchStatus | null>(null);
  /** Known to be held. Drives the banner, which should only appear on fact. */
  const emailPaused = emailStatus?.paused === true;
  /**
   * Known to be FLOWING — which is not the same as `!emailPaused`.
   *
   * Null covers two states that both matter: still loading, and the status call
   * failed outright. Treating either as "not paused" walks straight back into
   * the bug this change exists to fix, because the directory finishes loading
   * before this call returns and a staff member can click Send in that window.
   * So delivery is only ever ASSERTED on a positive answer; anything else gets
   * the neutral "queued" wording, which is true either way.
   */
  const emailConfirmedFlowing = emailStatus !== null && !emailStatus.paused;

  useEffect(() => {
    loadData();
  }, []);

  /**
   * Every refresh shows the full-page spinner, which tears down the table, any
   * open modal and the search box, then rebuilds them. That is poor, and an
   * attempt to make refreshes update in place correlated with a reactivation
   * regression in the e2e suite — so it was reverted rather than defended.
   * Worth fixing on its own branch, with the test run that proves it; not
   * inside a security pass, where an unexplained behaviour change is the last
   * thing anyone needs.
   */
  const loadData = async () => {
    try {
      setLoading(true);
      const [usersData, streamsData] = await Promise.all([
        usersApi.getAllUsers(),
        streamsApi.getAllStreams(),
      ]);
      // Removed: these logged every user's name, email and role to the console
      // on every visit to this page, in production. The console.error sweep did
      // not touch console.log, and once a Sentry DSN is configured its default
      // console breadcrumbs would have shipped the whole directory with any
      // error report from this screen.
      setUsers(usersData);
      setStreams(streamsData);
    } catch (err) {
      logError(err, { context: 'UsersManagementPage.loadData' });
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }

    /**
     * Deliberately after the directory and in its own try: if this call fails,
     * the page must still render. `emailStatus` stays null, and every message
     * below falls back to the neutral "queued" wording rather than asserting
     * a delivery this screen could not confirm.
     */
    try {
      setEmailStatus(await emailDispatchApi.status());
    } catch (err) {
      logError(err, { context: 'UsersManagementPage.emailStatus' });
    }
  };

  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRole = roleFilter === 'all' || user.roles.includes(roleFilter);
    const matchesSignIn =
      signInFilter === 'all' ||
      (signInFilter === 'never' ? !user.last_login_at : Boolean(user.last_login_at));
    return matchesSearch && matchesRole && matchesSignIn;
  });

  const handleDeactivateUser = async (userId: string) => {
    if (!confirm('Are you sure you want to deactivate this user?')) return;

    try {
      await usersApi.deactivateUser(userId);
      await loadData();
    } catch {
      setError('Failed to deactivate user');
    }
  };

  const handleActivateUser = async (userId: string) => {
    try {
      await usersApi.setUserActive(userId, true);
      setSuccess('User activated');
      await loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate user');
      setTimeout(() => setError(''), 3000);
    }
  };

  const handleTrashUser = async (userId: string, userName: string) => {
    if (!confirm(`Move ${userName} to trash? They can be restored later.`)) return;

    try {
      await usersApi.trashUser(userId);
      setSuccess('User moved to trash');
      await loadData();
      if (showTrash) {
        await loadTrashedUsers();
      }
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trash user');
      setTimeout(() => setError(''), 3000);
    }
  };

  const loadTrashedUsers = async () => {
    try {
      const data = await usersApi.getTrashedUsers();
      setTrashedUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trashed users');
    }
  };

  const handleShowTrash = async () => {
    if (!showTrash) {
      await loadTrashedUsers();
    }
    setShowTrash(!showTrash);
  };

  const handleRestoreUser = async (userId: string, userName: string) => {
    if (!confirm(`Restore ${userName}?`)) return;

    try {
      await usersApi.restoreUser(userId);
      setSuccess('User restored successfully');
      await loadData();
      await loadTrashedUsers();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore user');
      setTimeout(() => setError(''), 3000);
    }
  };

  const handlePermanentDelete = async (userId: string, userName: string) => {
    if (!confirm(`PERMANENTLY DELETE ${userName}?\n\nThis action CANNOT be undone. All user data will be lost forever.`)) return;

    try {
      await usersApi.permanentlyDeleteUser(userId);
      setSuccess('User permanently deleted');
      await loadTrashedUsers();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
      setTimeout(() => setError(''), 3000);
    }
  };

  const handleToggleMcp = async (userId: string, currentlyEnabled: boolean) => {
    try {
      const result = await usersApi.toggleMcpAccess(userId, !currentlyEnabled);
      if (result.success) {
        setSuccess(`MCP access ${!currentlyEnabled ? 'enabled' : 'disabled'}`);
        await loadData();
      } else {
        setError(result.error || 'Failed to toggle MCP access');
      }
      setTimeout(() => { setSuccess(''); setError(''); }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle MCP access');
      setTimeout(() => setError(''), 3000);
    }
  };

  const toggleUserSelection = (userId: string) => {
    const newSelection = new Set(selectedUsers);
    if (newSelection.has(userId)) {
      newSelection.delete(userId);
    } else {
      newSelection.add(userId);
    }
    setSelectedUsers(newSelection);
    setShowBulkActions(newSelection.size > 0);
  };

  const toggleSelectAll = () => {
    if (selectedUsers.size === filteredUsers.length) {
      setSelectedUsers(new Set());
      setShowBulkActions(false);
    } else {
      setSelectedUsers(new Set(filteredUsers.map(u => u.id)));
      setShowBulkActions(true);
    }
  };

  const handleBulkDeactivate = async () => {
    /**
     * The selection deliberately SURVIVES a filter change.
     *
     * Search one name, tick it, search the next, tick that, clear the box, act
     * on both — that is how a cross-filter selection gets built here, and
     * e2e/admin-users.spec.ts pins the workflow. (ApplicationsTab clears its
     * selection on every query change; that is the right call there and the
     * wrong one here, so the divergence is deliberate.)
     *
     * What that costs is the danger this names: some of the selected rows may
     * not be on screen, so a bare count invites confirming a bulk action
     * against people the admin has forgotten are in the set. The prompt spells
     * out how many are currently hidden rather than the list quietly acting on
     * them.
     */
    const visible = new Set(filteredUsers.map((u) => u.id));
    const hidden = Array.from(selectedUsers).filter((id) => !visible.has(id)).length;
    const warning = hidden > 0
      ? `\n\n${hidden} of them ${hidden === 1 ? 'is' : 'are'} not shown under the current search or role filter.`
      : '';

    if (!confirm(`Deactivate ${selectedUsers.size} users?${warning}`)) return;

    // `allSettled`, not `all`: `all` rejects on the first failure and abandons
    // the rest, so a partial run reported one generic error naming nothing and
    // the admin could not tell which accounts had actually changed.
    const ids = Array.from(selectedUsers);
    const outcomes = await Promise.allSettled(ids.map((id) => usersApi.deactivateUser(id)));
    const failed = ids.filter((_, i) => outcomes[i].status === 'rejected');

    setSelectedUsers(new Set());
    setShowBulkActions(false);
    await loadData();

    if (failed.length > 0) {
      setError(
        `Deactivated ${ids.length - failed.length} of ${ids.length}. Failed: ${failed.join(', ')}`,
      );
    }
  };

  const handleBulkPasswordReset = async () => {
    const prompt = emailPaused
      ? `Outgoing email is PAUSED. Queue ${selectedUsers.size} sign-in links to send when it resumes?`
      : `Send password reset emails to ${selectedUsers.size} users?`;
    if (!confirm(prompt)) return;

    try {
      setSendingPasswordReset(true);
      setError('');
      setSuccess('');

      const selectedEmails = Array.from(selectedUsers)
        .map(id => users.find(u => u.id === id)?.email)
        .filter(Boolean) as string[];

      const results = await usersApi.sendBulkPasswordResetEmails(selectedEmails);

      if (results.failed.length > 0) {
        setError(`Failed to send to ${results.failed.length} users: ${results.failed.join(', ')}`);
      }

      if (results.success > 0) {
        const plural = results.success > 1 ? 's' : '';
        setSuccess(
          emailConfirmedFlowing
            ? `Password reset emails sent to ${results.success} user${plural}`
            : emailPaused
              ? `Queued ${results.success} sign-in link${plural}. Outgoing email is paused, so nothing has been delivered — they send when it resumes.`
              : `Queued ${results.success} sign-in link${plural}. Check Admin → Settings to confirm outgoing email is running.`,
        );
      }

      setSelectedUsers(new Set());
      setShowBulkActions(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send password reset emails');
    } finally {
      setSendingPasswordReset(false);
    }
  };

  const handleSinglePasswordReset = async (email: string) => {
    const prompt = emailPaused
      ? `Outgoing email is PAUSED. Queue a sign-in link for ${email} to send when it resumes?`
      : `Send password reset email to ${email}?`;
    if (!confirm(prompt)) return;

    try {
      setError('');
      setSuccess('');
      await usersApi.sendPasswordResetEmail(email);
      setSuccess(
        emailConfirmedFlowing
          ? `Password reset email sent to ${email}`
          : emailPaused
            ? `Queued a sign-in link for ${email}. Outgoing email is paused, so it has not been delivered.`
            : `Queued a sign-in link for ${email}. Check Admin → Settings to confirm outgoing email is running.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send password reset email');
    }
  };

  const handleExportCSV = () => {
    const rows = filteredUsers.map((u) => ({
      id: u.id,
      name: u.full_name,
      email: u.email,
      roles: (u.roles ?? []).join(';'),
      points: u.total_points ?? 0,
      level: u.current_level ?? 1,
      streak: u.login_streak_count ?? 0,
      is_active: u.is_active ? 'yes' : 'no',
      created_at: u.created_at ?? '',
    }));
    const header = Object.keys(rows[0] ?? {}).join(',');
    const csv = [header, ...rows.map((r) => Object.values(r).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbit-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <Users className="w-8 h-8 text-iih-green" />
              User Management
            </h1>
            <p className="text-slate-600 mt-1">Manage users and their roles</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleExportCSV}
              className="bg-slate-600 hover:bg-slate-700 text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-medium flex items-center gap-2 transition-colors text-sm sm:text-base"
            >
              <Download className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="hidden sm:inline">Export CSV</span>
              <span className="sm:hidden">CSV</span>
            </button>
            <button
              onClick={handleShowTrash}
              className={`${showTrash ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'} text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-medium flex items-center gap-2 transition-colors text-sm sm:text-base`}
            >
              <Trash2 className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="hidden sm:inline">{showTrash ? 'Hide Trash' : 'View Trash'}</span>
              <span className="sm:hidden">Trash</span>
            </button>
            <button
              onClick={() => onNavigate?.('bulk-import')}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-medium flex items-center gap-2 transition-colors text-sm sm:text-base"
            >
              <Upload className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="hidden sm:inline">Bulk Import</span>
              <span className="sm:hidden">Import</span>
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-iih-green hover:bg-iih-green-dark text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-medium flex items-center gap-2 transition-colors text-sm sm:text-base"
            >
              <UserPlus className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="hidden sm:inline">Add User</span>
              <span className="sm:hidden">Add</span>
            </button>
          </div>
        </div>

        {/*
          Stated before anyone clicks, not only after. Sending a sign-in link is
          the main reason to visit this screen, and while mail is held that
          action does not do what its label says.
        */}
        {emailPaused && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg mb-6 flex items-start gap-3">
            <Mail className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Outgoing email is paused — nothing is being delivered.</p>
              <p className="text-sm mt-1">
                Sign-in links are queued and will send when email resumes.
                {emailStatus?.queued ? ` ${emailStatus.queued}${emailStatus.queuedIsCapped ? '+' : ''} message${emailStatus.queued === 1 ? '' : 's'} waiting.` : ''}
                {emailStatus?.pausedByEnv
                  ? ' Held by the EMAIL_PAUSED deployment variable, which cannot be released from the app.'
                  : ' Released from Admin → Settings.'}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg mb-6">
            {success}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search users by name or email..."
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)}
              className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">All Roles</option>
              <option value="admin">Admin</option>
              <option value="moderator">Moderator</option>
              <option value="intern">Intern</option>
            </select>
            <select
              value={signInFilter}
              onChange={(e) => setSignInFilter(e.target.value as typeof signInFilter)}
              className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">Any sign-in</option>
              <option value="never">Never signed in</option>
              <option value="signed_in">Has signed in</option>
            </select>
          </div>
        </div>

        {showBulkActions && (
          <div className="bg-iih-green/10 border border-iih-green rounded-xl p-4 mb-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <span className="text-slate-800 font-medium">
                {selectedUsers.size} user{selectedUsers.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleBulkPasswordReset}
                  disabled={sendingPasswordReset}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 sm:px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 disabled:opacity-50 text-sm"
                >
                  {sendingPasswordReset ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">Send Password Reset</span>
                  <span className="sm:hidden">Reset</span>
                </button>
                <button
                  onClick={handleBulkDeactivate}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 sm:px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm"
                >
                  <UserX className="w-4 h-4" />
                  <span className="hidden sm:inline">Deactivate Selected</span>
                  <span className="sm:hidden">Deactivate</span>
                </button>
                <button
                  onClick={() => {
                    setSelectedUsers(new Set());
                    setShowBulkActions(false);
                  }}
                  className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 sm:px-4 py-2 rounded-lg font-medium transition-colors text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left">
                    <button
                      onClick={toggleSelectAll}
                      aria-label={
                        selectedUsers.size === filteredUsers.length && filteredUsers.length > 0
                          ? 'Deselect all users'
                          : 'Select all users'
                      }
                      className="flex items-center gap-2 hover:text-iih-green transition-colors"
                    >
                      {selectedUsers.size === filteredUsers.length && filteredUsers.length > 0 ? (
                        <CheckSquare className="w-5 h-5 text-iih-green" />
                      ) : (
                        <Square className="w-5 h-5" />
                      )}
                    </button>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Stream
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Points
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Last sign-in
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <SkeletonTableRow key={i} />
                  ))
                ) : (
                  filteredUsers.map((user) => {
                  const userStream = streams.find((s) => s.id === user.current_stream_id);
                  return (
                    <tr key={user.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4">
                        <button
                          onClick={() => toggleUserSelection(user.id)}
                          className="flex items-center"
                          aria-label={selectedUsers.has(user.id) ? 'Deselect user' : 'Select user'}
                        >
                          {selectedUsers.has(user.id) ? (
                            <CheckSquare className="w-5 h-5 text-iih-green" />
                          ) : (
                            <Square className="w-5 h-5 text-slate-400" />
                          )}
                        </button>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center text-white font-medium">
                            {user.full_name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <button
                              onClick={() => onNavigate && onNavigate('user-profile', user.id)}
                              className="font-medium text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1 transition-colors"
                            >
                              {user.full_name}
                              <ExternalLink className="w-3 h-3" />
                            </button>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm text-slate-500">{user.email}</span>
                              {user.is_dummy && (
                                <span
                                  title={user.dummy_source || 'Marked as dummy content'}
                                  className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700"
                                >
                                  Dummy
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-1 flex-wrap">
                          {user.roles.map((role) => (
                            <span key={role} className="px-2 py-1 rounded-md text-xs font-medium bg-blue-100 text-blue-700 capitalize">
                              {role.replace('_', ' ')}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {userStream?.name || 'No stream'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-800">{user.total_points}</div>
                        <div className="text-xs text-slate-500">Level {user.current_level}</div>
                      </td>
                      {/*
                        The whole of week one is "did they get in?", so an
                        account that has never signed in is called out rather
                        than shown as a blank cell.
                      */}
                      <td className="px-6 py-4 text-sm">
                        {user.last_login_at ? (
                          <span className="text-slate-600" title={new Date(user.last_login_at).toLocaleString()}>
                            {new Date(user.last_login_at).toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            Never
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`px-3 py-1 rounded-full text-xs font-medium ${
                              user.is_active
                                ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {user.is_active ? 'Active' : 'Inactive'}
                          </span>
                          {user.mcp_enabled && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 flex items-center gap-1">
                              <Cpu className="w-3 h-3" /> MCP
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setEditingUser(user)}
                            className="text-blue-600 hover:text-blue-700"
                            aria-label={`Edit ${user.full_name}`}
                            title="Edit user"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleSinglePasswordReset(user.email)}
                            className="text-green-600 hover:text-green-700"
                            aria-label={`Send password reset to ${user.full_name}`}
                            title="Send password reset email"
                          >
                            <Mail className="w-4 h-4" />
                          </button>
                          {/* MCP access is a standing API credential, so which
                              accounts hold it has to be obvious at a glance.
                              The state is carried by SHAPE — a filled, ringed
                              chip when enabled versus a bare icon when not —
                              rather than by hue alone, which is invisible to
                              anyone who cannot separate the two colours, and
                              was previously the only difference. */}
                          <button
                            onClick={() => handleToggleMcp(user.id, !!user.mcp_enabled)}
                            aria-pressed={!!user.mcp_enabled}
                            className={
                              user.mcp_enabled
                                ? 'rounded bg-purple-100 p-1 text-purple-700 ring-1 ring-purple-300 hover:bg-purple-200'
                                : 'rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                            }
                            aria-label={`${user.mcp_enabled ? 'Disable' : 'Enable'} MCP access for ${user.full_name}`}
                            title={user.mcp_enabled ? 'MCP access enabled — click to revoke' : 'No MCP access — click to grant'}
                          >
                            <Cpu className="w-4 h-4" />
                          </button>
                          {/* Both directions. This rendered only when
                              `is_active` was true, so deactivating a user made
                              the control disappear and there was no way to undo
                              it from any screen — the server has always
                              supported both via adminSetActive(isActive). */}
                          {user.is_active ? (
                            <button
                              onClick={() => handleDeactivateUser(user.id)}
                              className="text-red-600 hover:text-red-700"
                              aria-label={`Deactivate ${user.full_name}`}
                              title="Deactivate user"
                            >
                              <UserX className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleActivateUser(user.id)}
                              className="text-emerald-600 hover:text-emerald-700"
                              aria-label={`Activate ${user.full_name}`}
                              title="Activate user"
                            >
                              <UserCheck className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => handleTrashUser(user.id, user.full_name)}
                            className="text-orange-600 hover:text-orange-700"
                            aria-label={`Move ${user.full_name} to trash`}
                            title="Move to trash"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {filteredUsers.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-800 mb-2">No users found</h3>
            <p className="text-slate-600">Try adjusting your search or filters</p>
          </div>
        )}
      </div>

      {showTrash && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-200">
              <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                <Trash2 className="w-6 h-6 text-red-600" />
                Trash ({trashedUsers.length})
              </h2>
              <p className="text-slate-600 mt-1">Deleted users - can be restored or permanently deleted</p>
            </div>

            {trashedUsers.length === 0 ? (
              <div className="p-12 text-center">
                <Trash2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-600 text-lg font-medium">Trash is empty</p>
                <p className="text-slate-500 text-sm mt-2">No deleted users</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                        User
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                        Email
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                        Deleted At
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {trashedUsers.map((user) => (
                      <tr key={user.id} className="hover:bg-slate-50">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            {user.profile_photo_url ? (
                              <img
                                src={user.profile_photo_url}
                                alt={user.full_name}
                                className="w-10 h-10 rounded-full object-cover"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-medium">
                                {user.full_name.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="font-medium text-slate-800">{user.full_name}</div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{user.email}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {user.deleted_at ? new Date(user.deleted_at).toLocaleString() : 'N/A'}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleRestoreUser(user.id, user.full_name)}
                              className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
                            >
                              Restore
                            </button>
                            <button
                              onClick={() => handlePermanentDelete(user.id, user.full_name)}
                              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
                            >
                              Delete Forever
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="p-4 bg-yellow-50 border-t border-yellow-200">
              <div className="flex items-start gap-2 text-sm text-yellow-800">
                <span className="font-medium">⚠️ Warning:</span>
                <span>
                  Permanently deleting a user will remove ALL their data including submissions, points, badges, messages, and posts. This action cannot be undone.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreateUserModal
          streams={streams}
          onClose={() => setShowCreateModal(false)}
          onCreated={loadData}
        />
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          streams={streams}
          onClose={() => setEditingUser(null)}
          onUpdated={loadData}
        />
      )}
    </div>
  );
}

function CreateUserModal({
  streams,
  onClose,
  onCreated,
}: {
  streams: OrbitStream[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [formData, setFormData] = useState({
    email: '',
    full_name: '',
    roles: ['intern'] as ('admin' | 'moderator' | 'intern')[],
    // Interns default to SIWES because that is the programme with duties
    // attached; getting it wrong the other way gives someone a logbook they do
    // not need, which is visible and correctable. The reverse is silent.
    programme_type: 'siwes',
    stream_id: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      /**
       * A programme belongs to an intern and to nobody else.
       *
       * The select is hidden when the intern role is unchecked, but the value
       * it last held stayed in state and was still submitted — so creating a
       * moderator or an admin stamped them as a SIWES intern, and `myStatus`
       * would report a programme for someone who is not on one.
       */
      const created = await usersApi.createUser({
        ...formData,
        programme_type: formData.roles.includes('intern') ? formData.programme_type : undefined,
      });

      /**
       * SHOWN, not discarded — and the parent is NOT refreshed until it has
       * been seen.
       *
       * When no password is supplied the server generates one, returns it here,
       * and does not store it: a temporary password kept in cleartext on the
       * user row was a credential at rest, so it was removed. Discarding the
       * response therefore creates an account whose password nobody in the
       * world knows.
       *
       * The refresh is deferred to the dismiss handler rather than fired here.
       * Calling onCreated() first triggers the parent's loadData(), and the
       * page renders a spinner INSTEAD of its children while that runs — which
       * would tear this modal down mid-update, before it could show anything.
       * The new row appearing a second later costs nothing; the password only
       * exists once.
       */
      if (created.temp_password) {
        setTempPassword(created.temp_password);
      } else {
        onCreated();
        onClose();
      }
    } catch (err) {
      logError(err, { context: 'UsersManagementPage.handleSubmit' });
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  // Shown once, and never retrievable again — see handleSubmit.
  if (tempPassword) {
    return (
      <div
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-created-modal-title"
      >
        <div className="bg-white rounded-xl max-w-md w-full p-6">
          <h2 id="user-created-modal-title" className="text-2xl font-bold text-slate-800 mb-2">User created</h2>
          <p className="text-slate-700 mb-4">
            This is the only time this password will be shown. Copy it now and send it to{' '}
            <strong>{formData.email}</strong> — it is not stored anywhere and cannot be looked up
            later. If it is lost, reset the password to issue a new one.
          </p>
          <div className="flex items-center gap-2 mb-6">
            <code className="flex-1 rounded-lg bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 select-all">
              {tempPassword}
            </code>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(tempPassword)}
              className="rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Copy
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              // Refresh only now. Doing it at creation time unmounted this
              // panel before it could render — see handleSubmit.
              onCreated();
              onClose();
            }}
            className="w-full rounded-lg bg-iih-green px-4 py-3 font-medium text-white hover:bg-iih-green-dark"
          >
            I have copied it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-user-modal-title"
    >
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <h2 id="add-user-modal-title" className="text-2xl font-bold text-slate-800 mb-4">Add New User</h2>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            {/* Associated with htmlFor/id. These were bare <label> siblings,
                so nothing linked them to their inputs: a screen reader
                announced each field unlabelled and clicking a label focused
                nothing. */}
            <label htmlFor="create-user-name" className="block text-sm font-medium text-slate-700 mb-2">Full Name</label>
            <input
              id="create-user-name"
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              required
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="create-user-email" className="block text-sm font-medium text-slate-700 mb-2">Email</label>
            <input
              id="create-user-email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              required
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {formData.roles.includes('intern') && (
            <div>
              <label htmlFor="create-user-programme" className="block text-sm font-medium text-slate-700 mb-2">
                Programme
              </label>
              <select
                id="create-user-programme"
                value={formData.programme_type}
                onChange={(e) => setFormData({ ...formData, programme_type: e.target.value })}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="siwes">SIWES</option>
                <option value="internship">Internship</option>
                <option value="nysc">NYSC</option>
                <option value="volunteer">Volunteer</option>
              </select>
              {/* Only SIWES keeps a logbook, so this is not a label — it decides
                  what the member is asked to do for the whole placement. */}
              <p className="mt-1 text-xs text-slate-500">
                Only SIWES interns keep a logbook and receive an acceptance letter.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Roles</label>
            <div className="space-y-2">
              {(['admin', 'moderator', 'intern'] as const).map((role) => (
                <label key={role} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.roles.includes(role)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setFormData({ ...formData, roles: [...formData.roles, role] });
                      } else {
                        setFormData({ ...formData, roles: formData.roles.filter((r) => r !== role) });
                      }
                    }}
                    className="rounded border-slate-300"
                  />
                  <span className="capitalize">{role}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="create-user-stream" className="block text-sm font-medium text-slate-700 mb-2">Stream</label>
            <select
              id="create-user-stream"
              value={formData.stream_id}
              onChange={(e) => setFormData({ ...formData, stream_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">No stream</option>
              {streams.map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {stream.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditUserModal({
  user,
  streams: _streams,
  onClose,
  onUpdated,
}: {
  user: OrbitUser;
  streams: OrbitStream[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [formData, setFormData] = useState({
    full_name: user.full_name,
    roles: user.roles,
    bio: user.bio || '',
    mcp_enabled: !!user.mcp_enabled,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await usersApi.updateUser(user.id, { full_name: formData.full_name, roles: formData.roles, bio: formData.bio });
      if (formData.mcp_enabled !== !!user.mcp_enabled) {
        await usersApi.toggleMcpAccess(user.id, formData.mcp_enabled);
      }
      onUpdated();
      onClose();
    } catch {
      setError('Failed to update user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-user-modal-title"
    >
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <h2 id="edit-user-modal-title" className="text-2xl font-bold text-slate-800 mb-4">Edit User</h2>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-user-name" className="block text-sm font-medium text-slate-700 mb-2">Full Name</label>
            <input
              id="edit-user-name"
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              required
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Roles</label>
            <div className="space-y-2">
              {(['admin', 'moderator', 'intern'] as const).map((role) => (
                <label key={role} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.roles.includes(role)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setFormData({ ...formData, roles: [...formData.roles, role] });
                      } else {
                        setFormData({ ...formData, roles: formData.roles.filter((r) => r !== role) });
                      }
                    }}
                    className="rounded border-slate-300"
                  />
                  <span className="capitalize">{role}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="edit-user-bio" className="block text-sm font-medium text-slate-700 mb-2">Bio</label>
            <textarea
              id="edit-user-bio"
              value={formData.bio}
              onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
              rows={3}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.mcp_enabled}
                onChange={(e) => setFormData({ ...formData, mcp_enabled: e.target.checked })}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <div>
                <span className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                  <Cpu className="w-4 h-4 text-purple-600" /> MCP Access
                </span>
                <span className="text-xs text-slate-500 block">Allow AI agents to connect via Model Context Protocol</span>
              </div>
            </label>
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Update
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
