import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { usersApi } from '../../lib/api/users';
import { mockAdminUser, seedLocalStorage } from '../fixtures';

/**
 * What survived the port, and what did not.
 *
 * `searchUsers` used to build a PostgREST `or=` filter out of raw user input,
 * so most of this file was about escaping commas and dots correctly — a whole
 * injection surface that exists only because the query language was a string
 * the browser assembled. There is no filter string now: the server returns the
 * directory it is willing to show and the match happens locally, so the escaping
 * tests are gone rather than rewritten. What is asserted instead is that the
 * matching is still right and still can't see more than the directory allows.
 *
 * `generateTempPassword` is gone too. It returned `Math.random().toString(36)`
 * — not a safe alphabet, not a safe source — and had no callers left: the server
 * generates the real temporary password and returns it from `adminCreateUser`.
 * Testing it would have been testing a decoy.
 */

function convexUser(over: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'ada@iih.ng',
    fullName: 'Ada Intern',
    profileSlug: 'ada',
    roles: ['intern'],
    totalPoints: 40,
    currentLevel: 2,
    isActive: true,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('usersApi', () => {
  describe('searchUsers()', () => {
    it('matches on name and on email, case-insensitively', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onQuery('users.list', () => [
        convexUser({ id: 'u1', fullName: 'Ada Intern', email: 'ada@iih.ng' }),
        convexUser({ id: 'u2', fullName: 'Bem Moderator', email: 'bem@iih.ng' }),
      ]);

      expect((await usersApi.searchUsers('ADA')).map((u) => u.id)).toEqual(['u1']);
      expect((await usersApi.searchUsers('bem@iih')).map((u) => u.id)).toEqual(['u2']);
    });

    it('returns nothing for a blank query without calling the server', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      // No mock registered: the mock throws on any unregistered call, so this
      // fails loudly if the module ever starts round-tripping an empty search.
      expect(await usersApi.searchUsers('   ')).toEqual([]);
    });

    it('treats PostgREST metacharacters as ordinary text', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onQuery('users.list', () => [
        convexUser({ id: 'u1', fullName: 'Ada Intern' }),
        convexUser({ id: 'u2', fullName: 'test,injection.attack' }),
      ]);

      // The old implementation interpolated this into an `or=` filter, where a
      // comma is a clause separator. Here it is just a substring.
      const found = await usersApi.searchUsers('test,injection.attack');
      expect(found.map((u) => u.id)).toEqual(['u2']);
    });

    it('returns an empty array when the directory is empty', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onQuery('users.list', () => []);

      expect(await usersApi.searchUsers('nobody')).toEqual([]);
    });
  });

  describe('createUser()', () => {
    it('sends the fields the admin form collects', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('users.adminCreateUser', (args) => {
        received = args;
        return { success: true, id: 'user-9', tempPassword: 'server-generated' };
      });
      convexMock.onMutation('users.adminSetPassword', () => ({ success: true }));
      convexMock.onQuery('users.adminGetById', () => convexUser({ id: 'user-9' }));

      await usersApi.createUser({
        full_name: 'New Intern',
        email: 'new@test.com',
        password: 'chosen-by-the-admin',
        roles: ['intern'],
      });

      expect(received.token).toBe('admin-tok');
      expect(received.fullName).toBe('New Intern');
      expect(received.email).toBe('new@test.com');
      expect(received.roles).toEqual(['intern']);
    });

    it('returns the temporary password the SERVER generated', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      convexMock.onMutation('users.adminCreateUser', () => ({
        success: true,
        id: 'user-9',
        tempPassword: 'server-generated',
      }));
      convexMock.onQuery('users.adminGetById', () => convexUser({ id: 'user-9' }));

      // The browser used to invent this and send it as the password. It is now
      // produced server-side and only reported back — and only when the admin
      // did NOT choose one, since reporting a password the admin typed back to
      // them as "temporary" is how it ends up written down.
      const created = await usersApi.createUser({
        full_name: 'X',
        email: 'x@test.com',
        roles: ['intern'],
      });

      expect(created.temp_password).toBe('server-generated');
    });

    it('surfaces the server error message', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      convexMock.onMutation('users.adminCreateUser', () => ({
        success: false,
        error: 'Email already exists',
      }));

      await expect(
        usersApi.createUser({
          full_name: 'X',
          email: 'x@test.com',
          password: 'p',
          roles: ['intern'],
        }),
      ).rejects.toThrow('Email already exists');
    });
  });

  describe('deactivateUser()', () => {
    it('sends the session token and the target id', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('users.adminSetActive', (args) => {
        received = args;
        return { success: true };
      });

      await usersApi.deactivateUser('user-intern-1');

      expect(received.token).toBe('admin-tok');
      expect(received.userId).toBe('user-intern-1');
      // Deactivation, explicitly — the mutation also reactivates, and passing
      // the wrong flag here would silently restore an account.
      expect(received.isActive).toBe(false);
    });
  });

  describe('getUsersByStream()', () => {
    it('filters the directory by the caller-supplied stream', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onQuery('users.list', () => [
        convexUser({ id: 'u1', currentStreamId: 'stream-1' }),
        convexUser({ id: 'u2', currentStreamId: 'stream-2' }),
        convexUser({ id: 'u3' }),
      ]);

      const found = await usersApi.getUsersByStream('stream-1');
      expect(found.map((u) => u.id)).toEqual(['u1']);
    });

    it('getUsersWithoutStream finds the unassigned', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onQuery('users.list', () => [
        convexUser({ id: 'u1', currentStreamId: 'stream-1' }),
        convexUser({ id: 'u3' }),
      ]);

      const found = await usersApi.getUsersWithoutStream();
      expect(found.map((u) => u.id)).toEqual(['u3']);
    });
  });

  describe('adaptation', () => {
    it('maps camelCase epoch-ms into the snake_case ISO shape the pages read', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onQuery('users.adminGetById', () =>
        convexUser({ lastLoginAt: 1_700_000_000_000 }),
      );

      const user = (await usersApi.getUserDetail('user-1'))!;

      expect(user.full_name).toBe('Ada Intern');
      expect(user.total_points).toBe(40);
      expect(user.current_level).toBe(2);
      expect(user.is_active).toBe(true);
      expect(user.created_at).toBe(new Date(1_700_000_000_000).toISOString());
      expect(user.last_login_at).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('does not invent a timestamp the directory does not carry', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      // `directoryShape` deliberately omits createdAt and lastLoginAt — the
      // list is rendered as a table of names and points, and a login time is
      // not something every member needs about every other member.
      convexMock.onQuery('users.list', () => [convexUser({ createdAt: undefined })]);

      const [user] = await usersApi.getActiveUsers();
      expect(user.last_login_at).toBeUndefined();
    });

    it('never materialises a password hash or a jwt column', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      // Even if the server somehow sent one, the adapter names every field it
      // copies — `select *` on orbit_users is what served hashes to anyone
      // holding the anon key.
      convexMock.onQuery('users.list', () => [
        convexUser({ passwordHash: '$2b$10$leaked', jwtToken: 'leaked' }),
      ]);

      const [user] = await usersApi.getActiveUsers();

      expect(user.password_hash).toBeUndefined();
      expect(user.jwt_token).toBeUndefined();
    });
  });
});
