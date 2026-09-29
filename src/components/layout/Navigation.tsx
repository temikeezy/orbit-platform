import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import orbitLogo from '../../assets/orbit-logo.png';
import { seesProgression } from '../../lib/roles';
import { useAuth } from '../../contexts/AuthContext';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { UserRole } from '../../types/database';
import { authService } from '../../lib/auth';
import {
  Home,
  Users,
  CheckSquare,
  Trophy,
  MessageCircle,
  Bell,
  User,
  Settings,
  LogOut,
  Menu,
  X,
  Award,
  BarChart3,
  Layers,
  ClipboardCheck,
  Flame,
  BookOpen,
  NotebookPen,
} from 'lucide-react';

export function Navigation() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [achievementsMenuOpen, setAchievementsMenuOpen] = useState(false);

  /**
   * The unread badge, live over the Convex WebSocket.
   *
   * The Supabase channel it replaces filtered on `recipient_id=eq.<id>` — a
   * column that does not exist on orbit_notifications, which uses `user_id`.
   * So the subscription matched nothing and the badge never moved after the
   * initial fetch, in either direction. The INSERT handler also incremented a
   * local counter rather than re-reading, so had it fired it would have drifted
   * from the truth as soon as anything was marked read in another tab.
   *
   * `useQuery` subscribes to `notifications.unreadCount` itself, so the number
   * on screen is the number the server would return, always.
   */
  const token = authService.getToken();

  const unreadNotifications =
    (useQuery(api.notifications.unreadCount, user?.id && token ? { token } : 'skip') as
      | number
      | undefined) ?? 0;

  const navItems = [
    { path: '/', label: 'Home', icon: Home, roles: ['admin', 'moderator', 'intern'] as UserRole[] },
    { path: '/community', label: 'Community', icon: Users, roles: ['admin', 'moderator', 'intern'] as UserRole[] },
    { path: '/streams', label: 'Streams', icon: Layers, roles: ['admin', 'moderator', 'intern'] as UserRole[] },
    { path: '/tasks', label: 'Tasks', icon: CheckSquare, roles: ['admin', 'moderator', 'intern'] as UserRole[] },
    { path: '/logbook', label: 'Logbook', icon: NotebookPen, roles: ['intern'] as UserRole[] },
    { path: '/orientation', label: 'Manual', icon: BookOpen, roles: ['admin', 'moderator', 'intern'] as UserRole[] },
  ];

  /**
   * Points, levels, badges and the leaderboard are an INTERN progression
   * device. `awardPoints` returns early for anyone who is not an intern and the
   * leaderboard filters to interns server-side, so a supervisor opening either
   * finds a ladder they can never climb and a board they can never appear on.
   * Showing it states something true and useless.
   */
  const showsProgression = seesProgression(user);

  const achievementsSubMenu = [
    { path: '/leaderboard', label: 'Leaderboard', icon: Trophy },
    { path: '/badges', label: 'Badges', icon: Award },
  ];

  // super_admin is listed explicitly. With only 'admin' here, a pure
  // super_admin — the most privileged account on the platform — had no Admin
  // link in the navigation at all and had to reach /admin by typing the URL.
  const adminItem = {
    path: '/admin',
    label: 'Admin',
    icon: BarChart3,
    roles: ['admin', 'super_admin'] as UserRole[],
  };

  const visibleNavItems = navItems.filter(item =>
    user && user.roles && item.roles.some(role => user.roles.includes(role))
  );

  const showAdmin = user && user.roles && adminItem.roles.some(role => user.roles.includes(role));

  const canReview = user && user.roles && (user.roles.includes('super_admin') || user.roles.includes('admin') || user.roles.includes('moderator'));

  return (
    <>
      <nav className="sticky top-0 z-50 border-b border-slate-200 bg-white text-orbit-ink shadow-orbit-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-8">
              <Link
                to="/"
                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
              >
                {/*
                  THE REAL WORDMARK, bundled with the app.
                  This was https://ilorininnovationhub.com/public/orbit.png,
                  which returns 404 — so the navigation rendered a broken-image
                  icon on every page for every signed-in user, and the app's own
                  branding depended on a third-party site staying up.
                  An earlier fix pointed at the PWA app icon, which is a
                  recreated mark rather than the logo; this is the actual ORBIT
                  logo from the project's brand assets, imported so the build
                  fingerprints it.

                  TRIMMED TO THE MARK, and transparent.

                  It was a 1024x1024 square holding a 902x743 mark with lopsided
                  padding — 82px of it on the left against 40 on the right, 117
                  above against 164 below. At `h-14` that rendered the logo
                  49x41 inside a 56x56 box, undersized and visibly off-centre,
                  which is what "the logo looks skewed" meant. Nothing was
                  stretched, so checking the aspect ratio did not find it.

                  Now cropped to the artwork's own bounds (aspect 1.213), so
                  height fixed + width `auto` fills the bar exactly. Do not add
                  a `w-*` class, and do not re-pad the canvas.
                */}
                <img
                  src={orbitLogo}
                  alt="ORBIT"
                  /**
                   * `shrink-0` and `object-contain` are LOAD-BEARING.
                   *
                   * This is a flex child. `h-14 w-auto` alone looks like it
                   * preserves the aspect ratio, and does — right up until the
                   * nav runs short of room, at which point flexbox's default
                   * `flex-shrink: 1` compresses the WIDTH while `h-14` holds the
                   * height fixed. The result is a horizontally squashed logo:
                   * the file is correct, the CSS distorts it, and measuring the
                   * asset finds nothing wrong. It reads worst at the narrow
                   * widths where the nav carries the most items.
                   *
                   * `shrink-0` takes it out of the shrink calculation;
                   * `object-contain` guarantees the bitmap is never stretched to
                   * fill a box it does not match — the same pair the login
                   * screen has always had, which is why that one never skewed.
                   */
                  className="h-14 w-auto shrink-0 object-contain"
                />
              </Link>

              <div className="hidden md:flex items-center gap-1">
                {visibleNavItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                        isActive
                          ? 'bg-iih-green text-orbit-ink font-semibold shadow-sm'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-orbit-ink font-medium'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      {item.label}
                    </Link>
                  );
                })}

                {/* Achievements Dropdown — interns only, see showsProgression */}
                {showsProgression && (
                <div className="relative">
                  <button
                    onClick={() => setAchievementsMenuOpen(!achievementsMenuOpen)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      location.pathname === '/leaderboard' || location.pathname === '/badges'
                        ? 'bg-iih-green text-orbit-ink font-semibold shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-orbit-ink font-medium'
                    }`}
                  >
                    <Trophy className="w-5 h-5" />
                    Achievements
                  </button>

                  {achievementsMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setAchievementsMenuOpen(false)}
                      />
                      <div className="absolute left-0 mt-2 w-48 rounded-lg border border-orbit-line bg-orbit-surface text-orbit-ink shadow-orbit-md z-20">
                        {achievementsSubMenu.map((subItem) => {
                          const SubIcon = subItem.icon;
                          return (
                            <Link
                              key={subItem.path}
                              to={subItem.path}
                              onClick={() => setAchievementsMenuOpen(false)}
                              className="flex items-center gap-2 px-4 py-3 hover:bg-orbit-mint/60 transition-colors first:rounded-t-lg last:rounded-b-lg"
                            >
                              <SubIcon className="w-4 h-4 text-orbit-muted" />
                              <span className="text-orbit-graphite font-medium">{subItem.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
                )}

                {/* Admin Link - Last in Navigation */}
                {showAdmin && (
                  <Link
                    to={adminItem.path}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      location.pathname === adminItem.path || location.pathname.startsWith(adminItem.path)
                        ? 'bg-iih-green text-orbit-ink font-semibold shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-orbit-ink font-medium'
                    }`}
                  >
                    <BarChart3 className="w-5 h-5" />
                    {adminItem.label}
                  </Link>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Login streak flame */}
              {user?.login_streak_count !== undefined && user.login_streak_count > 0 && (
                <div
                  className="flex items-center gap-1 text-orbit-amber"
                  title={`${user.login_streak_count}-day login streak!`}
                  role="img"
                  aria-label={`${user.login_streak_count}-day login streak`}
                >
                  <Flame className="w-5 h-5 fill-orbit-amber" />
                  <span className="text-xs font-bold orbit-data">{user.login_streak_count}</span>
                </div>
              )}

              <Link
                to="/notifications"
                className="relative text-slate-600 hover:text-orbit-ink transition-colors"
                aria-label={`Notifications${unreadNotifications > 0 ? ` (${unreadNotifications} unread)` : ''}`}
              >
                <Bell className="w-6 h-6" />
                {unreadNotifications > 0 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-iih-green text-white text-xs rounded-full flex items-center justify-center">
                    {unreadNotifications > 9 ? '9+' : unreadNotifications}
                  </span>
                )}
              </Link>

              <div className="relative">
                <button
                  onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-slate-100"
                  aria-label="User profile menu"
                  aria-expanded={profileMenuOpen}
                >
                  <div className="w-8 h-8 bg-iih-green rounded-full flex items-center justify-center text-orbit-ink font-bold">
                    {user?.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="hidden sm:block text-left">
                    <div className="text-sm font-medium text-orbit-ink">{user?.full_name}</div>
                    <div className="text-xs text-slate-500 capitalize">
                      {user?.roles?.[0]?.replace('_', ' ') || 'Member'}
                    </div>
                  </div>
                </button>

                {profileMenuOpen && (
                  <div className="absolute right-0 mt-2 w-56 rounded-lg border border-orbit-line bg-orbit-surface py-2 text-orbit-ink shadow-orbit-md">
                    <Link
                      to={`/users/${user?.id}`}
                      onClick={() => setProfileMenuOpen(false)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-orbit-graphite hover:bg-orbit-mint/60"
                    >
                      <User className="w-5 h-5" />
                      My Profile
                    </Link>
                    <Link
                      to="/profile"
                      onClick={() => setProfileMenuOpen(false)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-orbit-graphite hover:bg-orbit-mint/60"
                    >
                      <Award className="w-5 h-5" />
                      My ORBIT
                    </Link>
                    <Link
                      to="/messages"
                      onClick={() => setProfileMenuOpen(false)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-orbit-graphite hover:bg-orbit-mint/60"
                    >
                      <MessageCircle className="w-5 h-5" />
                      My Messages
                    </Link>
                    <Link
                      to="/settings"
                      onClick={() => setProfileMenuOpen(false)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-orbit-graphite hover:bg-orbit-mint/60"
                    >
                      <Settings className="w-5 h-5" />
                      My Settings
                    </Link>
                    {canReview && (
                      <>
                        <hr className="my-2 border-slate-200" />
                        <Link
                          to="/admin/submissions"
                          onClick={() => setProfileMenuOpen(false)}
                          className="w-full flex items-center gap-3 px-4 py-2 text-orbit-graphite hover:bg-orbit-mint/60"
                        >
                          <ClipboardCheck className="w-5 h-5" />
                          Review Submissions
                        </Link>
                        <Link
                          to="/review"
                          onClick={() => setProfileMenuOpen(false)}
                          className="w-full flex items-center gap-3 px-4 py-2 text-orbit-graphite hover:bg-orbit-mint/60"
                        >
                          <NotebookPen className="w-5 h-5" />
                          Review Logbooks
                        </Link>
                      </>
                    )}
                    <hr className="my-2 border-slate-200" />
                    <button
                      onClick={logout}
                      className="w-full flex items-center gap-3 px-4 py-2 text-red-600 hover:bg-red-50"
                    >
                      <LogOut className="w-5 h-5" />
                      Sign Out
                    </button>
                  </div>
                )}
              </div>

              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden text-slate-600 hover:text-orbit-ink"
                aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileMenuOpen}
              >
                {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
              </button>
            </div>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200 bg-white">
            <div className="px-4 py-4 space-y-1">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                      isActive
                        ? 'bg-iih-green text-orbit-ink font-semibold shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-orbit-ink font-medium'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    {item.label}
                  </Link>
                );
              })}

              {/* Achievements Section in Mobile — interns only, as on desktop */}
              {showsProgression && (
              <div className="pt-2">
                <div className="text-xs font-semibold text-slate-400 px-4 py-2">Achievements</div>
                {achievementsSubMenu.map((subItem) => {
                  const SubIcon = subItem.icon;
                  const isActive = location.pathname === subItem.path;
                  return (
                    <Link
                      key={subItem.path}
                      to={subItem.path}
                      onClick={() => setMobileMenuOpen(false)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                        isActive
                          ? 'bg-iih-green text-orbit-ink font-semibold shadow-sm'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-orbit-ink font-medium'
                      }`}
                    >
                      <SubIcon className="w-5 h-5" />
                      {subItem.label}
                    </Link>
                  );
                })}
              </div>
              )}

              {/* Admin Link in Mobile - Last Item */}
              {showAdmin && (
                <div className="pt-2 border-t border-white/10 mt-2">
                  <Link
                    to={adminItem.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                      location.pathname === adminItem.path || location.pathname.startsWith(adminItem.path)
                        ? 'bg-iih-green text-orbit-ink font-semibold shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-orbit-ink font-medium'
                    }`}
                  >
                    <BarChart3 className="w-5 h-5" />
                    {adminItem.label}
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}
      </nav>

      {profileMenuOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setProfileMenuOpen(false)}
        />
      )}
    </>
  );
}
