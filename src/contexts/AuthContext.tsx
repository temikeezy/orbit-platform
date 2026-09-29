import { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import { authService } from '../lib/auth';
import { OrbitUser } from '../types/database';

interface AuthContextType {
  user: OrbitUser | null;
  loading: boolean;
  /**
   * Whether the cached session has been checked against the server yet.
   *
   * `loading` goes false as soon as the CACHED user is on screen, which is what
   * keeps the app from flashing a sign-in page on every load. But the cache can
   * be stale about roles — someone promoted since it was written still carries
   * their old roles array — so a permission verdict computed before this flips
   * true can be wrong. Deny branches should wait for it; allow branches should
   * not, since the server re-checks every mutation anyway.
   */
  sessionSettled: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  loginWithZoho: (zohoToken: string) => Promise<{ success: boolean; error?: string }>;
  loginWithMagicLink: (token: string) => Promise<{ success: boolean; error?: string }>;
  requestMagicLink: (email: string) => Promise<{ success: boolean; error?: string }>;
  setSession: (token: string, user: OrbitUser) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isStreamLead: boolean;
  isMember: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<OrbitUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionSettled, setSessionSettled] = useState(false);

  useEffect(() => {
    // The cached user renders immediately, then the session is VALIDATED.
    //
    // Client-side expiry was deliberately removed when auth moved to Convex —
    // `jwt_expires_at` no longer exists — on the reasoning that `refreshUser()`
    // would notice a dead session instead. Nothing called it. So an expired,
    // revoked or deactivated session stayed "authenticated" forever, every page
    // threw opaque Unauthorized errors, and the user was never signed out.
    //
    // Showing the cached user first keeps the app from flashing a sign-in screen
    // on every load; `refreshUser` returns null and clears the session only when
    // the SERVER rejects it, never on a network failure.
    // Cancelled on unmount. Without this the validation is a promise nothing
    // owns: it resolves after the provider is gone and calls setUser on a dead
    // tree. In the app that is a React warning and a wasted render; in the test
    // suite it is worse, because `localStorage` is cleared between tests — so a
    // refresh outliving its test resolves against an empty cache, concludes the
    // session is gone, and calls `logout()`, signing out the NEXT test's user
    // mid-render. That is what made EditTaskPage's deadline spec fail on CI and
    // nowhere else: the leaked refresh from the preceding test.
    let cancelled = false;

    const cached = authService.getCurrentUser();
    setUser(cached);
    setLoading(false);

    // Nothing cached means nothing to revalidate: the sign-in page is already
    // the correct answer, so the session is as settled as it will get.
    if (!cached) {
      setSessionSettled(true);
      return;
    }

    void authService
      .refreshUser()
      .then((fresh) => {
        if (!cancelled) setUser(fresh);
      })
      .finally(() => {
        // Settled means "we have stopped waiting", not "the server answered".
        // A rejected promise or an offline browser must still release the deny
        // branches, or a network failure becomes an indefinite spinner on every
        // guarded route — which is the failure mode a previous attempt at this
        // shipped, and the reason it was reverted.
        if (!cancelled) setSessionSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email: string, password: string) => {
    const response = await authService.login(email, password);
    if (response.success && response.user) {
      setUser(response.user);
    }
    return { success: response.success, error: response.error };
  };

  const loginWithZoho = async (zohoToken: string) => {
    const response = await authService.loginWithZoho(zohoToken);
    if (response.success && response.user) {
      setUser(response.user);
    }
    return { success: response.success, error: response.error };
  };

  const loginWithMagicLink = async (token: string) => {
    const response = await authService.loginWithMagicLink(token);
    if (response.success && response.user) {
      setUser(response.user);
    }
    return { success: response.success, error: response.error };
  };

  const requestMagicLink = async (email: string) => {
    return await authService.requestMagicLink(email);
  };

  const setSession = (token: string, user: OrbitUser) => {
    authService.setSession(token, user);
    setUser(user);
  };

  const logout = () => {
    authService.logout();
    setUser(null);
  };

  const refreshUser = async () => {
    const updatedUser = await authService.refreshUser();
    setUser(updatedUser);
  };

  const value = useMemo<AuthContextType>(() => ({
    user,
    loading,
    sessionSettled,
    login,
    loginWithZoho,
    loginWithMagicLink,
    requestMagicLink,
    setSession,
    logout,
    refreshUser,
    isAuthenticated: !!user && !!authService.getToken(),
    isAdmin: (user?.roles?.includes('admin') || user?.roles?.includes('super_admin')) ?? false,
    isStreamLead: user?.roles?.includes('moderator') ?? false,
    isMember: user?.roles?.includes('intern') ?? false,
  }), [user, loading, sessionSettled]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
