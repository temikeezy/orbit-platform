import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { tasksApi } from '../../lib/api/tasks';
import { mockInternUser, mockAdminUser, mockTask, seedLocalStorage } from '../fixtures';

/**
 * The lifecycle as the CLIENT sees it: accept, submit, review, re-read.
 *
 * The Supabase version of this file drove the whole lifecycle by hand — insert
 * a submission, update its status column, insert a points-ledger row, RPC the
 * user's total — because the browser really did all of that. It also had to
 * swallow its own errors (`catch { // chain mock may not be fully resolved }`)
 * and then assert conditionally, which meant three of its four assertions could
 * silently not run.
 *
 * Each step is one call now, and the server owns the transitions. So this
 * asserts the sequence of calls and the state the client derives from what comes
 * back. The transitions themselves — that a deadline blocks a submission, that
 * approving pays the ledger exactly once, that re-scoring pays the difference —
 * are verified against a real deployment in `convex-client-swap.test.ts`.
 */

const submissionRow = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  taskId: mockTask.id,
  userId: mockInternUser.id,
  status: 'in_progress',
  startedAt: 1_700_100_000_000,
  createdAt: 1_700_100_000_000,
  ...over,
});

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: mockTask.id,
  streamId: 'stream-1',
  title: mockTask.title,
  description: 'do the thing',
  submissionType: 'link',
  points: 10,
  deadline: 1_700_600_000_000,
  isActive: true,
  createdAt: 1_700_000_000_000,
  streamName: 'Web Development',
  streamEmoji: '💻',
  isMemberOfStream: true,
  mySubmission: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('Task submission lifecycle', () => {
  it('an intern accepts a task with one call carrying only the task id', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('tasks.acceptTask', (args) => {
      received = args;
      return { success: true };
    });

    await tasksApi.acceptTask(mockTask.id);

    expect(received.taskId).toBe(mockTask.id);
    // The row is created server-side, from the session. The browser used to
    // insert it and choose both the user_id and the initial status.
    expect(received).not.toHaveProperty('userId');
    expect(received).not.toHaveProperty('status');
  });

  it('the accepted task then reads back as in_progress', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');
    convexMock.onQuery('tasks.listForUser', () => [
      taskRow({ mySubmission: submissionRow() }),
    ]);

    const [task] = await tasksApi.getUserTasksWithStatus();

    expect(task.is_accepted).toBe(true);
    expect(task.submission_status).toBe('in_progress');
  });

  it('an intern submits a url without naming a status', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('tasks.submitWork', (args) => {
      received = args;
      return { success: true };
    });

    await tasksApi.submitTask(mockTask.id, { url: 'https://my-project.com' });

    expect(received.taskId).toBe(mockTask.id);
    expect(received.submissionFileUrl).toBe('https://my-project.com');
    // Writing the status column from the browser is how a member could have set
    // it to 'approved'.
    expect(received).not.toHaveProperty('status');
  });

  it('a refused submission surfaces the reason rather than reporting success', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');
    convexMock.onMutation('tasks.submitWork', () => ({
      success: false,
      error: 'The deadline for this task has passed.',
    }));

    // The mutations report refusal in the RESULT, not by throwing. A client
    // that ignored it would show "submitted" for a submission that was rejected.
    await expect(tasksApi.submitTask(mockTask.id, { url: 'https://late.com' })).rejects.toThrow(
      'The deadline for this task has passed.',
    );
  });

  it('an admin approves with a score, in one call', async () => {
    seedLocalStorage(mockAdminUser, 'admin-tok');

    let received: Record<string, unknown> = {};
    convexMock.onMutation('tasks.reviewSubmission', (args) => {
      received = args;
      return { success: true, newTotal: 48 };
    });
    convexMock.onQuery('tasks.mySubmissions', () => []);
    convexMock.onQuery('tasks.listSubmissions', () => [
      submissionRow({ status: 'approved', score: 8, reviewedAt: 1_700_300_000_000 }),
    ]);

    const reviewed = await tasksApi.reviewSubmission('sub-1', { status: 'approved', score: 8 });

    expect(received.submissionId).toBe('sub-1');
    expect(received.status).toBe('approved');
    expect(received.score).toBe(8);
    // Scoring the submission, writing the ledger and moving the user's total
    // are one transaction now. The browser did them as three writes it could
    // stop between, leaving a scored submission with no ledger entry.
    expect(received).not.toHaveProperty('pointsToAdd');

    expect(reviewed.status).toBe('approved');
    expect(reviewed.score).toBe(8);
    expect(reviewed.points_awarded).toBe(8);
  });

  it('the approved task reads back as approved with its score', async () => {
    seedLocalStorage(mockInternUser, 'intern-tok');
    convexMock.onQuery('tasks.listForUser', () => [
      taskRow({
        mySubmission: submissionRow({
          status: 'approved',
          score: 8,
          reviewedAt: 1_700_300_000_000,
          submittedAt: 1_700_200_000_000,
        }),
      }),
    ]);

    const [task] = await tasksApi.getUserTasksWithStatus();

    expect(task.submission_status).toBe('approved');
    expect(task.user_submission!.score).toBe(8);
    expect(task.user_submission!.reviewed_at).toBe(new Date(1_700_300_000_000).toISOString());
  });
});
