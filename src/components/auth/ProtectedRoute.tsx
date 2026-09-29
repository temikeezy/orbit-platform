import { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { LoginPage } from './LoginPage';
import { UserRole } from '../../types/database';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: UserRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, loading, sessionSettled } = useAuth();

  const spinner = (
    <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
    </div>
  );

  if (loading) {
    return spinner;
  }

  if (!user) {
    return <LoginPage />;
  }

  const refused = allowedRoles && !allowedRoles.some(role => user.roles?.includes(role));

  /**
   * Refusing on CACHED roles would tell a freshly promoted admin they have no
   * permission. The cache is written at sign-in and not updated when roles
   * change server-side, so between opening the app and the session check
   * landing, `user.roles` can be a snapshot from before the promotion. Waiting
   * only on the deny branch keeps the cost to the case that would otherwise be
   * wrong: an allowed user still renders immediately from cache, and every
   * mutation is re-authorized on the server regardless.
   *
   * `sessionSettled` is set in a `finally`, so an offline browser releases this
   * too — the spinner cannot outlive the attempt.
   */
  if (refused && !sessionSettled) {
    return spinner;
  }

  if (refused) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md text-center">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">Access Denied</h2>
          <p className="text-slate-600">
            You don't have permission to access this page.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
