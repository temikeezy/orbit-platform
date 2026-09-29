import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { logbookApi } from '../../lib/api/logbook';
import { attendanceApi } from '../../lib/api/attendance';
import { siwesReviewApi } from '../../lib/api/siwesReview';
import { mockInternUser, mockModeratorUser, seedLocalStorage } from '../fixtures';

/**
 * The logbook lifecycle: draft → submit → review → weekly summary → sign-off,
 * plus attendance check-in and out.
 *
 * The interesting change is that three of these steps used to be ONE function
 * distinguished by a string the client chose. Saving a log took a `status`, so
 * 'approved' was a value an intern could write into their own log; reviewing
 * took an `action` the SQL branched on; recording attendance took a `status`,
 * so an intern could write 'verified' into their own record. Each is now the
 * boolean or the separate mutation the authorization actually requires, and
 * that translation happens in `callSiwesRpc` — which is what these assert.
 */

const convexLog = (over: Record<string, unknown> = {}) => ({
  id: 'log-1',
  logDate: '2026-07-22',
  participationMode: 'remote',
  title: 'Front-end work',
  workDone: 'Built the cohort table',
  status: 'draft',
  ...over,
});

const convexSummary = (over: Record<string, unknown> = {}) => ({
  id: 'week-1',
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  goals: 'Ship the reports tab',
  summary: 'Completed reports and CSV export',
  keyLearnings: 'CSV quoting rules',
  dailyLogIds: ['log-1', 'log-2', 'log-3'],
  status: 'submitted',
  ...over,
});

const convexAttendance = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  attendanceDate: new Date().toISOString().slice(0, 10),
  expectedMode: 'physical',
  status: 'present',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('Daily log submission flow', () => {
  it('saves a draft, then submits the same log', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');

    const sent: Record<string, unknown>[] = [];
    let stored = convexLog();

    convexMock.onMutation('logbook.saveDailyLog', (args) => {
      sent.push(args);
      stored = convexLog({ status: args.submit ? 'submitted' : 'draft' });
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => [stored]);

    const draft = await logbookApi.saveDailyLog({
      user_id: 'p1',
      log_date: '2026-07-22',
      title: 'Front-end work',
      work_done: 'Built the cohort table',
      status: 'draft',
    });
    expect(draft.status).toBe('draft');

    const submitted = await logbookApi.saveDailyLog({
      id: 'log-1',
      log_date: '2026-07-22',
      title: 'Front-end work',
      work_done: 'Built the cohort table',
      status: 'submitted',
    });
    expect(submitted.status).toBe('submitted');

    // A boolean the server acts on, not a status column the client writes.
    expect(sent[0].submit).toBe(false);
    expect(sent[1].submit).toBe(true);
    expect(sent[1].logId).toBe('log-1');
    sent.forEach((call) => expect(call).not.toHaveProperty('status'));
  });

  it('surfaces the lock error when editing a submitted log', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');
    convexMock.onMutation('logbook.saveDailyLog', () => ({
      success: false,
      error: 'Submitted or approved logs are locked. Ask your supervisor to reopen this log.',
    }));

    await expect(
      logbookApi.saveDailyLog({ id: 'log-1', log_date: '2026-07-22', work_done: 'sneaky edit' }),
    ).rejects.toThrow(/locked/i);
  });

  it('surfaces the duplicate-date error', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');
    convexMock.onMutation('logbook.saveDailyLog', () => ({
      success: false,
      error: 'A log already exists for that date',
    }));

    await expect(
      logbookApi.saveDailyLog({
        user_id: 'p1',
        log_date: '2026-07-22',
        status: 'draft',
      }),
    ).rejects.toThrow('A log already exists for that date');
  });
});

describe('Daily log review flow', () => {
  it('an approval becomes status: approved', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.reviewDailyLog', (args) => {
      received = args;
      return { success: true };
    });

    const reviewed = await siwesReviewApi.reviewDailyLog('log-1', 'approve', 'Great detail');

    expect(received.logId).toBe('log-1');
    expect(received.status).toBe('approved');
    expect(received.supervisorComment).toBe('Great detail');
    expect(reviewed.status).toBe('approved');
  });

  it('a change request becomes status: changes_requested', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.reviewDailyLog', (args) => {
      received = args;
      return { success: true };
    });

    const reviewed = await siwesReviewApi.reviewDailyLog(
      'log-1',
      'request_changes',
      'Please add the tools you used',
    );

    expect(received.status).toBe('changes_requested');
    expect(reviewed.status).toBe('changes_requested');
  });

  it('a reopen becomes status: draft', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.reviewDailyLog', (args) => {
      received = args;
      return { success: true };
    });

    await siwesReviewApi.reviewDailyLog('log-1', 'reopen');
    expect(received.status).toBe('draft');
  });
});

