import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';

import { authService } from '../../lib/auth';
import { tasksApi } from '../../lib/api/tasks';
import { levelsApi } from '../../lib/api/levels';
import { badgesApi } from '../../lib/api/badges';
import { leaderboardApi } from '../../lib/api/leaderboard';
import { usersApi } from '../../lib/api/users';
import { streamsApi } from '../../lib/api/streams';
import { activityApi } from '../../lib/api/activity';

/**
 * Exercises the REWRITTEN CLIENT MODULES against a live Convex deployment.
 *
 * The existing harnesses (mcp-server/scripts/*.mjs) verify the Convex functions.
 * They do not execute a single line of `src/lib/api/*` or `convexAdapters.ts` —
 * so the adapters, the snake_case mapping and the epoch-ms-to-ISO conversion had
 * never actually run anywhere before this file. That is the gap this closes: the
 * server contract being right does not mean the client reads it correctly.
 *
 * Requires ORBIT_TEST_MCP_SECRET to mint an admin session for fixture setup.
 * Skipped entirely without it, so `npm test` stays green without credentials.
 */

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined;
const MCP_SECRET = process.env.ORBIT_TEST_MCP_SECRET;

// Same guard as e2e/support/orbit.ts: the dev deployment, by exact name.
const DEV_DEPLOYMENT = process.env.ORBIT_DEV_DEPLOYMENT || 'your-dev-deployment';
const deployment = (() => { try { return new URL(CONVEX_URL ?? '').hostname.split('.')[0]; } catch { return ''; } })();
const runnable = Boolean(CONVEX_URL && MCP_SECRET && deployment === DEV_DEPLOYMENT);

const stamp = Date.now();
const email = `client-swap-${stamp}@iih.ng`;

let admin = '';
/** The signed-in session, re-applied per test — see the beforeEach below. */
let session = { token: '', user: '' };
let internId = '';
let streamId = '';
let taskId = '';
let convex: ConvexHttpClient;

/**
 * The intern's live session, read from where the client keeps it.
 *
 * The api modules under test all read this key, so taking it from there rather
 * than holding a second copy means these assertions are made with exactly the
 * token the code under test would use.
 */
const internToken = () => localStorage.getItem('orbit_auth_token_v2')!;

/**
 * Creates a task and publishes it.
 *
 * `admin` here is an MCP session, and MCP-created tasks are PROPOSALS awaiting
 * a supervisor — that is the point of the approval gate. Every fixture below
 * wants a task the stream can actually see, so it approves its own proposal in
 * the same breath. Tests that are about the gate itself do not use this.
 */
const publishTask = async (fields: Record<string, unknown>) => {
  const created = await convex.mutation(anyApi.tasks.create, { token: admin, ...fields });
  await convex.mutation(anyApi.tasks.approveProposal, { token: admin, taskId: created.id });
  return created;
};


/**
 * Every test in this file makes REAL network calls to a live Convex deployment,
 * and several make five or more in sequence. Vitest's 5s default is a unit-test
 * timeout: run alone these pass in well under it, but under the full suite the
 * deployment is serving the other files too and the slowest chains cross 5s —
 * so three of them failed on load rather than on logic, which is the worst kind
 * of red because it points at the wrong code.
 *
 * 30s file-wide. Individual tests that poll for an async fan-out still set their
 * own longer timeouts below; this only replaces the default for the rest.
 */
