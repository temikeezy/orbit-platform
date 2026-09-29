import { lazy, Suspense, useEffect, useRef } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { ReportBugButton } from './components/common/ReportBugButton';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { Navigation } from './components/layout/Navigation';
import { Footer } from './components/layout/Footer';
import { MobileTabBar } from './components/layout/MobileTabBar';
import { LevelUpCelebration } from './components/common/LevelUpCelebration';
import { BadgeUnlockCelebration } from './components/common/BadgeUnlockCelebration';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { HomePage } from './pages/HomePage';
import { ApplicationPage } from './pages/ApplicationPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Survives the reload it guards; sessionStorage is per-tab, so tabs don't interfere. */
const RETRY_KEY = 'orbit_chunk_retry';

function lazyRetry<T extends { [key: string]: React.ComponentType }>(
  factory: () => Promise<T>,
  name: keyof T
) {
  return lazy(() =>
    factory()
      .then(m => {
        // Cleared only on a load that actually succeeded, so a later genuine
        // stale-chunk failure still gets its one retry.
        sessionStorage.removeItem(RETRY_KEY);
        return { default: m[name] as React.ComponentType };
      })
      .catch((error: unknown) => {
        /**
         * ONE reload, not an unbounded loop.
         *
         * The reload exists for the ordinary case: a deploy replaced the chunk
         * this tab was about to fetch, and re-requesting the page picks up the
         * new manifest. But an import can also fail DETERMINISTICALLY — a
         * top-level throw inside the module, a chunk missing from an incomplete
         * PWA precache while offline, an extension blocking one asset — and
         * then every reload re-navigates to the same route, re-fails the same
         * import and reloads again, leaving the app flash-looping with nothing
         * on screen to explain it. The same one-shot discipline guards the
         * controllerchange reload in main.tsx.
         */
        if (!sessionStorage.getItem(RETRY_KEY)) {
          sessionStorage.setItem(RETRY_KEY, '1');
          window.location.reload();
          return new Promise<{ default: React.ComponentType }>(() => {});
        }
        // Second failure in a row: let it through to the ErrorBoundary, which
        // can at least say something, rather than reloading forever.
        throw error;
      })
  );
}

const TasksPage = lazyRetry(() => import('./pages/TasksPage'), 'TasksPage');
const CommunityPage = lazyRetry(() => import('./pages/CommunityPage'), 'CommunityPage');
const StreamsPage = lazyRetry(() => import('./pages/StreamsPage'), 'StreamsPage');
const StreamDetailPage = lazyRetry(() => import('./pages/StreamDetailPage'), 'StreamDetailPage');
const EditStreamPage = lazyRetry(() => import('./pages/EditStreamPage'), 'EditStreamPage');
const TaskDetailPage = lazyRetry(() => import('./pages/TaskDetailPage'), 'TaskDetailPage');
const TaskProposalsPage = lazyRetry(
  () => import('./pages/TaskProposalsPage'),
  'TaskProposalsPage',
);
const AddTaskPage = lazyRetry(() => import('./pages/AddTaskPage'), 'AddTaskPage');
const EditTaskPage = lazyRetry(() => import('./pages/EditTaskPage'), 'EditTaskPage');
const AdminDashboard = lazyRetry(() => import('./pages/admin/AdminDashboard'), 'AdminDashboard');
const MyOrbitPage = lazyRetry(() => import('./pages/MyOrbitPage'), 'MyOrbitPage');
const UserProfilePage = lazyRetry(() => import('./pages/UserProfilePage'), 'UserProfilePage');
const MessagesPage = lazyRetry(() => import('./pages/MessagesPage'), 'MessagesPage');
const LeaderboardPage = lazyRetry(() => import('./pages/LeaderboardPage'), 'LeaderboardPage');
const NotificationsPage = lazyRetry(() => import('./pages/NotificationsPage'), 'NotificationsPage');
const UserSettingsPage = lazyRetry(() => import('./pages/UserSettingsPage'), 'UserSettingsPage');
const EditProfilePage = lazyRetry(() => import('./pages/EditProfilePage'), 'EditProfilePage');
const OAuthRedirectPage = lazyRetry(() => import('./pages/OAuthRedirectPage'), 'OAuthRedirectPage');
const MagicLinkPage = lazyRetry(() => import('./pages/MagicLinkPage'), 'MagicLinkPage');
const BadgesPage = lazyRetry(() => import('./pages/BadgesPage'), 'BadgesPage');
const TaskCalendarPage = lazyRetry(() => import('./pages/TaskCalendarPage'), 'TaskCalendarPage');
const OrientationPage = lazyRetry(() => import('./pages/OrientationPage'), 'OrientationPage');
const SubmissionReviewPage = lazyRetry(() => import('./pages/admin/SubmissionReviewPage'), 'SubmissionReviewPage');
const LogbookPage = lazyRetry(() => import('./pages/LogbookPage'), 'LogbookPage');
const ReviewDashboardPage = lazyRetry(() => import('./pages/ReviewDashboardPage'), 'ReviewDashboardPage');

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-iih-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p className="text-slate-600">Loading...</p>
      </div>
    </div>
  );
}

