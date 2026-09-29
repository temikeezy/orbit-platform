import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { usersApi } from '../../lib/api/users';
import { tasksApi } from '../../lib/api/tasks';
import { authService } from '../../lib/auth';
import { mockInternUser, mockAdminUser, mockModeratorUser, seedLocalStorage } from '../fixtures';

/**
 * Where authorization actually happens.
 *
 * These tests used to say "RPC decides final access" and then assert that the
 * client did not throw — which is true and says nothing, because the client
 * never decided anything either way. That framing is worth keeping honest: the
 * only thing a client-side check can do is decide what to RENDER. The refusals
 * that matter are asserted against a real deployment in
 * `convex-client-swap.test.ts`, where an intern really is refused.
 *
 * What is left here is the boundary this file can see: a missing session fails
 * before any call is made, a present one is sent verbatim, and the role helpers
 * that gate the UI agree with the roles on the stored user.
 */

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('Role-based access', () => {
  describe('without a session', () => {
    it('createUser fails before reaching the network', async () => {
      // No mock registered — the mock throws on any unregistered call, so if
      // this ever starts issuing a request the failure names the call.
      await expect(
        usersApi.createUser({
          full_name: 'X',
          email: 'x@t.com',
          password: 'p',
          roles: ['intern'],
        }),
      ).rejects.toThrow('Not authenticated');
    });

    it('acceptTask fails before reaching the network', async () => {
      await expect(tasksApi.acceptTask('task-1')).rejects.toThrow('Not authenticated');
    });

    it('reviewSubmission fails before reaching the network', async () => {
      await expect(
        tasksApi.reviewSubmission('sub-1', { status: 'rejected' }),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('with a session', () => {
    it('sends the stored token rather than a role or a user id', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('users.adminCreateUser', (args) => {
        received = args;
        return { success: true, id: 'user-9', tempPassword: 'tmp' };
      });
      convexMock.onQuery('users.adminGetById', () => ({
        id: 'user-9',
        email: 'new@t.com',
        fullName: 'New User',
        roles: ['intern'],
        totalPoints: 0,
        currentLevel: 1,
        isActive: true,
        createdAt: 1_700_000_000_000,
      }));

      await usersApi.createUser({
        full_name: 'New User',
        email: 'new@t.com',
        roles: ['intern'],
      });

      // The token is the ONLY thing the server trusts. The old RPCs took a
      // p_token AND the caller's own id, so the two could disagree.
      expect(received.token).toBe('admin-tok');
      expect(received).not.toHaveProperty('callerId');
      expect(received).not.toHaveProperty('roles_of_caller');
    });

    it('an intern accepting a task sends only the task id', async () => {
      seedLocalStorage(mockInternUser, 'intern-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.acceptTask', (args) => {
        received = args;
        return { success: true };
      });

      await tasksApi.acceptTask('task-1');

      expect(received.token).toBe('intern-tok');
      expect(received.taskId).toBe('task-1');
      expect(received).not.toHaveProperty('userId');
    });

    it('reviewSubmission does not carry a reviewer id the caller chose', async () => {
      seedLocalStorage(mockModeratorUser, 'mod-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.reviewSubmission', (args) => {
        received = args;
        return { success: true };
      });
      convexMock.onQuery('tasks.mySubmissions', () => []);
      convexMock.onQuery('tasks.listSubmissions', () => [
        {
          id: 'sub-1',
          taskId: 'task-1',
          userId: 'user-intern-1',
          status: 'rejected',
          createdAt: 1_700_000_000_000,
        },
      ]);

      // The signature still ACCEPTS a reviewedBy, because ~6 call sites pass
      // one. It is ignored: reviewed_by comes off the session, so a moderator
      // cannot record a review as somebody else.
      await tasksApi.reviewSubmission('sub-1', { status: 'rejected' }, mockModeratorUser.id);

      expect(received.token).toBe('mod-tok');
      expect(received).not.toHaveProperty('reviewedBy');
    });
  });

  describe('the role helpers that gate the UI', () => {
    it('canReviewSubmissions is true for a moderator and false for an intern', () => {
      seedLocalStorage(mockModeratorUser, 'mod-tok');
      expect(authService.canReviewSubmissions()).toBe(true);

      localStorage.clear();
      seedLocalStorage(mockInternUser, 'intern-tok');
      expect(authService.canReviewSubmissions()).toBe(false);
    });

    it('isAdmin counts super_admin, not just admin', () => {
      seedLocalStorage({ ...mockAdminUser, roles: ['super_admin'] }, 'tok');
      // A super_admin whose roles array does not literally contain 'admin' was
      // being denied the admin UI by a plain includes('admin') check.
      expect(authService.isAdmin()).toBe(true);
    });

    it('reports no permissions at all with no session', () => {
      expect(authService.canReviewSubmissions()).toBe(false);
      expect(authService.isAdmin()).toBe(false);
    });
  });
});
