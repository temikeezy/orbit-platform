import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { authService } from '../../lib/auth';

/**
 * Sign-in goes through an httpAction, not a mutation.
 *
 * Rate limiting is the reason. The limiter keys on the caller's IP, and a
 * mutation cannot see one — `orbit_login`'s Convex replacement took `ipAddress`
 * as an ARGUMENT, which the browser never sent, so every login hit the
 * limiter's free-pass branch and the throttle never ran at all. An httpAction
 * reads the address off the request, where the caller cannot choose it.
 *
 * So this mocks the ROUTE, and asserts the keys the session lands under: v2,
 * with the v1 keys left empty. A Supabase token under the old key would make
 * `isAuthenticated()` true while every Convex call is rejected — signed in
 * according to the UI, unauthenticated according to the server.
 */

const convexUser = {
  id: 'user-intern-1',
  email: 'intern@test.com',
  fullName: 'Ada Intern',
  profileSlug: 'ada-intern',
  roles: ['intern'],
  totalPoints: 40,
  currentLevel: 2,
  isActive: true,
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  convexMock.installFetch();
  vi.clearAllMocks();
});

describe('Auth persistence', () => {
  it('login writes the session under the v2 keys', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: true,
      token: 'sess-token',
      user: convexUser,
    }));

    await authService.login('intern@test.com', 'pass');

    expect(localStorage.getItem('orbit_auth_token_v2')).toBe('sess-token');
    expect(JSON.parse(localStorage.getItem('orbit_user_v2')!)).toMatchObject({
      id: 'user-intern-1',
    });
  });

  it('leaves the v1 keys empty', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: true,
      token: 'sess-token',
      user: convexUser,
    }));

    await authService.login('intern@test.com', 'pass');

    expect(localStorage.getItem('orbit_auth_token')).toBeNull();
    expect(localStorage.getItem('orbit_user')).toBeNull();
  });

  it('stores no password hash or jwt column alongside the user', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: true,
      token: 'sess-token',
      // Even if the server sent one, `toOrbitUser` names every field it copies.
      user: { ...convexUser, passwordHash: '$2b$10$leaked', jwtToken: 'leaked' },
    }));

    await authService.login('intern@test.com', 'pass');

    const raw = localStorage.getItem('orbit_user_v2')!;
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('leaked');
  });

  it('isAuthenticated() and getCurrentUser() reflect the stored session', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: true,
      token: 'sess-token',
      user: convexUser,
    }));

    await authService.login('intern@test.com', 'pass');

    expect(authService.isAuthenticated()).toBe(true);
    expect(authService.getCurrentUser()).toMatchObject({ id: 'user-intern-1' });
  });

  it('a failed login stores nothing', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: false,
      error: 'Invalid email or password',
    }));

    const result = await authService.login('intern@test.com', 'wrong');

    expect(result.success).toBe(false);
    expect(localStorage.getItem('orbit_auth_token_v2')).toBeNull();
    expect(authService.isAuthenticated()).toBe(false);
  });

  it('logout clears both keys', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: true,
      token: 'sess-token',
      user: convexUser,
    }));
    convexMock.onMutation('auth.logout', () => ({ success: true }));

    await authService.login('intern@test.com', 'pass');
    await authService.logout();

    expect(authService.isAuthenticated()).toBe(false);
    expect(authService.getCurrentUser()).toBeNull();
    expect(localStorage.getItem('orbit_auth_token_v2')).toBeNull();
    expect(localStorage.getItem('orbit_user_v2')).toBeNull();
  });
});
