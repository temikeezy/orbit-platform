import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fn } from '../functions.js';
import type { OrbitClient } from '../client.js';
import { resolveId, resolveOptionalId } from '../ids.js';
import { register, json, text, expectOk } from './shared.js';

const ID = z.string().min(1).describe('Convex id, or the pre-migration uuid');

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** ISO 8601 in, epoch milliseconds out. */
function parseDeadline(iso: string): number {
  const match = ISO_DATETIME.exec(iso);
  if (match) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] =
      match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = Number(offsetHourText ?? 0);
    const offsetMinute = Number(offsetMinuteText ?? 0);

    // Date.parse accepts browser-friendly strings and normalizes impossible
    // dates. Letting either through makes an agent's malformed weekly schedule
    // look accepted while silently moving its deadline to another day.
    const validComponents =
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month) &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      offsetHour <= 23 &&
      offsetMinute <= 59;
    const ms = validComponents ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }

  throw new Error(`Could not parse "${iso}" as an ISO 8601 datetime (e.g. 2026-08-15T17:00:00Z).`);
}

export function registerTaskTools(server: McpServer, client: OrbitClient): void {
  register(
    server,
    'list_tasks',
    'List tasks, optionally filtered by stream',
    {
      stream_id: ID.optional(),
      is_active: z.boolean().default(true),
      limit: z.number().min(1).max(200).default(50),
    },
    async ({ stream_id, is_active, limit }) => {
      const streamId = await resolveOptionalId(client, 'streams', stream_id);

      const all = await client.query(fn.listTasks, { includeInactive: true });

      const filtered = all
        .filter((t) => t.isActive === is_active)
        .filter((t) => (streamId ? t.streamId === streamId : true))
        .sort((a, b) => a.deadline - b.deadline)
        .slice(0, limit)
        // `mySubmission` is the caller's own submission — meaningless for the
        // agent account, which does not do tasks.
        .map(({ mySubmission: _drop, ...task }) => task);

      return json(filtered);
    },
  );

  register(
    server,
    'get_task',
    'Get full details of a specific task',
    { task_id: ID },
    async ({ task_id }) => {
      const taskId = await resolveId(client, 'tasks', task_id);
      const task = await client.query(fn.getTask, { taskId });
      if (!task) return text(`No task with id ${task_id}`);

      const { mySubmission: _drop, ...rest } = task;
      return json(rest);
    },
  );

  register(
    server,
    'create_task',
    'Create a silent pending proposal in a stream. Members are not notified at creation; ' +
      'publication and its notifications are controlled by supervisor approval or automatic ' +
      'publication after the approval window when that option is configured. Omit deadline to use ' +
      'the current or next programme week\'s cadence deadline.',
    {
      title: z.string().min(2),
      description: z.string().default(''),
      stream_id: ID,
      // 1-20 matches the server bound (convex/lib/input.ts TASK_POINTS) and
      // LEVELS_SYSTEM.md. This had no ceiling at all, which mattered more once
      // agent-drafted proposals became the main way tasks get created.
      points: z.number().int().min(1).max(20).default(10),
      deadline: z
        .string()
        .optional()
        .describe('ISO 8601 datetime. Omit to use the programme cadence default.'),
      submission_type: z.enum(['text', 'link', 'file']).default('text'),
      is_featured: z.boolean().default(false),
      notify_members: z
        .boolean()
        .default(true)
        .describe(
          'Accepted for compatibility. It has no effect while MCP creates a pending proposal; ' +
            'publication notifications are controlled by the approval workflow.',
        ),
    },
    async (args) => {
      const streamId = await resolveId(client, 'streams', args.stream_id);
      const deadline = args.deadline === undefined ? undefined : parseDeadline(args.deadline);

      // One call. The Supabase version inserted the task, then hand-wrote a
      // notification row per member and an email-queue row per member — on top
      // of the orbit_notify_new_task trigger, which was already doing the same
      // thing. Members received the announcement three times. Here the mutation
      // owns notification policy: proposals alert only eligible reviewers, and
      // publication later notifies members through the one preference-aware
      // path.
      const result = await client.mutateAudited(
        fn.createTask,
        {
          streamId,
          title: args.title,
          description: args.description,
          submissionType: args.submission_type,
          points: args.points,
          // Convex owns the weekly clock. Omitting the field lets the same
          // cadence rule serve browser and agent-created tasks, preventing the
          // agent's drafted schedule from growing a second definition of due.
          ...(deadline === undefined ? {} : { deadline }),
          isFeatured: args.is_featured,
          notify: args.notify_members,
        },
        {
          action: 'CREATE_TASK',
          tableName: 'tasks',
          onSuccess: (r) => ({
            recordId: r.id,
            values: {
              title: args.title,
              streamId,
              points: args.points,
              deadline: r.deadline,
              notified: r.notified,
            },
          }),
        },
      );

      /**
       * An agent-created task is a PROPOSAL, not a published task.
       *
       * Saying "Created task" led the agent to report a published weekly
       * schedule to staff when nothing was visible to any participant. The
       * platform decides this by session, not by wording, so the only thing
       * that can go wrong here is the agent misreporting what it did.
       */
      if (result.approvalStatus === 'pending') {
        return text(
          `Proposed "${args.title}" (${result.id}) worth ${args.points} pts — ` +
            `AWAITING SUPERVISOR APPROVAL. It is not visible to participants yet, and ` +
            `no participant has been notified; supervisors may have been alerted for review. ` +
            `A stream supervisor approves it at /tasks/proposals. If automatic publication is ` +
            `configured, it can publish once the approval window elapses. ` +
            `Due ${new Date(result.deadline).toISOString()}.`,
        );
      }

      return text(
        `Created task "${args.title}" (${result.id}) worth ${args.points} pts. ` +
          `Notified ${result.notified} member(s). Due ${new Date(result.deadline).toISOString()}.`,
      );
    },
  );

  register(
    server,
    'update_task',
    'Update an existing task',
    {
      task_id: ID,
      title: z.string().optional(),
      description: z.string().optional(),
      points: z.number().min(0).optional(),
      deadline: z.string().optional().describe('ISO 8601 datetime'),
      is_active: z.boolean().optional(),
      is_featured: z.boolean().optional(),
    },
    async (args) => {
      const taskId = await resolveId(client, 'tasks', args.task_id);

      const patch = {
        taskId,
        title: args.title,
        description: args.description,
        points: args.points,
        deadline: args.deadline === undefined ? undefined : parseDeadline(args.deadline),
        isActive: args.is_active,
        isFeatured: args.is_featured,
      };

      const supplied = Object.entries(patch).filter(([k, v]) => k !== 'taskId' && v !== undefined);
      if (supplied.length === 0) return text('Nothing to update — supply at least one field.');

      await client.mutateAudited(fn.updateTask, patch, {
        action: 'UPDATE_TASK',
        tableName: 'tasks',
        onSuccess: () => ({ recordId: taskId, values: Object.fromEntries(supplied) }),
      });

      return text(`Updated task ${taskId} (${supplied.map(([k]) => k).join(', ')})`);
    },
  );

  register(
    server,
    'list_submissions',
    'List submissions for a task, a user, and/or a status',
    {
      task_id: ID.optional(),
      user_id: ID.optional(),
      status: z
        .enum(['in_progress', 'submitted', 'approved', 'rejected', 'changes_requested'])
        .optional(),
      limit: z.number().min(1).max(200).default(50),
    },
    async ({ task_id, user_id, status, limit }) => {
      const [taskId, userId] = await Promise.all([
        resolveOptionalId(client, 'tasks', task_id),
        resolveOptionalId(client, 'users', user_id),
      ]);

      const rows = await client.query(fn.listSubmissions, { taskId, userId, status, limit });
      return json(rows);
    },
  );

  register(
    server,
    'score_submission',
    'Review a submission. Approving WITH a score awards those points to the member, updates their ' +
      'level and re-checks their badges — all in one transaction. Approving without a score records ' +
      'the decision and awards nothing. The ledger always matches the current decision: re-approving ' +
      'at the same score pays nothing, re-scoring pays the difference, and rejecting or requesting ' +
      'changes reverses what was already paid.',
    {
      submission_id: ID,
      status: z.enum(['approved', 'rejected', 'changes_requested']),
      // Was a flat 0-100, which bore no relation to what the task is worth — an
      // agent could pay 100 for a 10-point task. The real ceiling is the task's
      // own `points` and is now enforced server-side in reviewSubmission; 20 is
      // the highest any task may be worth, so it is the tightest bound that can
      // be stated here without reading the task first.
      score: z.number().int().min(0).max(20).optional().describe('Points to award on approval, capped at the task\'s own points value. 0 is a valid score.'),
      feedback: z.string().optional(),
    },
    async ({ submission_id, status, score, feedback }) => {
      const submissionId = await resolveId(client, 'submissions', submission_id);

      // The bug this replaces: the Supabase tool patched orbit_submissions and
      // stopped. Points were written by the BROWSER in src/lib/api/tasks.ts, not
      // by a trigger, so every submission the MCP server approved was worth
      // zero — silently, because the patch itself succeeded.
      const result = await client.mutateAudited(
        fn.reviewSubmission,
        { submissionId, status, score, feedback },
        {
          action: 'SCORE_SUBMISSION',
          tableName: 'submissions',
          onSuccess: (r) => ({
            recordId: submissionId,
            values: {
              status,
              score,
              previousStatus: r.success ? r.previousStatus : undefined,
              awarded: (r.success && r.points?.awarded) || 0,
            },
          }),
        },
      );

      const ok = expectOk(result);

      if (status !== 'approved') {
        // A reversal shows up as a negative award, so say so plainly rather than
        // letting the member's total move without explanation.
        const reversed = ok.points
          ? ` Reversed ${Math.abs(ok.points.awarded)} previously awarded pts — new total ${ok.points.newTotal}.`
          : '';
        return text(
          `Submission ${submissionId} marked ${status} (was ${ok.previousStatus}).${reversed}`,
        );
      }

      // Reported because a badge can carry a points bonus, so the member's total
      // moves by more than the score. Saying "awarded 30, new total 35" without
      // naming the badge reads like an arithmetic error.
      const badges = ok.badgesAwarded.length
        ? ` Earned badge(s): ${ok.badgesAwarded.join(', ')}.`
        : '';

      if (!ok.points) {
        const why =
          score === undefined
            ? 'no score was supplied'
            : 'the ledger already records a payment for this submission at exactly that score';
        return text(
          `Submission ${submissionId} approved (was ${ok.previousStatus}). No points awarded — ${why}.${badges}`,
        );
      }

      return text(
        `Submission ${submissionId} approved (was ${ok.previousStatus}). ` +
          `Awarded ${ok.points.awarded} pts — new total ${ok.points.newTotal}, level ${ok.points.newLevel}` +
          `${ok.points.leveledUp ? ' (levelled up)' : ''}.${badges}`,
      );
    },
  );
}
