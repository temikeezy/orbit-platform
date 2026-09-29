import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { cohortsApi } from '../../lib/api/cohorts';
import { departmentsApi } from '../../lib/api/departments';
import { internProfilesApi } from '../../lib/api/internProfiles';
import { logbookApi } from '../../lib/api/logbook';
import { attendanceApi } from '../../lib/api/attendance';
import { todayLocalISO } from '../../lib/utils/date';
import { mockInternUser, mockAdminUser, seedLocalStorage } from '../fixtures';

/**
 * `callSiwesRpc` is now a DISPATCHER, and that is what this file tests.
 *
 * Seven client modules — logbook, attendance, siwesReview, applications,
 * internProfiles, cohorts, departments — reach the backend by naming a Postgres
 * RPC and passing `p_*` parameters. Rewriting that one seam moved the entire
 * SIWES surface to Convex without touching any of them, which means the mapping
 * inside it is the whole risk: an RPC pointed at the wrong function, or a
 * composite `p_log` object destructured into the wrong argument names, would
 * fail at runtime in a subsystem with a lot of surface and few users.
 *
 * The old file asserted `rpc` was called with `('orbit_siwes_x', {p_token})`.
 * The equivalent question now is which Convex function received which arguments,
 * so that is what is asserted — plus the three things the dispatcher does that
 * the SQL functions did differently, which is where behaviour actually changed:
 *
 *  - a composite object becomes explicit named arguments;
 *  - `status: 'submitted'` becomes a `submit` BOOLEAN, so 'approved' is not a
 *    value an intern can put in their own log;
 *  - a reviewer `action` string becomes the resulting status.
 */

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('callSiwesRpc — the dispatcher', () => {
  it('throws before reaching the network with no session', async () => {
    // No mock registered: the mock throws on any unregistered call, so this
    // fails loudly if a request is ever issued unauthenticated.
    await expect(cohortsApi.getCohorts()).rejects.toThrow('Not authenticated');
  });

  it('sends the stored token', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');

    let received: Record<string, unknown> = {};
    convexMock.onQuery('siwes.listCohorts', (args) => {
      received = args;
      return [];
    });

    await cohortsApi.getCohorts();
    expect(received.token).toBe('admin-tok');
  });

  it('surfaces a server refusal', async () => {
    seedLocalStorage(mockInternUser, 'tok');
    convexMock.onMutation('siwes.saveCohort', () => {
      throw new Error('Admin access required');
    });

    await expect(
      cohortsApi.saveCohort({
        name: 'X',
        start_date: '2026-08-01',
        end_date: '2026-12-18',
      }),
    ).rejects.toThrow('Admin access required');
  });

  it('refuses an unmapped RPC name loudly', async () => {
    seedLocalStorage(mockInternUser, 'tok');
    const { callSiwesRpc } = await import('../../lib/api/siwesRpc');

    // A silent fall-through here would render as an empty logbook rather than
    // an error.
    await expect(callSiwesRpc('orbit_siwes_invented')).rejects.toThrow(/No Convex mapping/);
  });
});

describe('cohortsApi', () => {
  it('flattens the p_cohort object into named arguments', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('siwes.saveCohort', (args) => {
      received = args;
      return { success: true, id: 'c1' };
    });
    convexMock.onQuery('siwes.listCohorts', () => [
      {
        id: 'c1',
        name: 'ORBIT 2.0 SIWES 2026',
        startDate: '2026-08-01',
        endDate: '2026-12-18',
        status: 'planned',
        defaultParticipationMode: 'hybrid',
        defaultPhysicalDay: 5,
      },
    ]);

    const saved = await cohortsApi.saveCohort({
      name: 'ORBIT 2.0 SIWES 2026',
      start_date: '2026-08-01',
      end_date: '2026-12-18',
      default_participation_mode: 'hybrid',
      default_physical_day: 5,
    });

    // Named arguments, not one JSON blob the server destructures.
    expect(received.name).toBe('ORBIT 2.0 SIWES 2026');
    expect(received.startDate).toBe('2026-08-01');
    expect(received.defaultPhysicalDay).toBe(5);
    expect(received).not.toHaveProperty('p_cohort');

    // And the result comes back in the snake_case shape the page renders.
    expect(saved.default_physical_day).toBe(5);
    expect(saved.start_date).toBe('2026-08-01');
  });

  it('names the missing field rather than passing an empty one through', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');

    // The SQL COALESCEd a missing value into a default, silently. The Convex
    // mutation declares it required, so failing here names the field instead of
    // returning a validator error about an argument the caller never sent.
    await expect(
      cohortsApi.saveCohort({ start_date: '2026-08-01', end_date: '2026-12-18' }),
    ).rejects.toThrow(/Cohort name is required/);
  });
});