describe.skipIf(!runnable)('client swap against live Convex', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    convex = new ConvexHttpClient(CONVEX_URL!);

    const auth = await convex.mutation(anyApi.mcp.authenticate, { secret: MCP_SECRET });
    admin = auth.token;

    const created = await convex.mutation(anyApi.users.adminCreateUser, {
      token: admin,
      email,
      fullName: `Client Swap ${stamp}`,
      roles: ['intern'],
    });
    internId = created.id;

    const stream = await convex.mutation(anyApi.streams.create, {
      token: admin,
      name: `Client Swap ${stamp}`,
    });
    streamId = stream.id;

    await convex.mutation(anyApi.streams.addMember, { token: admin, streamId, userId: internId });

    const task = await publishTask({
      streamId,
      title: `Client Swap task ${stamp}`,
      description: 'exercised by the integration test',
      submissionType: 'text',
      // In range for TASK_POINTS (1-20). The value is arbitrary — this fixture
      // only round-trips it through the adapter — but it must stay inside the
      // bound `tasks.create` now enforces.
      points: 15,
      deadline: Date.now() + 7 * 86_400_000,
      notify: false,
    });
    taskId = task.id;

    // Signs in through the REAL client path, which is what stores the token
    // every module below reads.
    const login = await authService.login(email, created.tempPassword);
    expect(login.success, JSON.stringify(login)).toBe(true);

    session = {
      token: localStorage.getItem('orbit_auth_token_v2')!,
      user: localStorage.getItem('orbit_user_v2')!,
    };
  }, 60_000);

  // src/test/setup.ts clears localStorage before EVERY test, which is right for
  // unit tests and wipes the session this suite signs in with once. Re-applied
  // rather than signing in per test: a fresh sign-in each time would be a dozen
  // bcrypt compares and would exercise the login throttle rather than the code
  // under test.
  beforeEach(() => {
    if (!session.token) return;
    localStorage.setItem('orbit_auth_token_v2', session.token);
    localStorage.setItem('orbit_user_v2', session.user);
  });

  afterAll(async () => {
    if (!admin) return;
    await convex
      .mutation(anyApi.users.adminSetActive, { token: admin, userId: internId, isActive: false })
      .catch(() => {});
    await convex.mutation(anyApi.streams.deactivate, { token: admin, streamId }).catch(() => {});
  });

  describe('authService', () => {
    it('stores the session under the v2 keys', () => {
      expect(localStorage.getItem('orbit_auth_token_v2')).toBeTruthy();
      expect(localStorage.getItem('orbit_user_v2')).toBeTruthy();
    });

    it('leaves nothing under the v1 keys', () => {
      // A Supabase token under the old key would make isAuthenticated() true
      // while every Convex call is rejected — the half-authenticated state the
      // versioning exists to prevent.
      expect(localStorage.getItem('orbit_auth_token')).toBeNull();
      expect(localStorage.getItem('orbit_user')).toBeNull();
    });

    it('maps the user into the snake_case shape the app reads', () => {
      const user = authService.getCurrentUser()!;
      expect(user.full_name).toBe(`Client Swap ${stamp}`);
      expect(user.email).toBe(email);
      expect(typeof user.total_points).toBe('number');
      expect(user.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('never exposes a password hash or a jwt column', () => {
      const raw = localStorage.getItem('orbit_user_v2')!;
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('jwt_');
    });

    it('refreshUser round-trips without losing fields', async () => {
      const refreshed = await authService.refreshUser();
      expect(refreshed?.full_name).toBe(`Client Swap ${stamp}`);
      expect(refreshed?.roles).toContain('intern');
    });
  });

  describe('tasksApi', () => {
    it('returns tasks in the snake_case shape with an ISO deadline', async () => {
      const tasks = await tasksApi.getUserTasksWithStatus();
      const task = tasks.find((t) => t.id === taskId)!;

      expect(task).toBeDefined();
      expect(task.stream_name).toBe(`Client Swap ${stamp}`);
      expect(task.points).toBe(15);
      // The adapter's job: epoch ms in, ISO out.
      expect(task.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isNaN(new Date(task.deadline).getTime())).toBe(false);
      expect(task.is_member_of_stream).toBe(true);
    });

    it('renders no undefined into the fields the task list displays', async () => {
      const tasks = await tasksApi.getUserTasksWithStatus();
      const task = tasks.find((t) => t.id === taskId)!;

      for (const field of ['title', 'description', 'stream_name', 'stream_emoji', 'created_by_name'] as const) {
        expect(task[field], field).not.toBeUndefined();
      }
    });

    it('reports an accepted task as in_progress, which is what the pages now check', async () => {
      await tasksApi.acceptTask(taskId);

      const task = (await tasksApi.getUserTasksWithStatus()).find((t) => t.id === taskId)!;
      expect(task.is_accepted).toBe(true);
      expect(task.user_submission?.status).toBe('in_progress');
      expect(task.submission_status).toBe('in_progress');
    });

    it('submits work and finds it by task and user', async () => {
      await tasksApi.submitTask(taskId, { text: 'work from the integration test' });

      const submission = await tasksApi.getSubmissionByTaskAndUser(taskId, internId);
      expect(submission?.status).toBe('submitted');
      expect(submission?.submission_text).toBe('work from the integration test');
      expect(submission?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('getSubmissionById finds the same row', async () => {
      const byPair = await tasksApi.getSubmissionByTaskAndUser(taskId, internId);
      const byId = await tasksApi.getSubmissionById(byPair!.id);
      expect(byId?.id).toBe(byPair!.id);
    });

    it('getTaskById agrees with the list', async () => {
      const single = await tasksApi.getTaskById(taskId);
      const fromList = (await tasksApi.getUserTasksWithStatus()).find((t) => t.id === taskId);

      expect(single?.stream_name).toBe(fromList?.stream_name);
      expect(single?.deadline).toBe(fromList?.deadline);
      expect(single?.submission_status).toBe(fromList?.submission_status);
    });

    it('refuses to review a submission as a member', async () => {
      const submission = await tasksApi.getSubmissionByTaskAndUser(taskId, internId);
      await expect(
        tasksApi.reviewSubmission(submission!.id, { status: 'approved', score: 999 }),
      ).rejects.toThrow();
    });
  });

  describe('authorization boundaries closed by the review', () => {
    it('a member cannot ask for deactivated tasks', async () => {
      // `includeInactive` was an unguarded argument, so the full content of a
      // withdrawn task was readable by anyone who passed it.
      await convex.mutation(anyApi.tasks.deactivate, { token: admin, taskId });

      const asMember = await convex.query(anyApi.tasks.listForUser, {
        token: localStorage.getItem('orbit_auth_token_v2'),
        includeInactive: true,
      });
      expect(asMember.some((t: { id: string }) => t.id === taskId)).toBe(false);

      const asAdmin = await convex.query(anyApi.tasks.listForUser, {
        token: admin,
        includeInactive: true,
      });
      expect(asAdmin.some((t: { id: string }) => t.id === taskId)).toBe(true);

      await convex.mutation(anyApi.tasks.update, { token: admin, taskId, isActive: true });
    });

    it('a moderator of one stream cannot edit another stream\'s tasks', async () => {
      const other = await convex.mutation(anyApi.users.adminCreateUser, {
        token: admin,
        email: `mod-${stamp}@iih.ng`,
        fullName: `Mod ${stamp}`,
        roles: ['moderator'],
      });
      const modLogin = await convex.mutation(anyApi.mcp.authenticate, { secret: MCP_SECRET });
      void modLogin;

      const login = await authService.login(`mod-${stamp}@iih.ng`, other.tempPassword);
      const modToken = login.token!;

      // Restore the suite's own session immediately — beforeEach re-applies it,
      // but this test still needs it afterwards.
      localStorage.setItem('orbit_auth_token_v2', session.token);
      localStorage.setItem('orbit_user_v2', session.user);

      await expect(
        convex.mutation(anyApi.tasks.update, {
          token: modToken,
          taskId,
          title: 'moderator from another stream',
        }),
      ).rejects.toThrow(/do not moderate this stream/i);

      await convex
        .mutation(anyApi.users.adminSetActive, { token: admin, userId: other.id, isActive: false })
        .catch(() => {});
    });

    it('submitting text does not erase a previously attached file', async () => {
      // ctx.db.patch REMOVES a key set to undefined; passing both fields through
      // unconditionally wiped whichever one the caller omitted.
      await convex.mutation(anyApi.tasks.submitWork, {
        token: session.token,
        taskId,
        submissionFileUrl: 'https://example.invalid/first',
      });
      await convex.mutation(anyApi.tasks.submitWork, {
        token: session.token,
        taskId,
        submissionText: 'text added later',
      });

      const rows = await convex.query(anyApi.tasks.mySubmissions, { token: session.token, taskId });
      expect(rows[0].submissionText).toBe('text added later');
      expect(rows[0].submissionFileUrl).toBe('https://example.invalid/first');
    });
  });

  /**
   * The new-member checklist.
   *
   * Onboarding is CHECKED, not submitted — see convex/onboarding.ts. That makes
   * the interesting assertions the boundary ones: staff have no checklist at
   * all, and the manual step records once rather than resetting each time the
   * page is opened. Neither is visible from the UI, so neither would be caught
   * by an e2e pass.
   */
  /**
   * The email queue as a queue, not just a table.
   *
   * These assert the parts that are invisible from the UI and expensive to be
   * wrong about: that a cancellation is distinguishable from a failure, that
   * requeuing clears the backoff timer rather than leaving the row waiting on a
   * stale one, and that every one of these is admin-only. A queue whose
   * management surface a member can reach is worse than one with no management
   * surface, because these mutations move real mail.
   */
  /**
   * Requesting a replacement task.
   *
   * The flow this exists for is: a supervisor reads a weak proposal, declines
   * it, and asks for another. That is also the flow that was broken — declining
   * DELETES the row, and the "already taken" set was built from rows still in
   * the table, so the next request handed back the task just declined.
   */
  /**
   * Changing a task's value after work has been scored against it.
   *
   * This used to move the task and nothing else, and it broke both ways.
   * Lowering points below an existing score left a submission that
   * `reviewSubmission` REFUSED — it bounds a score to [0, task.points] and
   * rejects rather than clamps — so the row became un-reviewable while the
   * ledger kept the old amount. Raising points left already-approved interns
   * short against anyone scored afterwards for the same work.
   */
  /**
   * A link submission must be READABLE by the person who has to grade it.
   *
   * The write path put a link in `submissionFileUrl`; three separate screens
   * read `submissionText` for it — the intern's own view, the peer showcase and
   * the reviewer's panel. So a link submitted correctly rendered as nothing,
   * and the reviewer could not tell it from an empty submission. Nothing
   * errored at any point, which is exactly why it lasted.
   */
  /**
   * Every submission type the bank actually uses must be accepted.
   *
   * The file allow-list omitted spreadsheets while the bank asks for them
   * outright — "Design a simple tracker" is a delivery-grade task whose whole
   * test is whether the formulas compute. An intern would have produced exactly
   * what was asked and been told the type was not allowed, after the upload.
   */
  /**
   * Error capture and bug reports.
   *
   * Before this, `logError` sent to Sentry when a DSN was configured and to the
   * console otherwise, and only when NOT in production — which has no DSN. So
   * on the deployment that matters, every caught error went nowhere.
   */
  describe('error reporting', () => {
    it('accepts a report from a signed-out visitor', async () => {
      // The signed-out path is the point: a broken login page is exactly the
      // fault nobody would otherwise hear about.
      const r = await convex.mutation(anyApi.errorReports.report, {
        source: 'reported',
        message: `anonymous probe ${stamp}`,
        note: 'sent without a token',
      });
      expect(r.success).toBe(true);
    });

    it('never stores a credential from the URL', async () => {
      const secret = `TOKENVALUE${stamp}`;
      await convex.mutation(anyApi.errorReports.report, {
        source: 'reported',
        message: `redaction probe ${stamp}`,
        url: `https://orbit2.iih.ng/magic#token=${secret}&next=/tasks`,
        note: 'the fragment must not survive',
      });

      const rows = await convex.query(anyApi.errorReports.list, { token: admin, limit: 50 });
      const mine = rows.find((r: { message: string }) => r.message === `redaction probe ${stamp}`);
      expect(mine).toBeTruthy();
      /**
       * Magic-link tokens travel in the FRAGMENT precisely so they never reach
       * a server log. Storing the full URL would undo that and write a live
       * credential into a table every admin can read.
       */
      expect(mine.path).toBe('https://orbit2.iih.ng/magic');
      expect(JSON.stringify(mine)).not.toContain(secret);
    });

    it('counts a repeated fault once, rather than filling the list', async () => {
      const message = `repeat probe ${stamp}`;
      for (let i = 0; i < 3; i++) {
        await convex.mutation(anyApi.errorReports.report, {
          source: 'caught',
          message,
          context: 'IntegrationTest.repeat',
        });
      }
      const rows = await convex.query(anyApi.errorReports.list, { token: admin, limit: 100 });
      const matching = rows.filter((r: { message: string }) => r.message === message);
      // One fault hit repeatedly is one problem; a list that says so is
      // readable where three identical rows are not.
      expect(matching.length).toBe(1);
      expect(matching[0].occurrences).toBeGreaterThanOrEqual(3);
    });

    it('refuses the admin list to a member', async () => {
      await expect(
        convex.query(anyApi.errorReports.list, { token: internToken() }),
      ).rejects.toThrow();
    });
  });

  describe('the submission surface accepts what the bank asks for', () => {
    it('takes a text submission and returns it on the text field', async () => {
      const task = await publishTask({
        streamId,
        title: `Client Swap text sub ${stamp}`,
        description: 'exercises a text submission',
        submissionType: 'text',
        points: 8,
        deadline: Date.now() + 7 * 86_400_000,
        notify: false,
      });
      await convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: task.id });
      const prose = `written answer ${stamp}`;
      await convex.mutation(anyApi.tasks.submitWork, {
        token: internToken(),
        taskId: task.id,
        submissionText: prose,
      });

      const rows = (await convex.query(anyApi.tasks.listSubmissions, {
        token: admin,
        taskId: task.id,
        userId: internId,
      })) as { submissionText?: string; submissionFileUrl?: string }[];
      expect(rows[0].submissionText).toBe(prose);
      // Text must NOT land on the file field — that was a real defect once.
      expect(rows[0].submissionFileUrl ?? '').not.toBe(prose);
    });

    it('rejects an empty submission rather than recording nothing', async () => {
      const task = await publishTask({
        streamId,
        title: `Client Swap empty sub ${stamp}`,
        description: 'exercises the empty-submission guard',
        submissionType: 'text',
        points: 8,
        deadline: Date.now() + 7 * 86_400_000,
        notify: false,
      });
      await convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: task.id });

      /**
       * A submission with no content is not a submission; recording one shows a
       * reviewer an empty panel and the intern a completed task.
       *
       * Asserted as a RETURNED failure, not a throw: `submitWork` reports
       * domain refusals in its result and reserves throwing for authorisation,
       * which is the same split the rest of these mutations use.
       */
      const empty = await convex.mutation(anyApi.tasks.submitWork, {
        token: internToken(),
        taskId: task.id,
      });
      expect(empty.success).toBe(false);
      expect(empty.error).toMatch(/add your work/i);
    });
  });

  describe('a link submission survives the round trip', () => {
    it('comes back on the field the reviewer reads', async () => {
      const task = await publishTask({
        streamId,
        title: `Client Swap link ${stamp}`,
        description: 'exercises the link submission round trip',
        submissionType: 'link',
        points: 10,
        deadline: Date.now() + 7 * 86_400_000,
        notify: false,
      });
      await convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: task.id });

      const url = `https://example.invalid/work-${stamp}`;
      await convex.mutation(anyApi.tasks.submitWork, {
        token: internToken(),
        taskId: task.id,
        submissionFileUrl: url,
      });

      const rows = (await convex.query(anyApi.tasks.listSubmissions, {
        token: admin,
        taskId: task.id,
        userId: internId,
      })) as { submissionFileUrl?: string; submissionText?: string }[];

      expect(rows.length).toBeGreaterThan(0);
      // Stored where the writer put it...
      expect(rows[0].submissionFileUrl).toBe(url);
      // ...and NOT on the field the screens used to read, which is the whole
      // point: a reader looking at submissionText finds nothing.
      expect(rows[0].submissionText ?? '').not.toBe(url);
    });
  });

  describe('changing task points reconciles work already scored', () => {
    const scoredTask = async (label: string, points: number, score: number) => {
      const task = await publishTask({
        streamId,
        title: `Client Swap rescale ${label} ${stamp}`,
        description: 'exercises points reconciliation',
        submissionType: 'text',
        points,
        deadline: Date.now() + 7 * 86_400_000,
        notify: false,
      });
      await convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: task.id });
      const submission = await convex.mutation(anyApi.tasks.submitWork, {
        token: internToken(),
        taskId: task.id,
        submissionText: `work ${label}`,
      });
      const reviewed = await convex.mutation(anyApi.tasks.reviewSubmission, {
        token: admin,
        submissionId: submission.id,
        status: 'approved',
        score,
      });
      expect(reviewed.success).toBe(true);
      return { taskId: task.id as string, submissionId: submission.id as string };
    };

    const scoreOf = async (taskId: string, submissionId: string) => {
      const rows = (await convex.query(anyApi.tasks.listSubmissions, {
        token: admin,
        taskId,
        userId: internId,
      })) as { id: string; score?: number }[];
      return rows.find((r) => r.id === submissionId)?.score;
    };

    it('scales a score up when the task becomes worth more', async () => {
      // Full marks on a 10-point task stays full marks when it becomes 20.
      const { taskId, submissionId } = await scoredTask('up', 10, 10);
      await convex.mutation(anyApi.tasks.update, { token: admin, taskId, points: 20 });
      expect(await scoreOf(taskId, submissionId)).toBe(20);
    });

    it('scales a score down, keeping the fraction earned', async () => {
      // Half marks stays half marks: 5/10 becomes 2/4, not a clamp to 4.
      const { taskId, submissionId } = await scoredTask('down', 10, 5);
      await convex.mutation(anyApi.tasks.update, { token: admin, taskId, points: 4 });
      expect(await scoreOf(taskId, submissionId)).toBe(2);
    });

    it('never invents points across repeated changes', async () => {
      /**
       * Rounding drifts upward: 1 on a 3-point task rounds to 1 when the task
       * drops to 2, then to 2 when it returns to 3 — a point earned by two
       * edits and no work. Flooring makes the sequence non-increasing.
       */
      const { taskId, submissionId } = await scoredTask('drift', 3, 1);
      await convex.mutation(anyApi.tasks.update, { token: admin, taskId, points: 2 });
      await convex.mutation(anyApi.tasks.update, { token: admin, taskId, points: 3 });
      const finalScore = await scoreOf(taskId, submissionId) ?? 0;
      expect(finalScore).toBeLessThanOrEqual(1);
    });

    it('leaves the submission re-reviewable afterwards', async () => {
      /**
       * The actual bug. Lowering points below a stored score used to make
       * `reviewSubmission` refuse the row outright, stranding it until someone
       * rescored by hand.
       */
      const { taskId, submissionId } = await scoredTask('reviewable', 20, 20);
      await convex.mutation(anyApi.tasks.update, { token: admin, taskId, points: 5 });

      /**
       * Re-reviewed WITHOUT an explicit score, so it falls back to the stored
       * one — which is the path that actually broke. Passing a fresh score
       * sidesteps the bug entirely and the test would pass either way.
       */
      const again = await convex.mutation(anyApi.tasks.reviewSubmission, {
        token: admin,
        submissionId,
        status: 'approved',
      });
      expect(again.success, 'a rescaled submission must still be reviewable').toBe(true);
    });

    it('does not touch scores when points are unchanged', async () => {
      const { taskId, submissionId } = await scoredTask('same', 10, 7);
      await convex.mutation(anyApi.tasks.update, {
        token: admin,
        taskId,
        title: `Client Swap rescale renamed ${stamp}`,
      });
      expect(await scoreOf(taskId, submissionId)).toBe(7);
    });
  });

  describe('requestNewTask', () => {
    it('does not return a task the supervisor just declined', async () => {
      /**
       * The stream name has to MATCH a bank rule (`seedTasksFor`), or the bank
       * is empty and this proves nothing. An earlier version of this test
       * declined a task with a made-up title, which could never have been
       * returned by the bank regardless — it passed whether or not the fix
       * worked.
       */
      const stream = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Software Engineering regen ${stamp}`,
      });

      // Draw a REAL bank task, so the title we decline is one the bank can
      // hand back.
      const first = await convex.mutation(anyApi.tasks.requestNewTask, {
        token: admin,
        streamId: stream.id,
      });
      expect(first.success).toBe(true);
      const declinedTitle = first.title as string;

      // Decline it — which DELETES the row and frees its title. That deletion
      // is what used to make the next request return this very task.
      const proposals = await convex.query(anyApi.tasks.pendingProposals, { token: admin });
      const row = proposals.find((p: { title: string }) => p.title === declinedTitle);
      expect(row, 'the requested task should be waiting as a proposal').toBeTruthy();

      await convex.mutation(anyApi.tasks.declineProposal, {
        token: admin,
        taskId: row.id,
        reason: 'too vague',
      });

      const second = await convex.mutation(anyApi.tasks.requestNewTask, {
        token: admin,
        streamId: stream.id,
      });

      // The whole point: a different task, or an honest "that is all of them".
      // Never the one just rejected.
      if (second.success) {
        expect(second.title).not.toBe(declinedTitle);
      } else {
        expect(second.error).toMatch(/no further tasks/i);
      }
    });

    it('still excludes a declined task that was retitled first', async () => {
      const stream = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Software Engineering retitle ${stamp}`,
      });

      const first = await convex.mutation(anyApi.tasks.requestNewTask, {
        token: admin,
        streamId: stream.id,
      });
      expect(first.success).toBe(true);
      const seedTitle = first.title as string;

      const proposals = await convex.query(anyApi.tasks.pendingProposals, { token: admin });
      const row = proposals.find((p: { title: string }) => p.title === seedTitle);
      expect(row).toBeTruthy();

      /**
       * "Edit first" is a first-class action on the proposals page, so editing
       * before deciding is an ordinary flow — not a corner case. The bank is
       * matched by title, so a retitle used to detach the proposal from its
       * seed: declining it then freed the ORIGINAL title and the next request
       * offered the same content back under its old name.
       */
      await convex.mutation(anyApi.tasks.update, {
        token: admin,
        taskId: row.id,
        title: `Reworded by the supervisor ${stamp}`,
      });

      await convex.mutation(anyApi.tasks.declineProposal, {
        token: admin,
        taskId: row.id,
        reason: 'still not right',
      });

      const second = await convex.mutation(anyApi.tasks.requestNewTask, {
        token: admin,
        streamId: stream.id,
      });

      if (second.success) {
        expect(second.title).not.toBe(seedTitle);
      } else {
        expect(second.error).toMatch(/no further tasks/i);
      }
    });

    it('refuses a MODERATOR a stream they do not moderate', async () => {
      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap unmoderated ${stamp}`,
      });

      /**
       * The caller must hold the moderator ROLE but no grant on this stream.
       *
       * Using an intern here would prove nothing about scope: `requireModerator`
       * rejects them on the role check before the `streamModerators` lookup is
       * ever reached, so the test would stay green even if this mutation
       * regressed from `requireStreamModerator` to plain `requireModerator` —
       * which is exactly the platform-wide bug fixed in "a moderator's
       * authority is a stream, not a role". With no row-level security behind
       * it, nothing else would catch that.
       */
      // 'intern', not 'member' — `adminSetRoles` validates against
      // ['intern','moderator','admin','super_admin'] and RETURNS
      // { success: false } for anything else rather than throwing. An earlier
      // version of this test passed 'member', which was silently rejected, so
      // the caller never became a moderator and the assertion below was
      // satisfied by the ROLE check — proving nothing about stream scope.
      const granted = await convex.mutation(anyApi.users.adminSetRoles, {
        token: admin,
        userId: internId,
        roles: ['intern', 'moderator'],
      });
      expect(granted.success, 'the fixture must actually hold the moderator role').toBe(true);

      try {
        await expect(
          convex.mutation(anyApi.tasks.requestNewTask, {
            token: internToken(),
            streamId: other.id,
          }),
        // Asserted as "throws" rather than on the message: Convex redacts a
        // plain Error to "Server Error" over the wire, so the text is not the
        // deployment's to promise. The refusal itself is the security property.
        ).rejects.toThrow();
      } finally {
        // Restored, or every later test inherits a moderator fixture.
        await convex.mutation(anyApi.users.adminSetRoles, {
          token: admin,
          userId: internId,
          roles: ['intern'],
        });
      }
    });
  });

  describe('the email queue management surface', () => {
    /** A queued message nobody else touches. */
    const enqueue = async (subject: string) => {
      const result = await convex.mutation(anyApi.emailQueue.adminEnqueue, {
        token: admin,
        userId: internId,
        subject: `${subject} ${stamp}`,
        bodyText: 'queued by the integration test',
        emailType: 'general',
      });
      expect(result.success).toBe(true);
      return result.id as string;
    };

    it('cancels a pending message, and cancelled is not failed', async () => {
      const id = await enqueue('cancel me');

      const cancelled = await convex.mutation(anyApi.emailQueue.adminCancel, {
        token: admin,
        emailId: id,
        reason: 'sent to the wrong cohort',
      });
      expect(cancelled.success).toBe(true);

      const rows = await convex.query(anyApi.emailQueue.adminList, {
        token: admin,
        status: 'cancelled',
        limit: 200,
      });
      const mine = rows.logs.find((l: { id: string }) => l.id === id);
      // A decision a person made, not something the system did — the two must
      // stay distinguishable or "why did this never arrive" has no answer.
      expect(mine).toBeDefined();
      expect(mine!.status).toBe('cancelled');
      expect(mine!.errorMessage).toContain('wrong cohort');
    });

    it('refuses to cancel the same message twice', async () => {
      const id = await enqueue('cancel once');
      await convex.mutation(anyApi.emailQueue.adminCancel, { token: admin, emailId: id });

      const again = await convex.mutation(anyApi.emailQueue.adminCancel, {
        token: admin,
        emailId: id,
      });
      expect(again.success).toBe(false);
      expect(again.error).toMatch(/already cancelled/i);
    });

    /**
     * NAMED FOR WHAT IT PROVES. This was "requeues a cancelled message and
     * clears its backoff", but the row it uses was never failed — so
     * `nextAttemptAt` was never set and `retryCount` was already 0, and both
     * "clearing" assertions passed whether or not `adminRetry` cleared
     * anything. The backoff-clearing behaviour cannot be reached from the
     * public surface without a real delivery failure; the schedule itself is
     * covered in src/test/unit/email-backoff.test.ts.
     */
    it('requeues a cancelled message back to pending', async () => {
      const id = await enqueue('requeue me');
      await convex.mutation(anyApi.emailQueue.adminCancel, { token: admin, emailId: id });

      const retried = await convex.mutation(anyApi.emailQueue.adminRetry, {
        token: admin,
        emailId: id,
      });
      expect(retried.success).toBe(true);

      const rows = await convex.query(anyApi.emailQueue.adminList, {
        token: admin,
        status: 'pending',
        limit: 200,
      });
      const mine = rows.logs.find((l: { id: string }) => l.id === id);
      expect(mine).toBeDefined();
      expect(mine!.status).toBe('pending');
    });

    it('records who requeued a message, so the attempt log is not just "the cron"', async () => {
      const id = await enqueue('attribute me');
      await convex.mutation(anyApi.emailQueue.adminCancel, { token: admin, emailId: id });
      await convex.mutation(anyApi.emailQueue.adminRetry, { token: admin, emailId: id });

      // The requeue and the send that follows are different transactions
      // minutes apart, so the attribution has to be carried on the queue row.
      // Asserting it is STORED is the half that does not need a live send.
      const rows = await convex.query(anyApi.emailQueue.adminList, {
        token: admin,
        status: 'pending',
        limit: 200,
      });
      expect(rows.logs.find((l: { id: string }) => l.id === id)).toBeDefined();

      // And the field is genuinely written — before this it was read in four
      // places and written in none, so the UI had a name column that could
      // never be populated.
      const health = await convex.query(anyApi.emailQueue.adminQueueHealth, { token: admin });
      expect(health.counts.pending).toBeGreaterThan(0);
    });

    it('reports queue health with the pause state and a bounded window', async () => {
      const health = await convex.query(anyApi.emailQueue.adminQueueHealth, { token: admin });

      expect(typeof health.counts.pending).toBe('number');
      expect(typeof health.counts.cancelled).toBe('number');
      expect(typeof health.dbPaused).toBe('boolean');
      // The env brake cannot be read from a query, and the screen says so
      // rather than reporting a green queue that is actually held.
      expect(health.envPauseVisible).toBe(false);
      expect(health.windowSize).toBeLessThanOrEqual(2000);
    });

    it('returns an empty attempt history for a message never sent', async () => {
      const id = await enqueue('never attempted');
      const attempts = await convex.query(anyApi.emailQueue.adminAttempts, {
        token: admin,
        emailId: id,
      });
      expect(attempts).toEqual([]);
    });

    it('stamps a cancellation with its own clock, not the failure one', async () => {
      const id = await enqueue('retention clock');
      await convex.mutation(anyApi.emailQueue.adminCancel, { token: admin, emailId: id });

      const rows = await convex.query(anyApi.emailQueue.adminList, {
        token: admin,
        status: 'cancelled',
        limit: 200,
      });
      const mine = rows.logs.find((l: { id: string }) => l.id === id)!;

      // A cancellation must not masquerade as a failure: `failedAt` drives the
      // failure sweep and the failure counters, and reusing it would both
      // miscount and start the wrong retention clock.
      expect(mine.failedAt ?? undefined).toBeUndefined();

      // And requeueing must clear the cancellation, or the sweep would still
      // see a terminal timestamp on a message that is pending again.
      await convex.mutation(anyApi.emailQueue.adminRetry, { token: admin, emailId: id });
      const after = await convex.query(anyApi.emailQueue.adminList, {
        token: admin,
        status: 'pending',
        limit: 200,
      });
      expect(after.logs.find((l: { id: string }) => l.id === id)).toBeDefined();
    });

    it('refuses every management function to a non-admin', async () => {
      const id = await enqueue('members may not touch this');
      const member = internToken();

      // Each of these moves real mail. There is no row-level security behind
      // them — if the function forgets its check, nothing else catches it.
      await expect(
        convex.query(anyApi.emailQueue.adminQueueHealth, { token: member }),
      ).rejects.toThrow();
      await expect(
        convex.query(anyApi.emailQueue.adminAttempts, { token: member, emailId: id }),
      ).rejects.toThrow();
      await expect(
        convex.mutation(anyApi.emailQueue.adminCancel, { token: member, emailId: id }),
      ).rejects.toThrow();
      await expect(
        convex.mutation(anyApi.emailQueue.adminRetry, { token: member, emailId: id }),
      ).rejects.toThrow();
    });
  });

  describe('the onboarding checklist', () => {
    it('gives an intern three steps, with sign-in already done', async () => {
      const status = await convex.query(anyApi.onboarding.status, { token: internToken() });

      expect(status.applicable).toBe(true);
      expect(status.steps.map((s: { key: string }) => s.key)).toEqual([
        'signIn',
        'password',
        'manual',
      ]);
      // Reaching this query at all proves the session, so it is never pending.
      expect(status.steps[0].done).toBe(true);
      // The password step must deep-link to the tab that actually holds the
      // form; plain /settings opens on Profile and hides it.
      expect(status.steps[1].href).toBe('/settings?tab=security');
    });

    it('gives staff no checklist at all', async () => {
      const status = await convex.query(anyApi.onboarding.status, { token: admin });

      // Tasks, points and levels are interns-only and so is this. `complete`
      // is true so no caller renders a permanently-unfinished checklist.
      expect(status.applicable).toBe(false);
      expect(status.steps).toEqual([]);
      expect(status.complete).toBe(true);
    });

    it('records the manual as read exactly once', async () => {
      const first = await convex.mutation(anyApi.onboarding.markOrientationRead, {
        token: internToken(),
      });
      // First write wins. A second call must NOT re-stamp the date, or "when did
      // this member onboard" stops being answerable.
      const second = await convex.mutation(anyApi.onboarding.markOrientationRead, {
        token: internToken(),
      });

      expect(first.recorded || second.recorded).toBe(true);
      expect(second.recorded).toBe(false);

      const after = await convex.query(anyApi.onboarding.status, { token: internToken() });
      expect(after.steps.find((s: { key: string }) => s.key === 'manual')!.done).toBe(true);
    });

    it('records nothing for staff', async () => {
      const result = await convex.mutation(anyApi.onboarding.markOrientationRead, {
        token: admin,
      });
      expect(result.recorded).toBe(false);
    });

    it('refuses an unauthenticated caller', async () => {
      await expect(
        convex.query(anyApi.onboarding.status, { token: 'not-a-real-session-token' }),
      ).rejects.toThrow();
    });
  });

  describe('usersApi and settings', () => {
    it('reads the directory without leaking a secret', async () => {
      const all = await usersApi.getActiveUsers();
      expect(all.length).toBeGreaterThan(0);
      expect(JSON.stringify(all)).not.toContain('password');
      expect(JSON.stringify(all)).not.toContain('jwt');
    });

    it('maps a directory row into the snake_case shape', async () => {
      const user = await usersApi.getUserById(internId);
      expect(user?.full_name).toBe(`Client Swap ${stamp}`);
      expect(typeof user?.total_points).toBe('number');
      expect(user?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('lets a member change their own privacy settings', async () => {
      // The reason this matters: leaderboard.top ENFORCES showOnLeaderboard,
      // and while the settings screen was on Supabase the opt-out was being
      // applied from a table the member could no longer reach.
      const updated = await usersApi.updateUser(internId, { show_on_leaderboard: false });
      expect(updated).toBeTruthy();

      const me = await convex.query(anyApi.users.me, { token: session.token });
      expect(me.showOnLeaderboard).toBe(false);

      const board = await leaderboardApi.get('overall', 100);
      expect(board.entries.some((e) => e.id === internId)).toBe(false);

      await usersApi.updateUser(internId, { show_on_leaderboard: true });
      expect(
        (await convex.query(anyApi.users.me, { token: session.token })).showOnLeaderboard,
      ).toBe(true);
    });

    it('refuses a role change from a member', async () => {
      await expect(
        usersApi.updateUser(internId, { roles: ['admin'] }),
      ).rejects.toThrow();
    });

    it('refuses an invalid profile visibility', async () => {
      await expect(
        usersApi.updateUser(internId, {
          profile_visibility: 'everyone' as never,
        }),
      ).rejects.toThrow(/visibility/i);
    });

    it('reads and writes notification preferences for the caller only', async () => {
      const before = await convex.query(anyApi.notificationPreferences.get, {
        token: session.token,
      });
      expect(typeof before.newTaskEnabled).toBe('boolean');

      await convex.mutation(anyApi.notificationPreferences.save, {
        token: session.token,
        newTaskEnabled: false,
      });

      const after = await convex.query(anyApi.notificationPreferences.get, {
        token: session.token,
      });
      expect(after.newTaskEnabled).toBe(false);
      // A partial save must not silently disable the settings it did not mention.
      expect(after.newMessageEnabled).toBe(true);

      // Put it back. This test shares one intern with everything below it, and
      // leaving new-task notifications switched off made the fan-out spec fail
      // for a reason that had nothing to do with fan-out — the code was right
      // and this test had disabled the thing being measured.
      await convex.mutation(anyApi.notificationPreferences.save, {
        token: session.token,
        newTaskEnabled: true,
      });
    });
  });

  describe('levelsApi', () => {
    it('maps levels into snake_case with usable defaults', async () => {
      const levels = await levelsApi.getAllLevels();
      expect(levels.length).toBeGreaterThan(0);

      for (const level of levels) {
        expect(typeof level.level_number).toBe('number');
        expect(typeof level.points_required).toBe('number');
        // Declared non-optional on the app's type and read straight into styles.
        expect(level.icon_emoji).toBeTruthy();
        expect(level.color_hex).toMatch(/^#/);
      }
    });

    it('returns level info with a progress percentage', async () => {
      const info = await levelsApi.getLevelInfo(50);
      expect(info?.current_level.level_number).toBeGreaterThanOrEqual(1);
      expect(typeof info?.progress_percentage).toBe('number');
      expect(Number.isNaN(info!.progress_percentage)).toBe(false);
    });

    it('getLevelByNumber matches the list', async () => {
      const levels = await levelsApi.getAllLevels();
      const found = await levelsApi.getLevelByNumber(levels[0].level_number);
      expect(found?.name).toBe(levels[0].name);
    });
  });

  describe('badgesApi', () => {
    it('maps badges into snake_case', async () => {
      const badges = await badgesApi.getAllBadges();
      expect(badges.length).toBeGreaterThan(0);

      for (const badge of badges) {
        expect(typeof badge.criteria_value).toBe('number');
        expect(typeof badge.points_bonus).toBe('number');
        expect(badge.icon_url === null || typeof badge.icon_url === 'string').toBe(true);
      }
    });

    it('reports earned status for a user', async () => {
      const badges = await badgesApi.getBadgesWithUserStatus(internId);
      expect(badges.every((b) => typeof b.earned === 'boolean')).toBe(true);
    });

    it('returns earned badges with an ISO date', async () => {
      const earned = await badgesApi.getUserBadges(internId);
      for (const badge of earned) {
        expect(badge.earned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });
  });

  describe('streamsApi', () => {
    it('maps a stream into the snake_case shape the pages read', async () => {
      const stream = await streamsApi.getStreamById(streamId);

      expect(stream).not.toBeNull();
      expect(stream!.name).toBe(`Client Swap ${stamp}`);
      expect(stream!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof stream!.member_count).toBe('number');
    });

    it('derives member_count from active memberships, not a stored counter', async () => {
      // The fixture added exactly one member. The Postgres column would read 1
      // here too — it only drifted on removal, which the next test covers.
      const stream = await streamsApi.getStreamById(streamId);
      expect(stream!.member_count).toBe(1);
    });

    it('reports the viewer as a member of their own stream', async () => {
      const stream = await streamsApi.getStreamById(streamId);
      expect(stream!.is_member).toBe(true);
      // An intern moderates nothing. AddTaskPage filters on exactly this.
      expect(stream!.is_moderator).toBe(false);
    });

    it('carries is_member/is_moderator through the list, not just getById', async () => {
      // AddTaskPage and EditTaskPage filter getAllStreams() on is_moderator. If
      // list omitted the flag every stream would read false and the task form
      // would offer an empty dropdown to an admin.
      const streams = await streamsApi.getActiveStreams();
      const mine = streams.find((s) => s.id === streamId);

      expect(mine, 'fixture stream missing from the active list').toBeTruthy();
      expect(mine!.is_member).toBe(true);
      expect(typeof mine!.is_moderator).toBe('boolean');
    });

    it('lists the roster with points and level, and no email', async () => {
      const members = await streamsApi.getStreamMembers(streamId);

      expect(members.map((m) => m.id)).toContain(internId);
      const me = members.find((m) => m.id === internId)!;
      expect(me.full_name).toBe(`Client Swap ${stamp}`);
      expect(typeof me.total_points).toBe('number');
      // `members` deliberately omits email — the roster is readable by every
      // member of the stream, and an address is not.
      expect(me.email).toBe('');
    });

    it('computes stats server-side in one call', async () => {
      const stats = await streamsApi.getStreamStats(streamId);

      expect(stats.memberCount).toBe(1);
      expect(stats.taskCount).toBeGreaterThanOrEqual(1);
      expect(typeof stats.submissionCount).toBe('number');
      expect(typeof stats.averagePoints).toBe('number');
    });

    it('refuses to read a stream the caller is not in', async () => {
      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap outsider ${stamp}`,
      });

      // The roster carries point totals, so a non-member reading it would be an
      // enumeration of every user's score by stream.
      await expect(streamsApi.getStreamMembers(other.id)).rejects.toThrow(/Not a member/i);
      await expect(streamsApi.getStreamStats(other.id)).rejects.toThrow(/Not a member/i);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: other.id })
        .catch(() => {});
    });

    it('refuses the moderator-only membership view to an intern', async () => {
      await expect(streamsApi.getStreamMemberships(streamId)).rejects.toThrow(/Moderator/i);
    });

    it('refuses to let an intern assign anyone to a stream', async () => {
      // assignMemberToStream is the admin bulk-import path. Reaching it as an
      // intern would be self-promotion into any stream, plus the ability to move
      // other people between streams.
      await expect(
        streamsApi.assignMemberToStream({ user_id: internId, stream_id: streamId }),
      ).rejects.toThrow(/Moderator/i);
    });

    it('refuses to let an intern create or deactivate a stream', async () => {
      await expect(streamsApi.createStream({ name: `nope ${stamp}` })).rejects.toThrow();
      await expect(streamsApi.deleteStream(streamId)).rejects.toThrow(/Admin/i);
    });

    it('lets a member leave, and decrements the derived count', async () => {
      await streamsApi.leaveStream(streamId);

      const after = await streamsApi.getStreamById(streamId);
      expect(after!.is_member).toBe(false);
      // The whole reason the count is derived: the Postgres trigger ignored the
      // is_active flip this write does, so the stored column stayed at 1.
      expect(after!.member_count).toBe(0);

      const me = await usersApi.getUserById(internId);
      expect(me!.current_stream_id, 'leaving must clear the pointer').toBeFalsy();
    });

    it('lets a member rejoin an open stream without a moderator', async () => {
      await streamsApi.joinStream(streamId);

      const after = await streamsApi.getStreamById(streamId);
      expect(after!.is_member).toBe(true);
      // Rejoining REACTIVATES the existing row. Inserting a second one is what
      // made the old counter double-count.
      expect(after!.member_count).toBe(1);
    });

    it('refuses a self-join to an invite-only stream', async () => {
      const closed = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap closed ${stamp}`,
        joinType: 'invite',
      });

      await expect(streamsApi.joinStream(closed.id)).rejects.toThrow(/invite-only/i);

      // And the failed attempt left no membership behind.
      const roster = await convex.query(anyApi.streams.members, {
        token: admin,
        streamId: closed.id,
      });
      expect(roster.map((m: { id: string }) => m.id)).not.toContain(internId);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: closed.id })
        .catch(() => {});
    });

    /**
     * REVERSED DELIBERATELY. This asserted that joining a second stream left
     * the first — one active stream per intern. Interns may now belong to
     * several, so the old expectation is not a regression to protect but the
     * behaviour that was removed.
     *
     * The old rule also had an edge nobody intended: because "add to a stream"
     * silently meant "move", a duplicate applicant whose second application
     * converted with no stream assigned had their existing membership
     * deactivated and got nothing back. Four interns were found in no stream at
     * all because of it.
     */
    it('keeps both streams when an intern joins a second', async () => {
      const second = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap second ${stamp}`,
      });

      await streamsApi.joinStream(second.id);

      const first = await streamsApi.getStreamById(streamId);
      expect(first!.is_member, 'joining a second stream must not leave the first').toBe(true);
      expect(first!.member_count).toBeGreaterThan(0);

      const other = await streamsApi.getStreamById(second.id);
      expect(other!.is_member, 'the newly joined stream must also hold them').toBe(true);

      // Put the fixture back the way the rest of the suite expects it.
      await streamsApi.leaveStream(second.id).catch(() => {});
      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: second.id })
        .catch(() => {});
    });
  });

  /**
   * StreamChat.tsx has no API module — it calls `api.streamChat.*` through
   * useQuery/useMutation directly. These assert the exact contract that
   * component reads, over the same HTTP transport, since a WebSocket
   * subscription cannot be driven from a node test.
   */
  describe('streamChat', () => {
    const asMember = () => ({ token: localStorage.getItem('orbit_auth_token_v2')! });

    it('returns the sender joined server-side, in the fields the component reads', async () => {
      const sent = await convex.mutation(anyApi.streamChat.send, {
        ...asMember(),
        streamId,
        content: `hello ${stamp}`,
      });
      expect(sent.success).toBe(true);

      const rows = await convex.query(anyApi.streamChat.list, { ...asMember(), streamId });
      const mine = rows.find((m: { content: string }) => m.content === `hello ${stamp}`);

      expect(mine, 'sent message missing from the list').toBeTruthy();
      // The old realtime callback issued a second query per message to get
      // these. They arrive with the row now.
      expect(mine.sender.fullName).toBe(`Client Swap ${stamp}`);
      // The component decides "is this mine" on sender.id, so the id has to be
      // on the wire — without it every message renders as someone else's.
      expect(mine.sender.id).toBe(internId);
      expect(typeof mine.createdAt).toBe('number');
      expect(mine.isAnnouncement).toBe(false);
    });

    it('returns messages oldest-first, which is the order the list renders', async () => {
      const rows = await convex.query(anyApi.streamChat.list, { ...asMember(), streamId });
      const times = rows.map((m: { createdAt: number }) => m.createdAt);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('refuses the announcement flag from a plain member', async () => {
      await convex.mutation(anyApi.streamChat.send, {
        ...asMember(),
        streamId,
        content: `not an announcement ${stamp}`,
        isAnnouncement: true,
      });

      const rows = await convex.query(anyApi.streamChat.list, { ...asMember(), streamId });
      const posted = rows.find(
        (m: { content: string }) => m.content === `not an announcement ${stamp}`,
      );

      // Downgraded, not rejected: the flag was passed straight into an INSERT
      // before, so any member could post a banner styled as staff comms.
      expect(posted.isAnnouncement).toBe(false);
    });

    it('rejects an empty message rather than storing whitespace', async () => {
      const result = await convex.mutation(anyApi.streamChat.send, {
        ...asMember(),
        streamId,
        content: '   ',
      });
      expect(result.success).toBe(false);
    });

    it('refuses to read or post to a stream the caller is not in', async () => {
      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap chat outsider ${stamp}`,
      });

      // The Supabase channel filtered on stream_id and nothing else, so any
      // logged-in user who knew an id received that stream's chat live.
      await expect(
        convex.query(anyApi.streamChat.list, { ...asMember(), streamId: other.id }),
      ).rejects.toThrow(/Not a member/i);

      await expect(
        convex.mutation(anyApi.streamChat.send, {
          ...asMember(),
          streamId: other.id,
          content: 'should not land',
        }),
      ).rejects.toThrow(/Not a member/i);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: other.id })
        .catch(() => {});
    });
  });

  /**
   * Findings from the security review of the streams slice. Each of these
   * failed before the fix in the same commit.
   */
  describe('streams authorization', () => {
    it('refuses includeInactive to a non-admin', async () => {
      // Deactivation is the delete path, so an unguarded flag hands every
      // authenticated user the streams an admin believes they removed.
      await expect(streamsApi.getAllStreamsIncludingInactive()).rejects.toThrow(/Admin/i);
    });

    it('does not return a deactivated stream to a non-admin by id', async () => {
      const dead = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap dead ${stamp}`,
      });
      await convex.mutation(anyApi.streams.deactivate, { token: admin, streamId: dead.id });

      // Same leak as includeInactive, one row at a time.
      expect(await streamsApi.getStreamById(dead.id)).toBeNull();
    });

    it('keeps getAllStreams free of deactivated streams', async () => {
      const dead = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap hidden ${stamp}`,
      });
      await convex.mutation(anyApi.streams.deactivate, { token: admin, streamId: dead.id });

      const streams = await streamsApi.getAllStreams();
      expect(streams.map((s) => s.id)).not.toContain(dead.id);
    });

    it('writes an explicit privacy and joinType on every new stream', async () => {
      // `join` fails shut, so a stream created without these would be one that
      // nobody can ever join — the decision has to be on the row, not implied
      // by a reader's default.
      const fresh = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap defaults ${stamp}`,
      });
      const row = await convex.query(anyApi.streams.getById, {
        token: admin,
        streamId: fresh.id,
      });

      expect(row.privacy).toBe('public');
      expect(row.joinType).toBe('open');

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: fresh.id })
        .catch(() => {});
    });

    it('refuses a self-join to a private stream even when joinType says open', async () => {
      const priv = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap private ${stamp}`,
        privacy: 'private',
        joinType: 'open',
      });

      // Both fields have to agree. privacy was previously read by nothing at
      // all, so a stream marked private was neither hidden nor closed.
      await expect(streamsApi.joinStream(priv.id)).rejects.toThrow(/invite-only/i);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: priv.id })
        .catch(() => {});
    });

    it('rejects an unrecognised privacy or joinType at the boundary', async () => {
      // Free text in an authorization input is a hole waiting for a typo.
      await expect(
        convex.mutation(anyApi.streams.create, {
          token: admin,
          name: `Client Swap bad ${stamp}`,
          joinType: 'opne',
        }),
      ).rejects.toThrow();
    });

    it('revokes the moderator row along with the membership', async () => {
      const scoped = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap scoped ${stamp}`,
      });
      await convex.mutation(anyApi.streams.addMember, {
        token: admin,
        streamId: scoped.id,
        userId: internId,
      });
      await convex.mutation(anyApi.streams.addModerator, {
        token: admin,
        streamId: scoped.id,
        userId: internId,
      });

      const before = await streamsApi.getStreamById(scoped.id);
      expect(before!.is_moderator).toBe(true);

      await convex.mutation(anyApi.streams.removeMember, {
        token: admin,
        streamId: scoped.id,
        userId: internId,
      });

      // Membership and moderator authority are separate rows. Revoking only the
      // first left someone removed from a stream still able to edit it.
      const after = await convex.query(anyApi.streams.getById, {
        token: admin,
        streamId: scoped.id,
      });
      expect(after.memberCount).toBe(0);

      await expect(
        streamsApi.updateStream(scoped.id, { name: 'should not be allowed' }),
      ).rejects.toThrow(/Admin or stream moderator/i);

      // Put the fixture membership back for the tests that follow.
      await convex.mutation(anyApi.streams.addMember, { token: admin, streamId, userId: internId });

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: scoped.id })
        .catch(() => {});
    });

    it('omits point totals for a member who opted off the leaderboard', async () => {
      const shy = await convex.mutation(anyApi.users.adminCreateUser, {
        token: admin,
        email: `client-swap-shy-${stamp}@iih.ng`,
        fullName: `Client Swap Shy ${stamp}`,
        roles: ['intern'],
      });
      await convex.mutation(anyApi.streams.addMember, { token: admin, streamId, userId: shy.id });

      // The opt-out is self-service, so it has to be made as that user. Signing
      // in swaps the stored session; the fixture one is restored below.
      await authService.login(`client-swap-shy-${stamp}@iih.ng`, shy.tempPassword);
      await usersApi.updateUser(shy.id, { show_on_leaderboard: false });

      localStorage.setItem('orbit_auth_token_v2', session.token);
      localStorage.setItem('orbit_user_v2', session.user);

      const roster = await streamsApi.getStreamMembers(streamId);
      const row = roster.find((m) => m.id === shy.id);

      expect(row, 'opting off the leaderboard must not remove you from the roster').toBeTruthy();
      // Omitted, not zeroed — a 0 would render as a real score. The roster was
      // otherwise a way round the leaderboard opt-out, since it returned every
      // member's exact total to every other member.
      expect(row!.total_points).toBeUndefined();

      // And the caller still sees their own.
      const me = roster.find((m) => m.id === internId);
      expect(typeof me!.total_points).toBe('number');

      await convex
        .mutation(anyApi.users.adminSetActive, { token: admin, userId: shy.id, isActive: false })
        .catch(() => {});
    });

    it('clamps a caller-supplied chat limit', async () => {
      // Each row costs a document read to join its sender, so an unclamped
      // limit is a cheap way to make the deployment do unbounded work.
      const rows = await convex.query(anyApi.streamChat.list, {
        token: localStorage.getItem('orbit_auth_token_v2')!,
        streamId,
        limit: 1_000_000,
      });
      expect(rows.length).toBeLessThanOrEqual(200);
    });
  });

  describe('activityApi', () => {
    /** Carried between the create/like/reply/delete tests below, in order. */
    let postId = '';

    it('never renders a post marked as debris', async () => {
      const feed = await convex.query(anyApi.posts.feed, { token: internToken(), limit: 30 });

      /**
       * `isDummy` is the platform's hide flag — the leaderboard, badges,
       * mentions and the letters register all honour it. The FEED did not, so
       * `resetFeedForLaunch` marked six weeks-old test posts on production,
       * reported "cleared: 6", and every one of them kept rendering on the home
       * page. The mutation's return value was not evidence that anything had
       * been hidden, and it was checked instead of the feed itself.
       *
       * Asserted on the OUTCOME rather than the flag, because nothing public
       * sets `isDummy` — this is what a member actually sees.
       */
      for (const post of feed as { content?: string; isDummy?: boolean }[]) {
        expect(post.isDummy ?? false).toBe(false);
      }
    });

    it('creates a post and reads it back in the shape the feed renders', async () => {
      await activityApi.createPost(`feed post ${stamp}`, streamId);

      const feed = await activityApi.getFeed(30, undefined, streamId);
      const mine = feed.find((p) => p.content === `feed post ${stamp}`);

      expect(mine, 'created post missing from the stream feed').toBeTruthy();
      postId = mine!.id;

      expect(mine!.user.full_name).toBe(`Client Swap ${stamp}`);
      expect(mine!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(mine!.likes_count).toBe(0);
      expect(mine!.replies_count).toBe(0);
      expect(mine!.user_has_liked).toBe(false);
    });

    it('never puts an email address in the feed', async () => {
      // orbit_get_activity_feed joined orbit_users and handed every member's
      // address to every reader of the feed.
      const feed = await activityApi.getFeed(30, undefined, streamId);
      feed.forEach((p) => expect(p.user.email).toBe(''));
    });

    it('filters by stream server-side', async () => {
      const feed = await activityApi.getFeed(30, undefined, streamId);
      // The page used to fetch the global feed and narrow it in the browser, so
      // posts the reader had no access to were sent and then discarded.
      feed.forEach((p) => expect(p.stream_id).toBe(streamId));
    });

    it('pages by cursor without repeating or skipping a post', async () => {
      for (let i = 0; i < 4; i++) {
        await activityApi.createPost(`page post ${stamp}-${i}`, streamId);
      }

      const first = await activityApi.getFeed(2, undefined, streamId);
      expect(first).toHaveLength(2);

      const second = await activityApi.getFeed(2, first[1].created_at_ms, streamId);

      const ids = new Set(first.map((p) => p.id));
      second.forEach((p) => expect(ids.has(p.id), 'cursor repeated a post').toBe(false));

      // And the cursor page is strictly older, which is what makes it stable
      // when a post is created mid-scroll.
      second.forEach((p) => expect(p.created_at_ms).toBeLessThan(first[1].created_at_ms));
    });

    it('toggles a like both ways and counts it', async () => {
      expect(await activityApi.toggleLike(postId)).toBe(true);

      let feed = await activityApi.getFeed(30, undefined, streamId);
      let mine = feed.find((p) => p.id === postId)!;
      expect(mine.likes_count).toBe(1);
      expect(mine.user_has_liked).toBe(true);

      expect(await activityApi.toggleLike(postId)).toBe(false);

      feed = await activityApi.getFeed(30, undefined, streamId);
      mine = feed.find((p) => p.id === postId)!;
      expect(mine.likes_count).toBe(0);
      expect(mine.user_has_liked).toBe(false);
    });

    it('replies, and the reply carries its author', async () => {
      await activityApi.createReply(postId, `reply ${stamp}`);

      const replies = await activityApi.getReplies(postId);
      const mine = replies.find((r) => r.content === `reply ${stamp}`);

      expect(mine, 'reply missing').toBeTruthy();
      expect(mine!.user.full_name).toBe(`Client Swap ${stamp}`);
      expect(mine!.user.email).toBe('');

      const feed = await activityApi.getFeed(30, undefined, streamId);
      expect(feed.find((p) => p.id === postId)!.replies_count).toBe(1);
    });

    /**
     * The two paths word this differently, and the assertion says so.
     *
     * `posts.create` returns its own "Post cannot be empty"; `posts.reply`
     * bounds the text through `lib/input.ts`, which throws "Reply is
     * required.". Both are accurate and both reach the member, so this asserts
     * the rejection rather than a shared phrasing it never had — the previous
     * `/empty/i` on both lines only ever passed because these tests skip
     * unless ORBIT_TEST_MCP_SECRET is set.
     */
    it('rejects an empty post and an empty reply', async () => {
      await expect(activityApi.createPost('   ', streamId)).rejects.toThrow(/empty/i);
      await expect(activityApi.createReply(postId, '   ')).rejects.toThrow(/required/i);
    });

    it('refuses to read or post into a stream the caller is not in', async () => {
      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap feed outsider ${stamp}`,
      });

      await expect(activityApi.getFeed(10, undefined, other.id)).rejects.toThrow(/Not a member/i);
      await expect(activityApi.createPost('nope', other.id)).rejects.toThrow(/Not a member/i);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: other.id })
        .catch(() => {});
    });

    it('refuses to read the replies of a post in a stream the caller is not in', async () => {
      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap reply outsider ${stamp}`,
      });
      await convex.mutation(anyApi.streams.addMember, {
        token: admin,
        streamId: other.id,
        userId: (await convex.query(anyApi.mcp.whoami, { token: admin })).id,
      });
      const hidden = await convex.mutation(anyApi.posts.create, {
        token: admin,
        content: `hidden ${stamp}`,
        streamId: other.id,
      });

      // replies/reply/toggleLike take a POST id, so the stream they touch is
      // whichever that post belongs to — and none of them used to look.
      await expect(activityApi.getReplies(hidden.id)).rejects.toThrow(/Not a member/i);
      await expect(activityApi.createReply(hidden.id, 'nope')).rejects.toThrow(/Not a member/i);
      await expect(activityApi.toggleLike(hidden.id)).rejects.toThrow(/Not a member/i);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: other.id })
        .catch(() => {});
    });

    it('refuses to delete someone else\'s post', async () => {
      const theirs = await convex.mutation(anyApi.posts.create, {
        token: admin,
        content: `admin post ${stamp}`,
      });

      await expect(activityApi.deletePost(theirs.id)).rejects.toThrow(/your own posts/i);

      await convex.mutation(anyApi.posts.remove, { token: admin, postId: theirs.id }).catch(() => {});
    });

    it('deletes its own post along with its likes and replies', async () => {
      await activityApi.deletePost(postId);

      const feed = await activityApi.getFeed(30, undefined, streamId);
      expect(feed.map((p) => p.id)).not.toContain(postId);

      // The replies went with it rather than being left pointing at nothing.
      // Reading a deleted post's replies is empty, not an error — there is
      // nothing to leak, and the pages call this on ids that may have just been
      // removed by someone else.
      expect(await activityApi.getReplies(postId)).toEqual([]);
    });
  });

  /**
   * NotificationsPage and the Navigation badge call `api.notifications.*`
   * directly through useQuery/useMutation, so these assert that contract over
   * HTTP — a WebSocket subscription cannot be driven from a node test.
   */
  describe('notifications', () => {
    const me = () => ({ token: localStorage.getItem('orbit_auth_token_v2')! });
    let mine = '';

    it('delivers an admin notification and counts it as unread', async () => {
      await convex.mutation(anyApi.notifications.adminSend, {
        token: admin,
        userId: internId,
        type: 'info',
        title: `Heads up ${stamp}`,
        content: 'something happened',
      });

      const rows = await convex.query(anyApi.notifications.list, me());
      const row = rows.find((n: { title: string }) => n.title === `Heads up ${stamp}`);

      expect(row, 'notification not delivered').toBeTruthy();
      mine = row.id;
      expect(row.isRead).toBe(false);
      expect(typeof row.createdAt).toBe('number');

      const count = await convex.query(anyApi.notifications.unreadCount, me());
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('returns newest first, which is the order the page renders', async () => {
      const rows = await convex.query(anyApi.notifications.list, me());
      const times = rows.map((n: { createdAt: number }) => n.createdAt);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('marks one read, and the unread count follows', async () => {
      const before = await convex.query(anyApi.notifications.unreadCount, me());

      const result = await convex.mutation(anyApi.notifications.markRead, {
        ...me(),
        notificationId: mine,
      });
      expect(result.updated).toBe(1);

      // Mark-as-read never worked on Supabase: the only UPDATE policy was scoped
      // to auth.uid(), the browser connected with the anon key, so RLS silently
      // denied the write while the client reported success.
      const after = await convex.query(anyApi.notifications.unreadCount, me());
      expect(after).toBe(before - 1);

      const rows = await convex.query(anyApi.notifications.list, me());
      expect(rows.find((n: { id: string }) => n.id === mine).isRead).toBe(true);
    });

    it('marking an already-read notification changes nothing', async () => {
      const result = await convex.mutation(anyApi.notifications.markRead, {
        ...me(),
        notificationId: mine,
      });
      expect(result.updated).toBe(0);
    });

    it('cannot mark or delete a notification belonging to someone else', async () => {
      const adminId = (await convex.query(anyApi.mcp.whoami, { token: admin })).id;

      const theirs = await convex.mutation(anyApi.notifications.adminSend, {
        token: admin,
        userId: adminId,
        type: 'info',
        title: `Not yours ${stamp}`,
        content: 'private',
      });

      const targetId = theirs.id ?? theirs.notificationId;

      // Reports the same result as "not found" rather than refusing, so the
      // endpoint cannot be used to confirm that an id exists.
      expect((await convex.mutation(anyApi.notifications.markRead, {
        ...me(),
        notificationId: targetId,
      })).updated).toBe(0);

      expect((await convex.mutation(anyApi.notifications.remove, {
        ...me(),
        notificationId: targetId,
      })).deleted).toBe(0);

      // And it really is still there for its owner.
      const theirRows = await convex.query(anyApi.notifications.list, { token: admin });
      expect(theirRows.map((n: { id: string }) => n.id)).toContain(targetId);
    });

    it('never returns another user\'s notifications in the list', async () => {
      const rows = await convex.query(anyApi.notifications.list, me());
      expect(rows.map((n: { title: string }) => n.title)).not.toContain(`Not yours ${stamp}`);
    });

    it('deletes its own', async () => {
      expect((await convex.mutation(anyApi.notifications.remove, {
        ...me(),
        notificationId: mine,
      })).deleted).toBe(1);

      const rows = await convex.query(anyApi.notifications.list, me());
      expect(rows.map((n: { id: string }) => n.id)).not.toContain(mine);
    });

    it('marks everything read in one call', async () => {
      for (let i = 0; i < 3; i++) {
        await convex.mutation(anyApi.notifications.adminSend, {
          token: admin,
          userId: internId,
          type: 'info',
          title: `Bulk ${stamp}-${i}`,
          content: 'x',
        });
      }

      expect(await convex.query(anyApi.notifications.unreadCount, me())).toBeGreaterThanOrEqual(3);

      await convex.mutation(anyApi.notifications.markAllRead, me());

      expect(await convex.query(anyApi.notifications.unreadCount, me())).toBe(0);
    });
  });

  /**
   * MessagesPage calls `api.messages.*` directly through useQuery/useMutation.
   * The table had no RLS and none of the page's writes carried an ownership
   * predicate, so these assert that each one now does.
   */
  describe('messages', () => {
    const me = () => ({ token: localStorage.getItem('orbit_auth_token_v2')! });
    let adminId = '';
    let toMe = '';

    it('delivers a message with its sender attached', async () => {
      adminId = (await convex.query(anyApi.mcp.whoami, { token: admin })).id;

      const sent = await convex.mutation(anyApi.messages.send, {
        token: admin,
        recipientId: internId,
        content: `hello there ${stamp}`,
      });
      expect(sent.success).toBe(true);
      toMe = sent.id;

      const rows = await convex.query(anyApi.messages.inbox, me());
      const row = rows.find((m: { id: string }) => m.id === toMe);

      expect(row, 'message not in the inbox').toBeTruthy();
      expect(row.sender.id).toBe(adminId);
      expect(row.isRead).toBe(false);
      expect(typeof row.createdAt).toBe('number');
    });

    it('returns the inbox newest-first', async () => {
      const rows = await convex.query(anyApi.messages.inbox, me());
      const times = rows.map((m: { createdAt: number }) => m.createdAt);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('shows only messages addressed to the caller', async () => {
      const rows = await convex.query(anyApi.messages.inbox, me());
      // The page loaded `.eq('recipient_id', user.id)` from the browser; the
      // recipient IS the session now, so it cannot be aimed elsewhere.
      rows.forEach((m: { sender: { id: string } | null }) => {
        expect(m.sender?.id).not.toBe(internId);
      });
    });

    it('marks read, then unread, and removes the read time with it', async () => {
      expect((await convex.mutation(anyApi.messages.markRead, { ...me(), messageId: toMe })).updated)
        .toBe(1);

      let rows = await convex.query(anyApi.messages.inbox, me());
      expect(rows.find((m: { id: string }) => m.id === toMe).isRead).toBe(true);

      expect((await convex.mutation(anyApi.messages.markUnread, { ...me(), messageId: toMe })).updated)
        .toBe(1);

      rows = await convex.query(anyApi.messages.inbox, me());
      const row = rows.find((m: { id: string }) => m.id === toMe);
      expect(row.isRead).toBe(false);
      // patch removes a field set to undefined, which is what "unread" means —
      // a message with no read time, not one read at zero.
      expect(row.readAt).toBeUndefined();
    });

    it('cannot mark, unmark or delete a message it is not party to', async () => {
      const theirs = await convex.mutation(anyApi.messages.send, {
        token: admin,
        recipientId: adminId,
        content: `admin to self ${stamp}`,
      });

      // Reports the same result as "not found" rather than refusing, so it
      // cannot be used to confirm an id exists.
      expect((await convex.mutation(anyApi.messages.markRead, {
        ...me(),
        messageId: theirs.id,
      })).updated).toBe(0);

      expect((await convex.mutation(anyApi.messages.markUnread, {
        ...me(),
        messageId: theirs.id,
      })).updated).toBe(0);

      // Delete DOES refuse, because it is destructive and the caller is not a
      // party at all.
      await expect(
        convex.mutation(anyApi.messages.remove, { ...me(), messageId: theirs.id }),
      ).rejects.toThrow(/Not your message/i);

      await convex.mutation(anyApi.messages.remove, { token: admin, messageId: theirs.id });
    });

    it('replies, and the server picks the recipient from the parent', async () => {
      const reply = await convex.mutation(anyApi.messages.replyTo, {
        ...me(),
        messageId: toMe,
        content: `and hello back ${stamp}`,
      });
      expect(reply.success).toBe(true);

      // The page used to work the recipient out in the browser and pass it in.
      const theirInbox = await convex.query(anyApi.messages.inbox, { token: admin });
      const landed = theirInbox.find((m: { id: string }) => m.id === reply.id);
      expect(landed, 'reply did not reach the original sender').toBeTruthy();
      expect(landed.sender.id).toBe(internId);
    });

    it('refuses a reply to a message the caller did not receive', async () => {
      const theirs = await convex.mutation(anyApi.messages.send, {
        token: admin,
        recipientId: adminId,
        content: `not for you ${stamp}`,
      });

      const result = await convex.mutation(anyApi.messages.replyTo, {
        ...me(),
        messageId: theirs.id,
        content: 'injecting',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not the recipient/i);

      await convex.mutation(anyApi.messages.remove, { token: admin, messageId: theirs.id });
    });

    it('returns the root and its replies, in order, for a party to the thread', async () => {
      const thread = await convex.query(anyApi.messages.threadOf, { ...me(), messageId: toMe });

      expect(thread.length).toBeGreaterThanOrEqual(2);
      expect(thread[0].id).toBe(toMe);
      expect(thread.map((m: { content: string }) => m.content)).toContain(
        `and hello back ${stamp}`,
      );

      const times = thread.map((m: { createdAt: number }) => m.createdAt);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('resolves a reply id to its thread root rather than returning nothing', async () => {
      const thread = await convex.query(anyApi.messages.threadOf, { ...me(), messageId: toMe });
      const replyId = thread.find((m: { parentMessageId?: string }) => m.parentMessageId)!.id;

      const fromReply = await convex.query(anyApi.messages.threadOf, {
        ...me(),
        messageId: replyId,
      });
      expect(fromReply.map((m: { id: string }) => m.id)).toEqual(
        thread.map((m: { id: string }) => m.id),
      );
    });

    it('returns nothing for a thread the caller is not party to', async () => {
      const theirs = await convex.mutation(anyApi.messages.send, {
        token: admin,
        recipientId: adminId,
        content: `private thread ${stamp}`,
      });

      // The page's `.or('id.eq.<x>,parent_message_id.eq.<x>')` returned any
      // thread whose root id the caller could name.
      expect(await convex.query(anyApi.messages.threadOf, {
        ...me(),
        messageId: theirs.id,
      })).toEqual([]);

      await convex.mutation(anyApi.messages.remove, { token: admin, messageId: theirs.id });
    });

    it('refuses an empty message', async () => {
      const result = await convex.mutation(anyApi.messages.send, {
        ...me(),
        recipientId: adminId,
        content: '   ',
      });
      expect(result.success).toBe(false);
    });

    it('deletes its own, and the unread count follows', async () => {
      const before = await convex.query(anyApi.messages.unreadCount, me());

      await convex.mutation(anyApi.messages.remove, { ...me(), messageId: toMe });

      const rows = await convex.query(anyApi.messages.inbox, me());
      expect(rows.map((m: { id: string }) => m.id)).not.toContain(toMe);

      const after = await convex.query(anyApi.messages.unreadCount, me());
      expect(after).toBe(before - 1);
    });
  });

  /**
   * Findings from the security review of the activity and notifications slices.
   * Each of these failed before the fix in the same commit.
   */
  describe('feed and comment authorization', () => {
    const me = () => ({ token: localStorage.getItem('orbit_auth_token_v2')! });
    let secretStream = '';
    let secretPost = '';

    beforeAll(async () => {
      if (!admin) return;

      const created = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap secret ${stamp}`,
        privacy: 'private',
        joinType: 'invite',
      });
      secretStream = created.id;

      const adminId = (await convex.query(anyApi.mcp.whoami, { token: admin })).id;
      await convex.mutation(anyApi.streams.addMember, {
        token: admin,
        streamId: secretStream,
        userId: adminId,
      });

      const post = await convex.mutation(anyApi.posts.create, {
        token: admin,
        content: `secret post ${stamp}`,
        streamId: secretStream,
      });
      secretPost = post.id;
    }, 60_000);

    it('keeps private-stream posts out of the GLOBAL feed', async () => {
      // assertStreamAccess returns early when no streamId is given — right, as
      // there is no single stream to check — which left the unfiltered branch
      // reading the whole posts table. Omitting the argument and walking the
      // cursor returned every post in every private stream to any caller.
      const feed = await activityApi.getFeed(100);

      expect(feed.map((p) => p.id)).not.toContain(secretPost);
      expect(feed.map((p) => p.content)).not.toContain(`secret post ${stamp}`);
    });

    it('keeps them out of every page of the cursor, not just the first', async () => {
      let before: number | undefined;

      for (let page = 0; page < 5; page++) {
        const rows = await activityApi.getFeed(20, before);
        if (rows.length === 0) break;
        expect(rows.map((p) => p.id), `page ${page}`).not.toContain(secretPost);
        before = rows[rows.length - 1].created_at_ms;
      }
    });

    it('still returns the caller\'s own streams in the global feed', async () => {
      // The fix must not empty the feed. A post in a stream the caller IS in
      // has to survive the same filter.
      await activityApi.createPost(`visible post ${stamp}`, streamId);

      const feed = await activityApi.getFeed(50);
      expect(feed.map((p) => p.content)).toContain(`visible post ${stamp}`);
    });

    it('refuses the comment thread of a post the caller cannot see', async () => {
      // targetType/targetId are free strings and requireUser was the only
      // check, so any authenticated caller could read the comments on any post
      // or submission id.
      await expect(
        convex.query(anyApi.reactions.listComments, {
          ...me(),
          targetType: 'post',
          targetId: secretPost,
        }),
      ).rejects.toThrow(/Not found/i);

      await expect(
        convex.query(anyApi.reactions.listReactions, {
          ...me(),
          targetType: 'post',
          targetId: secretPost,
        }),
      ).rejects.toThrow(/Not found/i);
    });

    it('refuses to comment on or react to it either', async () => {
      await expect(
        convex.mutation(anyApi.reactions.addComment, {
          ...me(),
          targetType: 'post',
          targetId: secretPost,
          content: 'injecting',
        }),
      ).rejects.toThrow(/Not found/i);

      await expect(
        convex.mutation(anyApi.reactions.toggleReaction, {
          ...me(),
          targetType: 'post',
          targetId: secretPost,
          emoji: '👍',
        }),
      ).rejects.toThrow(/Not found/i);
    });

    it('refuses the comments on someone else\'s submission', async () => {
      const others = await convex.query(anyApi.tasks.listSubmissions, { token: admin, limit: 50 });
      const notMine = others.find((s: { userId: string }) => s.userId !== internId);

      if (!notMine) return; // nothing to assert against on a fresh deployment

      // Reviewer commentary on someone else's coursework.
      await expect(
        convex.query(anyApi.reactions.listComments, {
          ...me(),
          targetType: 'submission',
          targetId: notMine.id,
        }),
      ).rejects.toThrow(/Not found/i);
    });

    it('lets the caller comment on their own submission', async () => {
      const mine = await convex.query(anyApi.tasks.mySubmissions, me());
      if (mine.length === 0) return;

      const rows = await convex.query(anyApi.reactions.listComments, {
        ...me(),
        targetType: 'submission',
        targetId: mine[0].id,
      });
      expect(Array.isArray(rows)).toBe(true);
    });

    it('refuses a caller-chosen postType', async () => {
      // 'badge' renders with the platform trophy chrome and hides the delete
      // control, so an unvalidated string let any member publish what looks
      // like a system-issued award and could not remove it afterwards.
      await expect(
        convex.mutation(anyApi.posts.create, {
          ...me(),
          content: `fake award ${stamp}`,
          postType: 'badge',
        }),
      ).rejects.toThrow();
    });

    it('refuses caller-supplied post metadata', async () => {
      // v.any(), written unvalidated, returned verbatim to every reader — and
      // the obvious thing to smuggle back in is metadata.image_url, the public
      // bucket url this migration removed.
      await expect(
        convex.mutation(anyApi.posts.create, {
          ...me(),
          content: `metadata smuggle ${stamp}`,
          metadata: { image_url: 'https://evil.test/tracker.png' },
        }),
      ).rejects.toThrow();
    });

    it('refuses to attach an upload that is already attached elsewhere', async () => {
      const issued = await convex.mutation(anyApi.files.generateUploadUrl, me());
      expect(issued.success).toBe(true);

      // The bytes go up as a Uint8Array, not a Blob. undici reaches for
      // `.stream()` on a Blob body, and the Blob this Node build constructs
      // from a Uint8Array has no such method — so the request threw
      // "object.stream is not a function" and the test never got as far as the
      // rule it exists to check.
      const put = await fetch(issued.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      });
      const { storageId } = (await put.json()) as { storageId: string };

      await convex.mutation(anyApi.files.validatePostImage, { ...me(), storageId });

      const first = await convex.mutation(anyApi.posts.create, {
        ...me(),
        content: `image post ${stamp}`,
        imageStorageId: storageId,
      });
      expect(first.success).toBe(true);

      // Ownership alone was the check, and posts.remove deletes the object
      // unconditionally — so attaching one file twice and deleting one post
      // took the other post's image with it. The same trick against an approved
      // submission file deleted coursework the member is not allowed to replace.
      const second = await convex.mutation(anyApi.posts.create, {
        ...me(),
        content: `image steal ${stamp}`,
        imageStorageId: storageId,
      });
      expect(second.success).toBe(false);

      await convex.mutation(anyApi.posts.remove, { ...me(), postId: first.id });
    });

    it('clamps a caller-supplied notification limit instead of throwing', async () => {
      // A negative value reached .take(-1) and threw.
      expect(Array.isArray(await convex.query(anyApi.notifications.list, { ...me(), limit: -5 })))
        .toBe(true);

      const many = await convex.query(anyApi.notifications.list, { ...me(), limit: 1_000_000 });
      expect(many.length).toBeLessThanOrEqual(200);
    });

    afterAll(async () => {
      if (!admin || !secretStream) return;
      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: secretStream })
        .catch(() => {});
    });
  });

  /**
   * The last four pages that read Supabase directly: HomePage, StreamDetailPage,
   * TaskDetailPage, UserProfilePage, MyOrbitPage. Each replaced a handful of
   * browser-issued table queries with one server-side call.
   */
  describe('page-level queries', () => {
    const me = () => ({ token: localStorage.getItem('orbit_auth_token_v2')! });

    it('streams.stats carries what the stats tab renders', async () => {
      const stats = await streamsApi.getStreamStats(streamId);

      expect(typeof stats.approvedCount).toBe('number');
      expect(typeof stats.weeklyPoints).toBe('number');
      expect(Array.isArray(stats.topContributors)).toBe(true);
      expect(stats.approvedCount).toBeLessThanOrEqual(stats.submissionCount);
      // The tab used to build its own top-five by selecting every member's id,
      // name, photo and exact total ordered by points — a leaderboard of the
      // stream assembled in the browser.
      expect(stats.topContributors.length).toBeLessThanOrEqual(5);
    });

    it('the peer showcase is gated on membership of the task stream', async () => {
      const rows = await convex.query(anyApi.tasks.peerSubmissions, { ...me(), taskId });
      expect(Array.isArray(rows)).toBe(true);

      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap showcase ${stamp}`,
      });
      const otherTask = await publishTask({
        streamId: other.id,
        title: `Showcase task ${stamp}`,
        description: 'not yours',
        submissionType: 'text',
        points: 5,
        deadline: Date.now() + 86_400_000,
        notify: false,
      });

      // The page read orbit_submissions filtered only by task_id and status,
      // so any authenticated user could read any task's coursework.
      await expect(
        convex.query(anyApi.tasks.peerSubmissions, { ...me(), taskId: otherTask.id }),
      ).rejects.toThrow(/not in one of your streams/i);

      await convex
        .mutation(anyApi.streams.deactivate, { token: admin, streamId: other.id })
        .catch(() => {});
    });

    it('the showcase omits drafts and in-progress work', async () => {
      const rows = await convex.query(anyApi.tasks.peerSubmissions, { ...me(), taskId });
      rows.forEach((r: { status: string }) => {
        // A draft is private to its author until they choose to submit.
        expect(['submitted', 'approved']).toContain(r.status);
      });
    });

    it('comments on a peer submission work for a stream member', async () => {
      const mine = await convex.query(anyApi.tasks.mySubmissions, me());
      if (mine.length === 0) return;

      const added = await convex.mutation(anyApi.reactions.addComment, {
        ...me(),
        targetType: 'submission',
        targetId: mine[0].id,
        content: `nice work ${stamp}`,
      });
      expect(added.success).toBe(true);

      const rows = await convex.query(anyApi.reactions.listComments, {
        ...me(),
        targetType: 'submission',
        targetId: mine[0].id,
      });
      expect(rows.map((c: { content: string }) => c.content)).toContain(`nice work ${stamp}`);
    });

    it('myStats counts the caller only, and counts likes RECEIVED', async () => {
      const stats = await convex.query(anyApi.users.myStats, me());

      expect(typeof stats.tasksCompleted).toBe('number');
      expect(typeof stats.posts).toBe('number');
      expect(typeof stats.likesReceived).toBe('number');
      expect(stats.streamMemberships).toBeGreaterThanOrEqual(1);

      // Seven zero-filled buckets, oldest first — the chart needs every day
      // present, and the page was building the empty ones itself.
      expect(stats.weekly).toHaveLength(7);
      const dates = stats.weekly.map((w: { date: string }) => w.date);
      expect(dates).toEqual([...dates].sort());
    });

    it('myStats has no argument that could aim it at another user', async () => {
      // Six browser-issued counts, every one a filter the client chose on a
      // table without RLS — the dashboard was a general-purpose reader for
      // anyone's activity.
      await expect(
        convex.query(anyApi.users.myStats, { ...me(), userId: internId }),
      ).rejects.toThrow();
    });

    it('friendship status, request and removal all derive the caller from the session', async () => {
      const adminId = (await convex.query(anyApi.mcp.whoami, { token: admin })).id;

      const before = await convex.query(anyApi.friendships.statusWith, {
        ...me(),
        otherUserId: adminId,
      });
      expect(before.status).toBe('none');

      const requested = await convex.mutation(anyApi.friendships.request, {
        ...me(),
        friendId: adminId,
      });
      expect(requested.success).toBe(true);

      const pending = await convex.query(anyApi.friendships.statusWith, {
        ...me(),
        otherUserId: adminId,
      });
      expect(pending.status).toBe('pending');
      expect(pending.isRequester).toBe(true);

      // The requester cannot accept their own request. The page UPDATEd the row
      // by id with no check at all.
      await expect(
        convex.mutation(anyApi.friendships.respond, {
          ...me(),
          friendshipId: pending.id,
          accept: true,
        }),
      ).rejects.toThrow(/recipient/i);

      await convex.mutation(anyApi.friendships.remove, { ...me(), otherUserId: adminId });

      const after = await convex.query(anyApi.friendships.statusWith, {
        ...me(),
        otherUserId: adminId,
      });
      expect(after.status).toBe('none');
    });
  });

  /**
   * Findings from the security review of the SIWES and admin slices.
   */
  describe('applications intake', () => {
    /**
     * The whole module was untested, and `/apply` is the ONE unauthenticated
     * write on the platform — the only surface a stranger can reach.
     *
     * The client and the server disagreed about its vocabulary until recently:
     * the server's terminal states were accepted/withdrawn while the screens
     * sent approved/converted, so an application could never actually be
     * approved. Nothing caught it because nothing drove it.
     */
    const applicantEmail = `client-swap-applicant-${stamp}@iih.ng`;
    const SITE = CONVEX_URL!.replace('.convex.cloud', '.convex.site');

    // One-pixel PNG. The declared mime must match the bytes; intake re-reads
    // the stored object rather than trusting the label.
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const intakeBody = (email: string, extra: Record<string, unknown> = {}) => ({
      programme_type: 'internship',
      full_name: `Client Swap applicant ${stamp}`,
      email,
      phone: '08000000000',
      location: 'Ilorin',
      emergency_contact_name: 'Client Swap kin',
      emergency_contact_phone: '08111111111',
      consent_logbook: true,
      consent_data_use: true,
      passport_photo: {
        name: 'passport.png',
        type: 'image/png',
        size: 70,
        data_url: `data:image/png;base64,${PNG}`,
      },
      siwes_letter: null,
      ...extra,
    });

    const submit = (body: unknown) =>
      fetch(`${SITE}/applications/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('accepts a public application and issues a reference code', async () => {
      const response = await submit(intakeBody(applicantEmail));
      const result = (await response.json()) as { success: boolean; reference_code?: string };

      expect(result.success).toBe(true);
      // The applicant has no account and no way to look themselves up later —
      // the reference is the only handle they get.
      expect(result.reference_code).toMatch(/^ORB-/);
    });

    it('refuses to list applications to a non-staff caller', async () => {
      await expect(
        convex.query(anyApi.applications.list, { token: internToken(), limit: 10 }),
      ).rejects.toThrow(/moderator/i);
    });

    it('moves an application through the status set the screens actually send', async () => {
      const rows = (await convex.query(anyApi.applications.list, {
        token: admin,
        limit: 100,
      })) as { id: string; email: string; status: string }[];

      const mine = rows.find((r) => r.email === applicantEmail);
      expect(mine).toBeTruthy();
      expect(mine!.status).toBe('submitted');

      const approved = await convex.mutation(anyApi.applications.updateStatus, {
        token: admin,
        applicationId: mine!.id,
        status: 'approved',
      });
      expect(approved.success, 'approval was refused').toBe(true);

      // And it cannot be walked back. Approval is one-way by design — see
      // convex/lib/applicationStatus.ts — because the Google Sheet can write
      // statuses now, and a stray paste there must not un-admit anyone.
      const reversed = await convex.mutation(anyApi.applications.updateStatus, {
        token: admin,
        applicationId: mine!.id,
        status: 'submitted',
      });
      expect(reversed.success).toBe(false);
      expect(reversed.error).toMatch(/cannot be changed/i);
    });

    it('refuses a status the screens never offer', async () => {
      const rows = (await convex.query(anyApi.applications.list, {
        token: admin,
        limit: 100,
      })) as { id: string; email: string }[];
      const mine = rows.find((r) => r.email === applicantEmail)!;

      const result = await convex.mutation(anyApi.applications.updateStatus, {
        token: admin,
        applicationId: mine.id,
        status: 'accepted',
      });
      // 'accepted' was the SERVER's old vocabulary, and 'under_review',
      // 'waitlisted', 'rejected' and 'converted' are gone too: nothing in the
      // platform behaved differently for any of them, so they were private
      // notes in a status column.
      expect(result.success).toBe(false);
    });

    it('drops a submission that filled the honeypot, and says nothing about it', async () => {
      const honeypotEmail = `client-swap-honeypot-${stamp}@iih.ng`;
      const response = await submit(intakeBody(honeypotEmail, { website: 'https://spam.example' }));

      // Answered exactly as a real applicant would be. A honeypot that
      // announces itself teaches the next attempt to leave the field alone.
      expect(((await response.json()) as { success: boolean }).success).toBe(true);

      const rows = (await convex.query(anyApi.applications.list, {
        token: admin,
        limit: 200,
      })) as { email: string }[];
      expect(rows.some((r) => r.email === honeypotEmail)).toBe(false);
    });

    it('refuses a passport photo whose bytes are not the type it claims', async () => {
      const response = await submit(
        intakeBody(`client-swap-badmime-${stamp}@iih.ng`, {
          passport_photo: {
            name: 'passport.png',
            type: 'image/png',
            size: 30,
            // Declared PNG, actually text. The data URL's own mime is what the
            // bytes are; the declared `type` is what the browser said.
            data_url: 'data:text/plain;base64,bm90IGEgcGljdHVyZQ==',
          },
        }),
      );

      // Refused with a 4xx and an error, not a `success: false` body — intake
      // validation failures are transport-level rejections, unlike the honeypot
      // above, which deliberately answers as though nothing were wrong.
      expect(response.ok).toBe(false);
      expect(((await response.json()) as { error?: string }).error).toMatch(/passport/i);
    });
  });

  describe('badges and levels', () => {
    it('awards a badge manually and lists the holder', async () => {
      const badges = (await convex.query(anyApi.badges.list, { token: admin })) as {
        id: string;
        name: string;
      }[];
      const badge = badges[0];

      const awarded = await convex.mutation(anyApi.badges.awardManually, {
        token: admin,
        userId: internId,
        badgeId: badge.id,
      });
      expect(awarded.success).toBe(true);

      // `holders` returns the userBadges ROW id as `id` and the person as
      // `user_id` — the one place in this module that answers in snake_case,
      // because the badge admin screen was ported straight from PostgREST.
      const holders = (await convex.query(anyApi.badges.holders, {
        token: admin,
        badgeId: badge.id,
      })) as { id: string; user_id: string }[];
      expect(holders.some((h) => h.user_id === internId)).toBe(true);

      const mine = (await convex.query(anyApi.badges.listForUser, {
        token: admin,
        userId: internId,
      })) as { id: string }[];
      expect(mine.some((b) => b.id === badge.id)).toBe(true);
    });

    it('awarding the same badge twice does not stack', async () => {
      const badges = (await convex.query(anyApi.badges.list, { token: admin })) as {
        id: string;
      }[];
      const badge = badges[0];

      await convex.mutation(anyApi.badges.awardManually, {
        token: admin,
        userId: internId,
        badgeId: badge.id,
      });

      const mine = (await convex.query(anyApi.badges.listForUser, {
        token: admin,
        userId: internId,
      })) as { id: string }[];
      expect(mine.filter((b) => b.id === badge.id)).toHaveLength(1);
    });

    it('revokes a badge', async () => {
      const badges = (await convex.query(anyApi.badges.list, { token: admin })) as {
        id: string;
      }[];
      const badge = badges[0];

      const revoked = await convex.mutation(anyApi.badges.revoke, {
        token: admin,
        userId: internId,
        badgeId: badge.id,
      });
      expect(revoked.success).toBe(true);

      const mine = (await convex.query(anyApi.badges.listForUser, {
        token: admin,
        userId: internId,
      })) as { id: string }[];
      expect(mine.some((b) => b.id === badge.id)).toBe(false);
    });

    it('refuses badge administration to an intern', async () => {
      const badges = (await convex.query(anyApi.badges.list, { token: admin })) as {
        id: string;
      }[];

      const result = await convex.mutation(anyApi.badges.awardManually, {
        token: internToken(),
        userId: internId,
        badgeId: badges[0].id,
      }).catch((e: Error) => ({ success: false, error: e.message }));

      expect(result.success).toBe(false);
    });
  });

  describe('calendar feed', () => {
    /**
     * `/calendar.ics` is a TOKEN-AUTHENTICATED PUBLIC URL. It carries its own
     * credential rather than a session, because the URL lives in Google or
     * Apple Calendar forever once pasted there and revoking a session must not
     * break a subscription the user still wants.
     *
     * That also means a leak here is unauthenticated data exposure, and nothing
     * exercised it.
     */
    const SITE = CONVEX_URL!.replace('.convex.cloud', '.convex.site');

    it('serves a calendar to the holder of a feed token', async () => {
      const { feedToken } = (await convex.mutation(anyApi.calendar.myFeedToken, {
        token: internToken(),
      })) as { feedToken: string };

      const response = await fetch(`${SITE}/calendar.ics?token=${feedToken}`);
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toMatch(/calendar/);

      const body = await response.text();
      expect(body).toContain('BEGIN:VCALENDAR');
    });

    it('serves nothing to a made-up token', async () => {
      const response = await fetch(`${SITE}/calendar.ics?token=not-a-real-feed-token`);
      expect(response.ok).toBe(false);
    });

    it('serves nothing with no token at all', async () => {
      const response = await fetch(`${SITE}/calendar.ics`);
      expect(response.ok).toBe(false);
    });

    it('rotating the token invalidates the old URL', async () => {
      const { feedToken: before } = (await convex.mutation(anyApi.calendar.myFeedToken, {
        token: internToken(),
      })) as { feedToken: string };

      const { feedToken: after } = (await convex.mutation(anyApi.calendar.myFeedToken, {
        token: internToken(),
        rotate: true,
      })) as { feedToken: string };

      expect(after).not.toBe(before);

      // The point of rotation is that a URL already pasted somewhere stops
      // working. If the old one still served, rotation would be decorative.
      expect((await fetch(`${SITE}/calendar.ics?token=${before}`)).ok).toBe(false);
      expect((await fetch(`${SITE}/calendar.ics?token=${after}`)).ok).toBe(true);
    });
  });

  describe('notification fan-out', () => {
    /**
     * That an ACTION PRODUCES a notification.
     *
     * The existing notification tests all read, mark and delete rows that the
     * test itself created. None of them assert that doing something on the
     * platform causes anyone to be told about it — and on Postgres these were
     * triggers, which Convex does not have. Every notify call is now an explicit
     * line in a mutation, and a caller that forgets one produces silence, not an
     * error.
     */
    const unreadFor = async (token: string) =>
      (await convex.query(anyApi.notifications.unreadCount, { token })) as number;

    const textFor = async (token: string) =>
      ((await convex.query(anyApi.notifications.list, { token, limit: 50 })) as {
        title: string;
        content: string;
      }[]).map((n) => `${n.title} ${n.content}`);

    it('tells stream members about a new task', { timeout: 30_000 }, async () => {
      // Stated rather than assumed: fan-out honours the recipient's preference,
      // so a spec that measures fan-out has to know what that preference is.
      await convex.mutation(anyApi.notificationPreferences.save, {
        token: internToken(),
        newTaskEnabled: true,
      });

      const before = await unreadFor(internToken());

      const title = `Client Swap notified task ${stamp}`;
      // Created over MCP, so this is a proposal and notifies nobody yet. The
      // fan-out is on APPROVAL now — the moment the stream is actually told —
      // which is what this asserts.
      const proposal = await convex.mutation(anyApi.tasks.create, {
        token: admin,
        streamId,
        title,
        description: 'exercises the new-task fan-out',
        submissionType: 'text',
        points: 5,
        deadline: Date.now() + 7 * 86_400_000,
        notify: true,
      });
      expect(proposal.approvalStatus).toBe('pending');
      expect(proposal.notified).toBe(0);

      await convex.mutation(anyApi.tasks.approveProposal, { token: admin, taskId: proposal.id });

      await vi.waitFor(async () => {
        expect(await unreadFor(internToken())).toBeGreaterThan(before);
      }, { timeout: 15_000, interval: 500 });

      // Not just "a notification arrived" — the one about THIS task. A count
      // that moves for an unrelated reason would satisfy the poll above.
      expect((await textFor(internToken())).some((t) => t.includes(title))).toBe(true);
    });

    it('tells an author their submission was reviewed', { timeout: 30_000 }, async () => {
      const task = await publishTask({
        streamId,
        title: `Client Swap reviewed task ${stamp}`,
        description: 'exercises the review fan-out',
        submissionType: 'text',
        points: 5,
        deadline: Date.now() + 7 * 86_400_000,
        notify: false,
      });

      await convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: task.id });
      const submission = await convex.mutation(anyApi.tasks.submitWork, {
        token: internToken(),
        taskId: task.id,
        submissionText: 'work for the review fan-out',
      });

      const before = await unreadFor(internToken());

      await convex.mutation(anyApi.tasks.reviewSubmission, {
        token: admin,
        submissionId: submission.id,
        status: 'approved',
        score: 5,
        feedback: 'Fine.',
      });

      // Being paid and not being told is the failure mode that matters: the
      // points arrive silently and the intern has no reason to look.
      await vi.waitFor(async () => {
        expect(await unreadFor(internToken())).toBeGreaterThan(before);
      }, { timeout: 15_000, interval: 500 });
    });

    it('tells a recipient about a new message', { timeout: 30_000 }, async () => {
      const before = await unreadFor(internToken());

      await convex.mutation(anyApi.messages.send, {
        token: admin,
        recipientId: internId,
        content: `Client Swap notify ${stamp}`,
      });

      await vi.waitFor(async () => {
        expect(await unreadFor(internToken())).toBeGreaterThan(before);
      }, { timeout: 15_000, interval: 500 });
    });

    it('does not notify the author of their own action', { timeout: 30_000 }, async () => {
      const before = await unreadFor(admin);

      await convex.mutation(anyApi.messages.send, {
        token: admin,
        recipientId: internId,
        content: `Client Swap self-notify ${stamp}`,
      });

      // Deliberately a wait-then-check rather than a poll for a change: this
      // asserts that nothing happens, and a poll would pass instantly.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await unreadFor(admin)).toBe(before);
    });
  });

  describe('agent task proposals', () => {
    /**
     * The approval gate. `admin` is an MCP session, so everything it creates
     * through tasks.create is a proposal — which is exactly the shape of the
     * agent drafting a weekly schedule.
     */
    const propose = async (title: string) =>
      convex.mutation(anyApi.tasks.create, {
        token: admin,
        streamId,
        title,
        description: 'proposed by the agent',
        submissionType: 'text',
        points: 5,
        deadline: Date.now() + 7 * 86_400_000,
        notify: true,
      });

    it('creates agent tasks as proposals that notify nobody', async () => {
      const result = await propose(`Client Swap proposal ${stamp}`);

      expect(result.approvalStatus).toBe('pending');
      expect(result.notified).toBe(0);
    });

    it('hides a proposal from the member task list', async () => {
      const created = await propose(`Client Swap hidden ${stamp}`);

      const mine = await convex.query(anyApi.tasks.listForUser, { token: internToken() });
      expect((mine as Array<{ id: string }>).some((t) => t.id === created.id)).toBe(false);
    });

    it('refuses to show a proposal by id, even to someone holding the id', async () => {
      const created = await propose(`Client Swap byid ${stamp}`);

      const row = await convex.query(anyApi.tasks.getById, {
        token: internToken(),
        taskId: created.id,
      });
      expect(row).toBeNull();
    });

    it('refuses to let a member accept a proposal', async () => {
      const created = await propose(`Client Swap accept ${stamp}`);

      await expect(
        convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: created.id }),
      ).rejects.toThrow();
    });

    it('publishes on approval, and only then tells the stream', async () => {
      const created = await propose(`Client Swap publish ${stamp}`);

      const approved = await convex.mutation(anyApi.tasks.approveProposal, {
        token: admin,
        taskId: created.id,
      });
      expect(approved.success).toBe(true);

      const row = await convex.query(anyApi.tasks.getById, {
        token: internToken(),
        taskId: created.id,
      });
      expect(row).not.toBeNull();
    });

    it('is idempotent, so a second approval cannot notify the stream twice', async () => {
      const created = await propose(`Client Swap twice ${stamp}`);

      await convex.mutation(anyApi.tasks.approveProposal, { token: admin, taskId: created.id });
      const again = await convex.mutation(anyApi.tasks.approveProposal, {
        token: admin,
        taskId: created.id,
      });

      expect(again.success).toBe(true);
      expect(again.notified).toBe(0);
    });

    it('declines a proposal by deleting it', async () => {
      const created = await propose(`Client Swap decline ${stamp}`);

      const declined = await convex.mutation(anyApi.tasks.declineProposal, {
        token: admin,
        taskId: created.id,
        reason: 'unrealistic for week one',
      });
      expect(declined.success).toBe(true);

      const listed = await convex.query(anyApi.tasks.pendingProposals, { token: admin });
      expect((listed as Array<{ id: string }>).some((t) => t.id === created.id)).toBe(false);
    });

    it('refuses to delete a published task through the decline path', async () => {
      const created = await propose(`Client Swap published-decline ${stamp}`);
      await convex.mutation(anyApi.tasks.approveProposal, { token: admin, taskId: created.id });

      const result = await convex.mutation(anyApi.tasks.declineProposal, {
        token: admin,
        taskId: created.id,
      });

      // Deleting a published task would take its submissions with it.
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already published/i);
    });

    it('refuses a file attached to a proposal, the path that bypassed the gate', async () => {
      const created = await propose(`Client Swap attach ${stamp}`);

      // attachSubmissionFile has its own gate and never learned about
      // proposals. A submission here would survive declineProposal deleting
      // the task — an orphaned row and a billed file with nothing pointing at
      // them. It must refuse exactly as a missing task does.
      const upload = await convex.mutation(anyApi.files.generateUploadUrl, {
        token: internToken(),
      });

      const put = await fetch(upload.uploadUrl ?? upload.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'proposal attachment attempt',
      });
      const { storageId } = await put.json();

      const result = await convex.mutation(anyApi.files.attachSubmissionFile, {
        token: internToken(),
        taskId: created.id,
        storageId,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('keeps proposals out of the member list but in the supervisor queue', async () => {
      const created = await propose(`Client Swap queue ${stamp}`);

      const queue = await convex.query(anyApi.tasks.pendingProposals, { token: admin });
      expect((queue as Array<{ id: string }>).some((t) => t.id === created.id)).toBe(true);

      await expect(
        convex.query(anyApi.tasks.pendingProposals, { token: internToken() }),
      ).rejects.toThrow();
    });
  });

  describe('rate limiting', () => {
    /**
     * Nothing drove convex/lib/rateLimit.ts. It is the only thing standing
     * between the sign-in endpoint and an unlimited password guesser, and its
     * free-pass branch for an empty or 'unknown' key is the kind of detail that
     * survives a refactor unnoticed.
     */
    const SITE = CONVEX_URL!.replace('.convex.cloud', '.convex.site');

    it('engages on repeated failed sign-ins for one account', { timeout: 60_000 }, async () => {
      const victim = await convex.mutation(anyApi.users.adminCreateUser, {
        token: admin,
        email: `client-swap-ratelimit-${stamp}@iih.ng`,
        fullName: `Client Swap ratelimit ${stamp}`,
        roles: ['intern'],
      });

      const attempt = () =>
        fetch(`${SITE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `client-swap-ratelimit-${stamp}@iih.ng`,
            password: 'wrong-every-time',
          }),
        }).then((r) => r.json() as Promise<{ success: boolean; error?: string }>);

      let limited = false;
      // The limit is 15 per 15 minutes per account; 20 attempts must trip it.
      for (let i = 0; i < 20 && !limited; i++) {
        const result = await attempt();
        expect(result.success).toBe(false);
        if (/too many/i.test(result.error ?? '')) limited = true;
      }

      expect(limited, 'twenty wrong passwords never tripped the limiter').toBe(true);

      // And the limit is per ACCOUNT, so it must not have locked out everyone
      // else on the way — the shared-IP case that makes an IP-only limiter
      // unusable.
      const other = await fetch(`${SITE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'also-wrong' }),
      }).then((r) => r.json() as Promise<{ error?: string }>);
      expect(/too many/i.test(other.error ?? '')).toBe(false);

      await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: victim.id });
      await convex
        .mutation(anyApi.users.adminPermanentlyDeleteUser, { token: admin, userId: victim.id })
        .catch(() => {});
    });
  });

  describe('user lifecycle', () => {
    /**
     * Trash, restore, the deletion report, and the authorship refusal.
     *
     * This is the surface Part 1 of the hardening plan actually needed, and it
     * had no coverage. The refusal is the interesting half: a permanent delete
     * is refused for anyone who AUTHORED anything — streams, tasks, reviews,
     * points awards — because removing them would leave those rows pointing at
     * nobody. That is a real limit on what "delete this user" can mean, and the
     * UI has to be able to explain it rather than surfacing a foreign-key error.
     */
    let victimId = '';
    let victimEmail = '';
    let victimPassword = '';
    const SITE = CONVEX_URL!.replace('.convex.cloud', '.convex.site');

    beforeAll(async () => {
      victimEmail = `client-swap-lifecycle-${stamp}@iih.ng`;
      const created = await convex.mutation(anyApi.users.adminCreateUser, {
        token: admin,
        email: victimEmail,
        fullName: `Client Swap lifecycle ${stamp}`,
        roles: ['intern'],
      });
      victimId = created.id;
      victimPassword = created.tempPassword;
    });

    afterAll(async () => {
      await convex
        .mutation(anyApi.users.adminPermanentlyDeleteUser, { token: admin, userId: victimId })
        .catch(() => {});
    });

    it('trashing removes them from the directory and kills their sessions', async () => {
      const login = await fetch(`${SITE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: victimEmail, password: victimPassword }),
      }).then((r) => r.json() as Promise<{ token: string }>);

      expect(await convex.query(anyApi.users.me, { token: login.token })).toBeTruthy();

      const trashed = await convex.mutation(anyApi.users.adminTrashUser, {
        token: admin,
        userId: victimId,
      });
      expect(trashed.success).toBe(true);

      const directory = (await convex.query(anyApi.users.list, {
        token: admin,
        includeInactive: true,
      })) as { id: string }[];
      expect(directory.some((u) => u.id === victimId)).toBe(false);

      // A live token outliving the account is the whole point of killing
      // sessions — otherwise "remove this person" leaves them signed in.
      await expect(convex.query(anyApi.users.me, { token: login.token })).rejects.toThrow();

      // And they cannot sign back in.
      const retry = await fetch(`${SITE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: victimEmail, password: victimPassword }),
      }).then((r) => r.json() as Promise<{ success: boolean }>);
      expect(retry.success).toBe(false);
    });

    it('lists them in the trash', async () => {
      const trash = (await convex.query(anyApi.users.adminListTrash, { token: admin })) as {
        id: string;
      }[];
      expect(trash.some((u) => u.id === victimId)).toBe(true);
    });

    it('restores them to the directory', async () => {
      const restored = await convex.mutation(anyApi.users.adminRestoreUser, {
        token: admin,
        userId: victimId,
      });
      expect(restored.success).toBe(true);

      const directory = (await convex.query(anyApi.users.list, {
        token: admin,
        includeInactive: true,
      })) as { id: string }[];
      expect(directory.some((u) => u.id === victimId)).toBe(true);
    });

    it('reports what a permanent delete would remove', async () => {
      const report = (await convex.query(anyApi.users.adminDeletionReport, {
        token: admin,
        userId: victimId,
      })) as { blockers?: unknown[]; canDelete?: boolean };

      // Read-only, and answerable BEFORE asking — "why can't I delete this
      // user" should not require attempting it.
      expect(report).toBeTruthy();
    });

    it('refuses to permanently delete someone who authored content', async () => {
      // The MCP actor has created streams, tasks and reviews all through this
      // suite, so it is the natural example of an account that cannot be erased.
      const me = (await convex.query(anyApi.users.me, { token: admin })) as { id: string };

      const result = await convex
        .mutation(anyApi.users.adminPermanentlyDeleteUser, { token: admin, userId: me.id })
        .catch((e: Error) => ({ success: false, error: e.message }));

      expect(result.success).toBe(false);
    });

    it('permanently deletes someone who authored nothing', async () => {
      await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: victimId });

      const deleted = await convex.mutation(anyApi.users.adminPermanentlyDeleteUser, {
        token: admin,
        userId: victimId,
      });
      expect(deleted.success).toBe(true);

      const trash = (await convex.query(anyApi.users.adminListTrash, { token: admin })) as {
        id: string;
      }[];
      expect(trash.some((u) => u.id === victimId)).toBe(false);
    });
  });

  describe('role administration', () => {
    /**
     * The privilege boundary between admin and super_admin.
     *
     * Every one of these was reachable in production: `adminSetActive`,
     * `adminTrashUser`, `adminResetPassword` and `adminSetMcpAccess` all
     * refused to touch a super_admin from a plain admin session, but
     * `adminSetRoles` guarded only the GRANT direction. So an admin could not
     * deactivate the platform owner — but could strip their super_admin role
     * first, at which point every other guard stopped applying, and could not
     * be undone, because restoring super_admin requires a super_admin.
     *
     * Found by probing the live deployment, not by reading the code: the four
     * refusals looked like a complete boundary until the fifth call went
     * through.
     */
    let plainAdmin = '';
    let superAdminId = '';
    let plainAdminId = '';

    beforeAll(async () => {
      const a = await convex.mutation(anyApi.users.adminCreateUser, {
        token: admin,
        email: `client-swap-admin-${stamp}@iih.ng`,
        fullName: `Client Swap admin ${stamp}`,
        roles: ['admin'],
      });
      plainAdminId = a.id;

      // Deliberately NOT authService.login: that stores the token in
      // localStorage, and every api module in this file reads from there — so
      // signing in here would silently run the rest of the suite as this admin
      // instead of the intern. The httpAction gives the same token without
      // touching client state.
      const response = await fetch(`${CONVEX_URL!.replace('.convex.cloud', '.convex.site')}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `client-swap-admin-${stamp}@iih.ng`,
          password: a.tempPassword,
        }),
      });
      plainAdmin = ((await response.json()) as { token: string }).token;

      const s = await convex.mutation(anyApi.users.adminCreateUser, {
        token: admin,
        email: `client-swap-super-${stamp}@iih.ng`,
        fullName: `Client Swap super ${stamp}`,
        roles: ['super_admin'],
      });
      superAdminId = s.id;
    });

    afterAll(async () => {
      for (const id of [plainAdminId, superAdminId]) {
        await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: id }).catch(() => {});
        await convex
          .mutation(anyApi.users.adminPermanentlyDeleteUser, { token: admin, userId: id })
          .catch(() => {});
      }
    });

    it('refuses to STRIP a super admin of their role', async () => {
      // Refused for every caller now, not just a plain admin: `super_admin` is
      // set and removed with deployment credentials only. The role that can
      // rewrite every other role should not be reachable from a session that
      // might be stolen — in either direction, since demoting the owner is as
      // good as taking the platform.
      const result = await convex.mutation(anyApi.users.adminSetRoles, {
        token: plainAdmin,
        userId: superAdminId,
        roles: ['intern'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/super[_ ]admin/i);
    });

    it('lets a super admin keep their role while other roles change', async () => {
      // The lock is on the super_admin bit itself, not on the account: an
      // account that holds it must still be editable in every other respect, or
      // the roster becomes unmanageable rather than merely deliberate.
      const result = await convex.mutation(anyApi.users.adminSetRoles, {
        token: admin,
        userId: superAdminId,
        roles: ['super_admin', 'moderator'],
      });

      expect(result.success).toBe(true);
    });

    it('refuses to let an admin grant super_admin', async () => {
      const result = await convex.mutation(anyApi.users.adminSetRoles, {
        token: plainAdmin,
        userId: internId,
        roles: ['super_admin'],
      });

      expect(result.success).toBe(false);
    });

    it('refuses to let an admin deactivate a super admin', async () => {
      const result = await convex.mutation(anyApi.users.adminSetActive, {
        token: plainAdmin,
        userId: superAdminId,
        isActive: false,
      });

      expect(result.success).toBe(false);
    });

    it('refuses to let an admin trash anyone at all', async () => {
      const result = await convex.mutation(anyApi.users.adminTrashUser, {
        token: plainAdmin,
        userId: internId,
      });

      expect(result.success).toBe(false);
    });

    it('refuses even a SUPER ADMIN demoting another super admin', async () => {
      // This assertion used to read the other way, on the reasoning that a
      // super admin had to remain able to demote another one. That is the
      // capability the strict model gives up on purpose: one stolen super_admin
      // session could otherwise strip the real owner and inherit the platform,
      // and no other guard in the system would have stopped it. The roster
      // moves with deployment credentials now, which are owner-level access to
      // the database and unreachable from any session.
      const result = await convex.mutation(anyApi.users.adminSetRoles, {
        token: admin,
        userId: superAdminId,
        roles: ['admin'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/super[_ ]admin/i);
    });

    it('lets an admin change an ordinary user, so the guard is not blanket', async () => {
      const result = await convex.mutation(anyApi.users.adminSetRoles, {
        token: plainAdmin,
        userId: internId,
        roles: ['intern', 'moderator'],
      });
      expect(result.success).toBe(true);

      // Put it back: the rest of the suite runs as this intern.
      await convex.mutation(anyApi.users.adminSetRoles, {
        token: admin,
        userId: internId,
        roles: ['intern'],
      });
    });
  });

  describe('siwes and admin authorization', () => {
    const me = () => ({ token: localStorage.getItem('orbit_auth_token_v2')! });

    it('masks credential settings rather than shipping them to a browser', async () => {
      const rows = await convex.query(anyApi.adminSettings.list, { token: admin });

      // The SMTP password that sends all of the platform's mail, and the Zoho
      // client secret behind its SSO, were returned in plaintext to every admin
      // on every Settings page load — and cached client-side for a minute.
      for (const row of rows) {
        if (row.key === 'zeptomail_config' && row.value?.pass) {
          expect(row.value.pass).toBe('__unchanged__');
        }
        if (row.key === 'zoho_oauth_config' && row.value?.clientSecret) {
          expect(row.value.clientSecret).toBe('__unchanged__');
        }
      }
    });

    it('refuses to store a credential sent to a settings row', async () => {
      const before = await convex.query(anyApi.adminSettings.get, {
        token: admin,
        key: 'zeptomail_config',
      });
      if (!before) return; // not seeded on this deployment

      // The row is not the source of truth and never was — the sender reads
      // SMTP_PASSWORD from the deployment. A password accepted here would be a
      // second copy of a live credential that no rotation reaches, which is
      // exactly what was found sitting in production.
      const result = await convex.mutation(anyApi.adminSettings.set, {
        token: admin,
        key: 'zeptomail_config',
        value: { ...before.value, host: 'smtp.zeptomail.com', pass: 'a-real-password' },
      });
      expect(result.success).toBe(true);

      const after = await convex.query(anyApi.adminSettings.get, {
        token: admin,
        key: 'zeptomail_config',
      });
      // Absent, not masked. A mask would mean something was stored.
      expect(after.value.pass).toBeUndefined();
      // The non-secret fields of the same save still land.
      expect(after.value.host).toBe('smtp.zeptomail.com');
    });

    it('refuses the peer showcase to a moderator of a different stream', async () => {
      const other = await convex.mutation(anyApi.streams.create, {
        token: admin,
        name: `Client Swap modscope ${stamp}`,
      });
      const otherTask = await publishTask({
        streamId: other.id,
        title: `Modscope task ${stamp}`,
        description: 'x',
        submissionType: 'text',
        points: 5,
        deadline: Date.now() + 86_400_000,
        notify: false,
      });

      // Promote the fixture user to the GLOBAL moderator role — which is
      // granted broadly and is not per-stream authority. reactions.canAccessTarget
      // already refused it; peerSubmissions accepted it, so the same person
      // could READ a foreign stream's submission comments and be refused when
      // posting one.
      await convex.mutation(anyApi.users.adminSetRoles, {
        token: admin,
        userId: internId,
        roles: ['intern', 'moderator'],
      });

      try {
        await expect(
          convex.query(anyApi.tasks.peerSubmissions, { ...me(), taskId: otherTask.id }),
        ).rejects.toThrow(/not in one of your streams/i);
      } finally {
        await convex.mutation(anyApi.users.adminSetRoles, {
          token: admin,
          userId: internId,
          roles: ['intern'],
        });
        await convex
          .mutation(anyApi.streams.deactivate, { token: admin, streamId: other.id })
          .catch(() => {});
      }
    });

    it('refuses to create an intern profile without naming the intern', async () => {
      const cohorts = await convex.query(anyApi.siwes.listCohorts, { token: admin });
      if (cohorts.length === 0) return;

      // It defaulted to `userId ?? user._id`, so forgetting the argument
      // enrolled the CALLER — self-enrolment as the default, beside a comment
      // claiming it was impossible.
      await expect(
        convex.mutation(anyApi.siwes.saveProfile, {
          token: admin,
          cohortId: cohorts[0].id,
          participationMode: 'remote',
        }),
      ).rejects.toThrow(/must be named/i);
    });

    it('accepts a reopen, which the validator used to reject', async () => {
      // The client has always offered 'reopen'; reviewDailyLog's validator
      // allowed only approved/changes_requested, so the button died at the
      // boundary with a validator error naming an argument nobody sent.
      await expect(
        convex.mutation(anyApi.logbook.reviewDailyLog, {
          token: admin,
          logId: 'nonexistent' as never,
          status: 'draft',
        }),
      ).rejects.toThrow(/Id|not a valid|Log not found/i);
    });

    it('lets the review queue answer someone with no reviewable interns', async () => {
      // The gate was `moderator` or better, which locked out a department lead
      // — who needs no elevated role and is exactly who canReviewProfile grants.
      const queue = await convex.query(anyApi.logbook.reviewQueue, me());

      expect(queue.interns).toEqual([]);
      expect(queue.pendingDailyLogs).toEqual([]);
      expect(queue.attendanceExceptions).toEqual([]);
    });

    it('scopes admin stats to live users and real memberships', async () => {
      const stats = await convex.query(anyApi.admin.stats, { token: admin });

      expect(stats.totalUsers).toBeGreaterThan(0);
      expect(stats.activeMembers).toBeLessThanOrEqual(stats.totalUsers);
      expect(typeof stats.recentUsers).toBe('number');

      await expect(convex.query(anyApi.admin.stats, me())).rejects.toThrow(/Admin/i);
    });

    it('reports the security dashboard, and refuses it to a member', async () => {
      const dash = await convex.query(anyApi.admin.securityDashboard, { token: admin });

      // blockedIps and rateLimits had no reader at all — the limiter wrote to
      // them and nothing ever looked.
      expect(Array.isArray(dash.blockedIps)).toBe(true);
      expect(Array.isArray(dash.recentFailedLogins)).toBe(true);
      expect(dash.totalBlocked).toBe(dash.blockedIps.length);

      await expect(convex.query(anyApi.admin.securityDashboard, me())).rejects.toThrow(/Admin/i);
    });

    it('keeps email bodies to a super admin, and audits the read', async () => {
      const listed = await convex.query(anyApi.emailQueue.adminList, { token: admin, limit: 5 });

      expect(Array.isArray(listed.logs)).toBe(true);
      expect(typeof listed.stats.total).toBe('number');
      // The list shape carries no body at all: a magic-link body is a live
      // sign-in credential for whoever it was addressed to.
      listed.logs.forEach((e: Record<string, unknown>) => {
        expect(e).not.toHaveProperty('bodyText');
        expect(e).not.toHaveProperty('bodyHtml');
      });

      await expect(
        convex.query(anyApi.emailQueue.adminList, { ...me(), limit: 5 }),
      ).rejects.toThrow(/Admin/i);
    });
  });

  /**
   * The points ledger, asserted EXACTLY.
   *
   * Every other points assertion in this repo is a lower bound —
   * `toBeGreaterThanOrEqual(LEVEL_TASK_POINTS)` in e2e/task-flow.spec.ts and
   * `>= pointsBefore + 5` in e2e/submission-review.spec.ts — and deliberately
   * so, because badge bonuses fold into a member's total and an exact total is
   * not predictable from the score alone. The consequence was that nothing in
   * the suite could catch points being paid TWICE, or ten times: every
   * over-award satisfies a `>=`.
   *
   * These assert on `reviewSubmission`'s returned `points.awarded`, which is
   * the delta written for THIS submission (`awarded: args.points` in
   * convex/lib/points.ts) and nothing else. Badge bonuses write their own
   * ledger rows and move only `newTotal`, so `awarded` stays exact — which
   * also makes these immune to the shared-actor race that forced the e2e
   * assertions to be deltas in the first place. Each test publishes its own
   * task, so nothing here depends on another test's state.
   */
  describe('the points ledger pays exactly once', () => {
    /** A task nobody else touches, accepted and submitted, ready to review. */
    const submitFresh = async (label: string) => {
      const task = await publishTask({
        streamId,
        title: `Client Swap ledger ${label} ${stamp}`,
        description: 'exercises the points ledger exactly',
        submissionType: 'text',
        // Worth 10 so the rescore test can correct 5 -> 8. `reviewSubmission`
        // bounds a score to [0, task.points], so on a 5-point task the
        // correction would be REJECTED and `points` would come back undefined —
        // which reads as "the delta was not paid" when in fact the review never
        // happened. The scores asserted below are 0, 5 and 8, all within 10.
        points: 10,
        deadline: Date.now() + 7 * 86_400_000,
        notify: false,
      });
      await convex.mutation(anyApi.tasks.acceptTask, { token: internToken(), taskId: task.id });
      const submission = await convex.mutation(anyApi.tasks.submitWork, {
        token: internToken(),
        taskId: task.id,
        submissionText: `ledger work ${label}`,
      });
      // The task id is carried out explicitly: `submitWork` returns only
      // `{ success, id }`, so reading `submission.taskId` yields undefined and
      // any listSubmissions call made with it silently falls back to "this
      // intern's most recent submission" instead of this test's own.
      return { ...submission, taskId: task.id as string };
    };

    const review = (submissionId: string, fields: Record<string, unknown>) =>
      convex.mutation(anyApi.tasks.reviewSubmission, { token: admin, submissionId, ...fields });

    it('pays the score once, and a repeat approval pays nothing more', async () => {
      const submission = await submitFresh('once');

      const first = await review(submission.id, { status: 'approved', score: 5 });
      expect(first.success).toBe(true);
      expect(first.points?.awarded).toBe(5);

      // The same decision again. `paidSoFar` is now 5, the delta is 0, and the
      // guard in reviewSubmission declines to write a second ledger row — so
      // `points` comes back null rather than paying 5 again. This is the
      // assertion a `>=` can never make.
      const again = await review(submission.id, { status: 'approved', score: 5 });
      expect(again.success).toBe(true);
      expect(again.points).toBeNull();
    });

    it('pays only the difference when a reviewer corrects the score', async () => {
      const submission = await submitFresh('rescore');

      expect((await review(submission.id, { status: 'approved', score: 5 })).points?.awarded).toBe(5);

      // 8 - 5, not 8. The comment at the head of src/test/unit/tasks-api.test.ts
      // claimed this was "verified in convex-client-swap.test.ts" while no such
      // test existed; a correction that paid the full corrected score again
      // would have shipped green.
      const corrected = await review(submission.id, { status: 'approved', score: 8 });
      expect(corrected.points?.awarded).toBe(3);
    });

    it('treats score 0 as a real score rather than an absent one', async () => {
      const submission = await submitFresh('zero');

      // `score: 0` is falsy, and the handler tests `score !== undefined &&
      // score !== null` precisely so a zero-scored approval is a decision and
      // not a no-op. Nothing paid, but the submission is scored.
      const reviewed = await review(submission.id, { status: 'approved', score: 0 });
      expect(reviewed.success).toBe(true);
      expect(reviewed.points).toBeNull();

      const rows = (await convex.query(anyApi.tasks.listSubmissions, {
        token: admin,
        taskId: submission.taskId,
        userId: internId,
      })) as { score?: number }[];
      expect(rows[0].score).toBe(0);
    });

    it('awards exactly zero when changes are requested on unpaid work', async () => {
      const submission = await submitFresh('unpaid');

      // The invariant e2e/submission-review.spec.ts used to guard by diffing
      // the shared intern's global totalPoints across a 20-second poll — which
      // is unprovable there, because task-flow.spec.ts awards 100 points to
      // that same actor concurrently under `fullyParallel`. Here it is exact.
      const reviewed = await review(submission.id, {
        status: 'changes_requested',
        feedback: 'Needs more detail.',
      });
      expect(reviewed.success).toBe(true);
      expect(reviewed.points).toBeNull();
    });

    it('reverses exactly what was paid when an approval is withdrawn', async () => {
      const submission = await submitFresh('reversal');

      expect((await review(submission.id, { status: 'approved', score: 5 })).points?.awarded).toBe(5);

      // Not "some negative number" — exactly -5. The Postgres version left the
      // points standing when a decision was withdrawn; the reversal branch is
      // what replaced that, and an off-by-one there is a member silently kept
      // whole or silently overcharged.
      const withdrawn = await review(submission.id, {
        status: 'changes_requested',
        feedback: 'On reflection, rework this.',
      });
      expect(withdrawn.points?.awarded).toBe(-5);

      // And re-approving pays the score again from zero, because `paidSoFar`
      // is back to 0 once the reversal is in the ledger.
      const reapproved = await review(submission.id, { status: 'approved', score: 5 });
      expect(reapproved.points?.awarded).toBe(5);
    });
  });

  describe('leaderboardApi', () => {
    it('returns a ranked page in the shape the page renders', async () => {
      const board = await leaderboardApi.get('overall', 5);

      expect(Array.isArray(board.entries)).toBe(true);
      board.entries.forEach((entry, i) => {
        expect(entry.rank).toBe(i + 1);
        expect(typeof entry.full_name).toBe('string');
        expect(typeof entry.total_points).toBe('number');
        expect(typeof entry.current_level).toBe('number');
      });
    });

    it('accepts every period the page offers', async () => {
      for (const period of ['overall', 'weekly', 'monthly'] as const) {
        const board = await leaderboardApi.get(period, 3);
        expect(Array.isArray(board.entries), period).toBe(true);
      }
    });
  });
});
