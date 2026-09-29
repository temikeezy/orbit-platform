import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { cohortsApi } from '../../lib/api/cohorts';
import { internProfilesApi } from '../../lib/api/internProfiles';
import { siwesReviewApi } from '../../lib/api/siwesReview';
import { logbookApi } from '../../lib/api/logbook';
import {
  mockInternUser,
  mockAdminUser,
  mockModeratorUser,
  seedLocalStorage,
} from '../fixtures';

/**
 * Role enforcement lives server-side — in the Convex functions now rather than
 * in SECURITY DEFINER SQL. What a client-side test can check is the CONTRACT:
 * that nothing is attempted without a session, that a refusal reaches the user
 * as its own message rather than a generic failure, and that the arguments
 * carrying an authorization decision go to the function that checks it.
 *
 * The real refusals are exercised against a live deployment in
 * `convex-client-swap.test.ts`, where an intern really is denied.
 */

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('SIWES role-based access', () => {
  describe('unauthenticated users', () => {
    it('cannot call any SIWES API without a session', async () => {
      // Nothing is registered on the mock, and it throws on any unregistered
      // call — so if one of these ever reaches the network, the failure names
      // the function it tried to call.
      await expect(logbookApi.getDailyLogs()).rejects.toThrow('Not authenticated');
      await expect(siwesReviewApi.getReviewQueue()).rejects.toThrow('Not authenticated');
      await expect(cohortsApi.getCohorts()).rejects.toThrow('Not authenticated');
    });
  });

  describe('intern access', () => {
    it('surfaces the refusal when an intern tries an admin-only cohort save', async () => {
      seedLocalStorage(mockInternUser, 'intern-tok');
      convexMock.onMutation('siwes.saveCohort', () => {
        throw new Error('Admin access required');
      });

      await expect(
        cohortsApi.saveCohort({ name: 'X', start_date: '2026-08-01', end_date: '2026-12-01' }),
      ).rejects.toThrow('Admin access required');
    });

    it('surfaces the refusal when an intern requests the review queue', async () => {
      seedLocalStorage(mockInternUser, 'intern-tok');
      convexMock.onQuery('logbook.reviewQueue', () => {
        throw new Error('Reviewer access required');
      });

      await expect(siwesReviewApi.getReviewQueue()).rejects.toThrow('Reviewer access required');
    });

    it("surfaces the refusal when reading another intern's logs", async () => {
      seedLocalStorage(mockInternUser, 'intern-tok');

      let received: Record<string, unknown> = {};
      convexMock.onQuery('logbook.listDailyLogs', (args) => {
        received = args;
        throw new Error('You do not have access to these logs');
      });

      await expect(logbookApi.getDailyLogs('someone-elses-profile')).rejects.toThrow(
        'You do not have access to these logs',
      );

      // The profile id IS sent — it has to be, a reviewer reads other people's
      // logs through the same call. The check is the server's, against the
      // session, which is the whole reason the id is safe to pass.
      expect(received.internUserId).toBe('someone-elses-profile');
    });

    it('cannot see supervisor notes', async () => {
      seedLocalStorage(mockInternUser, 'intern-tok');
      convexMock.onQuery('logbook.listSupervisorNotes', () => {
        throw new Error('Reviewer access required');
      });

      await expect(siwesReviewApi.getSupervisorNotes('p1')).rejects.toThrow(
        'Reviewer access required',
      );
    });
  });

  describe('supervisor (moderator) access', () => {
    it('requests the review queue with their token', async () => {
      seedLocalStorage(mockModeratorUser, 'mod-tok');

      let received: Record<string, unknown> = {};
      convexMock.onQuery('logbook.reviewQueue', (args) => {
        received = args;
        return {
          interns: [],
          pendingDailyLogs: [],
          pendingWeeklySummaries: [],
          missingLogs: [],
          attendanceExceptions: [],
        };
      });

      const queue = await siwesReviewApi.getReviewQueue();

      expect(received.token).toBe('mod-tok');
      expect(queue.pending_daily_logs).toEqual([]);
      expect(queue.pending_weekly_summaries).toEqual([]);
      expect(queue.interns).toEqual([]);
    });

    it('adds a private supervisor note against a named profile', async () => {
      seedLocalStorage(mockModeratorUser, 'mod-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('logbook.addSupervisorNote', (args) => {
        received = args;
        return { success: true, id: 'note-1' };
      });

      await siwesReviewApi.addSupervisorNote('p1', 'Struggling with Git');

      expect(received.token).toBe('mod-tok');
      expect(received.internUserId).toBe('p1');
      expect(received.note).toBe('Struggling with Git');
      // The author is the session, not a field. The RPC took the note and the
      // profile; who wrote it came from the token there too, but the shape here
      // makes it impossible to pass an author at all.
      expect(received).not.toHaveProperty('authorId');
    });

    it('surfaces the refusal when reviewing an unassigned intern', async () => {
      seedLocalStorage(mockModeratorUser, 'mod-tok');
      convexMock.onMutation('logbook.reviewDailyLog', () => {
        throw new Error('You are not a reviewer for this intern');
      });

      await expect(siwesReviewApi.reviewDailyLog('log-1', 'approve')).rejects.toThrow(
        'You are not a reviewer for this intern',
      );
    });
  });

  describe('admin access', () => {
    it('assigns an intern profile through two mutations, not one', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let saved: Record<string, unknown> = {};
      let assigned: Record<string, unknown> = {};

      convexMock.onMutation('siwes.saveProfile', (args) => {
        saved = args;
        return { success: true, id: 'p1' };
      });
      convexMock.onMutation('siwes.assignProfile', (args) => {
        assigned = args;
        return { success: true };
      });
      convexMock.onQuery('siwes.listProfiles', () => [
        {
          id: 'p1',
          userId: mockInternUser.id,
          cohortId: 'cohort-1',
          participationMode: 'physical',
          status: 'active',
        },
      ]);

      await internProfilesApi.saveInternProfile({
        user_id: mockInternUser.id,
        cohort_id: 'cohort-1',
        participation_mode: 'physical',
        department_id: 'dept-1',
        iih_supervisor_id: mockModeratorUser.id,
        status: 'active',
      });

      expect(saved.participationMode).toBe('physical');
      // The supervisor assignment is a SEPARATE authorization from an intern
      // editing their own institution details, so it is a separate mutation.
      // The RPC took both in one object.
      expect(assigned.iihSupervisorId).toBe(mockModeratorUser.id);
      expect(assigned.status).toBe('active');
    });

    it('runs cohort compliance reporting', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let received: Record<string, unknown> = {};
      convexMock.onQuery('siwes.cohortCompliance', (args) => {
        received = args;
        return {
          cohort: {
            id: 'cohort-1',
            name: 'SIWES 2026',
            status: 'active',
            startDate: '2026-08-01',
            endDate: '2026-12-18',
          },
          interns: [],
        };
      });

      const report = await internProfilesApi.getCohortCompliance('cohort-1');

      expect(received.cohortId).toBe('cohort-1');
      expect(report.cohort.name).toBe('SIWES 2026');
      expect(report.interns).toEqual([]);
    });

    it('no longer exposes reminder fan-out as an admin button', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      // orbit_siwes_send_reminders was admin-callable and exposed through
      // `siwesReviewApi.sendReminders()`, which meant reminders only went out
      // when a human remembered to press something — and there is no evidence
      // anything ever did. It is a cron now (scheduled.sendSiwesReminders), so
      // the dispatcher has no mapping for it and says so rather than silently
      // reporting success.
      await expect(siwesReviewApi.sendReminders()).rejects.toThrow(/No Convex mapping/);
    });
  });
});
