import { query, mutation, internalQuery, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { ConvexError, v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { QueryCtx, MutationCtx } from './_generated/server';
import { requireUser, requireModerator, hasRole, userFromToken, isMcpSession } from './lib/auth';
import { approvalWindowHours, isPublished, EXPIRED } from './lib/taskApproval';
import { activeMembership, canModerateStream } from './lib/membership';
import { awardPoints, recomputeUserPoints } from './lib/points';
import { isIntern } from './lib/internProfile';
import {
  FIELD,
  SUBMISSION_TYPES,
  TASK_POINTS,
  oneOf,
  optionalText,
  text,
  validate,
  wholeNumber,
} from './lib/input';
import { byMostRecentlySubmitted } from './lib/submissionOrder';
import { seedTasksFor } from './lib/taskSeed';
import { autoApprovalFeedback, settledByFallback } from './lib/agentFallback';
import {
  evaluateTaskProgramme,
  resolveCurrentTaskProgramme,
  taskProgrammeDecision,
} from './lib/taskProgramme';

/**
 * Tasks and submissions, including the points award.
 *
 * This is the trigger-heavy core. On Postgres, approving a submission set off
 * notification, email and badge triggers, while the points themselves were
 * written from the browser in three unchecked calls. All of it is explicit here.
 */

function taskShape(t: Doc<'tasks'>) {
  return {
    id: t._id,
    streamId: t.streamId,
    title: t.title,
    description: t.description,
    submissionType: t.submissionType,
    points: t.points,
    deadline: t.deadline,
    isActive: t.isActive,
    isFeatured: t.isFeatured,
    // So a supervisor's task list can badge what is still a proposal. Members
    // never receive an unpublished task at all, so for them this is always
    // 'approved'.
    approvalStatus: t.approvalStatus ?? 'approved',
    createdAt: t.createdAt,
  };
}


function submissionShape(s: Doc<'submissions'>) {
  return {
    id: s._id,
    taskId: s.taskId,
    userId: s.userId,
    submissionText: s.submissionText,
    submissionFileUrl: s.submissionFileUrl,
    // A BOOLEAN, not the storage id. The id is a capability — anything holding
    // one can read the object — so the client is told only that a file exists
    // and fetches it through /submissions/file, which checks the session.
    hasFile: Boolean(s.submissionFileId),
    status: s.status,
    score: s.score,
    feedback: s.feedback,
    reviewedBy: s.reviewedBy,
    reviewedAt: s.reviewedAt,
    submittedAt: s.submittedAt,
    startedAt: s.startedAt,
    createdAt: s.createdAt,
  };
}

/**
 * Asserts the caller may work on a task.
 *
 * `listForUser` scopes READS to streams the member belongs to, but nothing
 * scoped the WRITES: `acceptTask` and `submitWork` took a task id and inserted,
 * so any authenticated member holding an id from a stream they were not in could
 * accept and submit against it — and be awarded its points if a moderator
 * approved the work without noticing where it came from.
 *
 * Staff are exempt, as they are for reads.
 */
async function assertTaskAccess(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<'tasks'>,
  user: Doc<'users'>,
): Promise<Doc<'tasks'>> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error('Task not found');

  /**
   * An unapproved proposal does not exist — except to the people deciding on it.
   *
   * This one function gates reading a task, accepting it and submitting to it,
   * so the check belongs here rather than in each caller: a member who guessed
   * an id could otherwise accept a draft a supervisor was about to reject.
   *
   * But the supervisor's own "Edit first" button loads the task through this
   * gate, and refusing everyone made that button open a page reading "Task not
   * found" — the edit-before-approve flow the queue advertises could not work
   * at all. So a proposal is visible to an admin, and to a moderator of its
   * stream; everyone else gets the same refusal as a task that does not exist,
   * which keeps it from being used to probe for one.
   */
  if (!isPublished(task)) {
    if (hasRole(user, 'admin', 'super_admin')) return task;

    const scoped = await ctx.db
      .query('streamModerators')
      .withIndex('by_stream_and_user', (q) =>
        q.eq('streamId', task.streamId).eq('userId', user._id),
      )
      .first();

    if (scoped) return task;
    throw new Error('Task not found');
  }

  if (hasRole(user, 'admin', 'super_admin', 'moderator')) return task;

  // activeMembership, not .first() — see convex/lib/membership.ts.
  if (!(await activeMembership(ctx, task.streamId, user._id))) {
    throw new Error('This task is not in one of your streams');
  }
  return task;
}

/** Streams the user is an active member of. */
async function memberStreamIds(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<Id<'streams'>[]> {
  const memberships = await ctx.db
    .query('streamMemberships')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  return memberships.filter((m) => m.isActive).map((m) => m.streamId);
}


/**
 * A moderator may only act on tasks in a stream they moderate.
 *
 * `requireModerator` asks "is this person a moderator", not "of this stream" —
 * so any moderator could create, edit or deactivate a task in ANY stream, and
 * the only thing scoping it was the client hiding the button. `streamModerators`
 * exists precisely to express per-stream authority; nothing was consulting it on
 * this path. Admins are unscoped, as everywhere else.
 */
async function requireStreamModerator(
  ctx: MutationCtx,
  token: string,
  streamId: Id<'streams'>,
): Promise<Doc<'users'>> {
  const user = await requireModerator(ctx, token);
  if (hasRole(user, 'admin', 'super_admin')) return user;

  const scoped = await ctx.db
    .query('streamModerators')
    .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', user._id))
    .first();

  if (!scoped) throw new Error('You do not moderate this stream');
  return user;
}

export const listForUser = query({
  args: { token: v.string(), includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { token, includeInactive }) => {
    const user = await requireUser(ctx, token);
    /**
     * A MODERATOR IS NOT PLATFORM-WIDE STAFF HERE.
     *
     * This counted moderators as staff and handed them every task on the
     * deployment — so a supervisor of one stream saw seventy tasks across
     * fourteen, and their calendar plotted the whole programme's deadlines
     * rather than their own team's. That contradicts the authority model the
     * rest of the file enforces: `requireStreamModerator` exists precisely
     * because a moderator's reach is a stream, not a role.
     *
     * Admins keep the platform-wide view; that is what an admin is for. A
     * moderator gets the streams they moderate plus the ones they belong to,
     * which is the same set every other screen shows them.
     */
    const isPlatformStaff = hasRole(user, 'admin', 'super_admin');
    const isStaff = hasRole(user, 'admin', 'super_admin', 'moderator');

    // Staff see everything; members see only tasks in streams they belong to.
    // The old client did this filtering after fetching, so members received
    // tasks from streams they had no access to.
    /**
     * A member reads their OWN streams' tasks, not every task ever created.
     *
     * Collecting the whole table and filtering afterwards meant the cost of one
     * intern's task list grew with the entire platform's history — every
     * cohort's tasks, forever, to render a page showing at most a stream's
     * worth. Membership is one stream at a time, so the indexed read is both
     * smaller and exact. Staff genuinely need the cross-stream view, so theirs
     * stays a scan, bounded.
     */
    const STAFF_TASK_CAP = 2000;

    const visible = isPlatformStaff
      // Newest first, for the same reason as streams.list: an unordered take
      // returns the OLDEST rows, which would hide every task just created.
      ? await (async () => {
          const rows = await ctx.db.query('tasks').order('desc').take(STAFF_TASK_CAP);
          if (rows.length === STAFF_TASK_CAP) {
            console.warn(`tasks.listForUser hit its ${STAFF_TASK_CAP}-row cap; oldest tasks omitted.`);
          }
          return rows;
        })()
      : await (async () => {
          const ids = new Set(await memberStreamIds(ctx, user._id));
          // A supervisor moderates streams they may not be a member of — those
          // are exactly the ones whose work they are responsible for.
          for (const row of await ctx.db
            .query('streamModerators')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .collect()) {
            ids.add(row.streamId);
          }
          const mine = [];
          for (const streamId of ids) {
            mine.push(
              ...(await ctx.db
                .query('tasks')
                .withIndex('by_stream', (q) => q.eq('streamId', streamId))
                .collect()),
            );
          }
          return mine;
        })();

    // Deactivated tasks are the platform's "deleted" state. Members were given
    // them for the asking — `includeInactive` was an unguarded argument — so the
    // full content of a withdrawn task was readable by anyone who passed it.
    const active = visible
      // A proposal is not a task yet. It has its own screen — `pendingProposals`
      // — and until a supervisor releases it, it is absent from every list,
      // including a supervisor's own, so nobody has to work out from a badge
      // whether an intern can see the row they are looking at.
      .filter(isPublished)
      .filter((t) => (includeInactive && isStaff) || t.isActive);

    const submissions = await ctx.db
      .query('submissions')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    const byTask = new Map(submissions.map((s) => [s.taskId, s]));

    // Stream and creator resolved HERE rather than by the caller. The task list
    // renders a stream name and emoji per row, so leaving them out means the
    // client issues one query per task — the N+1 the API layer exists to avoid.
    // Each is read once and shared across the tasks that reference it.
    const streams = new Map<string, Doc<'streams'> | null>();
    const creators = new Map<string, string | null>();

    const sorted = active.sort((a, b) => a.deadline - b.deadline);
    const memberOf = new Set(await memberStreamIds(ctx, user._id));

    const out = [];
    for (const t of sorted) {
      if (!streams.has(t.streamId)) streams.set(t.streamId, await ctx.db.get(t.streamId));
      if (!creators.has(t.createdBy)) {
        creators.set(t.createdBy, (await ctx.db.get(t.createdBy))?.fullName ?? null);
      }

      const stream = streams.get(t.streamId);

      out.push({
        ...taskShape(t),
        streamName: stream?.name ?? null,
        streamEmoji: stream?.emoji ?? null,
        createdByName: creators.get(t.createdBy) ?? null,
        isMemberOfStream: memberOf.has(t.streamId),
        mySubmission: byTask.has(t._id) ? submissionShape(byTask.get(t._id)!) : null,
      });
    }

    return out;
  },
});

export const getById = query({
  args: { token: v.string(), taskId: v.id('tasks') },
  handler: async (ctx, { token, taskId }) => {
    const user = await requireUser(ctx, token);

    // Scoped like listForUser. Without this, any member holding a task id could
    // read the title, description, points and deadline of a task in a stream
    // they have no access to — the same read/write asymmetry assertTaskAccess
    // was added to close on the write side.
    const task = await assertTaskAccess(ctx, taskId, user).catch(() => null);
    if (!task) return null;

    const mine = await ctx.db
      .query('submissions')
      .withIndex('by_task_and_user', (q) => q.eq('taskId', taskId).eq('userId', user._id))
      .first();

    const stream = await ctx.db.get(task.streamId);
    const creator = await ctx.db.get(task.createdBy);

    const membership = await activeMembership(ctx, task.streamId, user._id);

    return {
      ...taskShape(task),
      streamName: stream?.name ?? null,
      streamEmoji: stream?.emoji ?? null,
      createdByName: creator?.fullName ?? null,
      isMemberOfStream: Boolean(membership?.isActive),
      mySubmission: mine ? submissionShape(mine) : null,
    };
  },
});

/**
 * The one task clock exposed to every creation surface.
 *
 * The browser and the MCP agent both need to explain a pre-start refusal and
 * show the same cadence-derived default the mutation will use. Returning this
 * authenticated state avoids duplicating cohort selection or weekly rollover
 * maths in either client, where the two task paths could drift apart again.
 */
export const programmeState = query({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    await requireUser(ctx, token);
    const cohort = await resolveCurrentTaskProgramme(ctx);
    const decision = evaluateTaskProgramme(cohort, now);

    return decision.allowed
      ? {
          allowed: true as const,
          cohortName: cohort?.name ?? null,
          startDate: decision.startDate,
          defaultDeadline: decision.defaultDeadline,
        }
      : {
          allowed: false as const,
          cohortName: cohort?.name ?? null,
          startDate: decision.startDate,
          defaultDeadline: null,
          error: decision.error,
        };
  },
});

export const create = mutation({
  args: {
    token: v.string(),
    streamId: v.id('streams'),
    title: v.string(),
    description: v.string(),
    submissionType: v.string(),
    points: v.number(),
    deadline: v.optional(v.number()),
    isFeatured: v.optional(v.boolean()),
    // Lets a caller stage a task without alerting the stream. The MCP server
    // needs this because an agent drafting a schedule creates several tasks in a
    // row; nothing in the UI sets it, so the default is unchanged behaviour.
    notify: v.optional(v.boolean()),
  },
  // Annotated because the handler reads the result of an `internal.*` call, and
  // an inferred return type then routes back through the generated api type —
  // which includes this function. TS reports that as a circular reference
  // (TS7022) rather than as anything to do with the code.
  handler: async (
    ctx,
    { token, notify, ...fields },
  ): Promise<{
    success: true;
    id: Id<'tasks'>;
    notified: number;
    approvalStatus: 'pending' | 'approved';
    deadline: number;
  }> => {
    const user = await requireStreamModerator(ctx, token, fields.streamId);
    const now = Date.now();
    const programme = await taskProgrammeDecision(ctx, now);
    if (!programme.allowed) throw new ConvexError(programme.error);
    const deadline = fields.deadline ?? programme.defaultDeadline;

    /**
     * THE AGENT PROPOSES; A SUPERVISOR PUBLISHES.
     *
     * The ORBIT agent drafts a weekly schedule across every stream, which is
     * the point of it — but a generated task can be unrealistic, mistimed, or
     * duplicate work a supervisor already set, and an intern cannot tell the
     * difference between that and a real instruction from IIH. So agent-created
     * tasks land as proposals: no notification, invisible to members, waiting
     * in the supervisor's approval queue.
     *
     * Decided by the SESSION, not by the actor's roles. The agent signs in as a
     * real account with real permissions — which is what makes it useful — so
     * `createdBy` cannot distinguish it, and a rule keyed on the account name
     * would break the moment the agent's identity changed. A supervisor sitting
     * at the UI is never an MCP session, so their tasks publish as they always
     * have.
     */
    const proposed = await isMcpSession(ctx, token);

    /**
     * Bounded. This mutation is reached by the ORBIT agent over MCP as well as
     * by a supervisor at the UI, and the agent is the caller most likely to
     * produce a very long description — so the limit is set well above anything
     * a drafted weekly schedule contains. Throwing rather than returning a
     * result union here, because tasks.create's declared return type has no
     * failure shape and giving it one would ripple through the MCP client.
     *
     * ConvexError, not Error: Convex REDACTS the message of an ordinary Error
     * in production and the caller sees "Server Error". A validation message
     * that does not reach the person who can act on it is the same as no
     * message, and worse than none, because it looks like our fault.
     */
    const bounded = validate(() => ({
      title: text(fields.title, 'Title', FIELD.taskTitle),
      description: text(fields.description, 'Description', FIELD.taskDescription),
      // Neither of these was bounded here, so whichever caller validated least
      // set the policy. `submissionType` reaching the row as an unrecognised
      // string is not cosmetic: the review pane switches on it and renders
      // NOTHING for a value it does not know, so the reviewer sees an empty
      // submission and no error explaining why.
      points: wholeNumber(fields.points, 'Points', TASK_POINTS.min, TASK_POINTS.max),
      submissionType: oneOf(fields.submissionType, 'Submission type', SUBMISSION_TYPES),
    }));
    if (!bounded.ok) throw new ConvexError(bounded.error);

    const { title, description, points, submissionType } = bounded.value;

    const taskId = await ctx.db.insert('tasks', {
      ...fields,
      deadline,
      title,
      description,
      // After the spread, so the validated values win over the raw ones.
      points,
      submissionType,
      isFeatured: fields.isFeatured ?? false,
      createdBy: user._id,
      approvalStatus: proposed ? 'pending' : 'approved',
      approvedBy: proposed ? undefined : user._id,
      approvedAt: proposed ? undefined : now,
      isActive: true,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    // Was orbit_notify_new_task, an AFTER INSERT trigger. Explicit now, and
    // scoped to actual stream MEMBERS — the trigger selected by
    // orbit_users.current_stream_id, a different and smaller set.
    //
    // A proposal notifies nobody: the whole point is that the stream does not
    // hear about it until a supervisor has agreed to it.
    const notified =
      notify === false || proposed
        ? { notified: 0 }
        : await ctx.runMutation(internal.notificationsInternal.notifyNewTask, { taskId });

    if (proposed) {
      await ctx.runMutation(internal.notificationsInternal.notifyTaskProposed, { taskId });
    }

    return {
      success: true as const,
      id: taskId,
      notified: notified.notified,
      approvalStatus: proposed ? ('pending' as const) : ('approved' as const),
      deadline,
    };
  },
});

/**
 * The supervisor's queue: proposals awaiting a decision, newest first.
 *
 * Scoped the same way authority over tasks is scoped everywhere else — an admin
 * sees every stream, a moderator sees only the streams they moderate. A
 * moderator being shown proposals they cannot act on is how a queue becomes
 * something people stop reading.
 */
export const pendingProposals = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireModerator(ctx, token);
    const isAdmin = hasRole(user, 'admin', 'super_admin');

    const mine = isAdmin
      ? null
      : new Set(
          (
            await ctx.db
              .query('streamModerators')
              .withIndex('by_user', (q) => q.eq('userId', user._id))
              .collect()
          ).map((m) => m.streamId),
        );

    const rows = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .order('desc')
      .take(200);

    const out = [];
    for (const t of rows) {
      if (!t.isActive) continue;
      if (mine && !mine.has(t.streamId)) continue;

      const stream = await ctx.db.get(t.streamId);
      const author = await ctx.db.get(t.createdBy);

      out.push({
        ...taskShape(t),
        streamName: stream?.name ?? null,
        streamEmoji: stream?.emoji ?? null,
        createdByName: author?.fullName ?? null,
      });
    }

    return out;
  },
});

