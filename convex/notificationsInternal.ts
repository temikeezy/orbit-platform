import { internalMutation } from './_generated/server';
import { emailButton } from './lib/emailShell';
import { isIntern } from './lib/internProfile';
import { appUrl } from './lib/appUrl';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { MutationCtx } from './_generated/server';
import { escapeHtml, isSafeActionUrl } from './lib/html';
import { approvalWindowHours, autoPublishAt } from './lib/taskApproval';
import { formatWat } from './lib/datetime';
import { internal } from './_generated/api';
import { shouldAnnounceLevel } from './lib/levelAnnounce';

/**
 * The notification and email side-effects that used to be Postgres triggers.
 *
 * Convex has no triggers, so each of these is called explicitly by the mutation
 * that causes it. They live apart from `notifications.ts` (the client-facing
 * queries) so it stays obvious which functions are reachable from a browser and
 * which are not — all of these are internal.
 *
 * Every one respects `notificationPreferences`, which the Postgres triggers
 * mostly did not.
 */

async function prefersNotification(
  ctx: MutationCtx,
  userId: Id<'users'>,
  key:
    | 'newTaskEnabled'
    | 'deadlineReminderEnabled'
    | 'newMessageEnabled'
    | 'taskSubmittedEnabled'
    | 'taskApprovedEnabled'
    | 'taskRejectedEnabled'
    | 'streamUpdateEnabled'
    | 'levelUpEnabled'
    | 'badgeEarnedEnabled',
): Promise<boolean> {
  const prefs = await ctx.db
    .query('notificationPreferences')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first();

  // Absent preferences mean "not yet configured", which defaults to on — the
  // same behaviour as the Postgres columns, which all defaulted true.
  return prefs ? prefs[key] !== false : true;
}

/**
 * Creates the notification AND queues its email.
 *
 * orbit_create_notification_with_email did both. An earlier draft of this port
 * inserted only the notification row, so new-task and new-message emails stopped
 * entirely — the cron kept draining an empty queue and nothing errored.
 */
