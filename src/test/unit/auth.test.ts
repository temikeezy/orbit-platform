import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { authService } from '../../lib/auth';
import { mockInternUser, mockAdminUser, seedLocalStorage } from '../fixtures';

/**
 * Rewritten for Convex.
 *
 * The previous version mocked Supabase RPCs and asserted things that are no
 * longer true — that an expired `jwt_expires_at` signs the user out, and that
 * login goes through `supabase.rpc`. Those were not failing tests to repair;
 * they were tests of a contract the migration deliberately replaced. What is
 * asserted here is the new one, including the two properties that exist
 * specifically because the old behaviour was wrong.
 */

const TOKEN_KEY = 'orbit_auth_token_v2';
const USER_KEY = 'orbit_user_v2';

/** What Convex actually returns: camelCase, and no secrets. */
const convexUser = {
  id: mockInternUser.id,
  email: mockInternUser.email,
  fullName: mockInternUser.full_name,
  roles: mockInternUser.roles,
  totalPoints: mockInternUser.total_points,
  currentLevel: mockInternUser.current_level,
  isActive: true,
  createdAt: 0,
};

describe('authService', () => {
  beforeEach(() => {
    localStorage.clear();
    convexMock.reset();
    convexMock.installFetch();
    vi.clearAllMocks();
  });

  describe('login()', () => {
    it('stores the token and the mapped user on success', async () => {
      convexMock.onRoute('/auth/login', () => ({
        success: true,
        token: 'tok-123',
        user: convexUser,
      }));

      const result = await authService.login('intern@test.com', 'pass');

      expect(result.success).toBe(true);
      expect(result.user?.full_name).toBe(mockInternUser.full_name);
      expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-123');
      expect(JSON.parse(localStorage.getItem(USER_KEY)!).full_name).toBe(mockInternUser.full_name);
    });

    it('leaves storage untouched on a rejected sign-in', async () => {
      convexMock.onRoute('/auth/login', () => ({
        success: false,
        error: 'Invalid email or password',
      }));

      const result = await authService.login('bad@test.com', 'wrong');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email or password');
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(USER_KEY)).toBeNull();
    });

    it('never persists a password hash, even if the server sent one', async () => {
      // `publicUser` keeps these off the wire; the adapter builds a literal
      // rather than spreading, so a field added later cannot ride along either.
      convexMock.onRoute('/auth/login', () => ({
        success: true,
        token: 'tok-123',
        user: { ...convexUser, passwordHash: '$2a$06$leaked', tempPassword: 'hunter2' },
      }));

      await authService.login('intern@test.com', 'pass');

      const stored = localStorage.getItem(USER_KEY)!;
      expect(stored).not.toContain('leaked');
      expect(stored).not.toContain('hunter2');
    });

    it('reports a transport failure as unavailable, not as a parse error', async () => {
      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502 }) as Response) as typeof fetch;

      const result = await authService.login('test@test.com', 'pass');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unavailable/i);
    });
  });

  describe('the versioned storage keys', () => {
    it('reads and writes only the v2 keys', () => {
      seedLocalStorage(mockInternUser, 'tok-abc');
      expect(authService.getToken()).toBe('tok-abc');
      expect(localStorage.getItem('orbit_auth_token')).toBeNull();
    });

    it('ignores a v1 session left by the Supabase build', () => {
      // The whole point of versioning: a Supabase token is one this deployment
      // has never heard of, so treating it as a session would leave the user
      // authenticated locally and rejected on every call.
      localStorage.setItem('orbit_auth_token', 'supabase-jwt');
      localStorage.setItem('orbit_user', JSON.stringify(mockInternUser));

      expect(authService.getToken()).toBeNull();
      expect(authService.isAuthenticated()).toBe(false);
    });
  });

  describe('logout()', () => {
    it('clears the session locally', () => {
      convexMock.onMutation('auth.logout', () => ({ success: true }));
      seedLocalStorage(mockInternUser, 'tok-abc');

      authService.logout();

      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(USER_KEY)).toBeNull();
    });

    it('also revokes it server-side', () => {
      // Clearing localStorage alone left the row alive for its full seven days,
      // so "log out" on a shared machine revoked nothing.
      const revoked = vi.fn(() => ({ success: true }));
      convexMock.onMutation('auth.logout', revoked);
      seedLocalStorage(mockInternUser, 'tok-abc');

      authService.logout();

      expect(revoked).toHaveBeenCalled();
    });
  });

  describe('getCurrentUser()', () => {
    it('returns null when nothing is stored', () => {
      expect(authService.getCurrentUser()).toBeNull();
    });

    it('returns null rather than throwing when the stored JSON is corrupt', () => {
      localStorage.setItem(USER_KEY, '{not json');
      expect(authService.getCurrentUser()).toBeNull();
    });
  });

  describe('isAuthenticated()', () => {
    it('is false with nothing stored', () => {
      expect(authService.isAuthenticated()).toBe(false);
    });

    it('is true with a token and a user', () => {
      seedLocalStorage(mockInternUser, 'tok-abc');
      expect(authService.isAuthenticated()).toBe(true);
    });

    it('does NOT consult a client-side expiry', () => {
      // Deliberate: it used to read `user.jwt_expires_at`, a Postgres column
      // that no longer exists, so the check would silently never fire. Expiry
      // belongs to the server; `refreshUser` is what notices a dead session.
      seedLocalStorage(
        { ...mockInternUser, jwt_expires_at: new Date(Date.now() - 86_400_000).toISOString() },
        'tok-abc',
      );
      expect(authService.isAuthenticated()).toBe(true);
    });
  });

  describe('role checks', () => {
    it('isAdmin() is true for an admin', () => {
      seedLocalStorage(mockAdminUser, 'tok');
      expect(authService.isAdmin()).toBe(true);
    });

    it('isAdmin() is true for a super_admin holding that role ALONE', () => {
      // Production's super admin carries exactly this, and the client checked
      // only 'admin' — so the platform's most privileged user failed every admin
      // check and was hidden from their own controls.
      seedLocalStorage({ ...mockInternUser, roles: ['super_admin'] }, 'tok');
      expect(authService.isAdmin()).toBe(true);
    });

    it('isAdmin() is false for an intern', () => {
      seedLocalStorage(mockInternUser, 'tok');
      expect(authService.isAdmin()).toBe(false);
    });

    it('isMember() is true for an intern', () => {
      seedLocalStorage(mockInternUser, 'tok');
      expect(authService.isMember()).toBe(true);
    });

    it('is false when nothing is stored', () => {
      expect(authService.isStreamLead()).toBe(false);
    });
  });

  describe('refreshUser()', () => {
    it('updates the cached user', async () => {
      seedLocalStorage(mockInternUser, 'tok-abc');
      convexMock.onQuery('auth.me', () => ({ ...convexUser, fullName: 'Renamed' }));

      const refreshed = await authService.refreshUser();

      expect(refreshed?.full_name).toBe('Renamed');
      expect(JSON.parse(localStorage.getItem(USER_KEY)!).full_name).toBe('Renamed');
    });

    it('signs the user out when the server rejects the session', async () => {
      // This is the compensating path for having no client-side expiry.
      seedLocalStorage(mockInternUser, 'tok-abc');
      convexMock.onQuery('auth.me', () => null);
      convexMock.onMutation('auth.logout', () => ({ success: true }));

      expect(await authService.refreshUser()).toBeNull();
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    it('does NOT sign the user out on a network failure', async () => {
      // Otherwise a PWA logs everyone out the moment they lose signal.
      seedLocalStorage(mockInternUser, 'tok-abc');
      convexMock.onQuery('auth.me', () => {
        throw new Error('Network error');
      });

      expect(await authService.refreshUser()).not.toBeNull();
      expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-abc');
    });

    it('returns null without a token', async () => {
      expect(await authService.refreshUser()).toBeNull();
    });
  });
});