/**
 * Publish a proposal. This is the moment the stream hears about it.
 *
 * Idempotent on an already-approved task so a double click cannot notify a
 * stream twice — the second call reports success and sends nothing.
 */
export const approveProposal = mutation({
  args: { token: v.string(), taskId: v.id('tasks') },
  handler: async (
    ctx,
    { token, taskId },
  ): Promise<{ success: boolean; error?: string; notified?: number }> => {
    const task = await ctx.db.get(taskId);
    if (!task) return { success: false as const, error: 'Task not found' };

    const user = await requireStreamModerator(ctx, token, task.streamId);

    if (isPublished(task)) return { success: true as const, notified: 0 };

    /**
     * A withdrawn or expired proposal cannot be published from a stale page.
     *
     * The sweep withdraws a proposal whose deadline passed unreviewed. Without
     * this, a supervisor whose queue was loaded before that happened could
     * still click Approve and fan out "New task published" to a whole stream
     * for a task nobody can act on and nobody will see in their list.
     */
    const now = Date.now();
    const programme = await taskProgrammeDecision(ctx, now);
    if (!programme.allowed) {
      return { success: false as const, error: programme.error };
    }

    if (!task.isActive || task.deadline <= now) {
      return {
        success: false as const,
        error: 'This proposal has expired. Ask the agent to draft a fresh one.',
      };
    }

    await ctx.db.patch(taskId, {
      approvalStatus: 'approved',
      approvedBy: user._id,
      approvedAt: now,
      updatedAt: now,
    });

    const notified = await ctx.runMutation(internal.notificationsInternal.notifyNewTask, {
      taskId,
    });

    return { success: true as const, notified: notified.notified };
  },
});

/**
 * Reject a proposal. The row is DELETED.
 *
 * Nothing is lost by deleting it: a pending task was never visible to a member,
 * so it can have no submissions, no points and no notifications hanging off it.
 * Keeping rejected drafts would leave the agent's discarded output sitting in
 * every task query forever, filtered out by every caller that remembered to.
 * What is worth keeping is the fact that a human said no — and the reason, if
 * they gave one — so that goes to the audit log.
 */
export const declineProposal = mutation({
  args: { token: v.string(), taskId: v.id('tasks'), reason: v.optional(v.string()) },
  handler: async (ctx, { token, taskId, reason }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return { success: false as const, error: 'Task not found' };

    const user = await requireStreamModerator(ctx, token, task.streamId);

    /**
     * Belt and braces: refuse if anything was ever submitted against it.
     *
     * The invariant is that a pending proposal cannot have submissions, because
     * members cannot see it — and `attachSubmissionFile` now enforces the same
     * gate that `submitWork` does. This check is what makes the deletion safe
     * even if a third submission path is added later and forgets: a row here
     * means the invariant is already broken, and deleting the task would take
     * someone's work with it.
     */
    const submitted = await ctx.db
      .query('submissions')
      .withIndex('by_task', (q) => q.eq('taskId', taskId))
      .first();

    if (submitted) {
      return {
        success: false as const,
        error: 'This task already has a submission and cannot be discarded.',
      };
    }

    // A published task is withdrawn with `deactivate`, which keeps submissions.
    // Deleting one here would take people's work with it.
    if (isPublished(task)) {
      return {
        success: false as const,
        error: 'This task is already published. Deactivate it instead.',
      };
    }

    await ctx.db.insert('auditLogs', {
      userId: user._id,
      userEmail: user.email,
      userRoles: user.roles,
      action: 'task_proposal_declined',
      tableName: 'tasks',
      recordId: taskId,
      success: true,
      oldValues: {
        title: task.title,
        streamId: task.streamId,
        points: task.points,
        deadline: task.deadline,
        proposedBy: task.createdBy,
      },
      newValues: reason ? { reason: reason.slice(0, 500) } : undefined,
      createdAt: Date.now(),
    });

    /**
     * Remembered BEFORE the row goes, so the bank knows not to offer it again.
     *
     * The deletion below is what frees the title — without this the next
     * `requestNewTask` returns the task just declined.
     */
    await ctx.db.insert('declinedTaskTitles', {
      streamId: task.streamId,
      // The seed it came from, not the possibly-edited display title — that is
      // what `requestNewTask` compares against the bank.
      title: task.seedTitle ?? task.title,
      declinedBy: user._id,
      reason: reason ? reason.slice(0, 500) : undefined,
      createdAt: Date.now(),
    });

    await ctx.db.delete(taskId);
    return { success: true as const };
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    taskId: v.id('tasks'),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    points: v.optional(v.number()),
    deadline: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    isFeatured: v.optional(v.boolean()),
    // The edit form offers this; the mutation silently dropped it, so changing
    // a task's submission type reported success and did nothing.
    submissionType: v.optional(v.string()),
  },
  handler: async (ctx, { token, taskId, ...patch }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return { success: false as const, error: 'Task not found' };

    const user = await requireStreamModerator(ctx, token, task.streamId);
    // Read BEFORE the patch — the rescale needs the ratio each score earned.
    const previousPoints = task.points;

    if (task.isActive === false && patch.isActive === true) {
      const programme = await taskProgrammeDecision(ctx, Date.now());
      if (!programme.allowed) return { success: false as const, error: programme.error };
    }

    // The same bounds `create` applies. Without them, edit was a way straight
    // past them: create a short task, then rewrite it to any length you like.
    const bounded = validate(() => ({
      title: patch.title === undefined ? undefined : text(patch.title, 'Title', FIELD.taskTitle),
      description:
        patch.description === undefined
          ? undefined
          : text(patch.description, 'Description', FIELD.taskDescription),
      // Only validated when actually being changed, so a task created before
      // these bounds existed stays editable in every other respect. Touching
      // the value is what brings it under the rule.
      points:
        patch.points === undefined
          ? undefined
          : wholeNumber(patch.points, 'Points', TASK_POINTS.min, TASK_POINTS.max),
      submissionType:
        patch.submissionType === undefined
          ? undefined
          : oneOf(patch.submissionType, 'Submission type', SUBMISSION_TYPES),
    }));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    const clean = Object.fromEntries(
      Object.entries({ ...patch, ...bounded.value }).filter(([, v]) => v !== undefined),
    );
    await ctx.db.patch(taskId, { ...clean, updatedAt: Date.now() });

    /**
     * WORK ALREADY SCORED AGAINST THIS TASK FOLLOWS THE NEW VALUE.
     *
     * Changing `points` used to move the task and nothing else, which broke in
     * both directions. Lowering it below an existing score left submissions
     * that `reviewSubmission` then REFUSED — it bounds a score to
     * [0, task.points] and rejects rather than clamps, so the row could not be
     * re-reviewed at all until someone rescored it by hand, while the ledger
     * quietly kept paying the old amount. Raising it left already-approved
     * interns short against everyone scored afterwards, for the same work.
     *
     * Scores are rescaled by the RATIO they earned, not clamped. Someone who
     * scored full marks on a 10-point task keeps full marks when it becomes 15;
     * someone who scored half keeps half. Clamping would silently convert a
     * perfect score into a partial one whenever a task's value fell.
     *
     * The ledger is corrected by DELTA through `awardPoints`, the same path
     * `reviewSubmission` uses for a re-score, so totals, levels and the ledger's
     * own history stay consistent and the correction is legible as a correction
     * rather than appearing as fresh work.
     */
    const newPoints = bounded.value.points;
    if (newPoints !== undefined && newPoints !== previousPoints && previousPoints > 0) {
      /**
       * BOUNDED, and refuses rather than reconciling half.
       *
       * This runs inside one mutation, and every scored submission costs a read
       * plus an `awardPoints` write. A stream task with a full cohort behind it
       * would blow Convex's per-mutation limits — the intern-profile backfill
       * already read 27,127 documents against a 32,000 cap at ~760 accounts.
       *
       * Reconciling the first N and abandoning the rest is the worst outcome:
       * some interns paid at the new rate, some at the old, and nothing saying
       * which. So the read takes one more than the cap purely to detect the
       * overflow, and the whole edit is refused with something the admin can
       * act on.
       */
      const RECONCILE_CAP = 200;
      const scoredPage = await ctx.db
        .query('submissions')
        .withIndex('by_task', (q) => q.eq('taskId', taskId))
        .take(RECONCILE_CAP + 1);

      const scored = scoredPage.filter(
        (sub) => sub.status === 'approved' && typeof sub.score === 'number',
      );

      if (scoredPage.length > RECONCILE_CAP) {
        return {
          success: false as const,
          error:
            `This task has too many submissions to re-price safely in one go ` +
            `(over ${RECONCILE_CAP}). Its other details can still be edited; ` +
            `changing the points needs to be done by an administrator in batches.`,
        };
      }

      for (const sub of scored) {
        const oldScore = sub.score as number;
        /**
         * FLOOR, not round — so a rescale can never invent points.
         *
         * Rounding is more accurate for a single change but drifts upward over
         * several: a score of 1 on a 3-point task becomes 1 when the task drops
         * to 2, then 2 when it returns to 3. Two edits and the intern is a
         * point better off than when they started, for no additional work, and
         * every such point is unearned against everyone else on the leaderboard.
         *
         * Flooring makes the sequence monotonically non-increasing. The cost is
         * that a small score on a heavily devalued task can round to nothing —
         * which is the honest arithmetic of a task losing most of its worth,
         * and is at least never someone else's loss.
         */
        const rescaled = Math.min(
          Math.floor((oldScore / previousPoints) * newPoints),
          newPoints,
        );
        if (rescaled === oldScore) continue;

        await ctx.db.patch(sub._id, { score: rescaled, updatedAt: Date.now() });

        const delta = rescaled - oldScore;
        if (delta !== 0) {
          await awardPoints(ctx, {
            userId: sub.userId,
            points: delta,
            reason: `Task points changed from ${previousPoints} to ${newPoints}`,
            referenceId: String(sub._id),
            referenceType: 'submission',
            createdBy: user._id,
          });
        }
      }
    }

    return { success: true as const };
  },
});

/**
 * Deactivates rather than deletes.
 *
 * `tasks.ts:314` hard-deleted the task, orphaning every submission against it —
 * people's work disappeared along with the task. Deactivating keeps submissions
 * and their points history intact.
 */