describe('departmentsApi', () => {
  it('maps departments into the snake_case shape, lead included', async () => {
    seedLocalStorage(mockInternUser, 'tok');
    convexMock.onQuery('siwes.listDepartments', () => [
      {
        id: 'd1',
        name: 'Technical/Product',
        isActive: true,
        lead: { id: 'u1', fullName: 'Bem Moderator' },
      },
    ]);

    const [department] = await departmentsApi.getDepartments();

    expect(department.name).toBe('Technical/Product');
    expect(department.is_active).toBe(true);
    expect(department.lead_user_id).toBe('u1');
    expect(department.lead_name).toBe('Bem Moderator');
  });
});

describe('internProfilesApi', () => {
  it('fetches the caller\'s own profile', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onQuery('siwes.myProfile', (args) => {
      received = args;
      return {
        id: 'p1',
        userId: mockInternUser.id,
        cohortId: 'c1',
        participationMode: 'remote',
        status: 'active',
      };
    });

    const profile = await internProfilesApi.getMyProfile();

    expect(profile?.id).toBe('p1');
    // No id argument at all — the session decides whose profile this is.
    expect(received).not.toHaveProperty('userId');
    expect(received).not.toHaveProperty('internUserId');
  });

  it('returns null when the user has no SIWES profile', async () => {
    seedLocalStorage(mockInternUser, 'tok');
    convexMock.onQuery('siwes.myProfile', () => null);

    await expect(internProfilesApi.getMyProfile()).resolves.toBeNull();
  });

  it('filters intern profiles by cohort', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');

    let received: Record<string, unknown> = {};
    convexMock.onQuery('siwes.listProfiles', (args) => {
      received = args;
      return [];
    });

    await internProfilesApi.getInternProfiles('cohort-1');
    expect(received.cohortId).toBe('cohort-1');
  });

  it('routes supervisor and status changes to the ASSIGN mutation', async () => {
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
      { id: 'p1', userId: 'u1', cohortId: 'c1', participationMode: 'remote', status: 'active' },
    ]);

    await internProfilesApi.saveInternProfile({
      id: 'p1',
      cohort_id: 'c1',
      institution_name: 'Unilag',
      iih_supervisor_id: 'sup-1',
      department_id: 'dept-1',
      status: 'active',
    });

    // The RPC took the intern's own institution details and their supervisor
    // assignment in the SAME object — so the one function a member may call to
    // edit their own profile also accepted the fields that assign their
    // supervisor and set their status.
    expect(saved.institutionName).toBe('Unilag');
    expect(saved).not.toHaveProperty('iihSupervisorId');
    expect(saved).not.toHaveProperty('status');

    expect(assigned.iihSupervisorId).toBe('sup-1');
    expect(assigned.departmentId).toBe('dept-1');
    expect(assigned.status).toBe('active');
  });

  it('does not call the assign mutation for a plain profile edit', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    convexMock.onMutation('siwes.saveProfile', () => ({ success: true, id: 'p1' }));
    convexMock.onQuery('siwes.listProfiles', () => [
      { id: 'p1', userId: 'u1', cohortId: 'c1', participationMode: 'remote', status: 'active' },
    ]);
    // assignProfile is deliberately NOT registered: the mock throws on an
    // unregistered call, so reaching it fails the test by name.

    await expect(
      internProfilesApi.saveInternProfile({
        id: 'p1',
        cohort_id: 'c1',
        institution_name: 'Unilag',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('logbookApi', () => {
  const convexLog = (over: Record<string, unknown> = {}) => ({
    id: 'log-1',
    logDate: '2026-07-22',
    participationMode: 'remote',
    title: 'API integration work',
    workDone: 'Wired the payments endpoint',
    hoursSpent: 6,
    evidenceLinks: ['https://github.com/example/pr/1'],
    status: 'draft',
    ...over,
  });

  it('turns a draft status into submit: false', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.saveDailyLog', (args) => {
      received = args;
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => [convexLog()]);

    await logbookApi.saveDailyLog({
      user_id: 'p1',
      log_date: '2026-07-22',
      title: 'API integration work',
      work_done: 'Wired the payments endpoint',
      hours_spent: 6,
      evidence_links: ['https://github.com/example/pr/1'],
      status: 'draft',
    });

    expect(received.logDate).toBe('2026-07-22');
    expect(received.workDone).toBe('Wired the payments endpoint');
    expect(received.evidenceLinks).toEqual(['https://github.com/example/pr/1']);
    // A boolean, not a status column. The RPC took the status, so 'approved'
    // was a value an intern could write into their own log.
    expect(received.submit).toBe(false);
    expect(received).not.toHaveProperty('status');
  });

  it('turns a submitted status into submit: true', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.saveDailyLog', (args) => {
      received = args;
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => [convexLog({ status: 'submitted' })]);

    await logbookApi.saveDailyLog({
      log_date: '2026-07-22',
      title: 'x',
      work_done: 'y',
      status: 'submitted',
    });

    expect(received.submit).toBe(true);
  });

  it('maps a log into the snake_case shape the page renders', async () => {
    seedLocalStorage(mockInternUser, 'tok');
    convexMock.onQuery('logbook.listDailyLogs', () => [
      convexLog({ status: 'approved', submittedAt: 1_700_000_000_000 }),
    ]);

    const [log] = await logbookApi.getDailyLogs();

    expect(log.log_date).toBe('2026-07-22');
    expect(log.work_done).toBe('Wired the payments endpoint');
    expect(log.hours_spent).toBe(6);
    expect(log.status).toBe('approved');
    expect(log.submitted_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('sends the date range to the SERVER rather than filtering after the fact', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onQuery('logbook.listDailyLogs', (args) => {
      received = args;
      return [convexLog({ id: 'b', logDate: '2026-07-22' })];
    });

    const logs = await logbookApi.getDailyLogs('p1', '2026-07-20', '2026-07-26');

    expect(received.internUserId).toBe('p1');
    // The window used to be applied client-side, AFTER the query had already
    // truncated to its newest N — so a range older than that window came back
    // empty however many logs existed, and an intern's own logbook appeared to
    // stop partway through the term.
    expect(received.from).toBe('2026-07-20');
    expect(received.to).toBe('2026-07-26');
    expect(logs.map((l) => l.id)).toEqual(['b']);
  });

  it('exports through the mutation that records the audit row', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.exportLogbook', (args) => {
      received = args;
      return { success: true, data: { profile: {}, dailyLogs: [] } };
    });

    await logbookApi.exportLogbook('p1', '2026-07-01', '2026-07-22', 'print');

    expect(received.internUserId).toBe('p1');
    expect(received.from).toBe('2026-07-01');
    expect(received.exportType).toBe('print');
  });
});