/**
 * Plain text as email HTML, with its shape intact.
 *
 * The body was one `<p>` around the whole string, so every line break in it
 * collapsed. That is invisible on a one-line task notification and ruins a feed
 * post, which is written in paragraphs with headings and reads as a single wall
 * of text without them.
 *
 * ESCAPED FIRST, then marked up — never the other way round. The content
 * reaching here is member-authored on most paths, and interpolating it raw once
 * let anyone inject markup into mail sent from ORBIT's own domain. Escaping
 * before adding tags keeps that closed: the only markup in the result is the
 * markup this function put there.
 */
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).split('\n').join('<br>')}</p>`)
    .join('');
}

async function createNotification(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>;
    type: string;
    title: string;
    content: string;
    actionUrl?: string;
    relatedTaskId?: Id<'tasks'>;
    relatedStreamId?: Id<'streams'>;
    relatedUserId?: Id<'users'>;
    relatedMessageId?: Id<'messages'>;
    relatedPostId?: Id<'posts'>;
    /**
     * The email's subject, when it should differ from the notification title.
     *
     * The in-app row wants a short label ("ORBIT Agent posted"); an inbox needs
     * something that distinguishes one announcement from the next.
     */
    subjectOverride?: string;
    /**
     * The email's body, when it should differ from the notification's.
     *
     * A notification row sits in a list and has to stay short; an email has a
     * whole screen. A feed post used to be cut to 160 characters for BOTH, so
     * the email — the version most people actually read, and the only one that
     * reaches somebody who has not signed in — arrived truncated mid-sentence
     * with no way to see the rest but to open the app.
     *
     * Falls back to `content`, so every existing caller is unchanged.
     */
    emailContent?: string;
  },
) {
  const now = Date.now();

  // The liveness check runs BEFORE the insert, not between the insert and the
  // email. orbit_siwes_notify created nothing at all for an inactive user; this
  // wrote the notification row anyway, so a trashed account accumulated a
  // backlog it would be handed on restore — including reminders for days it was
  // suspended — and every row fed the growth of a table several queries scan.
  const recipient = await ctx.db.get(args.userId);
  // Returns FALSE rather than nothing, so a caller counting "notified" counts
  // people actually reached. `notifyNewPost` reported 16 notified on a run that
  // created nothing at all — every one of them an inactive account dropped
  // here, while the caller incremented regardless. A count that overstates
  // delivery is worse than no count: it is the number you would quote.
  if (!recipient || !recipient.isActive || recipient.isDeleted) return false;

  /**
   * `emailContent` is for the EMAIL and is not a column on this table.
   *
   * This spread `...args` wholesale, so adding a field for the email body sent
   * it into the notifications insert too, where the schema rejected it — and
   * because the insert happens first, the throw took the whole fan-out with it.
   * A post notified nobody and nothing surfaced: the failure was inside a
   * scheduled function, so the mutation that triggered it still returned
   * success.
   *
   * Destructured rather than deleted from a copy, so the next field added for
   * one side of this function cannot silently reach the other.
   */
  const { emailContent: _emailContent, subjectOverride: _subjectOverride, ...notificationFields } = args;

  await ctx.db.insert('notifications', {
    ...notificationFields,
    isRead: false,
    isDummy: false,
    createdAt: now,
  });

  const base = appUrl();

  // An actionUrl that is not an app-relative path is dropped rather than
  // followed. These are built server-side today, but notifications.adminSend
  // accepts one from a caller, and this is the function that turns it into a
  // link in an email.
  const path = args.actionUrl && isSafeActionUrl(args.actionUrl) ? args.actionUrl : '';
  const link = `${base}${path}`;

  await ctx.db.insert('emailQueue', {
    userId: args.userId,
    emailType: args.type,
    recipientEmail: recipient.email,
    subject: args.subjectOverride ?? args.title,
    // ESCAPED. `content` is member-authored on every path that reaches here —
    // a message body, a task title — and this used to interpolate it raw, which
    // let any member inject markup into mail sent from ORBIT's domain.
    bodyHtml: textToHtml(args.emailContent ?? args.content) + emailButton(link, 'Open ORBIT'),
    bodyText: `${args.emailContent ?? args.content}\n\n${link}`,
    referenceType: args.relatedTaskId ? 'task' : args.relatedMessageId ? 'message' : undefined,
    status: 'pending',
    retryCount: 0,
    isDummy: false,
    createdAt: now,
  });

  return true;
}

/**
 * Replaces orbit_notify_new_task.
 *
 * The trigger selected recipients by `orbit_users.current_stream_id`, i.e. only
 * people whose *current* stream matched — not everyone actually in the stream.
 * This uses active streamMemberships, which is the set the UI shows.
 */
export const notifyNewTask = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return { notified: 0 };

    const stream = await ctx.db.get(task.streamId);

    const memberships = await ctx.db
      .query('streamMemberships')
      .withIndex('by_stream', (q) => q.eq('streamId', task.streamId))
      .collect();

    let notified = 0;

    for (const m of memberships.filter((m) => m.isActive)) {
      if (m.userId === task.createdBy) continue;

      /**
       * TASKS ARE FOR INTERNS. Staff review them; they are not assigned them.
       *
       * This fanned out to every active membership regardless of role, so an
       * admin, moderator or supervisor who belongs to a stream — which is
       * ordinary, it is how they see its feed — was notified and emailed about
       * every task published there as though it were theirs to do. The same
       * person is the one meant to REVIEW that task, so it also put reviewers in
       * the assignee list.
       *
       * `isIntern` already guards the logbook sweeps, the attendance sweep, the
       * deadline reminder and the SIWES reports; this was the one fan-out that
       * skipped it.
       */
      const member = await ctx.db.get(m.userId);
      if (!isIntern(member)) continue;

      if (!(await prefersNotification(ctx, m.userId, 'newTaskEnabled'))) continue;

      await createNotification(ctx, {
        userId: m.userId,
        type: 'new_task',
        title: 'New task published',
        content: `"${task.title}" was published in ${stream?.name ?? 'your stream'}. Worth ${task.points} points.`,
        actionUrl: `/tasks/${taskId}`,
        relatedTaskId: taskId,
        relatedStreamId: task.streamId,
      });
      notified++;
    }

    return { notified };
  },
});

/**
 * Tells the people who can publish it that a proposal is waiting.
 *
 * To the stream's own moderators, and to admins only when the stream has none —
 * otherwise every agent-drafted schedule would notify every admin on the
 * platform once per stream per week, which is how a notification channel stops
 * being read.
 */
export const notifyTaskProposed = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return { notified: 0 };

    const stream = await ctx.db.get(task.streamId);

    // Stated in the notification because it is the only thing that makes it
    // actionable: a supervisor needs to know not just that something is
    // waiting, but by when their silence becomes a decision.
    const hours = await approvalWindowHours(ctx);
    const publishesAt = autoPublishAt(task.createdAt, hours);

    const deadlineSentence = publishesAt
      ? `If you do nothing it publishes automatically on ${formatWat(publishesAt)}.`
      : 'It will not publish until you approve it.';

    const moderators = await ctx.db
      .query('streamModerators')
      .withIndex('by_stream', (q) => q.eq('streamId', task.streamId))
      .collect();

    let recipients = moderators.map((m) => m.userId);

    if (recipients.length === 0) {
      const admins = await ctx.db.query('users').collect();
      recipients = admins
        .filter((u) => u.isActive && !u.isDeleted)
        .filter((u) => u.roles.some((r) => r === 'admin' || r === 'super_admin'))
        .map((u) => u._id);
    }

    let notified = 0;

    for (const userId of new Set(recipients)) {
      // No preference check: this is a request for a decision addressed to a
      // specific person, not an activity update they can opt out of and still
      // do their job.
      if (userId === task.createdBy) continue;

      await createNotification(ctx, {
        userId,
        type: 'task_proposed',
        title: 'Task awaiting your approval',
        content:
          `The ORBIT agent proposed "${task.title}" for ${stream?.name ?? 'a stream'}, ` +
          `due ${formatWat(task.deadline)} and worth ${task.points} points. ` +
          `It is not visible to members until you approve it. ${deadlineSentence}`,
        actionUrl: '/tasks/proposals',
        relatedTaskId: taskId,
        relatedStreamId: task.streamId,
      });
      notified++;
    }

    return { notified };
  },
});

/** Replaces create_submission_review_notification. */
export const notifySubmissionReviewed = internalMutation({
  args: { submissionId: v.id('submissions'), status: v.string() },
  handler: async (ctx, { submissionId, status }) => {
    const submission = await ctx.db.get(submissionId);
    if (!submission) return { notified: 0 };

    const task = await ctx.db.get(submission.taskId);

    const key = status === 'approved' ? 'taskApprovedEnabled' : 'taskRejectedEnabled';
    if (!(await prefersNotification(ctx, submission.userId, key))) return { notified: 0 };

    const approved = status === 'approved';

    await createNotification(ctx, {
      userId: submission.userId,
      type: approved ? 'submission_approved' : 'submission_reviewed',
      title: approved ? 'Submission approved' : 'Submission reviewed',
      content: approved
        ? `Your submission for "${task?.title ?? 'a task'}" was approved${
            submission.score !== undefined ? ` with ${submission.score} points` : ''
          }.`
        : `Your submission for "${task?.title ?? 'a task'}" was reviewed. See the feedback.`,
      actionUrl: task ? `/tasks/${task._id}` : '/tasks',
      relatedTaskId: submission.taskId,
    });

    return { notified: 1 };
  },
});

/**
 * Replaces orbit_siwes_notify.
 *
 * The SIWES family had its own notification helper, and it was the only one that
 * consulted no preferences at all. Routed through `createNotification` here, so
 * logbook mail escapes HTML and honours the same settings as everything else.
 *
 * No preference key covers logbook review specifically — the nine columns are
 * all task/message/stream shaped — so these are unconditional, as they were.
 * That is deliberate: a supervisor's request for changes is not a notification a
 * member should be able to mute and then miss.
 */
export const notifySiwes = internalMutation({
  args: {
    userId: v.id('users'),
    type: v.string(),
    title: v.string(),
    content: v.string(),
    actionUrl: v.optional(v.string()),
  },
  handler: async (ctx, { userId, type, title, content, actionUrl }) => {
    await createNotification(ctx, {
      userId,
      type,
      title,
      content,
      actionUrl: actionUrl ?? '/logbook',
    });
    return { notified: 1 };
  },
});

/**
 * Tells the reviewer that a logbook entry is waiting.
 *
 * Recipient is the profile's assigned supervisor, falling back to the lead of
 * its department — the same COALESCE the SQL used. Silent when the submitter is
 * the reviewer, and when there is nobody to tell.
 */
export const notifyLogbookSubmitted = internalMutation({
  args: {
    // The intern, by user id. This took an internProfileId when a person had a
    // second identity; the enrolment is on the account now.
    userId: v.id('users'),
    kind: v.union(v.literal('daily_log'), v.literal('weekly_summary')),
    label: v.string(),
  },
  handler: async (ctx, { userId, kind, label }) => {
    const profile = await ctx.db.get(userId);
    if (!profile) return { notified: 0 };

    let reviewerId = profile.iihSupervisorId;

    if (!reviewerId && profile.departmentId) {
      const dept = await ctx.db.get(profile.departmentId);
      const lead = dept?.leadUserId ? await ctx.db.get(dept.leadUserId) : null;

      // Only the liveness check now. `canReviewProfile` no longer requires a
      // separate moderator role on the department-lead branch, so a lead can
      // always act on what this tells them about — which is the property that
      // matters here, and the one that was briefly false in both directions.
      if (lead && lead.isActive && !lead.isDeleted) {
        reviewerId = lead._id;
      }
    }

    if (!reviewerId || reviewerId === profile._id) return { notified: 0 };

    const intern = profile;
    const who = intern?.fullName ?? 'An intern';

    await createNotification(ctx, {
      userId: reviewerId,
      type: 'logbook_review_pending',
      title: kind === 'daily_log' ? 'Daily log awaiting review' : 'Weekly summary awaiting sign-off',
      content:
        kind === 'daily_log'
          ? `${who} submitted a daily log for ${label}.`
          : `${who} submitted a weekly summary (${label}).`,
      actionUrl: '/review',
      relatedUserId: profile._id,
    });

    return { notified: 1 };
  },
});

/**
 * Replaces BOTH create_message_notification and orbit_notify_new_message.
 *
 * Those two triggers overlapped on the same INSERT, so every direct message
 * produced two notification rows. The MCP server then hand-inserted a third.
 * This is the single path.
 */
export const notifyNewMessage = internalMutation({
  args: { messageId: v.id('messages') },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message) return { notified: 0 };

    if (!(await prefersNotification(ctx, message.recipientId, 'newMessageEnabled'))) {
      return { notified: 0 };
    }

    const sender = await ctx.db.get(message.senderId);

    await createNotification(ctx, {
      userId: message.recipientId,
      type: 'new_message',
      title: `New message from ${sender?.fullName ?? 'someone'}`,
      content: message.content.slice(0, 140),
      actionUrl: `/messages/${message.senderId}`,
      relatedMessageId: messageId,
      relatedUserId: message.senderId,
    });

    return { notified: 1 };
  },
});

/**
 * ONE email per supervisor listing everything waiting on them.
 *
 * `notifyTaskProposed` sends one message per proposal. With five proposals per
 * stream per week and a supervisor who covers three streams, that is fifteen
 * emails saying almost the same thing — which is how a reviewer learns to
 * ignore the notification that matters. A supervisor needs to know there is a
 * queue and how big it is, not to be told fifteen times.
 *
 * Queued like anything else, so it goes out with the next drain rather than
 * immediately — nothing sends while outgoing mail is held.
 */
export const notifyProposalSummary = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query('tasks')
      .withIndex('by_approval', (q) => q.eq('approvalStatus', 'pending'))
      .collect();

    if (!pending.length) return { queued: 0, reviewers: 0 };

    // stream -> its pending proposals
    const byStream = new Map<string, typeof pending>();
    for (const t of pending) {
      const k = String(t.streamId);
      if (!byStream.has(k)) byStream.set(k, []);
      byStream.get(k)!.push(t);
    }

    // reviewer -> the streams they must clear
    const perReviewer = new Map<string, { streamName: string; count: number }[]>();

    for (const [streamKey, tasks] of byStream) {
      const stream = await ctx.db.get(tasks[0].streamId);
      if (!stream || !stream.isActive) continue;

      const grants = await ctx.db
        .query('streamModerators')
        .withIndex('by_stream', (q) => q.eq('streamId', tasks[0].streamId))
        .collect();

      for (const g of grants) {
        const key = String(g.userId);
        if (!perReviewer.has(key)) perReviewer.set(key, []);
        perReviewer.get(key)!.push({ streamName: stream.name, count: tasks.length });
      }
      void streamKey;
    }

    const now = Date.now();
    let queued = 0;

    for (const [userKey, streams] of perReviewer) {
      const reviewer = await ctx.db.get(userKey as Id<'users'>);
      if (!reviewer || reviewer.isDeleted || !reviewer.isActive || !reviewer.email) continue;

      const total = streams.reduce((n, s) => n + s.count, 0);
      const lines = streams
        .sort((a, b) => a.streamName.localeCompare(b.streamName))
        .map((s) => `<li>${escapeHtml(s.streamName)} — ${s.count}</li>`)
        .join('');
      const linesText = streams.map((s) => `  ${s.streamName} — ${s.count}`).join('\n');

      await ctx.db.insert('emailQueue', {
        userId: reviewer._id,
        emailType: 'task_proposal_summary',
        recipientEmail: reviewer.email,
        subject: `${total} task${total === 1 ? '' : 's'} waiting for your review`,
        bodyHtml:
          `<p>Hi ${escapeHtml(reviewer.fullName ?? 'there')},</p>` +
          `<p>There ${total === 1 ? 'is' : 'are'} <strong>${total}</strong> proposed ` +
          `task${total === 1 ? '' : 's'} waiting for you to approve, edit or decline:</p>` +
          `<ul>${lines}</ul>` +
          `<p>Members do not see a task until you approve it. You can also ask for a ` +
          `different task if one is not right for your stream.</p>` +
          emailButton(`${appUrl()}/tasks/proposals`, 'Open the review queue'),
        bodyText:
          `Hi ${reviewer.fullName ?? 'there'},\n\n` +
          `There are ${total} proposed tasks waiting for your review:\n\n${linesText}\n\n` +
          `Members do not see a task until you approve it.\n\n` +
          `${appUrl()}/tasks/proposals\n`,
        status: 'pending',
        retryCount: 0,
        isDummy: false,
        createdAt: now,
      });
      queued++;
    }

    return { queued, reviewers: perReviewer.size };
  },
});

/**
 * Tells people when the agent or a supervisor posts.
 *
 * A post used to notify nobody. `posts.create` scheduled nothing, so the
 * welcome message — and every announcement after it — reached only whoever
 * happened to open the feed that day. On a cohort where a third of people have
 * never signed in, that is most of the audience missed.
 *
 * ONLY STAFF-AUTHORED POSTS. An intern posting in a stream is conversation, and
 * fanning it out would mail every member about every comment until people
 * filtered the domain — at which point the notifications that matter stop
 * landing too. The check is on the AUTHOR, in posts.create, so an intern's post
 * never reaches here.
 *
 * PAGINATED AND RESCHEDULED, not one pass. A home-feed post addresses everyone,
 * and doing several hundred people in one transaction means a `get`, a
 * preference lookup and two inserts each — comfortably past what one Convex
 * transaction should carry. This follows `scheduled.ts`: fifty at a time,
 * handing itself the continue cursor.
 *
 * Honours `streamUpdateEnabled`, which until now was a switch in the settings
 * screen that nothing read.
 */
export const notifyNewPost = internalMutation({
  args: { postId: v.id('posts'), cursor: v.optional(v.string()) },
  returns: v.object({ notified: v.number(), done: v.boolean() }),
  handler: async (ctx, { postId, cursor }) => {
    const post = await ctx.db.get(postId);
    if (!post || post.isDummy) return { notified: 0, done: true };

    const author = await ctx.db.get(post.userId);
    const authorName = author?.fullName ?? 'ORBIT';

    /**
     * The row is a summary; the email is the post.
     *
     * `preview` is what appears in the notifications list, where a long post
     * would push everything else off the screen. The EMAIL carries the whole
     * thing — it is the version most people read, and the only one that reaches
     * somebody who has not signed in, so cutting it there meant announcing
     * something and then withholding it.
     */
    const preview = post.content.replace(/\s+/g, ' ').trim().slice(0, 160);
    const full = post.content;

    /**
     * THE SUBJECT NAMES THE POST.
     *
     * Every agent post was mailed as "ORBIT Agent posted", so two entirely
     * different announcements arrived under one subject and read, in an inbox,
     * as the same message sent twice. Reported as a duplicate; it was not one.
     *
     * The post's first line is its headline — these are written that way — so
     * it is what the subject should carry. Bounded, because a subject line has
     * a usable length whatever the post does.
     */
    const headline = post.content.split('\n')[0].replace(/\s+/g, ' ').trim();
    const subject = headline
      ? `${authorName}: ${headline.slice(0, 90)}${headline.length > 90 ? '…' : ''}`
      : `${authorName} posted`;
    const title = post.streamId ? `${authorName} posted in your stream` : `${authorName} posted`;
    const actionUrl = post.streamId ? `/streams/${post.streamId}` : '/';

    /**
     * A stream post reaches that stream; a home post reaches everyone. This
     * mirrors what `posts.feed` will actually SHOW, so nobody is notified about
     * something they then cannot open.
     */
    let recipientIds: Id<'users'>[];
    let nextCursor: string | null;
    let isDone: boolean;

    if (post.streamId) {
      const page = await ctx.db
        .query('streamMemberships')
        .withIndex('by_stream', (q) => q.eq('streamId', post.streamId!))
        .paginate({ numItems: 50, cursor: cursor ?? null });
      recipientIds = page.page.filter((m) => m.isActive).map((m) => m.userId);
      nextCursor = page.continueCursor;
      isDone = page.isDone;
    } else {
      const page = await ctx.db.query('users').paginate({ numItems: 50, cursor: cursor ?? null });
      recipientIds = page.page.map((u) => u._id);
      nextCursor = page.continueCursor;
      isDone = page.isDone;
    }

    let notified = 0;

    for (const userId of recipientIds) {
      // Nobody is told about their own post.
      if (userId === post.userId) continue;
      if (!(await prefersNotification(ctx, userId, 'streamUpdateEnabled'))) continue;

      /**
       * TOLD ONCE, WHATEVER HAPPENS TO THIS FUNCTION.
       *
       * The fan-out paginates and reschedules itself, so a retried page, an
       * overlapping run or a hand-invoked repeat would otherwise mail the same
       * people about the same post again — and each of those mails a real
       * person. Checked per recipient rather than per run, because the failure
       * this guards against is precisely a run that does not know it is the
       * second one.
       */
      const already = await ctx.db
        .query('notifications')
        .withIndex('by_user_and_post', (q) => q.eq('userId', userId).eq('relatedPostId', postId))
        .first();
      if (already) continue;

      const created = await createNotification(ctx, {
        userId,
        type: 'stream_update',
        title,
        subjectOverride: subject,
        content: preview,
        emailContent: full,
        actionUrl,
        relatedStreamId: post.streamId ?? undefined,
        relatedPostId: postId,
      });
      if (created) notified++;
    }

    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyNewPost, {
        postId,
        cursor: nextCursor,
      });
    }

    return { notified, done: isDone };
  },
});

/**
 * Tells someone they have reached a new level.
 *
 * WHY THIS DID NOT EXIST. `awardPoints` has always computed `leveledUp` and
 * returned it to its caller, and every caller ignored it. Meanwhile
 * `notificationPreferences.levelUpEnabled` shipped in the schema, is rendered
 * as a toggle on the settings page, and gates nothing — so an intern could
 * switch off a notification that was never sent. A control that does nothing is
 * worse than an absent one: it reads as a working feature.
 *
 * The level is read from the `levels` table rather than passed in, so the name
 * and description an intern is congratulated with are the ones actually
 * configured — and a later change to the ladder cannot leave this quoting a
 * level that no longer exists.
 */
export const notifyLevelUp = internalMutation({
  args: { userId: v.id('users'), newLevel: v.number() },
  returns: v.object({ notified: v.boolean() }),
  handler: async (ctx, { userId, newLevel }) => {
    if (!(await prefersNotification(ctx, userId, 'levelUpEnabled'))) return { notified: false };

    const levels = await ctx.db.query('levels').withIndex('by_levelNumber').collect();
    const level = levels.find((l) => l.levelNumber === newLevel);
    if (!level) return { notified: false };

    const user = await ctx.db.get(userId);
    if (!user) return { notified: false };

    /**
     * ANNOUNCE THE LEVEL THEY HOLD NOW, not the one they held when this was
     * scheduled. Two failures live here, both from `runAfter` landing in a later
     * transaction than the award.
     *
     * One review calls `awardPoints` up to three times — the score, a badge
     * bonus, then the reconciliation pass — so a single approval can cross two
     * boundaries and schedule notify(3) and notify(4). Both re-read the user for
     * `totalPoints`, so the Level 3 email would quote a Level 4 figure and
     * contradict itself.
     *
     * And a withdrawal landing in the gap drops the level before the email goes
     * out, which would congratulate someone on a level they had just lost — the
     * message `awardPoints` guards against at schedule time and could not guard
     * against here.
     *
     * Comparing against the stored level fixes both: a burst collapses to one
     * email for the level that survived, and a reversed award sends nothing.
     */

    const emoji = level.iconEmoji ? `${level.iconEmoji} ` : '';
    const title = `${emoji}You reached ${level.name}`;

    /**
     * TOLD ONCE. Withdrawing a mark and re-applying it — which happened to
     * twelve interns whose links could not be opened, and nine more sent for
     * re-review — reverses the points, drops the level, then re-crosses the same
     * boundary. `leveledUp` is legitimately true the second time, so without
     * this the same congratulation arrives twice for one achievement.
     *
     * Badges need no equivalent: the surviving `userBadges` row keeps them out
     * of `awarded` on the second pass. Levels have no such record, so this is it.
     */
    /**
     * Bounded, and ordered newest-first deliberately.
     *
     * An unbounded `.collect()` here grows with every notification the user has
     * ever received, of any type — a per-level-up read that only gets more
     * expensive. The re-announcement this guards against comes from a withdraw
     * and re-mark, which happens within days, so the recent window is where the
     * duplicate always is.
     */
    const priorLevelUps = (
      await ctx.db
        .query('notifications')
        .withIndex('by_user_and_time', (q) => q.eq('userId', userId))
        .order('desc')
        .take(300)
    ).filter((n) => n.type === 'level_up');

    // Both rules live in lib/levelAnnounce.ts so they can be tested directly.
    if (
      !shouldAnnounceLevel({
        currentLevel: user.currentLevel,
        scheduledLevel: newLevel,
        priorTitles: priorLevelUps.map((n) => n.title),
        title,
      })
    ) {
      return { notified: false };
    }

    /**
     * IN-APP ONLY — no email, and so NOT via `createNotification`, which always
     * queues one.
     *
     * Progression is the platform congratulating you on using it. ORBIT has
     * already sent 352 deadline reminders to this cohort, so the inbox is
     * spoken for by things that need acting on; a level badge is worth seeing
     * next time you sign in, not worth interrupting someone for.
     *
     * It also removes the last of the bulk-email exposure in `applyAssessment`,
     * which schedules a points award per submission — a re-marking pass no
     * longer mails anybody about levels or badges.
     *
     * `actionUrl` still matters: it is the in-app row's link. `/progress` was
     * written here first and is not a route — it passed `isSafeActionUrl`, which
     * checks the shape and not whether the page exists.
     *
     * `LevelUpCelebration` fires confetti on the next visit; this row is the
     * durable record behind it.
     */
    if (!user.isActive || user.isDeleted) return { notified: false };

    await ctx.db.insert('notifications', {
      userId,
      type: 'level_up',
      title,
      content:
        `You are now Level ${level.levelNumber} — ${level.name}. ${level.description}`,
      actionUrl: '/leaderboard',
      isRead: false,
      isDummy: false,
      createdAt: Date.now(),
    });

    return { notified: true };
  },
});

/**
 * Tells someone which badges they have just earned.
 *
 * ONE MESSAGE FOR THE WHOLE BATCH, deliberately. `evaluateBadges` can award
 * several at once — a submission that completes a streak, a milestone and a
 * quality threshold in the same review awards three — and three separate emails
 * about the same moment reads as a malfunction rather than three pieces of good
 * news.
 */
export const notifyBadgesEarned = internalMutation({
  args: { userId: v.id('users'), badgeNames: v.array(v.string()) },
  returns: v.object({ notified: v.boolean() }),
  handler: async (ctx, { userId, badgeNames }) => {
    if (badgeNames.length === 0) return { notified: false };
    if (!(await prefersNotification(ctx, userId, 'badgeEarnedEnabled'))) return { notified: false };

    const user = await ctx.db.get(userId);
    if (!user) return { notified: false };

    const all = await ctx.db.query('badges').collect();
    const earned = badgeNames
      .map((n) => all.find((b) => b.name === n))
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (earned.length === 0) return { notified: false };

    const one = earned.length === 1;
    const title = one ? `You earned the ${earned[0].name} badge` : `You earned ${earned.length} badges`;

    /**
     * The bonus is quoted only to people who actually received it.
     *
     * `evaluateBadges` excludes admins but NOT moderators, so a supervisor can
     * hold a badge row — while `awardPoints` returns early for anyone who is not
     * an intern and writes no ledger entry. Quoting the configured bonus to them
     * states a payment that never happened.
     */
    const earnsPoints = isIntern(user);
    const detail = earned
      .map((b) => {
        const bonus = earnsPoints && b.pointsBonus > 0 ? ` (+${b.pointsBonus} points)` : '';
        return `${b.name}${bonus} — ${b.description}`;
      })
      .join('\n');

    /**
     * IN-APP ONLY. No email, deliberately — and not via `createNotification`,
     * which always queues one.
     *
     * Badges are frequent: 217 awards across 108 scorers in the first three
     * weeks, two each already, and they are 53% of all points on the platform.
     * That projects to roughly eight per intern and ~868 messages cohort-wide
     * over a twelve-week programme. Mail at that rate stops being good news and
     * becomes something people filter, which costs the messages that matter —
     * the level-up, the deadline, the acceptance — their inbox.
     *
     * Levels stay on email precisely because they are rare: at most two per
     * intern for the whole programme on the current ladder. Ceremony matched to
     * frequency.
     *
     * `BadgeUnlockCelebration` already fires confetti on the next visit, so the
     * moment is covered; this row is the durable record behind it.
     *
     * Reversing this is one call: swap the insert for `createNotification` with
     * an `emailContent`, which is what the level-up path above does.
     */
    if (!user.isActive || user.isDeleted) return { notified: false };

    await ctx.db.insert('notifications', {
      userId,
      type: 'badge_earned',
      title,
      content: one ? earned[0].description : `${earned.map((b) => b.name).join(', ')}\n\n${detail}`,
      actionUrl: '/badges',
      isRead: false,
      isDummy: false,
      createdAt: Date.now(),
    });

    return { notified: true };
  },
});