export const deactivate = mutation({
  args: { token: v.string(), taskId: v.id('tasks') },
  handler: async (ctx, { token, taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return { success: false as const, error: 'Task not found' };

    await requireStreamModerator(ctx, token, task.streamId);
    await ctx.db.patch(taskId, { isActive: false, updatedAt: Date.now() });
    return { success: true as const };
  },
});

export const acceptTask = mutation({
  args: { token: v.string(), taskId: v.id('tasks') },
  handler: async (ctx, { token, taskId }) => {
    const user = await requireUser(ctx, token);

    /**
     * Tasks are for interns. Staff review them.
     *
     * `requireUser` alone let an admin, moderator or supervisor accept and
     * submit work — creating a real submission, in a real review queue, that a
     * reviewer then has to deal with, and awarding real points to someone who
     * is not on the programme. Notifications were fixed to skip staff; this is
     * the same rule at the write path, which is the one that leaves a record.
     */
    if (!isIntern(user)) {
      return { success: false as const, error: 'Tasks are for interns. Staff review submissions rather than making them.' };
    }
    await assertTaskAccess(ctx, taskId, user);
    const now = Date.now();

    const existing = await ctx.db
      .query('submissions')
      .withIndex('by_task_and_user', (q) => q.eq('taskId', taskId).eq('userId', user._id))
      .first();

    if (existing) return { success: true as const, id: existing._id, alreadyAccepted: true };

    const id = await ctx.db.insert('submissions', {
      taskId,
      userId: user._id,
      status: 'in_progress',
      startedAt: now,
      acceptedAt: now,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id, alreadyAccepted: false };
  },
});

export const submitWork = mutation({
  args: {
    token: v.string(),
    taskId: v.id('tasks'),
    submissionText: v.optional(v.string()),
    submissionFileUrl: v.optional(v.string()),
  },
  handler: async (ctx, { token, taskId, submissionText, submissionFileUrl }) => {
    const user = await requireUser(ctx, token);

    /**
     * Tasks are for interns. Staff review them.
     *
     * `requireUser` alone let an admin, moderator or supervisor accept and
     * submit work — creating a real submission, in a real review queue, that a
     * reviewer then has to deal with, and awarding real points to someone who
     * is not on the programme. Notifications were fixed to skip staff; this is
     * the same rule at the write path, which is the one that leaves a record.
     */
    if (!isIntern(user)) {
      return { success: false as const, error: 'Tasks are for interns. Staff review submissions rather than making them.' };
    }
    await assertTaskAccess(ctx, taskId, user);
    const now = Date.now();

    const existing = await ctx.db
      .query('submissions')
      .withIndex('by_task_and_user', (q) => q.eq('taskId', taskId).eq('userId', user._id))
      .first();

    // Resubmitting after approval would silently reopen a scored submission and
    // strip the reviewer's decision.
    if (existing?.status === 'approved') {
      return { success: false as const, error: 'This submission has already been approved.' };
    }

    /**
     * Bounded. submissionText is rendered as an href when the task's type is
     * `link` — TaskDetailPage and SubmissionReviewPage both do it — so it is
     * read by peers and by reviewers, which makes it the same untrusted-href
     * path as the applicant portfolio field. It is NOT validated as a URL here,
     * because the same column carries free text for text-type tasks; the client
     * guard in src/lib/utils/url.ts is what refuses to render a non-URL as a
     * link.
     */
    const bounded = validate(() => ({
      submissionText: optionalText(submissionText, 'Submission', FIELD.submissionText),
      submissionFileUrl: optionalText(submissionFileUrl, 'File reference', FIELD.url),
    }));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    /**
     * A SUBMISSION MUST CONTAIN SOMETHING.
     *
     * Both fields are optional individually — a text task fills one, a link or
     * file task the other — so nothing stopped a call supplying neither. The
     * row was then written as `submitted` with no content: the intern's task
     * showed as done, and the reviewer opened a panel indistinguishable from
     * one where nothing had been submitted at all. The form has always required
     * content, but the form is not the boundary.
     *
     * Checked on the BOUNDED values, so a submission of only whitespace is
     * empty too — `optionalText` trims.
     */
    if (!bounded.value.submissionText && !bounded.value.submissionFileUrl) {
      return {
        success: false as const,
        error: 'Add your work before submitting — text, a link, or a file, depending on the task.',
      };
    }

    if (existing) {
      // Only what was supplied. `ctx.db.patch` REMOVES a key set to undefined,
      // so passing both through unconditionally meant resubmitting text after a
      // file upload erased the file reference — the same hazard reviewSubmission
      // was already fixed for, in the same file.
      const patch: Record<string, unknown> = {
        status: 'submitted',
        submittedAt: now,
        updatedAt: now,
      };
      if (submissionText !== undefined) patch.submissionText = bounded.value.submissionText;
      if (submissionFileUrl !== undefined) patch.submissionFileUrl = bounded.value.submissionFileUrl;

      await ctx.db.patch(existing._id, patch);
      return { success: true as const, id: existing._id };
    }

    const id = await ctx.db.insert('submissions', {
      taskId,
      userId: user._id,
      submissionText: bounded.value.submissionText,
      submissionFileUrl: bounded.value.submissionFileUrl,
      status: 'submitted',
      submittedAt: now,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

/**
 * Reviews a submission and, on approval, awards points — atomically.
 *
 * Fixes two defects in the browser-side original:
 *  - It was not idempotent. Re-approving an already-approved submission ran the
 *    ledger insert again, awarding the points a second time with no guard.
 *  - `if (status === 'approved' && reviewData.score)` treats a score of 0 as
 *    falsy, so a deliberate zero silently skipped the ledger entirely.
 */
export const reviewSubmission = mutation({
  args: {
    token: v.string(),
    submissionId: v.id('submissions'),
    status: v.union(v.literal('approved'), v.literal('rejected'), v.literal('changes_requested')),
    score: v.optional(v.number()),
    feedback: v.optional(v.string()),
  },
  // Annotated for the same TS7022 reason as `create`: the handler consumes the
  // result of an `internal.*` call.
  handler: async (
    ctx,
    { token, submissionId, status, score, feedback },
  ): Promise<
    | {
        success: true;
        previousStatus: string;
        points: { awarded: number; newTotal: number; newLevel: number; leveledUp: boolean } | null;
        badgesAwarded: string[];
      }
    | { success: false; error: string }
  > => {
    const reviewer = await requireModerator(ctx, token);

    const submission = await ctx.db.get(submissionId);
    if (!submission) return { success: false as const, error: 'Submission not found' };

    /**
     * PER STREAM, not the global moderator role.
     *
     * `requireModerator` asks "is this person a moderator", not "of this
     * stream" — so any moderator could approve work, award points and set a
     * score in a stream they have nothing to do with. `canModerateStream` is
     * the check the rest of this file already uses for exactly this reason
     * (see listSubmissionComments), and admins stay unscoped as everywhere.
     */
    const reviewedTask = await ctx.db.get(submission.taskId);
    if (!reviewedTask) return { success: false as const, error: 'Task not found' };

    if (!(await canModerateStream(ctx, reviewedTask.streamId, reviewer))) {
      return { success: false as const, error: 'You do not moderate this stream' };
    }

    /**
     * A score cannot exceed what the task is worth.
     *
     * Nothing server-side checked this, and the two callers disagreed about
     * what the ceiling even was: the admin review pane clamps its input to
     * [0, task.points], while the MCP `score_submission` tool caps at a flat
     * 100 regardless of the task. So an agent could pay 100 for a 10-point
     * task, and the ledger — which is the durable record the totals, levels and
     * leaderboard are all recomputed from — would simply believe it.
     *
     * Checked against the task rather than a constant, because that is the
     * number the reviewer was shown.
     */
    if (score !== undefined) {
      const checked = validate(() => wholeNumber(score, 'Score', 0, reviewedTask.points));
      if (!checked.ok) return { success: false as const, error: checked.error };
    }

    const previousStatus = submission.status;
    const now = Date.now();

    // Only patch fields that were actually supplied. ctx.db.patch REMOVES a field
    // set to undefined, so passing score/feedback through unconditionally wiped
    // a previously recorded score whenever a reviewer submitted without one.
    // supabase-js dropped undefined keys, so the original never had this.
    const patch: Record<string, unknown> = {
      status,
      reviewedBy: reviewer._id,
      reviewedAt: now,
      updatedAt: now,
    };
    if (score !== undefined) patch.score = score;
    if (feedback !== undefined) patch.feedback = feedback;

    await ctx.db.patch(submissionId, patch);

    let points = null as null | Awaited<ReturnType<typeof awardPoints>>;
    let badgesAwarded: string[] = [];

    // Captured before anything is awarded, so `leveledUp` still means "this
    // review moved them up" once the badge bonus has been folded in below.
    const levelBefore = (await ctx.db.get(submission.userId))?.currentLevel ?? 0;

    // Idempotency keyed on the LEDGER, not on the current status. A status check
    // alone is defeated by approve -> reject -> approve: the second approval
    // sees status 'rejected', decides it is a fresh approval, and pays out
    // again. The ledger is the durable record of what this submission has been
    // paid.
    const ledger = await ctx.db
      .query('pointsLedger')
      .withIndex('by_user', (q) => q.eq('userId', submission.userId))
      .collect();

    // What this submission has been paid SO FAR, not merely whether it has been
    // paid at all. A boolean was not enough: `patch.score` above is applied
    // unconditionally, so re-reviewing an approved submission with a corrected
    // score rewrote submissions.score and then declined to touch the ledger —
    // leaving the row reading 80 while the ledger, the total and the leaderboard
    // all read 30, with no notification and no error.
    const paidSoFar = ledger
      .filter((e) => e.referenceType === 'submission' && e.referenceId === submissionId)
      .reduce((sum, e) => sum + e.points, 0);

    if (status === 'approved') {
      /**
       * The score already ON the row counts when none is supplied.
       *
       * `patch.score` above only writes a score that was actually sent, so an
       * approval with no score leaves the previous one standing. Without this
       * fallback the payment was skipped entirely in that case, and
       * approve(30) -> changes_requested (reverses -30) -> approve() left the
       * row reading "approved, score 30" while the ledger, the member's total
       * and the leaderboard all held 0 for it — the same silent drift the
       * `paidSoFar` machinery exists to prevent, reached through the scoreless
       * branch. The MCP path makes `score` optional, so this is reachable.
       */
      const effectiveScore = score ?? submission.score;

      if (effectiveScore !== undefined && effectiveScore !== null) {
        /**
         * Bounded HERE, not only where `score` arrives, because this is the
         * value that actually gets paid.
         *
         * Validating the incoming argument alone leaves the fallback branch
         * open: a submission carrying a score recorded before these bounds
         * existed — or written by the MCP tool back when it capped at a flat
         * 100 — is replayed verbatim by a later scoreless approval. Reject
         * rather than clamp, so a row needing correction is surfaced to the
         * reviewer instead of being quietly part-paid.
         */
        const payable = validate(() =>
          wholeNumber(effectiveScore, 'Score', 0, reviewedTask.points),
        );
        if (!payable.ok) {
          return {
            success: false as const,
            error: `${payable.error} This submission carries a stored score of ${effectiveScore}, which is above what the task is worth. Re-review it with an explicit score.`,
          };
        }

        const delta = effectiveScore - paidSoFar;

        // Zero delta covers the ordinary re-approval: nothing owed, nothing
        // written, so the payment is still exactly once per score.
        if (delta !== 0) {
          points = await awardPoints(ctx, {
            userId: submission.userId,
            points: delta,
            // A correction is labelled as one, so the ledger reads as a history
            // rather than as two conflicting payments for the same work.
            reason: paidSoFar === 0 ? 'task_completion' : 'task_completion_adjustment',
            referenceId: submissionId,
            referenceType: 'submission',
            createdBy: reviewer._id,
          });
        }
      }

      // Runs on EVERY approval, not only scored ones. The Postgres trigger
      // check_badges_on_submission fired on any transition into approved, and
      // the approved-count feeds the tasks, quality and streak measures — so
      // gating this on a score silently froze those badges.
      const badges = await ctx.runMutation(internal.badges.checkAndAward, {
        userId: submission.userId,
      });
      badgesAwarded = badges.awarded;

      // A badge with pointsBonus > 0 writes its own ledger row, so the totals
      // awardPoints computed a moment ago are already stale. Approving a first
      // task worth 30 also earns "First Steps" (+5): this returned
      // "new total 30" while the member's real total was 35, and the MCP tool
      // relayed that number to whoever asked.
      if (points && badges.awarded.length > 0) {
        const fresh = await ctx.db.get(submission.userId);
        if (fresh) {
          points = {
            ...points,
            newTotal: fresh.totalPoints,
            newLevel: fresh.currentLevel,
            leveledUp: fresh.currentLevel > levelBefore,
          };
        }
      }
    } else if (paidSoFar !== 0) {
      // Reversing a payment when the decision is withdrawn.
      //
      // The Postgres version left the points standing: approve a submission for
      // 30, then reject it, and the member kept the 30 forever with nothing
      // recording why. The submission row said 'rejected' and the leaderboard
      // said otherwise. `changes_requested` reverses too — an entry sent back
      // for rework is not a completed task, and re-approving it pays the score
      // again from zero because paidSoFar is back to 0 by then.
      points = await awardPoints(ctx, {
        userId: submission.userId,
        points: -paidSoFar,
        reason: 'task_completion_reversed',
        referenceId: submissionId,
        referenceType: 'submission',
        createdBy: reviewer._id,
      });

      // Badges are deliberately NOT revoked. `badges.checkAndAward` only ever
      // adds, and taking an achievement back off someone because a reviewer
      // changed their mind is a worse outcome than a badge whose criteria no
      // longer strictly hold. The bonus stays in the ledger with it, so the
      // total remains the sum of the ledger. `badges.revoke` exists for an admin
      // who genuinely wants it gone.
    }

    // The Postgres trigger returned early when OLD.status = NEW.status. Without
    // that guard, re-clicking a decision re-notifies the submitter every time.
    if (status !== previousStatus) {
      await ctx.runMutation(internal.notificationsInternal.notifySubmissionReviewed, {
        submissionId,
        status,
      });
    }

    return { success: true as const, points, previousStatus, badgesAwarded };
  },
});

/**
 * Submissions filtered by task, author and/or status.
 *
 * Backs the MCP `list_submissions` tool, which previously read
 * `orbit_submissions` directly with the service key and so returned every
 * submission on the platform regardless of who asked. Moderator-gated, because
 * a submission carries someone's unpublished work, their score and a reviewer's
 * private feedback.
 */
export const listSubmissions = query({
  args: {
    token: v.string(),
    taskId: v.optional(v.id('tasks')),
    userId: v.optional(v.id('users')),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, taskId, userId, status, limit }) => {
    const viewer = await requireModerator(ctx, token);

    /**
     * Narrow on the most selective index available — and BOUND the read.
     *
     * The comment here used to claim this was "bounded by `take`". It was not:
     * every branch ended in `.collect()`, and the `.slice()` further down runs
     * after the rows are already in memory. With `status` alone — which is what
     * every tab of the review screen except "Pending Review" sends — that read
     * every submission ever given that status, and with no argument at all it
     * read the whole table. Submissions grow with interns x tasks x
     * resubmissions, so this was on course to exceed Convex's per-transaction
     * read limit and take the screen down with it.
     *
     * The `status` path now reads through `by_status_and_submitted` in
     * descending order, so the cap keeps the NEWEST rows rather than an
     * arbitrary slice — the same index and the same reasoning as `reviewQueue`.
     * `by_task` and `by_user` are naturally bounded (one task's submissions,
     * one member's) and stay exact.
     */
    const READ_CAP = 500;

    const rows = taskId
      ? await ctx.db
          .query('submissions')
          .withIndex('by_task', (q) => q.eq('taskId', taskId))
          .collect()
      : userId
        ? await ctx.db
            .query('submissions')
            .withIndex('by_user', (q) => q.eq('userId', userId))
            .collect()
        : status
          ? await ctx.db
              .query('submissions')
              .withIndex('by_status_and_submitted', (q) => q.eq('status', status))
              .order('desc')
              .take(READ_CAP)
          : // No filter at all. Ordered by creation rather than submission, because
            // no global `submittedAt` index exists — a resubmitted row can therefore
            // fall outside the window here. The review screen always sends a status,
            // so it does not travel this path; it exists for ad-hoc admin calls, and
            // a bounded answer beats an unbounded read that eventually throws.
            await ctx.db.query('submissions').order('desc').take(READ_CAP);

    /**
     * A moderator sees submissions in the streams they moderate.
     *
     * Unfiltered, this handed every moderator the whole platform's work —
     * other people's submission text, files and scores — which contradicts the
     * per-stream scoping enforced on every write path. Admins are unscoped.
     */
    const scoped = hasRole(viewer, 'admin', 'super_admin')
      ? rows
      : await (async () => {
          const allowed = new Set<string>();
          const out = [];
          for (const row of rows) {
            const t = await ctx.db.get(row.taskId);
            if (!t) continue;
            const key = String(t.streamId);
            if (!allowed.has(key)) {
              if (!(await canModerateStream(ctx, t.streamId, viewer))) continue;
              allowed.add(key);
            }
            out.push(row);
          }
          return out;
        })();

    /**
     * Ordered by `submittedAt`, via the shared rule in lib/submissionOrder.ts.
     *
     * This sorted on `createdAt` alone, which is the same defect `reviewQueue`
     * above was fixed for and which survived here because that fix only touched
     * the pending path. Every status filter on the review screen EXCEPT
     * "Pending Review" reads through this function, so a resubmission — which
     * patches its row and keeps its original creation time — sorted as if it
     * were weeks old and, past the cap below, fell off the list entirely.
     */
    const matched = scoped
      .filter((s) => (taskId ? s.taskId === taskId : true))
      .filter((s) => (userId ? s.userId === userId : true))
      .filter((s) => (status ? s.status === status : true))
      .sort(byMostRecentlySubmitted)
      .slice(0, Math.min(Math.max(limit ?? 50, 1), 200));

    const out = [];
    for (const s of matched) {
      const [task, author] = await Promise.all([ctx.db.get(s.taskId), ctx.db.get(s.userId)]);
      out.push({
        ...submissionShape(s),
        // The FULL task shape, not {id,title,points}.
        //
        // SubmissionReviewPage replaces its list row with this detail on click,
        // and gates the submission's text/link/file renderers on
        // `task.submission_type`. With the narrow projection that field was
        // undefined, so NONE of them rendered: a reviewer opened a submission,
        // saw an empty box, and could still approve it and pay out points for
        // work they could not see. The deadline and description were blank for
        // the same reason.
        task: task ? taskShape(task) : null,
        author: author ? { id: author._id, fullName: author.fullName } : null,
      });
    }
    return out;
  },
});

/**
 * The caller's OWN submissions.
 *
 * `listSubmissions` is moderator-gated, because a submission carries someone's
 * unpublished work, their score and a reviewer's private feedback. That is right
 * for browsing other people's — and wrong as the only way to read your own,
 * which is what the task detail screen does every time it renders. Routing the
 * member path through the moderator query meant a member could not see the work
 * they had just submitted.
 */
export const mySubmissions = query({
  args: { token: v.string(), taskId: v.optional(v.id('tasks')) },
  handler: async (ctx, { token, taskId }) => {
    const user = await requireUser(ctx, token);

    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    return rows
      .filter((s) => (taskId ? s.taskId === taskId : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(submissionShape);
  },
});

/**
 * Everyone's submitted work on one task — the peer showcase on TaskDetailPage.
 *
 * Gated on membership of the task's stream. The page read this straight from
 * `orbit_submissions` filtered only by `task_id` and `status = 'submitted'`, so
 * any authenticated user could read any task's coursework, text and links
 * included, whether or not they were in the stream.
 *
 * Only `submitted` and `approved` rows. Drafts and in-progress work are private
 * to their author until they choose to submit, and a `rejected` or
 * `changes_requested` row is a review outcome that is nobody else's business.
 */
export const peerSubmissions = query({
  args: { token: v.string(), taskId: v.id('tasks') },
  handler: async (ctx, { token, taskId }) => {
    const user = await requireUser(ctx, token);

    const task = await ctx.db.get(taskId);
    if (!task) return [];

    // canModerateStream, NOT the global moderator role. A global moderator is
    // granted broadly and is not per-stream authority — reactions.canAccessTarget
    // already enforces that, so accepting the role here made the two disagree:
    // the same person could READ a foreign stream's submission comments through
    // this query and be refused when posting one.
    if (
      !(await canModerateStream(ctx, task.streamId, user)) &&
      !(await activeMembership(ctx, task.streamId, user._id))
    ) {
      throw new Error('This task is not in one of your streams');
    }

    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_task', (q) => q.eq('taskId', taskId))
      .collect();

    const visible = rows.filter((r) => r.status === 'submitted' || r.status === 'approved');

    const out = [];
    for (const r of visible.sort((a, b) => (b.submittedAt ?? b.createdAt) - (a.submittedAt ?? a.createdAt))) {
      const author = await ctx.db.get(r.userId);
      if (!author || author.isDeleted) continue;

      // Reactions and comments counted here rather than by two more queries per
      // submission from the browser.
      const reactions = await ctx.db
        .query('reactions')
        .withIndex('by_target', (q) => q.eq('targetType', 'submission').eq('targetId', r._id))
        .collect();

      const comments = await ctx.db
        .query('comments')
        .withIndex('by_target', (q) => q.eq('targetType', 'submission').eq('targetId', r._id))
        .collect();

      const commentsOut = [];
      for (const c of comments.filter((c) => c.isActive).sort((a, b) => a.createdAt - b.createdAt)) {
        const commenter = await ctx.db.get(c.userId);
        commentsOut.push({
          id: c._id,
          content: c.content,
          createdAt: c.createdAt,
          author: commenter
            ? {
                id: commenter._id,
                fullName: commenter.fullName,
                profilePhotoUrl: commenter.profilePhotoUrl,
              }
            : null,
        });
      }

      out.push({
        id: r._id,
        userId: r.userId,
        submissionText: r.submissionText,
        submissionUrl: r.submissionFileUrl,
        hasFile: Boolean(r.submissionFileId),
        status: r.status,
        submittedAt: r.submittedAt,
        author: {
          id: author._id,
          fullName: author.fullName,
          profilePhotoUrl: author.profilePhotoUrl,
        },
        likeCount: reactions.length,
        likedByMe: reactions.some((x) => x.userId === user._id),
        comments: commentsOut,
      });
    }
    return out;
  },
});

export const reviewQueue = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { token, limit }) => {
    const reviewer = await requireModerator(ctx, token);

    /**
     * NEWEST FIRST. `.take(n)` on an unordered index walks ascending, so this
     * returned the OLDEST 50 pending submissions — and dev had 67, meaning the
     * 17 most recent were invisible to every reviewer. The queue looked healthy
     * and simply never showed new work: an intern submits, the reviewer's page
     * shows nothing new, and the submission sits unreviewed until the backlog
     * below it drains. `listSubmissions` already sorted descending, so the same
     * data appeared in two different orders depending on which screen you used.
     */
    /**
     * Ordered by `submittedAt`, not by creation.
     *
     * The comment above describes half the bug; this is the other half. Even
     * ordered descending, `by_status` sorts on `_creationTime` — and a
     * resubmission PATCHES the existing row, so work sent back for changes and
     * then redone keeps the creation time of its first attempt. Once the
     * backlog exceeds one page, that resubmission is reliably below the fold:
     * the intern redoes the work, and the reviewer who asked for it never sees
     * it come back. Found by an end-to-end test against a deployment carrying
     * 170 backlogged submissions, which is exactly the condition that exposes
     * it and exactly the condition nobody reproduces by hand.
     */
    const pending = await ctx.db
      .query('submissions')
      .withIndex('by_status_and_submitted', (q) => q.eq('status', 'submitted'))
      .order('desc')
      // Same clamp as listSubmissions, so the two reviewer-facing reads of the
      // same table cannot disagree about how much they will return.
      .take(Math.min(Math.max(limit ?? 50, 1), 200));

    /**
     * A moderator sees only the streams they moderate — the same scoping
     * `listSubmissions` applies, for the same reason.
     *
     * The global `moderator` role is granted broadly (a track lead gets it from
     * `tracks.setLead` while holding `streamModerators` rows for their own
     * track only), so role alone is not authority over a stream. Unscoped, this
     * queue handed every such moderator the whole platform's pending work:
     * other interns' submission text, scores, reviewer feedback and author
     * identity, from streams they have no part in. The write path
     * (`reviewSubmission`) has always checked `canModerateStream`; this read
     * and `submissionFileFor` were the two that did not.
     */
    const isAdmin = hasRole(reviewer, 'admin', 'super_admin');
    const allowed = new Set<string>();
    const denied = new Set<string>();

    const out = [];
    for (const s of pending) {
      const task = await ctx.db.get(s.taskId);
      if (!task) continue;

      if (!isAdmin) {
        const key = String(task.streamId);
        if (denied.has(key)) continue;
        if (!allowed.has(key)) {
          if (!(await canModerateStream(ctx, task.streamId, reviewer))) {
            denied.add(key);
            continue;
          }
          allowed.add(key);
        }
      }

      const author = await ctx.db.get(s.userId);
      out.push({
        ...submissionShape(s),
        task: taskShape(task),
        author: author ? { id: author._id, fullName: author.fullName, profileSlug: author.profileSlug } : null,
      });
    }
    return out;
  },
});

/**
 * Backs the `/submissions/file` httpAction.
 *
 * Internal: it returns a storage id, which is a capability. The route checks the
 * session before calling this, and this re-checks who may see the file — the
 * author, or someone who could review it.
 */
export const submissionFileFor = internalQuery({
  args: { token: v.string(), submissionId: v.id('submissions') },
  handler: async (ctx, { token, submissionId }) => {
    const viewer = await userFromToken(ctx, token);
    if (!viewer) return null;

    const submission = await ctx.db.get(submissionId);
    if (!submission?.submissionFileId) return null;

    const task = await ctx.db.get(submission.taskId);

    // The author, an admin, or a moderator OF THIS SUBMISSION'S STREAM. A
    // submission is someone's coursework; the Supabase version put it in a
    // public bucket, which would have made every member's work readable by
    // anyone who guessed a path — had the bucket existed at all.
    //
    // The global `moderator` role is not authority over a stream: it is granted
    // broadly (a track lead receives it while moderating only their own track's
    // streams), so accepting the bare role here let any moderator download any
    // submission file on the platform by id. `canModerateStream` is what the
    // write path checks, and it is what this check was missing.
    const isAuthor = submission.userId === viewer._id;
    const mayReview =
      hasRole(viewer, 'admin', 'super_admin') ||
      (task ? await canModerateStream(ctx, task.streamId, viewer) : false);
    if (!isAuthor && !mayReview) return null;

    return {
      storageId: submission.submissionFileId,
      fileName: `${task?.title ?? 'submission'}`.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 80) || 'submission',
    };
  },
});

/** Proposals handled per transaction. See the note on the batch below. */
const BATCH = 25;

/**
 * Publishes proposals nobody got to in time.
 *
 * THE POINT OF THE WINDOW. Supervisor approval exists to keep the agent's
 * output realistic, not to make a supervisor's inbox a single point of failure
 * for the whole programme — if one person is on leave, interns should not be
 * left with an empty week. So a proposal that has waited out its window
 * publishes itself, and the supervisor keeps every power they had: they can
 * still edit it, and they can still deactivate it.
 *
 * The window is configurable and can be switched off. `taskApprovalWindowHours`
 * of 0 means never auto-publish, for a cohort where a human must sign off on
 * everything; a positive number is hours.
 *
 * Auto-published tasks are marked as such (`approvedBy` stays unset) so the
 * audit trail distinguishes "a supervisor agreed to this" from "the window
 * expired", which are very different answers to "who decided this?".
 */
export const autoApproveOverdueProposals = internalMutation({
  args: {},
  returns: v.object({
    published: v.number(),
    expired: v.number(),
    scheduled: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{ published: number; expired: number; scheduled: number }> => {
    const now = Date.now();
    const programme = await taskProgrammeDecision(ctx, now);
    if (!programme.allowed) return { published: 0, expired: 0, scheduled: 0 };

    const hours = await approvalWindowHours(ctx);
    if (hours <= 0) return { published: 0, expired: 0, scheduled: 0 };

    const cutoff = now - hours * 60 * 60 * 1000;

    /**
     * A SMALL batch, and it reschedules itself.
     *
     * `.take()` on an unordered index returns the OLDEST rows, which is the
     * right end here — the longest-waiting proposals are the ones due to
     * publish. But every task published fans out to a stream, and nested
     * `ctx.runMutation` runs in the SAME transaction, so a batch of 200 could
     * cross the 4,096-read limit and roll back every publication in it. 25 is
     * comfortably inside the limit whatever the stream sizes are.
     */
    const pending = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .take(BATCH);

    let published = 0;
    let expired = 0;
    let scheduled = 0;

    for (const task of pending) {
      /**
       * TERMINAL ROWS MUST LEAVE THE PENDING INDEX.
       *
       * Marking a dead proposal `isActive: false` and skipping it left it
       * `pending` forever, at the oldest end of the very index this query reads
       * from. Once 25 of them accumulated, the window would be entirely dead
       * rows and NOTHING would ever auto-publish again — a safety valve that
       * silently welds itself shut. `expired` is a status nothing treats as
       * published, so these disappear from the supervisor queue too.
       */
      if (!task.isActive) {
        await ctx.db.patch(task._id, { approvalStatus: EXPIRED, updatedAt: now });
        expired++;
        continue;
      }

      if (task.createdAt > cutoff) continue;

      // A task whose deadline has already passed is not worth publishing — it
      // would arrive as an instruction nobody can act on, which is worse for
      // trust in the schedule than the gap it fills.
      if (task.deadline <= now) {
        await ctx.db.patch(task._id, {
          approvalStatus: EXPIRED,
          isActive: false,
          updatedAt: now,
        });
        expired++;
        continue;
      }

      await ctx.db.patch(task._id, {
        approvalStatus: 'approved',
        approvedAt: now,
        updatedAt: now,
      });

      /**
       * SCHEDULED, not awaited in this transaction.
       *
       * `ctx.runMutation` shares the caller's transaction; `runAfter(0)` gives
       * the fan-out its own. That is what keeps a batch of publications inside
       * the read limit — and it means the count below is what was scheduled,
       * not what was delivered, which is why the field is named `scheduled`.
       */
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyNewTask, {
        taskId: task._id,
      });

      scheduled++;
      published++;
    }

    /**
     * Continue ONLY if the page held work this run could act on.
     *
     * A full page of proposals that are simply too young — 25 drafted this
     * morning, an approval window of 48 hours — is not a signal that more work
     * is waiting. Rescheduling on page-fullness alone meant the sweep chased
     * its own tail with no delay for as long as the window lasted: a
     * scheduled-function storm that does nothing, once per pass, forever.
     *
     * `touched` counts rows this run actually decided. Zero means the window is
     * the constraint, not the batch size, and the hourly cron is the right
     * cadence to wait for.
     */
    const touched = published + expired;
    if (pending.length === BATCH && touched > 0) {
      await ctx.scheduler.runAfter(0, internal.tasks.autoApproveOverdueProposals, {});
    }

    return { published, expired, scheduled };
  },
});

/** The window, for the supervisor screen — so the deadline it states is the real one. */
export const approvalWindow = query({
  args: { token: v.string() },
  returns: v.object({ hours: v.number() }),
  handler: async (ctx, { token }) => {
    await requireModerator(ctx, token);
    return { hours: await approvalWindowHours(ctx) };
  },
});

/**
 * Fills the week's proposal queue: five tasks per active stream.
 *
 * RUN `./scripts/review-tasks.sh` BEFORE THIS. The bank is reviewed, not
 * assumed — see the header of lib/taskSeed.ts for what the first unreviewed
 * batch contained.
 *
 * Created as PROPOSALS, not published tasks — `approvalStatus: 'pending'` — so
 * a supervisor approves, edits or declines each before any member sees it. That
 * is the same state an agent-drafted task lands in, and the same queue at
 * /tasks/proposals reviews them.
 *
 * Idempotent per stream per week: a stream that already has a pending proposal
 * for this cadence week is skipped entirely, so re-running tops up the streams
 * that need it rather than duplicating the ones that do not.
 *
 * Deadlines come from the cohort's own weekly cadence, so all five share the
 * week's due instant and a member choosing between them is choosing on the work
 * rather than on the clock.
 */

/**
 * How long a proposal cycle lasts, and therefore how long a decline holds.
 *
 * ONE definition, used by both paths that care, because they used to disagree.
 * `seedWeeklyProposals` skips a stream that already has a pending proposal from
 * the last seven days and otherwise re-inserts the whole bank; `requestNewTask`
 * treated a decline as permanent. So a supervisor could decline a task, be told
 * the bank was exhausted, and then meet that same task again on the next
 * seeding — two answers to "what does declining mean".
 *
 * It has to be a cycle rather than forever. The bank is a FIXED five titles per
 * stream (lib/taskSeed.ts) and the seeder re-proposes the same five each cycle;
 * if declines accumulated permanently, a stream that worked through its bank
 * would be left with nothing to draw for the rest of the programme.
 *
 * So: declining means "not this one, this cycle". The next cycle starts clean,
 * which is also the honest reading — a task rejected as a poor fit in one week
 * may be exactly right in another.
 */
const PROPOSAL_CYCLE_MS = 7 * 86_400_000;

export const seedWeeklyProposals = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const programme = await taskProgrammeDecision(ctx, Date.now());
    if (!programme.allowed) return { ok: false as const, error: programme.error };

    const now = Date.now();

    /**
     * NEXT week's due instant, not this week's.
     *
     * The cadence default is the CURRENT week's deadline, which is correct for a
     * task being published now and wrong for one that has not been approved yet.
     * Seeded on a Thursday it produced a deadline of that same evening: five
     * proposals per stream, none yet seen by a supervisor, all due in six hours.
     * A week's work needs a week.
     */
    /**
     * Next week's due instant ONLY when this week's is too close to be met.
     *
     * The unconditional +7 days assumed a Thursday seeding for the following
     * week. Run on Saturday, `defaultDeadline` has already rolled to next
     * Thursday, so +7 put the deadline twelve days out — and with streams
     * skipped while they have live work, each stream got work every OTHER
     * week. Proposals wait out the approval window before anyone sees them,
     * so that plus a few working days is the minimum lead.
     */
    const minLead = (await approvalWindowHours(ctx)) * 3_600_000 + 3 * 86_400_000;
    const deadline =
      programme.defaultDeadline - now < minLead
        ? programme.defaultDeadline + 7 * 86_400_000
        : programme.defaultDeadline;
    const weekStart = now - PROPOSAL_CYCLE_MS;

    const streams = (await ctx.db.query('streams').collect()).filter((s) => s.isActive && !s.isDummy);
    const existing = await ctx.db.query('tasks').withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending')).collect();

    const created: { stream: string; count: number }[] = [];
    let skipped = 0;

    for (const stream of streams) {
      const alreadyThisWeek = existing.some(
        (t) => t.streamId === stream._id && t.createdAt >= weekStart,
      );
      if (alreadyThisWeek) { skipped++; continue; }

      /**
       * NOT when the stream already has work. This now runs on a cron as the
       * FALLBACK for the agent's own drafting (agentTasks.ts), whose tasks are
       * published directly and so never appear among the pending rows checked
       * above. Without this, a week the agent did write would also receive the
       * bank's five repeated titles two days later.
       */
      const streamTasks = await ctx.db
        .query('tasks')
        .withIndex('by_stream', (q) => q.eq('streamId', stream._id))
        .collect();
      if (streamTasks.some((t) => t.createdAt >= weekStart || (t.isActive && (t.deadline ?? 0) > now))) {
        skipped++;
        continue;
      }

      const seeds = seedTasksFor(stream.name);
      if (!seeds.length) continue;

      if (!dryRun) {
        for (const seed of seeds) {
          await ctx.db.insert('tasks', {
            streamId: stream._id,
            title: seed.title,
            // Provenance, so a later retitle cannot detach this from its bank
            // entry — see the field's note in schema.ts.
            seedTitle: seed.title,
            description: seed.description,
            submissionType: seed.submissionType,
            points: seed.points,
            deadline,
            createdBy: stream.createdBy,
            // Pending: a supervisor decides before anyone sees it.
            approvalStatus: 'pending',
            isActive: true,
            isFeatured: false,
            isDummy: false,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      created.push({ stream: stream.name, count: seeds.length });
    }

    return {
      ok: true as const,
      dryRun: Boolean(dryRun),
      streamsSeeded: created.length,
      tasksCreated: created.reduce((n, c) => n + c.count, 0),
      streamsSkippedAlreadySeeded: skipped,
      deadline,
      created,
    };
  },
});

/**
 * A supervisor asks for another task for their stream.
 *
 * The proposal queue already lets them approve, edit or decline. Declining is
 * final — the row is deleted — so a supervisor who rejects a weak task is left
 * with four for the week and no way to get back to five. This is that way.
 *
 * It draws the next task from the week's bank that this stream does not already
 * have proposed or published — and has not already DECLINED, which is the part
 * that makes repeated requests walk through the set rather than handing back
 * the task just rejected. When the bank for that stream is exhausted it says so
 * plainly instead of inventing filler — five good tasks and an honest "that is
 * all of them" beats a sixth that nobody meant.
 *
 * Exhaustion is a NORMAL outcome, not an error, and becomes the common one once
 * a stream has worked through its five: the bank is five titles per stream
 * (lib/taskSeed.ts) and published tasks stay in the table. The caller must
 * treat `success: false` here as information, not a fault — hence the message
 * naming what to do next.
 *
 * Scoped to moderators of THAT stream, like every other action in the queue.
 */
export const requestNewTask = mutation({
  args: { token: v.string(), streamId: v.id('streams') },
  handler: async (ctx, { token, streamId }) => {
    await requireStreamModerator(ctx, token, streamId);

    const programme = await taskProgrammeDecision(ctx, Date.now());
    if (!programme.allowed) return { success: false as const, error: programme.error };

    const stream = await ctx.db.get(streamId);
    if (!stream || !stream.isActive) {
      return { success: false as const, error: 'That stream is not running.' };
    }

    const existing = await ctx.db
      .query('tasks')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect();

    /**
     * Keyed on PROVENANCE where there is any, the visible title otherwise.
     *
     * The bank is matched by title, and titles are editable — so comparing only
     * the visible title meant a retitled proposal no longer matched the seed it
     * came from, and the bank offered that seed again as though untouched.
     */
    const taken = new Set(existing.map((t) => t.seedTitle ?? t.title));

    /**
     * DECLINED TITLES COUNT AS TAKEN, even though their rows are gone.
     *
     * `taken` above is built from rows currently in the table, and declining a
     * proposal DELETES its row — which frees its title again. So the first
     * "request another" after a decline returned the task that had just been
     * declined, the one flow this function exists to serve.
     *
     * Read from a table indexed BY STREAM, so this is exact and needs no cap.
     * An earlier version scanned the most recent 500 `task_proposal_declined`
     * audit rows instead; audit rows are indexed by action rather than stream,
     * so enough declines anywhere on the platform would push this stream's own
     * decline out of the window and the bug would quietly come back.
     */
    const declined = await ctx.db
      .query('declinedTaskTitles')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect();

    /**
     * Only THIS cycle's declines suppress a title.
     *
     * `seedWeeklyProposals` re-proposes the whole bank each cycle, so a decline
     * that lasted forever would have meant two answers to "what does declining
     * mean": the button saying the bank was exhausted while the seeder handed
     * the same task back the following week. Worse, the bank is a fixed five
     * per stream — permanent declines would leave a stream that worked through
     * it with nothing to draw for the rest of the programme.
     */
    const cycleStart = Date.now() - PROPOSAL_CYCLE_MS;
    for (const row of declined) {
      if (row.createdAt >= cycleStart) taken.add(row.title);
    }

    const next = seedTasksFor(stream.name).find((s) => !taken.has(s.title));

    if (!next) {
      return {
        success: false as const,
        error: `No further tasks are prepared for ${stream.name}. Write one directly, or edit an existing proposal.`,
      };
    }

    const now = Date.now();
    const taskId = await ctx.db.insert('tasks', {
      streamId,
      title: next.title,
      seedTitle: next.title,
      description: next.description,
      submissionType: next.submissionType,
      points: next.points,
      deadline: programme.defaultDeadline + 7 * 86_400_000,
      createdBy: stream.createdBy,
      approvalStatus: 'pending',
      isActive: true,
      isFeatured: false,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, taskId, title: next.title };
  },
});

/**
 * Replaces unapproved proposals with the current bank.
 *
 * The first 70 proposals were seeded before a review of their content, which
 * found real problems: tasks that would have had students submitting test data
 * to ORBIT's own live application form, fuzzing third-party production systems,
 * dismantling powered equipment, or cold-contacting business owners; several
 * that no supervisor could grade because a lazy submission was indistinguishable
 * from a good one; and costings with no currency, city or price source.
 *
 * Safe to run only while they are unapproved, which is enforced: anything a
 * supervisor has already approved or that carries a submission is left exactly
 * as it is. This deletes the rest and re-seeds from the corrected bank.
 */
export const replaceUnapprovedProposals = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const pending = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .collect();

    let removed = 0;
    let keptBecauseSubmitted = 0;

    for (const task of pending) {
      const submission = await ctx.db
        .query('submissions')
        .withIndex('by_task', (q) => q.eq('taskId', task._id))
        .first();

      // A proposal members never saw cannot have one, but checking costs
      // nothing and makes this safe to run at any point later.
      if (submission) { keptBecauseSubmitted++; continue; }
      if (!dryRun) await ctx.db.delete(task._id);
      removed++;
    }

    return { dryRun: Boolean(dryRun), removed, keptBecauseSubmitted };
  },
});

/**
 * Brings the live proposal queue back into line with the task bank.
 *
 * TWO THINGS DRIFT. Rescoring `lib/taskSeed.ts` changes what a task is worth
 * for tasks created AFTERWARDS; the rows already in the queue keep whatever
 * they were seeded with, so the bank and the queue quietly disagree. And a task
 * RENAMED in the bank no longer matches its live row at all — during one
 * clean-up that mismatch cost three legitimate proposals, deleted as though
 * they were demo leftovers, because the sweep compared new titles against a
 * database holding the old ones.
 *
 * Matched on description rather than title, precisely because titles are the
 * thing that changes. Descriptions are the task; a title is a label on it.
 *
 * Only ever touches PENDING proposals. A published task with work against it is
 * repriced through `tasks.update`, which rescales the scores already awarded —
 * doing that silently here would move people's points with no audit trail.
 */
export const syncProposalsToBank = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    bank: v.array(
      v.object({
        title: v.string(),
        description: v.string(),
        submissionType: v.string(),
        points: v.number(),
        streamMatch: v.string(),
      }),
    ),
  },
  handler: async (ctx, { dryRun, bank }) => {
    const pending = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .collect();

    /**
     * Matched on description OR title, because BOTH drift and not together.
     *
     * Description alone looks right — titles are labels, descriptions are the
     * task — until an edit rewords a description, at which point its live row
     * looks like a stranger. Title alone fails the moment a task is renamed.
     * A pass that used description only reported five bank entries missing when
     * three had been renamed and two reworded, and none were actually absent.
     */
    const byDescription = new Map(pending.map((t) => [t.description, t]));
    const byTitle = new Map(pending.map((t) => [t.title, t]));
    const claimed = new Set<string>();

    const allStreams = (await ctx.db.query('streams').collect()).filter(
      (st) => st.isActive && !st.isDummy,
    );
    const streamsByMatch = (raw: string) => {
      const pattern = new RegExp(raw.replace(/^\/|\/[a-z]*$/g, ''), 'i');
      return allStreams.find((st) => pattern.test(st.name));
    };

    const moved: { title: string; to: string }[] = [];
    const repriced: { title: string; from: number; to: number }[] = [];
    const retitled: { from: string; to: string }[] = [];
    const missing: string[] = [];

    for (const seed of bank) {
      const found = byDescription.get(seed.description) ?? byTitle.get(seed.title);
      // One live row cannot satisfy two bank entries — without this, a pair
      // sharing a description would both bind to it and one would be repriced
      // twice while the other was reported missing.
      const live = found && !claimed.has(String(found._id)) ? found : undefined;
      if (!live) {
        missing.push(seed.title);
        continue;
      }
      claimed.add(String(live._id));
      const patch: Record<string, unknown> = {};
      if (live.points !== seed.points) {
        repriced.push({ title: seed.title, from: live.points, to: seed.points });
        patch.points = seed.points;
      }
      if (live.description !== seed.description) {
        patch.description = seed.description;
      }
      /**
       * The STREAM is part of the bank entry too.
       *
       * A task moved between streams in the bank — because it belonged with a
       * different set of work — kept its original stream here, so the queue and
       * the bank quietly disagreed about whose task it was. Patched like any
       * other field; only pending proposals are touched, so nothing an intern
       * has accepted can be moved out from under them.
       */
      const wantStream = streamsByMatch(seed.streamMatch);
      if (wantStream && live.streamId !== wantStream._id) {
        patch.streamId = wantStream._id;
        moved.push({ title: seed.title, to: wantStream.name });
      }
      if (live.title !== seed.title) {
        retitled.push({ from: live.title, to: seed.title });
        patch.title = seed.title;
        // Provenance follows the rename, or the bank stops recognising its own
        // task the next time someone asks for a replacement.
        patch.seedTitle = seed.title;
      }
      if (!dryRun && Object.keys(patch).length) {
        await ctx.db.patch(live._id, { ...patch, updatedAt: Date.now() });
      }
    }

    /**
     * Restores bank entries with no live row.
     *
     * `seedWeeklyProposals` cannot do this: it skips any stream that already
     * has a proposal this cycle, which every stream does — so a single task
     * lost from an otherwise-seeded stream stays lost. That is not theoretical;
     * three were lost exactly this way when a clean-up matched renamed titles
     * against a database still holding the old ones.
     */
    let inserted = 0;
    if (!dryRun && missing.length) {
      const programme = await taskProgrammeDecision(ctx, Date.now());
      if (!programme.allowed) {
        return {
          dryRun: false,
          livePending: pending.length,
          bankSize: bank.length,
          repriced: repriced.length,
          retitled: retitled.length,
          missing,
          inserted: 0,
          error: programme.error,
          sample: repriced.slice(0, 8),
        };
      }

      const streams = (await ctx.db.query('streams').collect()).filter(
        (st) => st.isActive && !st.isDummy,
      );
      // Same deadline the seeder uses: next week's due instant, not this
      // week's, because a proposal nobody has approved yet needs a week of
      // runway once it is.
      const deadline = programme.defaultDeadline + PROPOSAL_CYCLE_MS;

      for (const title of missing) {
        const seed = bank.find((b) => b.title === title);
        if (!seed) continue;
        const pattern = new RegExp(seed.streamMatch.replace(/^\/|\/[a-z]*$/g, ''), 'i');
        const stream = streams.find((st) => pattern.test(st.name));
        if (!stream) continue;

        await ctx.db.insert('tasks', {
          streamId: stream._id,
          title: seed.title,
          seedTitle: seed.title,
          description: seed.description,
          submissionType: seed.submissionType,
          points: seed.points,
          deadline,
          createdBy: stream.createdBy,
          approvalStatus: 'pending',
          isActive: true,
          isFeatured: false,
          isDummy: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        inserted++;
      }
    }

    return {
      dryRun: Boolean(dryRun),
      livePending: pending.length,
      bankSize: bank.length,
      repriced: repriced.length,
      retitled: retitled.length,
      moved,
      missing,
      inserted,
      sample: repriced.slice(0, 8),
    };
  },
});

/**
 * Publishes every pending proposal at once, without notifying anybody.
 *
 * WHY SILENT. The ordinary approval paths — `approveProposal` and the
 * auto-publish sweep — both schedule `notifyNewTask`, which fans out to every
 * member of the task's stream. That is right for one task appearing in a
 * working week. It is wrong for the go-live backlog: 75 proposals across 14
 * streams, published in one action, minutes after the email hold was released,
 * would put several hundred notifications into the queue and land as a wall of
 * mail in the inbox of an intern whose acceptance arrived the same morning.
 * The tasks need to be THERE; nobody needs to be told about each one.
 *
 * Applies the same two refusals the sweep does, for the same reasons: an
 * inactive proposal is marked expired so it leaves the pending index rather
 * than clogging it, and a proposal whose deadline has already passed is expired
 * rather than published, because a task nobody can act on damages trust in the
 * schedule more than the gap it was filling.
 *
 * `approvedBy` is deliberately left unset, matching the sweep — so "published
 * as part of go-live" stays distinguishable from "a supervisor read this and
 * agreed".
 */
export const publishAllPendingProposals = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    published: v.number(),
    expiredInactive: v.number(),
    expiredPastDeadline: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx, { dryRun }) => {
    const now = Date.now();

    const pending = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .take(BATCH);

    let published = 0;
    let expiredInactive = 0;
    let expiredPastDeadline = 0;

    for (const task of pending) {
      if (!task.isActive) {
        if (!dryRun) await ctx.db.patch(task._id, { approvalStatus: EXPIRED, updatedAt: now });
        expiredInactive++;
        continue;
      }

      if (task.deadline <= now) {
        if (!dryRun) {
          await ctx.db.patch(task._id, {
            approvalStatus: EXPIRED,
            isActive: false,
            updatedAt: now,
          });
        }
        expiredPastDeadline++;
        continue;
      }

      if (!dryRun) {
        await ctx.db.patch(task._id, {
          approvalStatus: 'approved',
          approvedAt: now,
          updatedAt: now,
        });
      }
      published++;
    }

    const left = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .take(BATCH + 1);

    return {
      published,
      expiredInactive,
      expiredPastDeadline,
      remaining: dryRun ? left.length : Math.max(0, left.length - published - expiredInactive - expiredPastDeadline),
    };
  },
});