describe('siwesReviewApi', () => {
  it('turns a reviewer action into the resulting status', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');
    const { siwesReviewApi } = await import('../../lib/api/siwesReview');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.reviewDailyLog', (args) => {
      received = args;
      return { success: true };
    });

    await siwesReviewApi.reviewDailyLog('log-1', 'request_changes', 'Add the evidence links');

    // The SQL branched on an action string inside the function that also did
    // the write. The branch happens once, here.
    expect(received.status).toBe('changes_requested');
    expect(received.supervisorComment).toBe('Add the evidence links');
    expect(received).not.toHaveProperty('action');
  });

  it('maps every section of the review dashboard', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');
    const { siwesReviewApi } = await import('../../lib/api/siwesReview');

    convexMock.onQuery('logbook.reviewQueue', () => ({
      interns: [
        {
          id: 'p1',
          userId: 'u1',
          cohortId: 'c1',
          participationMode: 'physical',
          status: 'active',
          fullName: 'Ada Intern',
          email: 'ada@iih.ng',
          cohortName: 'SIWES 2026',
          departmentName: 'Technical/Product',
          approvedLogs: 4,
          pendingLogs: 1,
          signedOffWeeks: 2,
        },
      ],
      pendingDailyLogs: [
        {
          id: 'l1',
          userId: 'p1',
          logDate: '2026-07-22',
          title: 'Day one',
          participationMode: 'remote',
          submittedAt: 1_700_000_000_000,
          status: 'submitted',
          fullName: 'Ada Intern',
        },
      ],
      pendingWeeklySummaries: [
        {
          id: 's1',
          userId: 'p1',
          weekStart: '2026-07-20',
          weekEnd: '2026-07-26',
          submittedAt: 1_699_000_000_000,
          status: 'submitted',
          fullName: 'Ada Intern',
        },
      ],
      missingLogs: [{ userId: 'p1', fullName: 'Ada Intern', missingDays: 2 }],
      attendanceExceptions: [
        {
          id: 'a1',
          userId: 'p1',
          attendanceDate: '2026-07-21',
          status: 'absent',
          expectedMode: 'physical',
          fullName: 'Ada Intern',
        },
      ],
    }));

    const queue = await siwesReviewApi.getReviewQueue();

    // Three of these five sections did not exist on the Convex query at all
    // until the page was ported — it returned pending logs and summaries and
    // nothing else, so the dashboard's other three panels would have read
    // undefined.
    expect(queue.interns[0].full_name).toBe('Ada Intern');
    expect(queue.interns[0].approved_logs).toBe(4);
    expect(queue.pending_daily_logs[0].log_date).toBe('2026-07-22');
    expect(queue.pending_daily_logs[0].submitted_at).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
    expect(queue.pending_weekly_summaries[0].week_start).toBe('2026-07-20');
    expect(queue.missing_logs[0].missing_days).toBe(2);
    expect(queue.attendance_exceptions[0].status).toBe('absent');
  });
});