describe('Weekly summary flow', () => {
  it('submits a weekly summary linked to daily logs', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.saveWeeklySummary', (args) => {
      received = args;
      return { success: true, id: 'week-1' };
    });
    convexMock.onQuery('logbook.listWeeklySummaries', () => [convexSummary()]);

    const saved = await logbookApi.saveWeeklySummary({
      user_id: 'p1',
      week_start: '2026-07-20',
      week_end: '2026-07-26',
      goals: 'Ship the reports tab',
      summary: 'Completed reports and CSV export',
      key_learnings: 'CSV quoting rules',
      daily_log_ids: ['log-1', 'log-2', 'log-3'],
      status: 'submitted',
    });

    expect(received.weekStart).toBe('2026-07-20');
    expect(received.dailyLogIds).toHaveLength(3);
    expect(received.submit).toBe(true);
    expect(received).not.toHaveProperty('status');

    expect(saved.week_start).toBe('2026-07-20');
    expect(saved.daily_log_ids).toHaveLength(3);
  });

  it('a sign-off becomes approve: true', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.signOffWeeklySummary', (args) => {
      received = args;
      return { success: true };
    });

    await siwesReviewApi.reviewWeeklySummary('week-1', 'sign_off', 'Well done');

    expect(received.summaryId).toBe('week-1');
    expect(received.approve).toBe(true);
    expect(received.supervisorComment).toBe('Well done');
  });

  it('a change request becomes approve: false', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.signOffWeeklySummary', (args) => {
      received = args;
      return { success: true };
    });

    await siwesReviewApi.reviewWeeklySummary('week-1', 'request_changes');
    expect(received.approve).toBe(false);
  });

  it('sign-off of an unsubmitted summary surfaces the server error', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');
    convexMock.onMutation('logbook.signOffWeeklySummary', () => ({
      success: false,
      error: 'Only submitted summaries can be signed off',
    }));

    await expect(siwesReviewApi.reviewWeeklySummary('week-1', 'sign_off')).rejects.toThrow(
      'Only submitted summaries can be signed off',
    );
  });
});

describe('Attendance flow', () => {
  it('intern checks in and out on the same day', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');

    const sent: Record<string, unknown>[] = [];
    convexMock.onMutation('logbook.recordAttendance', (args) => {
      sent.push(args);
      return { success: true, id: 'a1' };
    });
    convexMock.onQuery('logbook.listAttendance', () => [convexAttendance()]);

    await attendanceApi.checkInToday('p1', 'dept-1');
    await attendanceApi.checkOutToday('p1', 'Worked with the media team');

    expect(sent).toHaveLength(2);
    expect(sent[0].checkIn).toBe(true);
    expect(sent[1].checkOut).toBe(true);
    expect(sent[1].activitySummary).toBe('Worked with the media team');
  });

  it('a supervisor excusing an absence goes to the VERIFY mutation', async () => {
    seedLocalStorage(mockModeratorUser, 'mod-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('logbook.verifyAttendance', (args) => {
      received = args;
      return { success: true, id: 'a2' };
    });
    convexMock.onQuery('logbook.listAttendance', () => [
      convexAttendance({ id: 'a2', attendanceDate: '2026-07-17', status: 'excused' }),
    ]);
    // recordAttendance is deliberately unregistered: reaching it would mean a
    // supervisor's verification went down the intern's own check-in path, which
    // is exactly what the single RPC taking a status column allowed.

    const record = await attendanceApi.recordAttendance({
      user_id: 'p1',
      attendance_date: '2026-07-17',
      status: 'excused',
    });

    expect(received.internUserId).toBe('p1');
    expect(received.attendanceDate).toBe('2026-07-17');
    expect(received.status).toBe('excused');
    expect(record.status).toBe('excused');
  });
});