/**
 * A true count of submissions by status, and how long the oldest has waited.
 *
 * `listSubmissions` caps at 200 rows by design — it feeds a screen, and an
 * unbounded read on a table that grows as interns x tasks x resubmissions would
 * take that screen down. But it means the number it returns stops being a count
 * exactly when the backlog becomes worth counting: 200 looked like the answer
 * when it was the ceiling.
 *
 * Reads ids, status and timestamps only, never submitted text or file
 * references, so it stays well inside the read limit.
 */
export const submissionCounts = internalQuery({
  args: {},
  returns: v.object({
    total: v.number(),
    byStatus: v.record(v.string(), v.number()),
    oldestPendingAt: v.union(v.number(), v.null()),
    pendingOlderThan48h: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const CAP = 8000;
    const rows = await ctx.db.query('submissions').take(CAP + 1);
    const truncated = rows.length > CAP;
    const all = rows.slice(0, CAP);

    const byStatus: Record<string, number> = {};
    let oldest: number | null = null;
    let stale = 0;
    const now = Date.now();
    const CUTOFF = now - 48 * 60 * 60 * 1000;

    for (const r of all) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.status !== 'submitted') continue;
      const at = r.submittedAt ?? r.createdAt;
      if (oldest === null || at < oldest) oldest = at;
      if (at < CUTOFF) stale++;
    }

    return { total: all.length, byStatus, oldestPendingAt: oldest, pendingOlderThan48h: stale, truncated };
  },
});

