import { OrbitUser } from '../types/database';
import { logError } from './monitoring';
import { convexHttp as convex, convexSiteUrl } from './convex';
import { api } from '../../convex/_generated/api';
import { toOrbitUser, ConvexUser } from './convexAdapters';
import { clearSessionCaches } from './sessionCaches';

/**
 * Session handling, on Convex.
 *
 * THE STORAGE KEYS ARE VERSIONED. A session minted by Supabase is a token this
 * deployment has never heard of, and a cached Supabase user has `jwt_expires_at`
 * and a uuid `id` that no Convex function will accept. Reusing the old keys
 * would leave anyone who had used ORBIT before half-authenticated:
 * `isAuthenticated()` true from the cached record, every actual call rejected.
 * The `_v2` suffix makes the switch a clean sign-out instead, and the v1 keys are
 * removed on load so a later bug cannot pick them up.
 *
 * SIGN-IN GOES OVER HTTP, not through the Convex client. `loginWithPassword` is
 * an internalMutation behind `/auth/login`, because a mutation cannot see the
 * client address — a rate limit inside one can only key on a value the caller
 * supplies, which is not a rate limit. The httpAction reads the real address.
 */

const TOKEN_KEY = 'orbit_auth_token_v2';
const USER_KEY = 'orbit_user_v2';

const LEGACY_KEYS = ['orbit_auth_token', 'orbit_user'];

/** Dropped once, at module load. A Supabase session is not a Convex session. */
for (const key of LEGACY_KEYS) {
  if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
}

/** httpActions live on `.convex.site`; queries and mutations on `.convex.cloud`. */
const SITE_URL = convexSiteUrl;

export interface AuthResponse {
  success: boolean;
  user?: OrbitUser;
  token?: string;
  error?: string;
}

function persist(token: string, user: ConvexUser): AuthResponse {
  const orbitUser = toOrbitUser(user);
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(orbitUser));
  return { success: true, user: orbitUser, token };
}

/**
 * `unknown` values, not `any`.
 *
 * Every caller narrows what it reads out of this — an `any` here would let a
 * typo in a field name flow silently into a user object.
 */