function AppContent() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  /**
   * Move focus to the new page on navigation.
   *
   * A single-page app swaps the content and leaves focus wherever it was — on
   * the nav link that was just clicked. A screen reader announces nothing, and
   * a keyboard user's next Tab continues through the navigation they have
   * already passed rather than entering the page they just asked for. The
   * browser does this for free on a real page load; a router has to do it
   * deliberately.
   *
   * `preventScroll` because the scroll position is the router's business, not
   * the focus manager's, and focusing a container at the top of a restored
   * scroll position would yank the view.
   */
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-orbit-canvas flex flex-col">
      {/*
        The first thing in the tab order, visible only once focused. Every page
        here begins with the same nav and tab bar, so without this a keyboard
        user tabs through the whole of it on every single navigation before
        reaching anything specific to the page.
      */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:text-iih-green focus:shadow-lg focus:outline focus:outline-2 focus:outline-iih-green"
      >
        Skip to main content
      </a>
      <Navigation />
      <LevelUpCelebration />
      <BadgeUnlockCelebration />
      {/*
        tabIndex={-1} makes this focusable programmatically without adding it to
        the tab order — the standard way to give a router somewhere to put focus.
      */}
      <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 pb-16 md:pb-0 focus:outline-none">
        {/*
          The only boundary used to be in main.tsx, OUTSIDE <App> — so a crash
          on any one page blanked the entire chrome (Navigation, Footer,
          MobileTabBar) along with it, taking away the very controls someone
          needs to leave the broken page. Keyed on the path so navigating away
          gets a fresh boundary instead of the previous page's stale
          "Something went wrong" following the user to the next route.
        */}
        <ErrorBoundary key={location.pathname} name={`route:${location.pathname}`}>
          <Suspense fallback={<LoadingFallback />}>
            {/* Everywhere, signed in or not — the login page is where a stuck
                person most needs to be able to say so. */}
            <ReportBugButton />
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/tasks" element={<TasksPage />} />
              {/* Before /tasks/:taskId — otherwise "proposals" is read as a task id. */}
              <Route path="/tasks/proposals" element={<TaskProposalsPage />} />
              <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
              <Route path="/tasks/:taskId/edit" element={<EditTaskPage />} />
              <Route path="/task-calendar" element={<TaskCalendarPage />} />
              <Route path="/streams" element={<StreamsPage />} />
              <Route path="/streams/:streamId" element={<StreamDetailPage />} />
              <Route path="/streams/:streamId/edit" element={<EditStreamPage />} />
              <Route path="/streams/:streamId/add-task" element={<AddTaskPage />} />
              <Route path="/community" element={<CommunityPage />} />
              <Route path="/leaderboard" element={<LeaderboardPage />} />
              <Route path="/badges" element={<BadgesPage />} />
              <Route path="/profile" element={<MyOrbitPage />} />
              <Route path="/profile/edit" element={<EditProfilePage />} />
              <Route path="/users/:userId" element={<UserProfilePage />} />
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/messages/:recipientId" element={<MessagesPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/settings" element={<UserSettingsPage />} />
              <Route path="/orientation" element={<OrientationPage />} />
              <Route path="/logbook" element={<LogbookPage />} />
              <Route path="/review" element={
                <ProtectedRoute allowedRoles={['admin', 'super_admin', 'moderator']}>
                  <ReviewDashboardPage />
                </ProtectedRoute>
              } />
              <Route path="/admin/*" element={
                <ProtectedRoute allowedRoles={['admin', 'super_admin']}>
                  <AdminDashboard />
                </ProtectedRoute>
              } />
              <Route path="/admin/submissions" element={
                <ProtectedRoute allowedRoles={['admin', 'super_admin', 'moderator']}>
                  <SubmissionReviewPage />
                </ProtectedRoute>
              } />
              {/* Catch-all. An unmatched path used to render the chrome around an
                  empty body, so a typo and a broken deploy looked the same. */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <Footer />
      <MobileTabBar />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/oauthredirect" element={<OAuthRedirectPage />} />
          <Route path="/magic" element={<MagicLinkPage />} />
          <Route path="/apply" element={<ApplicationPage />} />
          <Route path="/*" element={
            <ProtectedRoute>
              <AppContent />
            </ProtectedRoute>
          } />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}

export default App;