/**
 * How long a submission may wait before the agent approves it itself.
 *
 * Longer than the 48 hours a task PROPOSAL gets, because the cost of being
 * early is different at each end. An unactioned proposal publishes work nobody
 * objected to; an unactioned submission is a person's finished effort, and a
 * supervisor deserves a fair chance to read it before the platform decides on
 * their behalf. Three working days is that chance.
 */
const AUTO_REVIEW_AFTER_HOURS = 72;

/** How many to settle per run, before rescheduling. Sized like the other sweeps. */
const AUTO_REVIEW_BATCH = 25;

/**
 * Approves submissions no supervisor has reviewed in time.
 *
 * WHY THIS HAS TO EXIST. A submission that nobody reads is worse for an intern
 * than one that is rejected: they cannot resubmit, cannot earn the points, and
 * cannot tell whether their work was poor or simply unseen. The review queue
 * reached 524 with not one of them actioned and the oldest waiting over a week,
 * so this is not a hypothetical failure mode.
 *
 * IT ONLY EVER APPROVES. An automated rejection is indefensible — no machine
 * here has read the work, and "rejected" is a judgement that a person has to
 * make and be answerable for. Where a supervisor's silence is the only signal,
 * the benefit of the doubt goes to the intern who did the work, not to the
 * platform.
 *
 * IT PAYS IN FULL, for the same reason. Withholding points because a supervisor
 * was busy charges the intern for someone else's delay.
 *
 * `reviewedBy` IS LEFT UNSET, exactly as `autoApproveOverdueProposals` leaves
 * `approvedBy` unset. That is what keeps "the window expired" distinguishable
 * from "a supervisor read this and agreed" — in the data, permanently, for
 * anyone auditing how a mark was arrived at. The feedback says so in words too,
 * because the intern is entitled to know their work was not individually read.
 *
 * REFUSES AN EMPTY SUBMISSION. A row with no text and no file is not work, and
 * paying for it would put points on the leaderboard that nothing earned.
 */
