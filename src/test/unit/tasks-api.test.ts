import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { tasksApi } from '../../lib/api/tasks';
import { mockInternUser, mockAdminUser, seedLocalStorage } from '../fixtures';

/**
 * The scoring rules moved to the server, so the tests moved with them.
 *
 * Most of this file used to assert that the BROWSER wrote a points-ledger row
 * after approving a submission, and skipped it for a rejection. That sequence —
 * update the submission, insert the ledger row, then RPC the user's total — was
 * three unrelated writes from a client that could stop between any two of them,
 * leaving a scored submission with no ledger entry or a ledger entry with no
 * points. `tasks.reviewSubmission` does all three in one transaction.
 *
 * A unit test cannot assert a transaction. The ledger behaviour is verified
 * against a real deployment in `convex-client-swap.test.ts`, including the
 * cases the old code got wrong: `score: 0` is a real score rather than a falsy
 * value that silently skipped the ledger, and re-scoring pays the difference.
 * What remains here is the part that is still the client's job — the arguments
 * it sends and the shapes it produces.
 */

function convexTask(over: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    streamId: 'stream-1',
    title: 'Write the thing',
    description: 'and then ship it',
    submissionType: 'text',
    points: 25,
    deadline: 1_700_600_000_000,
    isActive: true,
    createdAt: 1_700_000_000_000,
    streamName: 'Web Development',
    streamEmoji: '💻',
    createdByName: 'Bem Moderator',
    isMemberOfStream: true,
    mySubmission: null,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('tasksApi', () => {
  describe('getTaskProgrammeState()', () => {
    it('queries the programme clock at the supplied instant', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      const now = Date.parse('2026-08-12T10:00:00.000Z');
      let received: Record<string, unknown> = {};
      convexMock.onQuery('tasks.programmeState', (args) => {
        received = args;
        return {
          allowed: true,
          cohortName: 'Cohort 2',
          startDate: '2026-08-10',
          defaultDeadline: Date.parse('2026-08-13T22:59:59.999Z'),
        };
      });

      const result = await (tasksApi as unknown as {
        getTaskProgrammeState: (instant: number) => Promise<{ defaultDeadline: number }>;
      }).getTaskProgrammeState(now);

      expect(received).toEqual({ token: 'admin-tok', now });
      expect(result.defaultDeadline).toBe(Date.parse('2026-08-13T22:59:59.999Z'));
    });
  });

  describe('task deadline WAT conversion', () => {
    it('renders an epoch deadline in WAT without using the browser timezone', async () => {
      const module = await import('../../lib/api/tasks');
      const format = (module as unknown as { taskDeadlineToWatInput: (ms: number) => string })
        .taskDeadlineToWatInput;

      expect(format(Date.parse('2026-08-13T22:59:59.999Z'))).toBe('2026-08-13T23:59');
    });

    it('parses a datetime-local value as WAT without using the browser timezone', async () => {
      const module = await import('../../lib/api/tasks');
      const parse = (module as unknown as { taskDeadlineFromWatInput: (value: string) => number })
        .taskDeadlineFromWatInput;

      expect(parse('2026-08-13T23:59')).toBe(Date.parse('2026-08-13T22:59:00.000Z'));
    });

    it.each([
      '2026-02-30T10:00',
      '2025-02-29T10:00',
      '2026-08-19T24:00',
      '2026-08-19T23:60',
    ])('rejects impossible WAT datetime %s instead of allowing Date.parse to normalize it', async (value) => {
      const module = await import('../../lib/api/tasks');
      const parse = (module as unknown as { taskDeadlineFromWatInput: (input: string) => number })
        .taskDeadlineFromWatInput;

      expect(() => parse(value)).toThrow('Please set a valid deadline');
    });

    it.each([
      ['2024-02-29T00:00', '2024-02-28T23:00:00.000Z'],
      ['2026-12-31T23:59', '2026-12-31T22:59:00.000Z'],
    ])('accepts valid WAT datetime boundary %s', async (value, expected) => {
      const module = await import('../../lib/api/tasks');
      const parse = (module as unknown as { taskDeadlineFromWatInput: (input: string) => number })
        .taskDeadlineFromWatInput;

      expect(parse(value)).toBe(Date.parse(expected));
    });
  });

  describe('createTask()', () => {
    it('omits an untouched deadline so the server recomputes it at mutation time', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.create', (args) => {
        received = args;
        return { success: true, id: 'task-1', deadline: 1_700_600_000_000 };
      });
      convexMock.onQuery('tasks.getById', () => convexTask());

      await tasksApi.createTask({
        stream_id: 'stream-1',
        title: 'Weekly task',
        description: 'Do the work',
        submission_type: 'text',
        points: 10,
      } as Parameters<typeof tasksApi.createTask>[0]);

      expect(received).not.toHaveProperty('deadline');
    });

    it('sends an edited datetime-local deadline as a WAT instant', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.create', (args) => {
        received = args;
        return { success: true, id: 'task-1', deadline: 1_700_600_000_000 };
      });
      convexMock.onQuery('tasks.getById', () => convexTask());

      await tasksApi.createTask({
        stream_id: 'stream-1',
        title: 'Weekly task',
        description: 'Do the work',
        submission_type: 'text',
        points: 10,
        deadline: '2026-08-13T23:59',
      });

      expect(received.deadline).toBe(Date.parse('2026-08-13T22:59:00.000Z'));
    });
  });

  describe('updateTask()', () => {
    it('throws the exact server refusal instead of reading back an unchanged task', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      convexMock.onMutation('tasks.update', () => ({
        success: false,
        error: 'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
      }));

      await expect(tasksApi.updateTask('task-1', { is_active: true })).rejects.toThrow(
        'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
      );
    });
  });

  describe('acceptTask()', () => {
    it('sends the session token and the task id', async () => {
      seedLocalStorage(mockInternUser, 'tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.acceptTask', (args) => {
        received = args;
        return { success: true };
      });

      await tasksApi.acceptTask('task-1');

      expect(received.token).toBe('tok');
      expect(received.taskId).toBe('task-1');
      // No user_id. The browser used to name the user it was accepting FOR,
      // which is a field an attacker gets to choose; the session decides now.
      expect(received).not.toHaveProperty('userId');
    });

    it('throws when there is no session', async () => {
      await expect(tasksApi.acceptTask('task-1')).rejects.toThrow('Not authenticated');
    });
  });

  describe('submitTask()', () => {
    it('sends the url and the text as separate fields', async () => {
      seedLocalStorage(mockInternUser, 'tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.submitWork', (args) => {
        received = args;
        return { success: true };
      });

      await tasksApi.submitTask('task-1', { url: 'https://example.com', text: 'my notes' });

      expect(received.taskId).toBe('task-1');
      expect(received.submissionFileUrl).toBe('https://example.com');
      expect(received.submissionText).toBe('my notes');
      // Not status: 'submitted'. The browser used to set the status column
      // itself, so it could write any value the enum allowed — including
      // 'approved'.
      expect(received).not.toHaveProperty('status');
    });

    it('surfaces the server error rather than reporting success', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onMutation('tasks.submitWork', () => ({
        success: false,
        error: 'The deadline for this task has passed.',
      }));

      await expect(tasksApi.submitTask('task-1', { url: 'https://example.com' })).rejects.toThrow(
        'The deadline for this task has passed.',
      );
    });
  });

  describe('getUserTasksWithStatus()', () => {
    it('throws when there is no session', async () => {
      await expect(tasksApi.getUserTasksWithStatus()).rejects.toThrow('Not authenticated');
    });

    it('maps a task into the snake_case shape the pages render', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('tasks.listForUser', () => [convexTask()]);

      const [task] = await tasksApi.getUserTasksWithStatus();

      expect(task.id).toBe('task-1');
      expect(task.stream_id).toBe('stream-1');
      expect(task.stream_name).toBe('Web Development');
      expect(task.points).toBe(25);
      // Epoch ms in, ISO out.
      expect(task.deadline).toBe(new Date(1_700_600_000_000).toISOString());
      expect(task.is_member_of_stream).toBe(true);
    });

    it('reports an un-accepted task as not accepted', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('tasks.listForUser', () => [convexTask()]);

      const [task] = await tasksApi.getUserTasksWithStatus();

      expect(task.is_accepted).toBe(false);
      expect(task.submission_status).toBeNull();
      expect(task.user_submission).toBeNull();
    });

    it('treats an in_progress submission as accepted', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('tasks.listForUser', () => [
        convexTask({
          mySubmission: {
            id: 'sub-1',
            taskId: 'task-1',
            userId: mockInternUser.id,
            status: 'in_progress',
            startedAt: 1_700_100_000_000,
            createdAt: 1_700_100_000_000,
          },
        }),
      ]);

      const [task] = await tasksApi.getUserTasksWithStatus();

      // Accepting a task is what creates the submission row, in `in_progress` —
      // a status the app's own union was missing, so every accepted-but-not-yet
      // -submitted row was mistyped.
      expect(task.is_accepted).toBe(true);
      expect(task.submission_status).toBe('in_progress');
      expect(task.accepted_at).toBe(new Date(1_700_100_000_000).toISOString());
    });

    it('reports a file submission as having a file even with no public url', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('tasks.listForUser', () => [
        convexTask({
          mySubmission: {
            id: 'sub-1',
            taskId: 'task-1',
            userId: mockInternUser.id,
            status: 'submitted',
            hasFile: true,
            createdAt: 1_700_100_000_000,
          },
        }),
      ]);

      const [task] = await tasksApi.getUserTasksWithStatus();

      // Convex-stored files have no public url at all, so a truthiness check on
      // submission_url would report "no file" for every one of them.
      expect(task.user_submission!.has_file).toBe(true);
      expect(task.user_submission!.submission_url).toBeUndefined();
    });
  });

  describe('reviewSubmission()', () => {
    it('sends the status, score and feedback in one call', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.reviewSubmission', (args) => {
        received = args;
        return { success: true, newTotal: 33 };
      });
      convexMock.onQuery('tasks.mySubmissions', () => []);
      convexMock.onQuery('tasks.listSubmissions', () => [
        {
          id: 'sub-1',
          taskId: 'task-1',
          userId: mockInternUser.id,
          status: 'approved',
          score: 8,
          createdAt: 1_700_100_000_000,
        },
      ]);

      await tasksApi.reviewSubmission('sub-1', { status: 'approved', score: 8, feedback: 'good' });

      expect(received.token).toBe('admin-tok');
      expect(received.submissionId).toBe('sub-1');
      expect(received.status).toBe('approved');
      expect(received.score).toBe(8);
      expect(received.feedback).toBe('good');
    });

    it('sends a zero score rather than dropping it', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('tasks.reviewSubmission', (args) => {
        received = args;
        return { success: true, newTotal: 0 };
      });
      convexMock.onQuery('tasks.mySubmissions', () => []);
      convexMock.onQuery('tasks.listSubmissions', () => [
        {
          id: 'sub-1',
          taskId: 'task-1',
          userId: mockInternUser.id,
          status: 'approved',
          score: 0,
          createdAt: 1_700_100_000_000,
        },
      ]);

      await tasksApi.reviewSubmission('sub-1', { status: 'approved', score: 0 });

      // `if (score)` skipped the whole ledger write for a zero, so a submission
      // deliberately scored 0 was recorded as approved-and-unscored.
      expect(received.score).toBe(0);
    });

    it('throws when the review is refused', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      convexMock.onMutation('tasks.reviewSubmission', () => ({
        success: false,
        error: 'You do not moderate this stream',
      }));

      await expect(
        tasksApi.reviewSubmission('sub-1', { status: 'approved', score: 8 }),
      ).rejects.toThrow('You do not moderate this stream');
    });
  });

  describe('getSubmissionDetails()', () => {
    /**
     * THE REGRESSION TEST FOR A REAL DEFECT THE E2E SUITE FOUND.
     *
     * Without a task id this function scanned four status-filtered lists in
     * sequence — and a submission whose status moved while the scan ran (its
     * author resubmitting at that moment) evaded every list: it left
     * 'changes_requested' after that list was read and entered 'submitted'
     * before that one was re-read. The id fallback then returned the row with
     * NO task attached, and the review pane rendered from it could not approve
     * anything: no visible submission, a blank "Max:", and every typed score
     * clamped against the missing maximum to 0.
     *
     * Keyed on the task instead, the lookup uses a field that never changes,
     * so there is no status to race.
     */
    it('reads by task when the task is known, never by status', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      const calls: Record<string, unknown>[] = [];
      convexMock.onQuery('tasks.listSubmissions', (args) => {
        calls.push(args);
        return [
          {
            id: 'sub-1',
            taskId: 'task-1',
            userId: mockInternUser.id,
            status: 'submitted',
            submissionText: 'attempt two',
            createdAt: 1_700_100_000_000,
            submittedAt: 1_700_200_000_000,
            task: convexTask(),
            author: { id: mockInternUser.id, fullName: 'Ade Intern' },
          },
        ];
      });

      const details = await tasksApi.getSubmissionDetails('sub-1', 'task-1');

      // One indexed read, carrying the task id and no status.
      expect(calls).toHaveLength(1);
      expect(calls[0].taskId).toBe('task-1');
      expect(calls[0].status).toBeUndefined();

      // The joined task survives — `points` is what the review form clamps
      // the score against, so losing it makes approval impossible.
      expect(details?.task?.points).toBe(25);
      expect(details?.user?.full_name).toBe('Ade Intern');
      expect(details?.status).toBe('submitted');
    });

    it('falls back to the status scan when the row is not under the task', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');

      const calls: Record<string, unknown>[] = [];
      convexMock.onQuery('tasks.listSubmissions', (args) => {
        calls.push(args);
        if (args.taskId) return []; // not found under this task
        return args.status === 'approved'
          ? [
              {
                id: 'sub-9',
                taskId: 'task-2',
                userId: mockInternUser.id,
                status: 'approved',
                createdAt: 1_700_100_000_000,
                task: convexTask({ id: 'task-2' }),
                author: { id: mockInternUser.id, fullName: 'Ade Intern' },
              },
            ]
          : [];
      });

      const details = await tasksApi.getSubmissionDetails('sub-9', 'task-1');

      expect(details?.id).toBe('sub-9');
      expect(details?.task?.id).toBe('task-2');
      // The by-task read came first; the scan only ran because it missed.
      expect(calls[0].taskId).toBe('task-1');
      expect(calls.some((c) => c.status === 'approved')).toBe(true);
    });
  });
});