describe('attendanceApi', () => {
  const convexAttendance = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    attendanceDate: todayLocalISO(),
    expectedMode: 'physical',
    status: 'present',
    ...over,
  });

  it('checkInToday sends checkIn for today', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.recordAttendance', (args) => {
      received = args;
      return { success: true, id: 'a1' };
    });
    convexMock.onQuery('logbook.listAttendance', () => [convexAttendance()]);

    await attendanceApi.checkInToday('p1', 'dept-1');

    // The LOCAL calendar date. Asserting the UTC slice here pinned the bug it
    // produces: between 00:00 and 00:59 WAT that expression names yesterday,
    // so the check-in was filed under the previous day.
    expect(received.attendanceDate).toBe(todayLocalISO());
    expect(received.departmentId).toBe('dept-1');
    expect(received.checkIn).toBe(true);
    // No user_id: the record is written against the caller's own
    // profile, resolved from the session.
    expect(received).not.toHaveProperty('userId');
  });

  it('checkOutToday sends checkOut and the activity summary', async () => {
    seedLocalStorage(mockInternUser, 'tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.recordAttendance', (args) => {
      received = args;
      return { success: true, id: 'a1' };
    });
    convexMock.onQuery('logbook.listAttendance', () => [convexAttendance()]);

    await attendanceApi.checkOutToday('p1', 'Shadowed the front desk team');

    expect(received.checkOut).toBe(true);
    expect(received.activitySummary).toBe('Shadowed the front desk team');
  });

  it('routes a supervisor verification to the VERIFY mutation', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.verifyAttendance', (args) => {
      received = args;
      return { success: true, id: 'a1' };
    });
    convexMock.onQuery('logbook.listAttendance', () => [
      convexAttendance({ attendanceDate: '2026-07-22', status: 'verified' }),
    ]);
    // recordAttendance is deliberately NOT registered — reaching it would mean
    // a supervisor's verification was written down the intern's own check-in
    // path, which is what the single RPC did.

    // Routed by WHICH FIELDS the caller sends: a verification carries a status
    // and no check-in/out time. It used to route on an `id` that no caller has
    // — RecordAttendanceData has no such field — so every supervisor action
    // fell through to the intern's own check-in mutation.
    await attendanceApi.recordAttendance({
      user_id: 'p1',
      attendance_date: '2026-07-22',
      status: 'verified',
    });

    expect(received.internUserId).toBe('p1');
    expect(received.attendanceDate).toBe('2026-07-22');
    expect(received.status).toBe('verified');
    // Addressed by (profile, date), so the day an intern never checked in on —
    // which has no row to reference — can still be recorded.
    expect(received).not.toHaveProperty('attendanceId');
  });
});