export const autoReviewStaleSubmissions = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    afterHours: v.optional(v.number()),
    agentFallback: v.optional(v.boolean()),
  },
  returns: v.object({
    approved: v.number(),
    skippedEmpty: v.number(),
    skippedAlreadyPaid: v.number(),
    remaining: v.number(),
    dryRun: v.boolean(),
  }),
  handler: async (
    ctx,
    { dryRun, afterHours, agentFallback },
  ): Promise<{
    approved: number;
    skippedEmpty: number;
    skippedAlreadyPaid: number;
    remaining: number;
    dryRun: boolean;
  }> => {
    const now = Date.now();
    const cutoff = now - (afterHours ?? AUTO_REVIEW_AFTER_HOURS) * 60 * 60 * 1000;

    // Oldest SUBMISSION first. `by_status` orders by row creation, so a class
    // of permanently-stuck rows would sit at the head of the window for ever.
    const pending = await ctx.db
      .query('submissions')
      .withIndex('by_status_and_submitted', (q) => q.eq('status', 'submitted'))
      .take(AUTO_REVIEW_BATCH * 8);

    const due = pending.filter((s) => {
      const submitted = s.submittedAt ?? s.createdAt;
      if (!agentFallback) return submitted < cutoff;
      const a = s.agentAssessment;
      return settledByFallback(a?.outcome, submitted, a?.firstAt ?? a?.at, cutoff, now);
    });
    const batch = due.slice(0, AUTO_REVIEW_BATCH);

    let approved = 0;
    let skippedEmpty = 0;
    let skippedAlreadyPaid = 0;

    for (const sub of batch) {
      const task = await ctx.db.get(sub.taskId);
      if (!task) continue;

      /**
       * BOTH FILE COLUMNS, and this nearly shipped checking one.
       *
       * `attachSubmissionFile` stores a Convex file as `submissionFileId`;
       * `submissionFileUrl` holds a LINK submission. Testing only the url made
       * every file-based submission look empty — a dry run reported 11 of 25
       * "empty", all of which turned out to hold real uploaded work. Left
       * uncorrected this would have silently skipped every intern who submitted
       * a file, denying them points for work the platform had stored perfectly
       * well, and it would have looked like interns submitting nothing rather
       * than a bug in the check.
       */
      const hasWork =
        (sub.submissionText && sub.submissionText.trim().length > 0) ||
        Boolean(sub.submissionFileUrl) ||
        Boolean(sub.submissionFileId);
      if (!hasWork) {
        skippedEmpty++;
        continue;
      }

      /**
       * Never pay twice. This only ever sees rows still marked `submitted`, so
       * a prior payment should be impossible — but the ledger is the thing that
       * moves a leaderboard, and checking it costs one read against a mistake
       * that would be invisible and permanent.
       */
      // The NET, as in applyAssessment: a withdrawn mark leaves a +n and a -n
      // that sum to zero, and testing for a row's existence stranded every
      // withdrawn submission unpaid for ever.
      const ledger = await ctx.db
        .query('pointsLedger')
        .withIndex('by_user_and_reference', (q) =>
          q.eq('userId', sub.userId).eq('referenceType', 'submission').eq('referenceId', sub._id),
        )
        .collect();
      const paid = ledger.reduce((sum, e) => sum + e.points, 0) !== 0;
      if (paid) {
        skippedAlreadyPaid++;
        continue;
      }

      if (dryRun) {
        approved++;
        continue;
      }

      await ctx.db.patch(sub._id, {
        status: 'approved',
        score: task.points,
        reviewedAt: now,
        // reviewedBy deliberately absent — see the note above.
        feedback: autoApprovalFeedback(sub.agentAssessment?.outcome),
        updatedAt: now,
      });

      await awardPoints(ctx, {
        userId: sub.userId,
        points: task.points,
        reason: `Auto-approved: ${task.title}`,
        referenceId: String(sub._id),
        referenceType: 'submission',
        createdBy: sub.userId,
      });

      await ctx.scheduler.runAfter(0, internal.badges.checkAndAward, { userId: sub.userId });
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifySubmissionReviewed, {
        submissionId: sub._id,
        status: 'approved',
      });

      approved++;
    }

    const remaining = Math.max(0, due.length - batch.length);

    // Continue only while there is more that this run could act on.
    if (!dryRun && batch.length === AUTO_REVIEW_BATCH && remaining > 0) {
      await ctx.scheduler.runAfter(0, internal.tasks.autoReviewStaleSubmissions, {
        afterHours,
        agentFallback,
      });
    }

    return { approved, skippedEmpty, skippedAlreadyPaid, remaining, dryRun: Boolean(dryRun) };
  },
});