async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!SITE_URL) throw new Error('VITE_CONVEX_URL is not configured');

  const response = await fetch(`${SITE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // The routes answer 200 with `{ success: false }` for a rejected sign-in, so
  // anything else is infrastructure — and its body is not necessarily JSON.
  // Parsing it blindly surfaced "Unexpected token '<'" to the user instead of
  // something they could act on.
  if (!response.ok) {
    return { success: false, error: 'Sign-in is unavailable right now. Please try again.' };
  }

  try {
    return await response.json();
  } catch {
    return { success: false, error: 'Sign-in is unavailable right now. Please try again.' };
  }
}

export const authService = {
  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      const data = await postJson('/auth/login', { email, password });

      if (data?.success === true && typeof data.token === 'string' && data.user) {
        return persist(data.token, data.user as ConvexUser);
      }

      return {
        success: false,
        error: typeof data?.error === 'string' ? data.error : 'Invalid credentials',
      };
    } catch (error) {
      logError(error, { context: 'login' });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Login failed',
      };
    }
  },

  /**
   * Completes a Zoho sign-in.
   *
   * The callback redirects back with a single-use CODE rather than a token, so
   * the session never rides in a URL where it would land in history and the
   * referrer header.
   */
  async loginWithZoho(exchangeCode: string): Promise<AuthResponse> {
    try {
      const data = await convex.mutation(api.zoho.exchangeOAuthCode, { code: exchangeCode });

      if (data?.success === true && typeof data.token === 'string' && data.user) {
        return persist(data.token, data.user as ConvexUser);
      }

      return { success: false, error: 'Zoho authentication failed' };
    } catch (error) {
      logError(error, { context: 'loginWithZoho' });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Zoho login failed',
      };
    }
  },

  async loginWithMagicLink(token: string): Promise<AuthResponse> {
    try {
      /**
       * POSTed to the site origin, not sent as a mutation argument.
       *
       * Convex records function arguments in its logs, so redeeming through a
       * mutation put a live sign-in credential into them for the hour the link
       * was valid. A request body is not recorded that way.
       */
      const response = await fetch(`${SITE_URL}/auth/magic-link/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const result = (await response.json()) as {
        success: boolean;
        error?: string;
        token?: string;
        user?: unknown;
      };

      if (!result.success || !result.token) {
        return { success: false, error: result.error ?? 'This sign-in link is invalid or has expired.' };
      }

      // The same helper the password path uses, so a magic-link session is
      // stored exactly like any other and AuthContext boots from it identically.
      return persist(result.token, result.user as ConvexUser);
    } catch (error) {
      logError(error, { context: 'loginWithMagicLink' });
      return { success: false, error: 'Could not sign you in. Please request a new link.' };
    }
  },

  async requestMagicLink(email: string): Promise<{ success: boolean; error?: string }> {
    try {
      // The response is the same whether or not the account exists, so this
      // cannot be used to discover who has an ORBIT account.
      //
      // The RESULT is inspected rather than discarded, though. `postJson` turns
      // a non-2xx response or an unparseable body into `{ success: false }`
      // instead of throwing (see its comment), so awaiting it and returning a
      // hardcoded success reported "magic link sent" when Convex was down and
      // nothing had been queued. That is not an enumeration risk — the server
      // already answers 200 with its generic body for an unknown address, so a
      // transport failure is safely distinguishable from "no such account".
      // usersApi.sendPasswordResetEmail and sendBulkPasswordResetEmails share
      // this path, so an admin bulk reset during an outage reported N successes
      // and 0 failures.
      const result = await postJson('/auth/magic-link', { email });
      if (result.success === false) {
        return {
          success: false,
          error: typeof result.error === 'string' ? result.error : 'Failed to send magic link',
        };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send magic link',
      };
    }
  },

  /** Persists a pre-validated pair, for flows that obtain one out of band. */
  setSession(token: string, user: OrbitUser): void {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },

  /**
   * Signs out, ending the session SERVER-SIDE as well as locally.
   *
   * Clearing localStorage alone left the row alive for its full seven days, so
   * "log out" on a shared machine revoked nothing.
   */
  logout(): void {
    const token = localStorage.getItem(TOKEN_KEY);

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);

    // In-memory caches go too. `settingsApi` holds admin settings for 60s and
    // serves them BEFORE any token check when warm, and `levelUtils` caches the
    // ladder — so on a shared machine the next person to sign in within that
    // window could be served the previous admin's settings with no server
    // authorization in the path. Clearing localStorage alone left both standing.
    clearSessionCaches();

    // Fire-and-forget: the user is already signed out locally, and a network
    // failure must not strand them on a page they cannot leave.
    if (token) {
      convex.mutation(api.auth.logout, { token }).catch(() => {});
    }
  },

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  getCurrentUser(): OrbitUser | null {
    const userJson = localStorage.getItem(USER_KEY);
    if (!userJson) return null;

    try {
      return JSON.parse(userJson);
    } catch {
      return null;
    }
  },

  /**
   * Whether this browser holds a session it believes is live.
   *
   * EXPIRY IS SERVER-SIDE ONLY, deliberately. This used to read
   * `user.jwt_expires_at` off the cached record — a Postgres column that no
   * longer exists, so the check would silently never fire and this would return
   * true forever. Rather than reintroduce a client clock that can disagree with
   * the server, the session's lifetime belongs entirely to `userFromToken`,
   * which rejects an expired row on every call.
   *
   * The cost is that an expired session looks valid until the next request. That
   * is the right trade: the failure mode becomes one rejected call followed by
   * `refreshUser()` signing the user out, rather than a client that believes it
   * is authenticated indefinitely.
   */
  isAuthenticated(): boolean {
    return Boolean(this.getToken() && this.getCurrentUser());
  },

  hasRole(role: string): boolean {
    const user = this.getCurrentUser();
    return Boolean(user?.roles?.includes(role as never));
  },

  hasAnyRole(roles: string[]): boolean {
    const user = this.getCurrentUser();
    if (!user?.roles) return false;
    return roles.some((role) => user.roles.includes(role as never));
  },

  /**
   * SUPER ADMIN COUNTS AS ADMIN.
   *
   * This was `hasRole('admin')`, and a super admin can carry
   * `roles: ['super_admin']` alone — production's does. So every admin check in
   * the client was false for the platform's most privileged user, hiding admin
   * UI from the person who owns it. The Convex side has always treated the pair
   * together (`hasRole(user, 'admin', 'super_admin')`); the client had drifted.
   */
  isAdmin(): boolean {
    return this.hasAnyRole(['admin', 'super_admin']);
  },

  /**
   * Strictly super admin.
   *
   * Distinct from `isAdmin()`, which deliberately treats the pair as one. A few
   * server functions are super-admin-only by design — creating users, trashing
   * them, reading raw email bodies — and any screen that offers one of those to
   * a plain admin walks them to a refusal they could not have predicted.
   */
  isSuperAdmin(): boolean {
    return this.hasAnyRole(['super_admin']);
  },

  isStreamLead(): boolean {
    return this.hasRole('moderator');
  },

  isMember(): boolean {
    return this.hasRole('intern');
  },

  canManageStreams(): boolean {
    return this.isAdmin();
  },

  canManageTasks(): boolean {
    return this.isAdmin() || this.hasRole('moderator');
  },

  canReviewSubmissions(): boolean {
    return this.isAdmin() || this.hasRole('moderator');
  },

  /**
   * Re-reads the user, and signs out if the session is gone.
   *
   * This is where an expired or revoked session is noticed, since there is no
   * client-side expiry any more. `auth.me` returns null for anything the server
   * will not accept: expired, revoked, deactivated or deleted.
   */
  async refreshUser(): Promise<OrbitUser | null> {
    const token = this.getToken();
    if (!token) return null;

    try {
      const user = await convex.query(api.auth.me, { token });

      if (!user) {
        this.logout();
        return null;
      }

      const orbitUser = toOrbitUser(user as ConvexUser);
      localStorage.setItem(USER_KEY, JSON.stringify(orbitUser));
      return orbitUser;
    } catch (error) {
      // A network failure is NOT a reason to sign out — that would log everyone
      // out of a PWA the moment they lost signal. Only an explicit null from the
      // server does that, above.
      logError(error, { context: 'refreshUser' });
      return this.getCurrentUser();
    }
  },
};