/**
 * Samples submissions that look empty, to tell a blank row from a lost one.
 *
 * The auto-review dry run found 44% of the due batch carrying neither text nor
 * a file. Either interns are submitting nothing, or the submit path is losing
 * what they sent — and those need opposite responses. Returns shapes and
 * lengths, never the work itself.
 */
export const sampleEmptySubmissions = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.string(),
      taskTitle: v.string(),
      submissionType: v.string(),
      textLength: v.number(),
      hasFile: v.boolean(),
      startedAt: v.union(v.number(), v.null()),
      submittedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(400);

    const empty = rows.filter(
      (r) =>
        !(r.submissionText && r.submissionText.trim()) &&
        !r.submissionFileUrl &&
        !r.submissionFileId,
    );

    const out = [];
    for (const r of empty.slice(0, limit ?? 12)) {
      const t = await ctx.db.get(r.taskId);
      out.push({
        id: String(r._id),
        taskTitle: t?.title ?? '(task missing)',
        submissionType: t?.submissionType ?? '(none)',
        textLength: (r.submissionText ?? '').length,
        hasFile: Boolean(r.submissionFileUrl) || Boolean(r.submissionFileId),
        startedAt: r.startedAt ?? null,
        submittedAt: r.submittedAt ?? null,
      });
    }
    return out;
  },
});

/** What the pending queue is made of, for judging whether it can be assessed. */
export const pendingShape = internalQuery({
  args: {},
  returns: v.object({
    total: v.number(),
    byType: v.record(v.string(), v.number()),
    withText: v.number(),
    withFile: v.number(),
    withLink: v.number(),
    medianTextLength: v.number(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(1000);

    const byType: Record<string, number> = {};
    let withText = 0, withFile = 0, withLink = 0;
    const lens: number[] = [];

    for (const r of rows) {
      const t = await ctx.db.get(r.taskId);
      const k = t?.submissionType ?? 'unknown';
      byType[k] = (byType[k] ?? 0) + 1;
      const txt = (r.submissionText ?? '').trim();
      if (txt) { withText++; lens.push(txt.length); }
      if (r.submissionFileId) withFile++;
      if (r.submissionFileUrl) withLink++;
    }
    lens.sort((a, b) => a - b);
    return {
      total: rows.length, byType, withText, withFile, withLink,
      medianTextLength: lens.length ? lens[Math.floor(lens.length / 2)] : 0,
    };
  },
});

/**
 * Pending submissions with the work and the brief, for assessment.
 *
 * Returns what a marker actually needs: the task's own wording and points, and
 * what the intern wrote. Text only — a file submission cannot be judged from
 * here and is excluded rather than half-assessed on its metadata.
 */
export const pendingForAssessment = internalQuery({
  args: { limit: v.optional(v.number()), skip: v.optional(v.number()) },
  returns: v.array(
    v.object({
      submissionId: v.string(),
      taskTitle: v.string(),
      taskDescription: v.string(),
      maxPoints: v.number(),
      submissionText: v.string(),
      submittedAt: v.number(),
    }),
  ),
  handler: async (ctx, { limit, skip }) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(600);

    const out = [];
    for (const r of rows) {
      const txt = (r.submissionText ?? '').trim();
      // Accompanying notes are not the work when the evidence is a file or link.
      if (!txt || r.submissionFileId || r.submissionFileUrl) continue;
      const t = await ctx.db.get(r.taskId);
      if (!t) continue;
      out.push({
        submissionId: String(r._id),
        taskTitle: t.title,
        taskDescription: t.description,
        maxPoints: t.points,
        submissionText: txt,
        submittedAt: r.submittedAt ?? r.createdAt,
      });
    }
    out.sort((a, b) => a.submittedAt - b.submittedAt);
    return out.slice(skip ?? 0, (skip ?? 0) + (limit ?? 10));
  },
});

/**
 * Records an assessed score and feedback on a pending submission.
 *
 * The counterpart to `autoReviewStaleSubmissions`, and deliberately different
 * from it: that one pays full marks because nothing read the work, this one
 * carries a score something actually arrived at by reading it. Both leave
 * `reviewedBy` UNSET, because neither is a supervisor — an intern and anyone
 * auditing later can tell an assessed mark from a human one, permanently.
 *
 * REFUSES anything already reviewed or already paid. The ledger is what moves a
 * leaderboard, and a double payment there is invisible and permanent.
 */
export const applyAssessment = internalMutation({
  args: {
    submissionId: v.id('submissions'),
    score: v.number(),
    feedback: v.string(),
    assessor: v.string(),
    notify: v.optional(v.boolean()),
    // See recordAgentOutcome: refuses a mark for work the intern has since replaced.
    expectUpdatedAt: v.optional(v.number()),
  },
  returns: v.object({ applied: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { submissionId, score, feedback, assessor, notify, expectUpdatedAt }) => {
    const sub = await ctx.db.get(submissionId);
    if (!sub) return { applied: false, reason: 'not found' };
    if (sub.status !== 'submitted') return { applied: false, reason: `already ${sub.status}` };
    if (expectUpdatedAt !== undefined && sub.updatedAt !== expectUpdatedAt) {
      return { applied: false, reason: 'resubmitted while it was being marked' };
    }

    const task = await ctx.db.get(sub.taskId);
    if (!task) return { applied: false, reason: 'task missing' };

    // Bounded to what the task is worth, exactly as reviewSubmission bounds a
    // reviewer's score. An assessor handing back 12 for an 8-point task is a
    // mistake to refuse, not to clamp silently.
    if (!Number.isInteger(score) || score < 0 || score > task.points) {
      return { applied: false, reason: `score ${score} outside 0..${task.points}` };
    }

    /**
     * The NET, not the existence of a row.
     *
     * `withdrawAssessment` reverses a payment by writing a negative entry
     * rather than deleting the original — the ledger is a record, and deleting
     * from it would hide that a mark was ever given. So a withdrawn submission
     * still HAS entries; they simply sum to zero. Testing for existence meant a
     * submission could never be re-marked after a withdrawal: nine were
     * withdrawn for a second review and then refused re-entry, leaving their
     * authors with no mark at all until this was fixed.
     */
    const ledger = await ctx.db
      .query('pointsLedger')
      .withIndex('by_user_and_reference', (q) =>
        q.eq('userId', sub.userId).eq('referenceType', 'submission').eq('referenceId', submissionId),
      )
      .collect();
    const paidSoFar = ledger.reduce((sum, e) => sum + e.points, 0);
    if (paidSoFar !== 0) {
      return { applied: false, reason: `already paid ${paidSoFar}` };
    }

    const now = Date.now();
    await ctx.db.patch(submissionId, {
      status: 'approved',
      score,
      reviewedAt: now,
      // reviewedBy deliberately absent — this was not a supervisor.
      feedback: `${feedback}\n\n— Assessed by ${assessor}. Your supervisor can revisit this at any time.`,
      updatedAt: now,
    });

    if (score > 0) {
      const paid = await awardPoints(ctx, {
        userId: sub.userId,
        points: score,
        reason: `Assessed: ${task.title}`,
        referenceId: String(submissionId),
        referenceType: 'submission',
        createdBy: sub.userId,
      });

      /**
       * PAY EVEN IF `awardPoints` DECLINED, or a correction confiscates points.
       *
       * `awardPoints` writes nothing for anyone `isIntern` rejects — which is
       * not only staff: it excludes MODERATORS, so an intern promoted to lead
       * their stream is in that set. `withdrawAssessment` inserts its debit
       * directly and therefore always succeeds, so the withdraw-then-re-mark
       * cycle used to correct a bad mark would take the points away and never
       * give them back, while still returning `applied: true`.
       *
       * That is exactly the remediation flow this was built for: the twelve
       * interns whose Google links could not be read were withdrawn and
       * re-marked. Before the direct-insert withdrawal both halves no-oped and
       * the cycle was harmlessly net-zero; making one half work made the pair
       * net-negative.
       *
       * Mirrors the withdrawal: insert the row, then recompute from the ledger.
       */
      if (paid.awarded === 0) {
        await ctx.db.insert('pointsLedger', {
          userId: sub.userId,
          points: score,
          reason: `Assessed: ${task.title}`,
          referenceId: String(submissionId),
          referenceType: 'submission',
          createdBy: sub.userId,
          isDummy: false,
          createdAt: Date.now(),
        });
        await recomputeUserPoints(ctx, sub.userId);
      }

      await ctx.scheduler.runAfter(0, internal.badges.checkAndAward, { userId: sub.userId });
    }

    // Bulk assessors can suppress the review email; ordinary reviews still notify.
    if (notify !== false) {
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifySubmissionReviewed, {
        submissionId,
        status: 'approved',
      });
    }

    return { applied: true };
  },
});

/** How long a transient failure (a reader timed out) waits before a retry. */
const AGENT_RETRY_MS = 6 * 60 * 60 * 1000;
/** An unreadable link is re-fetched daily, a few times, in case it was reshared. */
const UNREADABLE_RETRY_MS = 24 * 60 * 60 * 1000;
const UNREADABLE_MAX_ATTEMPTS = 4;

/**
 * The marking runner's work queue: every pending submission it has not already
 * tried in its current form, oldest submission first.
 *
 * Covers all three evidence kinds, unlike `pendingForAssessment` (text only).
 * Files come with a short-lived storage URL so the runner can download and read
 * them; links come as the raw URL, and deciding whether a link is readable is
 * the runner's job, because only something that fetches it can tell.
 *
 * SKIPS WHAT IT ALREADY TRIED, unless the intern changed it since. A contested
 * row re-read every cycle would cost the same readers the same disagreement
 * forever; it waits for `autoReviewStaleSubmissions` instead. A transient
 * failure (`no-quorum`) is retried after six hours.
 */
export const pendingForAgent = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(
      v.object({
        submissionId: v.string(),
        taskTitle: v.string(),
        taskDescription: v.string(),
        submissionType: v.string(),
        maxPoints: v.number(),
        submissionText: v.string(),
        fileUrl: v.union(v.string(), v.null()),
        fileContentType: v.string(),
        link: v.string(),
        submittedAt: v.number(),
        updatedAt: v.number(),
        previousOutcome: v.union(v.string(), v.null()),
      }),
    ),
    queueDepth: v.number(),
  }),
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status_and_submitted', (q) => q.eq('status', 'submitted'))
      .take(800);

    const due = rows.filter((r) => {
      const hasWork =
        Boolean(r.submissionText?.trim()) || Boolean(r.submissionFileId) || Boolean(r.submissionFileUrl);
      if (!hasWork) return false;
      const prior = r.agentAssessment;
      if (!prior) return true;
      if (r.updatedAt > prior.at) return true;
      if (prior.outcome === 'no-quorum') return now - prior.at > AGENT_RETRY_MS;
      /**
       * A RESHARE MOVES NOTHING ON THE ROW. The intern fixes a Google sharing
       * setting, exactly as asked, and the submission is byte-for-byte the same
       * — so `updatedAt` cannot be how an unreadable link gets another look.
       * Re-fetching is free (no model runs until the evidence reads), so it is
       * simply retried daily, a few times, inside the settlement window.
       */
      if (prior.outcome === 'unreadable') {
        return now - prior.at > UNREADABLE_RETRY_MS && prior.attempts < UNREADABLE_MAX_ATTEMPTS;
      }
      return false;
    });

    const cap = Math.max(1, Math.min(limit ?? 12, 50));
    const out = [];
    for (const r of due) {
      if (out.length >= cap) break;
      // Skipped, not counted: a row whose task is gone must not take a batch
      // slot every cycle and starve the rows behind it.
      const t = await ctx.db.get(r.taskId);
      if (!t) continue;
      let fileUrl: string | null = null;
      let fileContentType = '';
      if (r.submissionFileId) {
        fileUrl = await ctx.storage.getUrl(r.submissionFileId);
        const meta = await ctx.db.system.get(r.submissionFileId);
        fileContentType = meta?.contentType ?? '';
      }
      out.push({
        submissionId: String(r._id),
        taskTitle: t.title,
        taskDescription: t.description,
        submissionType: t.submissionType ?? 'text',
        maxPoints: t.points,
        submissionText: (r.submissionText ?? '').trim(),
        fileUrl,
        fileContentType,
        link: r.submissionFileUrl ?? '',
        submittedAt: r.submittedAt ?? r.createdAt,
        updatedAt: r.updatedAt,
        previousOutcome: r.agentAssessment?.outcome ?? null,
      });
    }
    return { rows: out, queueDepth: due.length };
  },
});

/**
 * Records that the runner looked at a submission and set it aside.
 *
 * Does NOT touch `updatedAt` — that field is how `pendingForAgent` notices the
 * intern changed their work, and moving it here would make every set-aside row
 * look freshly resubmitted and re-read it next cycle.
 */
export const recordAgentOutcome = internalMutation({
  args: {
    submissionId: v.id('submissions'),
    outcome: v.union(
      v.literal('contested'),
      v.literal('unreadable'),
      v.literal('unsupported'),
      v.literal('empty'),
      v.literal('no-quorum'),
    ),
    detail: v.optional(v.string()),
    // The `updatedAt` the runner read. If the intern resubmitted while the
    // readers were working, this verdict is about work that no longer exists.
    expectUpdatedAt: v.optional(v.number()),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, { submissionId, outcome, detail, expectUpdatedAt }) => {
    const sub = await ctx.db.get(submissionId);
    if (!sub || sub.status !== 'submitted') return { recorded: false };
    if (expectUpdatedAt !== undefined && sub.updatedAt !== expectUpdatedAt) return { recorded: false };

    const now = Date.now();
    const prior = sub.agentAssessment;
    // Same version of the work as last time? Then the settlement clock keeps
    // running from when it was first set aside; a retry must not restart it.
    const sameVersion = prior !== undefined && sub.updatedAt <= prior.at;
    const setAside = outcome !== 'no-quorum';
    const firstAt = sameVersion && prior?.firstAt !== undefined
      ? prior.firstAt
      : setAside ? now : undefined;

    await ctx.db.patch(submissionId, {
      agentAssessment: {
        outcome,
        at: now,
        attempts: (sameVersion ? prior?.attempts ?? 0 : 0) + 1,
        detail: detail?.slice(0, 500),
        ...(firstAt !== undefined ? { firstAt } : {}),
      },
    });

    /**
     * Tell the intern ONCE per version of the work, and only when there is
     * something they can do. A contested mark or an unsupported format is ours
     * to settle; an unreadable link or an empty note is theirs to fix, and they
     * cannot fix what nobody tells them about. Skipped if the reshare chaser
     * already asked about this submission recently.
     */
    const firstTimeForVersion = !sameVersion || prior?.firstAt === undefined;
    const recentlyChased =
      sub.resharePromptedAt !== undefined && now - sub.resharePromptedAt < 5 * 24 * 60 * 60 * 1000;
    if ((outcome === 'unreadable' || outcome === 'empty') && firstTimeForVersion && !recentlyChased) {
      const task = await ctx.db.get(sub.taskId);
      await ctx.db.insert('notifications', {
        userId: sub.userId,
        type: 'submission_unreadable',
        title: outcome === 'empty' ? 'Your submission has no work in it yet' : 'We could not open your submission',
        content:
          outcome === 'empty'
            ? `Your submission for "${task?.title ?? 'a task'}" does not contain the work itself, ` +
              `so it cannot be marked. Please resubmit with the work — text, a file, or a link ` +
              `anyone can open.`
            : `ORBIT could not read your submission for "${task?.title ?? 'a task'}"` +
              (detail ? ` (${detail})` : '') +
              `. If it is a link, make sure anyone with the link can open it without signing in; ` +
              `ORBIT will try it again automatically. Or resubmit it as a PDF or document.`,
        actionUrl: `/tasks/${sub.taskId}`,
        relatedTaskId: sub.taskId,
        isRead: false,
        isDummy: false,
        createdAt: now,
      });
    }
    return { recorded: true };
  },
});

/**
 * Sends a submission back for another attempt, with the markers' feedback.
 *
 * FOR A ZERO, NOT A LOW MARK. When both readers agree the work earns nothing —
 * nearly always because it answers a different task — recording 0 as
 * `approved` closes the submission for good: `submitWork` refuses to reopen an
 * approved row, so feedback saying "please resubmit" would be advice the
 * intern cannot take. `changes_requested` leaves it open, pays nothing yet,
 * and the resubmission is marked on its merits like any other.
 *
 * Never used for a mark above zero: a low-but-real score is a judgement to
 * record, not a request to try again.
 */
export const returnForChanges = internalMutation({
  args: {
    submissionId: v.id('submissions'),
    feedback: v.string(),
    assessor: v.string(),
    expectUpdatedAt: v.optional(v.number()),
  },
  returns: v.object({ applied: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { submissionId, feedback, assessor, expectUpdatedAt }) => {
    const sub = await ctx.db.get(submissionId);
    if (!sub) return { applied: false, reason: 'not found' };
    if (sub.status !== 'submitted') return { applied: false, reason: `already ${sub.status}` };
    if (expectUpdatedAt !== undefined && sub.updatedAt !== expectUpdatedAt) {
      return { applied: false, reason: 'resubmitted while it was being marked' };
    }
    const now = Date.now();
    await ctx.db.patch(submissionId, {
      status: 'changes_requested',
      score: undefined,
      reviewedAt: now,
      feedback: `${feedback}\n\n— Returned by ${assessor}. Resubmit when ready; it will be marked again.`,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifySubmissionReviewed, {
      submissionId,
      status: 'changes_requested',
    });
    return { applied: true };
  },
});

/** A sample of assessed marks, to sanity-check the spread and the feedback. */
export const assessedSample = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    total: v.number(),
    fullMarks: v.number(),
    zero: v.number(),
    avgFraction: v.number(),
    sample: v.array(v.object({ score: v.number(), max: v.number(), feedback: v.string() })),
  }),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'approved'))
      .take(600);

    const marked = rows.filter((r) => r.reviewedBy === undefined && r.score !== undefined);
    let full = 0, zero = 0, sum = 0, n = 0;
    const sample = [];
    for (const r of marked) {
      const t = await ctx.db.get(r.taskId);
      if (!t) continue;
      const sc = r.score ?? 0;
      if (sc === t.points) full++;
      if (sc === 0) zero++;
      sum += sc / t.points; n++;
      if (sample.length < (limit ?? 8)) {
        sample.push({ score: sc, max: t.points, feedback: (r.feedback ?? '').slice(0, 150) });
      }
    }
    return {
      total: marked.length, fullMarks: full, zero,
      avgFraction: n ? Math.round((sum / n) * 100) / 100 : 0,
      sample,
    };
  },
});

/** File submissions awaiting review, with the brief and the file's shape. */
export const pendingFileSubmissions = internalQuery({
  args: { limit: v.optional(v.number()), skip: v.optional(v.number()) },
  returns: v.array(
    v.object({
      submissionId: v.string(),
      taskTitle: v.string(),
      taskDescription: v.string(),
      maxPoints: v.number(),
      fileName: v.string(),
      contentType: v.string(),
      sizeBytes: v.number(),
      submissionText: v.string(),
      isLink: v.boolean(),
      link: v.string(),
    }),
  ),
  handler: async (ctx, { limit, skip }) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(700);

    const out = [];
    for (const r of rows) {
      const hasFile = Boolean(r.submissionFileId);
      const hasLink = Boolean(r.submissionFileUrl);
      if (!hasFile && !hasLink) continue;

      const t = await ctx.db.get(r.taskId);
      if (!t) continue;

      let fileName = '', contentType = '', sizeBytes = 0;
      if (r.submissionFileId) {
        const meta = await ctx.db.system.get(r.submissionFileId);
        if (meta) {
          contentType = meta.contentType ?? '';
          sizeBytes = meta.size ?? 0;
        }
        fileName = "";
      }

      out.push({
        submissionId: String(r._id),
        taskTitle: t.title,
        taskDescription: t.description,
        maxPoints: t.points,
        fileName, contentType, sizeBytes,
        submissionText: (r.submissionText ?? '').trim(),
        isLink: hasLink && !hasFile,
        link: r.submissionFileUrl ?? '',
      });
    }
    return out.slice(skip ?? 0, (skip ?? 0) + (limit ?? 20));
  },
});

/** Low-scoring assessed submissions, for a second look before they stand. */
export const lowScored = internalQuery({
  args: { maxFraction: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      submissionId: v.string(),
      userId: v.string(),
      userName: v.string(),
      userEmail: v.string(),
      taskTitle: v.string(),
      taskDescription: v.string(),
      maxPoints: v.number(),
      score: v.number(),
      feedback: v.string(),
      submissionText: v.string(),
      hasFile: v.boolean(),
      link: v.string(),
    }),
  ),
  handler: async (ctx, { maxFraction, limit }) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'approved'))
      .take(700);

    const out = [];
    for (const r of rows) {
      // Only the agent's own marks — a supervisor's judgement is not ours to review.
      if (r.reviewedBy !== undefined) continue;
      if (r.score === undefined || r.score === null) continue;
      const t = await ctx.db.get(r.taskId);
      if (!t || !t.points) continue;
      if (r.score / t.points > (maxFraction ?? 0.4)) continue;
      const u = await ctx.db.get(r.userId);
      out.push({
        submissionId: String(r._id),
        userId: String(r.userId),
        userName: u?.fullName ?? '',
        userEmail: u?.email ?? '',
        taskTitle: t.title,
        taskDescription: t.description,
        maxPoints: t.points,
        score: r.score,
        feedback: r.feedback ?? '',
        submissionText: (r.submissionText ?? '').slice(0, 4000),
        hasFile: Boolean(r.submissionFileId),
        link: r.submissionFileUrl ?? '',
      });
    }
    out.sort((a, b) => a.score / a.maxPoints - b.score / b.maxPoints);
    return out.slice(0, limit ?? 60);
  },
});

/** Every agent-assessed submission whose evidence was a link, with its mark. */
export const assessedLinks = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      submissionId: v.string(),
      userName: v.string(),
      userEmail: v.string(),
      taskTitle: v.string(),
      maxPoints: v.number(),
      score: v.number(),
      link: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'approved'))
      .take(700);
    const out = [];
    for (const r of rows) {
      if (r.reviewedBy !== undefined) continue;
      if (!r.submissionFileUrl) continue;
      const t = await ctx.db.get(r.taskId);
      const u = await ctx.db.get(r.userId);
      if (!t) continue;
      out.push({
        submissionId: String(r._id),
        userName: u?.fullName ?? '', userEmail: u?.email ?? '',
        taskTitle: t.title, maxPoints: t.points, score: r.score ?? -1,
        link: r.submissionFileUrl,
      });
    }
    return out;
  },
});

/**
 * Withdraws a mark the agent should never have given.
 *
 * WHY THIS EXISTS. The link assessor treated any page returning text as
 * readable. A Google Docs sign-in shell returns plenty of text — chrome,
 * boilerplate, a title — so twelve submissions were fetched, found to contain
 * no audit findings, and marked accordingly. Their mean was 8%. Every other
 * link averaged 59%. Those twelve people almost certainly did the work; what
 * failed was the fetch, and the mark recorded the failure as theirs.
 *
 * A wrong mark is worse than no mark. It sits on the record, it moved the
 * leaderboard, and the intern has been told they scored 1 out of 13 for work
 * nothing ever read. So this puts the submission back to `submitted`, clears
 * the score and the feedback, and REVERSES THE LEDGER — the same reversal
 * `reviewSubmission` performs when a decision is withdrawn, because points that
 * outlive the judgement that created them are how a leaderboard quietly stops
 * meaning anything.
 *
 * Refuses anything a human reviewed. A supervisor's decision is not ours to undo.
 */
export const withdrawAssessment = internalMutation({
  args: { submissionId: v.id('submissions'), reason: v.string() },
  returns: v.object({ withdrawn: v.boolean(), pointsReversed: v.number(), reason: v.optional(v.string()) }),
  handler: async (ctx, { submissionId, reason }) => withdrawMark(ctx, submissionId, reason),
});

/**
 * The body of `withdrawAssessment`, shared with the anomaly response in
 * agentOps.ts so both undo a mark in exactly one way.
 */
export async function withdrawMark(
  ctx: MutationCtx,
  submissionId: Id<'submissions'>,
  reason: string,
): Promise<{ withdrawn: boolean; pointsReversed: number; reason?: string }> {
  const sub = await ctx.db.get(submissionId);
  if (!sub) return { withdrawn: false, pointsReversed: 0, reason: 'not found' };
  if (sub.reviewedBy !== undefined) {
    return { withdrawn: false, pointsReversed: 0, reason: 'reviewed by a person' };
  }
  if (sub.status !== 'approved') {
    return { withdrawn: false, pointsReversed: 0, reason: `status is ${sub.status}` };
  }

  const ledger = await ctx.db
    .query('pointsLedger')
    .withIndex('by_user_and_reference', (q) =>
      q.eq('userId', sub.userId).eq('referenceType', 'submission').eq('referenceId', submissionId),
    )
    .collect();
  const paid = ledger.reduce((sum, e) => sum + e.points, 0);

  let pointsReversed = 0;
  if (paid !== 0) {
    // A correction must undo historical earnings even after the intern becomes staff.
    await ctx.db.insert('pointsLedger', {
      userId: sub.userId,
      points: -paid,
      reason: `Assessment withdrawn: ${reason}`,
      referenceId: String(submissionId),
      referenceType: 'submission',
      createdBy: sub.userId,
      isDummy: false,
      createdAt: Date.now(),
    });
    await recomputeUserPoints(ctx, sub.userId);
    pointsReversed = paid;
  }

  await ctx.db.patch(submissionId, {
    status: 'submitted',
    score: undefined,
    feedback: undefined,
    reviewedAt: undefined,
    updatedAt: Date.now(),
  });

  return { withdrawn: true, pointsReversed };
}
