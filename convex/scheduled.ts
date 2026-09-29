import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { isIntern } from './lib/internProfile';
import { userCarriesLogbook } from './lib/programme';
import { formatWat, WAT_OFFSET_MS } from './lib/datetime';
import {
  cadenceFor,
  watDayOfWeek,
  weekStartUtc,
  weeklySummaryDueAt,
} from './lib/cadence';
import { isPublished } from './lib/taskApproval';
import { escapeHtml } from './lib/html';
import { appUrl } from './lib/appUrl';
import { orgName } from './lib/org';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';

/**
 * Scheduled work, replacing the Netlify cron functions.
 *
 * `deadline-reminder.mts` and `populate-weekly-leaderboard.mts` had no Convex
 * counterpart at all — an omission the migration plan's own parity table missed
 * until it was audited. Both are here now.
 */

// Notification lead time, not task duration. A normal Thursday end-of-day
// deadline enters this window around Tuesday's close, leaving two programme
// workdays to act; shrinking it because deadlines now share one weekly clock
// would remove that useful final prompt.
const REMINDER_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Queues a 48-hour reminder for each upcoming task, once per recipient.
 *
 * The Netlify version deduplicated using `Prefer: resolution=ignore-duplicates`
 * against a composite reference_id, and — importantly — it degraded SILENTLY: if
 * its RPC returned 4xx it logged a count and returned `{skipped:true}` without
 * emailing anyone (`deadline-reminder.mts:52-61`). Nothing surfaced that. Here
 * the dedupe is an explicit query and there is no silent-skip path.
 */
export const sendDeadlineReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now + REMINDER_WINDOW_MS;

    const due = await ctx.db
      .query('tasks')
      .withIndex('by_deadline', (q) => q.gte('deadline', now).lte('deadline', cutoff))
      // Bounded: this fans out per member per task, and an unbounded window
      // makes the whole hourly run roll back once enough tasks share a
      // deadline. 200 tasks inside one 48-hour window would be extraordinary.
      .take(200);

    let queued = 0;

    /**
     * PUBLISHED ONLY.
     *
     * Without `isPublished`, a task the ORBIT agent proposed and no supervisor
     * has approved gets its title, stream, deadline and points emailed to every
     * member of that stream as soon as it falls inside the 48-hour window —
     * which is the approval gate defeated by a cron. Worse, declining the
     * proposal afterwards deletes the task and leaves the mail referring to
     * something that never existed.
     */
    for (const task of due.filter((t) => t.isActive && isPublished(t))) {
      const memberships = await ctx.db
        .query('streamMemberships')
        .withIndex('by_stream', (q) => q.eq('streamId', task.streamId))
        .collect();

      const stream = await ctx.db.get(task.streamId);

      for (const m of memberships.filter((m) => m.isActive)) {
        /**
         * Anyone whose work is ACTUALLY settled does not need chasing.
         *
         * This used to skip on any status other than `in_progress`, which swept
         * up `changes_requested` and `rejected` too — the two states that mean
         * the member still owes the work. The effect was backwards: a peer who
         * had merely accepted the task got a 48-hour reminder, while the intern
         * whose submission had been sent back for rework the day before got
         * nothing, and their deadline passed quietly. Only work that is awaiting
         * review or already approved is genuinely done with.
         */
        const submission = await ctx.db
          .query('submissions')
          .withIndex('by_task_and_user', (q) => q.eq('taskId', task._id).eq('userId', m.userId))
          .first();

        const settled = submission?.status === 'submitted' || submission?.status === 'approved';
        if (settled) continue;

        const prefs = await ctx.db
          .query('notificationPreferences')
          .withIndex('by_user', (q) => q.eq('userId', m.userId))
          .first();

        if (prefs && prefs.deadlineReminderEnabled === false) continue;

        const reference = `${task._id}:${m.userId}:48h`;

        // Explicit dedupe: the composite reference is the idempotency key, so a
        // re-run inside the window cannot double-send. Indexed rather than
        // filtered — this runs once per member per due task, every hour.
        const existing = await ctx.db
          .query('emailQueue')
          .withIndex('by_reference', (q) => q.eq('referenceId', reference))
          .first();

        if (existing) continue;

        const user = await ctx.db.get(m.userId);
        if (!user || !user.isActive || user.isDeleted) continue;

        /**
         * Interns only, matching notifyNewTask. Staff who belong to a stream —
         * which is how they see its feed — were being chased about deadlines
         * for tasks they are the reviewer of, not the assignee.
         */
        if (!isIntern(user)) continue;

        await ctx.db.insert('emailQueue', {
          userId: m.userId,
          emailType: 'deadline_reminder',
          recipientEmail: user.email,
          subject: `Reminder: "${task.title}" is due soon`,
          // ESCAPED. A task title and a stream name are both written by a
          // moderator, and interpolating them raw put author-controlled markup
          // into mail sent from ORBIT's domain to every member of the stream.
          // The same hole was closed in notificationsInternal.ts; this template
          // kept it.
          bodyHtml:
            `<p><strong>${escapeHtml(task.title)}</strong> in ` +
            `${escapeHtml(stream?.name ?? 'your stream')} is due within 48 hours.</p>` +
            // The actual deadline, in the timezone the whole programme runs on.
            // "Within 48 hours" told someone to hurry without telling them by
            // when, which is the question the email exists to answer.
            `<p>Due <strong>${escapeHtml(formatWat(task.deadline))}</strong>. ` +
            `Worth ${task.points} points.</p>` +
            `<p><a href="${appUrl()}/tasks/${task._id}">Open the task</a></p>`,
          bodyText:
            `"${task.title}" in ${stream?.name ?? 'your stream'} is due within 48 hours.\n\n` +
            `Due ${formatWat(task.deadline)}. Worth ${task.points} points.\n\n` +
            `${appUrl()}/tasks/${task._id}`,
          referenceType: 'task',
          referenceId: reference,
          status: 'pending',
          retryCount: 0,
          isDummy: false,
          createdAt: now,
        });

        await ctx.db.insert('notifications', {
          userId: m.userId,
          type: 'deadline_reminder',
          title: 'Deadline approaching',
          content: `"${task.title}" is due within 48 hours.`,
          actionUrl: `/tasks/${task._id}`,
          relatedTaskId: task._id,
          relatedStreamId: task.streamId,
          isRead: false,
          isDummy: false,
          createdAt: now,
        });

        queued++;
      }
    }

    return { queued };
  },
});

/**
 * Snapshots the week's points into weeklyLeaderboard.
 *
 * The leaderboard itself is computed live from the ledger, so this exists only
 * for the historical record and rank-change display. A midweek cutover would
 * otherwise ship an empty table until the following Monday.
 */
export const populateWeeklyLeaderboard = internalMutation({
  args: { weekStart: v.optional(v.string()) },
  handler: async (ctx, { weekStart }) => {
    const now = Date.now();

    /**
     * THE WEEK THAT JUST ENDED, not the one that just began.
     *
     * The cron fires Monday 00:05 UTC and this defaulted to the Monday of the
     * CURRENT week — five minutes old. Every ledger sum in that window was
     * therefore zero, and `points !== 0` below skipped every row, so the table
     * this function exists to fill has been empty since it was written and the
     * run reported success every week while doing nothing.
     *
     * An explicit weekStart still wins, which is what makes backfilling
     * possible.
     */
    const d = new Date(now);
    const thisMondayMs = d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000;
    const lastMondayMs = thisMondayMs - 7 * 86400000;

    const start = weekStart ?? new Date(lastMondayMs).toISOString().slice(0, 10);
    const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
    const endMs = startMs + 7 * 86400000;

    /**
     * Bounded, and honest about it.
     *
     * This read every user, then every qualifying ledger entry for each, and
     * rewrote the whole snapshot in one transaction. It is a nice-to-have
     * historical record; it should not be the thing that makes a scheduled run
     * roll back. The leaderboard people actually see is computed live from the
     * ledger and is unaffected.
     */
    const LEADERBOARD_CAP = 1000;
    // Newest accounts first: if the cap ever bites, losing the oldest dormant
    // accounts from a historical snapshot beats losing the current cohort.
    const users = await ctx.db.query('users').order('desc').take(LEADERBOARD_CAP);

    const rows: Array<{ userId: Id<'users'>; points: number }> = [];

    for (const u of users) {
      if (!u.isActive || u.isDeleted || u.isDummy || !u.showOnLeaderboard) continue;
      // Same rule as the live leaderboard: the programme's score is the
      // interns' score.
      if (!isIntern(u)) continue;

      const ledger = await ctx.db
        .query('pointsLedger')
        .withIndex('by_user_and_time', (q) =>
          q.eq('userId', u._id).gte('createdAt', startMs).lt('createdAt', endMs),
        )
        .collect();

      const points = ledger.reduce((sum, e) => sum + e.points, 0);
      if (points !== 0) rows.push({ userId: u._id, points });
    }

    rows.sort((a, b) => b.points - a.points);

    const weekEnd = new Date(endMs - 86400000).toISOString().slice(0, 10);

    /**
     * Ranks come from the PRECEDING week, which is the only comparison that
     * makes "rank change" mean anything.
     *
     * This read the week being written, so on the ordinary once-a-week run it
     * found nothing and every rank change was reported as a debut. It only ever
     * had a value to compare against when the same week was snapshotted twice.
     */
    const priorWeek = new Date(startMs - 7 * 86400000).toISOString().slice(0, 10);

    const priorRows = await ctx.db
      .query('weeklyLeaderboard')
      .withIndex('by_week', (q) => q.eq('weekStart', priorWeek))
      .collect();

    const priorRank = new Map(priorRows.map((p) => [String(p.userId), p.rank ?? 0]));

    // Re-running replaces the week rather than appending a second set.
    const existing = await ctx.db
      .query('weeklyLeaderboard')
      .withIndex('by_week', (q) => q.eq('weekStart', start))
      .collect();

    for (const p of existing) await ctx.db.delete(p._id);

    let written = 0;
    for (let i = 0; i < rows.length; i++) {
      const rank = i + 1;
      const before = priorRank.get(String(rows[i].userId));

      await ctx.db.insert('weeklyLeaderboard', {
        userId: rows[i].userId,
        weekStart: start,
        weekEnd,
        pointsEarned: rows[i].points,
        rank,
        rankChange: before ? before - rank : undefined,
        createdAt: now,
      });
      written++;
    }

    return { week: start, written };
  },
});

/**
 * Daily-log and physical-day reminders for active SIWES interns.
 *
 * Replaces orbit_siwes_send_reminders, which was an ADMIN-CALLABLE function
 * exposed through `siwesReviewApi.sendReminders()` — meaning it only ever ran
 * when a human remembered to press something. There is no evidence anything
 * ever called it. A cron is what it always wanted to be.
 *
 * Two fan-outs, both deduplicated on "has this user already had one today", so
 * an extra run is harmless:
 *  - a daily-log nudge to anyone with no submitted log today, weekdays only;
 *  - a physical-day nudge the day before someone is due on site.
 */
export const sendSiwesReminders = internalMutation({
  args: { cohortId: v.optional(v.id('cohorts')), cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    { cohortId, cursor },
  ): Promise<{ dailyLog: number; physicalDay: number; weeklySummary: number; signoff: number }> => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const startOfToday = new Date(`${today}T00:00:00.000Z`).getTime();

    // getUTCDay() for tomorrow: 0 Sun .. 6 Sat, which is what physicalDay holds
    // (the SQL compared against EXTRACT(DOW), also Sunday-based). Deliberately
    // NOT the ISO numbering used above — the two coexist in the original and
    // silently disagree if unified.
    const tomorrowDow = new Date(now + 86_400_000).getUTCDay();

    /**
     * ONE COHORT, ONE PAGE, ONE TRANSACTION.
     *
     * This used to open with `ctx.db.query('users').collect()` — the entire
     * user table, growing forever, before any per-intern work. Adding fan-outs
     * on top of that is how a reminder cron starts silently sending nothing:
     * it exceeds its read limit and the whole run rolls back.
     *
     * Called with no arguments (the cron) it fans out one chain per active
     * cohort; called with a cursor it does one page and reschedules itself.
     */
    if (!cohortId) {
      const cohorts = await ctx.db
        .query('cohorts')
        .withIndex('by_status', (q) => q.eq('status', 'active'))
        .collect();

      for (const cohort of cohorts) {
        await ctx.scheduler.runAfter(0, internal.scheduled.sendSiwesReminders, {
          cohortId: cohort._id,
        });
      }

      return { dailyLog: 0, physicalDay: 0, weeklySummary: 0, signoff: 0 };
    }

    const cohortDoc = await ctx.db.get(cohortId);
    if (!cohortDoc || cohortDoc.status !== 'active') {
      return { dailyLog: 0, physicalDay: 0, weeklySummary: 0, signoff: 0 };
    }

    const cadence = cadenceFor(cohortDoc);
    const watDow = watDayOfWeek(now);
    const thisWeek = weekStartUtc(now);

    const page = await ctx.db
      .query('users')
      .withIndex('by_cohort', (q) => q.eq('cohortId', cohortId))
      .paginate({ numItems: 50, cursor: cursor ?? null });

    let dailyLog = 0;
    let physicalDay = 0;
    let weeklySummary = 0;
    let signoff = 0;

    /**
     * Reviewers tallied per page, not globally — a reviewer whose interns span
     * two pages would otherwise be counted twice. The same-day dedupe below is
     * what makes that correct rather than merely tidy: the second page's check
     * finds the first page's notification and skips. It is load-bearing here,
     * not just a guard against re-runs.
     */
    const signoffBacklog = new Map<string, number>();

    for (const profile of page.page) {
      // Staff have accounts and therefore enrolment fields, and would otherwise
      // be reminded to fill in a logbook they do not keep.
      if (!isIntern(profile)) continue;
      if (profile.isDeleted || !profile.isActive) continue;
      if ((profile.internStatus ?? 'active') !== 'active') continue;
      /**
       * Whether the LOGBOOK reminders below apply to this person.
       *
       * Not a `continue`: the physical-day reminder further down is about
       * attendance, not the logbook, and is gated on participation mode. A
       * volunteer who comes in on Mondays should still be told so — skipping
       * the whole loop would have taken that away from them too.
       *
       * The logbook reminders used to fan out to every intern in an active
       * cohort, gated only on the cohort's own flags, which are all switched
       * on. Volunteers and internship participants were emailed every expected
       * weekday about a logbook they do not keep — and `notifySiwes` consults
       * no preference key by design, so they could not turn it off.
       */
      const logbookDuties = userCarriesLogbook(profile);
      const cohort = cohortDoc;

      // Windowed on by_user_and_time. Collecting the user's whole notification
      // history and filtering in memory worked and had a hard expiry date:
      // notifications accumulate forever, and this runs once per intern per day.
      const todays = await ctx.db
        .query('notifications')
        .withIndex('by_user_and_time', (q) =>
          q.eq('userId', profile._id).gte('createdAt', startOfToday),
        )
        .collect();

      const alreadySent = (type: string) => todays.some((n) => n.type === type);

      const logExpectedToday = cadence.dailyLogDays.includes(watDow);

      if (logbookDuties && logExpectedToday && cohort.dailyLogsRequired && !alreadySent('logbook_reminder')) {
        const logs = await ctx.db
          .query('dailyLogs')
          .withIndex('by_user_and_date', (q) =>
            q.eq('userId', profile._id).eq('logDate', today),
          )
          .collect();

        const done = logs.some((l) => ['submitted', 'approved'].includes(l.status));

        if (!done) {
          await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
            userId: profile._id,
            type: 'logbook_reminder',
            title: 'Daily log reminder',
            content:
              'You have not submitted your daily log for today yet. It only takes a few minutes.',
            actionUrl: '/logbook',
          });
          dailyLog++;
        }
      }

      const onSite = ['hybrid', 'physical'].includes(profile.participationMode ?? '');
      const day = profile.physicalDay ?? cohort.defaultPhysicalDay;

      if (onSite && day === tomorrowDow && !alreadySent('physical_day_reminder')) {
        await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
          userId: profile._id,
          type: 'physical_day_reminder',
          title: 'Physical day tomorrow',
          content:
            `Reminder: tomorrow is your physical participation day at the ${orgName()}. ` +
            'Remember to check in on ORBIT when you arrive.',
          actionUrl: '/logbook',
        });
        physicalDay++;
      }

      /**
       * The weekly summary, which nothing has ever reminded anyone about.
       *
       * `cohort.weeklySummaryRequired` had no reader anywhere in the codebase
       * until now — the flag existed, the form existed, and nothing connected
       * them to a date.
       */
      if (logbookDuties && cohort.weeklySummaryRequired && (watDow === cadence.weeklySummaryDueDay || watDow === (cadence.weeklySummaryDueDay + 1) % 7)) {
        const summary = await ctx.db
          .query('weeklySummaries')
          .withIndex('by_user_and_week', (q) =>
            q.eq('userId', profile._id).eq('weekStart', thisWeek),
          )
          .first();

        const done = summary && ['submitted', 'signed_off'].includes(summary.status);
        const overdue = watDow !== cadence.weeklySummaryDueDay;
        const type = overdue ? 'weekly_summary_overdue' : 'weekly_summary_due';

        if (!done && !alreadySent(type)) {
          const due = weeklySummaryDueAt(thisWeek, cadence);

          await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
            userId: profile._id,
            type,
            title: overdue ? 'Weekly summary overdue' : 'Weekly summary due today',
            content: overdue
              ? `Your weekly summary for the week of ${thisWeek} was due ${formatWat(due)}. ` +
                'Submit it as soon as you can so your supervisor can sign the week off.'
              : `Your weekly summary for the week of ${thisWeek} is due ${formatWat(due)}. ` +
                'Submit it with this week\'s deliverable.',
            actionUrl: '/logbook',
          });
          weeklySummary++;
        }
      }

      // Whose desk the week lands on, for the sign-off tally below.
      if (logbookDuties && cohort.signoffRequired && watDow === cadence.signoffDueDay) {
        const summary = await ctx.db
          .query('weeklySummaries')
          .withIndex('by_user_and_week', (q) =>
            q.eq('userId', profile._id).eq('weekStart', thisWeek),
          )
          .first();

        if (summary?.status === 'submitted') {
          /**
           * The SAME fallback review authority uses.
           *
           * Counting only `iihSupervisorId` missed every intern reviewed by
           * their department lead — which is a real path, not a corner case:
           * conversion sets a department, and naming an individual supervisor
           * is optional. Those weeks sat unsigned with nobody reminded.
           */
          let reviewerId = profile.iihSupervisorId ?? null;

          if (!reviewerId && profile.departmentId) {
            const dept = await ctx.db.get(profile.departmentId);
            const lead = dept?.leadUserId ? await ctx.db.get(dept.leadUserId) : null;
            if (lead && lead.isActive && !lead.isDeleted) reviewerId = lead._id;
          }

          if (reviewerId && reviewerId !== profile._id) {
            const key = String(reviewerId);
            signoffBacklog.set(key, (signoffBacklog.get(key) ?? 0) + 1);
          }
        }
      }
    }

    for (const [reviewerId, count] of signoffBacklog) {
      const todays = await ctx.db
        .query('notifications')
        .withIndex('by_user_and_time', (q) =>
          q.eq('userId', reviewerId as Id<'users'>).gte('createdAt', startOfToday),
        )
        .collect();

      if (todays.some((n) => n.type === 'signoff_due')) continue;

      /**
       * "at least N", not "N".
       *
       * The tally is per page: a reviewer whose interns span two pages is
       * counted twice, and the same-day dedupe then suppresses the second
       * notification — so the number sent is a floor, not a total. Saying so is
       * cheaper and more honest than aggregating across pages, and the action
       * is the same either way: open the review queue.
       */
      await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
        userId: reviewerId as Id<'users'>,
        type: 'signoff_due',
        title: 'Weekly sign-offs due today',
        content:
          `At least ${count} weekly ${count === 1 ? 'summary is' : 'summaries are'} waiting ` +
          'for your sign-off. Signing them today means everyone starts Monday with clear ' +
          'standing.',
        actionUrl: '/review',
      });
      signoff++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.scheduled.sendSiwesReminders, {
        cohortId,
        cursor: page.continueCursor,
      });
    }

    return { dailyLog, physicalDay, weeklySummary, signoff };
  },
});

/**
 * Opens today's expected attendance for on-site participants.
 *
 * Cohort 1 expects Ilorin-based participants at the Hub on their physical day.
 * Nothing in the platform represented that: `attendanceRecords` only ever came
 * into existence when someone checked IN, so a person who simply did not turn
 * up left no record at all, and "who was expected and did not come" was a
 * question the data could not answer.
 *
 * This writes the `'expected'` status the UI has always rendered and nothing
 * has ever written.
 */
export const openExpectedAttendance = internalMutation({
  args: {
    cohortId: v.optional(v.id('cohorts')),
    cursor: v.optional(v.string()),
    /** An explicit date, so a missed morning can be opened by hand. */
    date: v.optional(v.string()),
  },
  returns: v.object({ opened: v.number() }),
  handler: async (ctx, { cohortId, cursor, date }): Promise<{ opened: number }> => {
    const now = Date.now();
    const today = date ?? new Date(now + WAT_OFFSET_MS).toISOString().slice(0, 10);

    if (!cohortId) {
      const cohorts = await ctx.db
        .query('cohorts')
        .withIndex('by_status', (q) => q.eq('status', 'active'))
        .collect();

      for (const cohort of cohorts) {
        await ctx.scheduler.runAfter(0, internal.scheduled.openExpectedAttendance, {
          cohortId: cohort._id,
          date,
        });
      }
      return { opened: 0 };
    }

    const cohort = await ctx.db.get(cohortId);
    if (!cohort || cohort.status !== 'active') return { opened: 0 };

    const cadence = cadenceFor(cohort);
    if (!cadence.physicalAttendanceRequired) return { opened: 0 };

    const dow = watDayOfWeek(Date.parse(`${today}T12:00:00.000Z`));

    const page = await ctx.db
      .query('users')
      .withIndex('by_cohort', (q) => q.eq('cohortId', cohortId))
      .paginate({ numItems: 50, cursor: cursor ?? null });

    let opened = 0;

    for (const profile of page.page) {
      if (!isIntern(profile)) continue;
      if (profile.isDeleted || !profile.isActive) continue;
      if ((profile.internStatus ?? 'active') !== 'active') continue;

      const mode = profile.participationMode ?? cohort.defaultParticipationMode;
      if (!['hybrid', 'physical'].includes(mode)) continue;

      const expectedDay = profile.physicalDay ?? cohort.defaultPhysicalDay;
      if (expectedDay !== dow) continue;

      const existing = await ctx.db
        .query('attendanceRecords')
        .withIndex('by_user_and_date', (q) =>
          q.eq('userId', profile._id).eq('attendanceDate', today),
        )
        .first();

      if (existing) continue;

      await ctx.db.insert('attendanceRecords', {
        userId: profile._id,
        attendanceDate: today,
        expectedMode: 'physical',
        departmentId: profile.departmentId,
        status: 'expected',
        createdAt: now,
        updatedAt: now,
      });
      opened++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.scheduled.openExpectedAttendance, {
        cohortId,
        cursor: page.continueCursor,
        date,
      });
    }

    return { opened };
  },
});

/**
 * Closes the day: an expected on-site participant who never checked in is absent.
 *
 * `verifiedBy` is DELIBERATELY LEFT UNSET, which keeps the row in the reviewer's
 * exception queue. The system records the fact; a supervisor decides what it
 * means, and can mark it excused or verified with the mutations that already
 * exist. Nothing here calls `markAbsent` or `verifyAttendance` — both stamp
 * `verifiedBy` with the caller, and a cron doing that would forge a human's
 * confirmation.
 */
export const closeExpectedAttendance = internalMutation({
  args: {
    cohortId: v.optional(v.id('cohorts')),
    cursor: v.optional(v.string()),
    date: v.optional(v.string()),
  },
  returns: v.object({ absent: v.number() }),
  handler: async (ctx, { cohortId, cursor, date }): Promise<{ absent: number }> => {
    const now = Date.now();
    const today = date ?? new Date(now + WAT_OFFSET_MS).toISOString().slice(0, 10);

    if (!cohortId) {
      const cohorts = await ctx.db
        .query('cohorts')
        .withIndex('by_status', (q) => q.eq('status', 'active'))
        .collect();

      for (const cohort of cohorts) {
        await ctx.scheduler.runAfter(0, internal.scheduled.closeExpectedAttendance, {
          cohortId: cohort._id,
          date,
        });
      }
      return { absent: 0 };
    }

    const page = await ctx.db
      .query('users')
      .withIndex('by_cohort', (q) => q.eq('cohortId', cohortId))
      .paginate({ numItems: 50, cursor: cursor ?? null });

    let absent = 0;

    for (const profile of page.page) {
      const row = await ctx.db
        .query('attendanceRecords')
        .withIndex('by_user_and_date', (q) =>
          q.eq('userId', profile._id).eq('attendanceDate', today),
        )
        .first();

      if (!row || row.status !== 'expected' || row.checkInTime !== undefined) continue;

      await ctx.db.patch(row._id, { status: 'absent', updatedAt: now });
      absent++;

      // Told the same day, so they can supply a reason before it hardens.
      await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
        userId: profile._id,
        type: 'attendance_absent',
        title: 'Marked absent today',
        content:
          `You were expected at the Hub on ${today} and no check-in was recorded, so the day ` +
          'is marked absent. If that is wrong, tell your supervisor — they can mark it ' +
          'excused or verified.',
        actionUrl: '/logbook',
      });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.scheduled.closeExpectedAttendance, {
        cohortId,
        cursor: page.continueCursor,
        date,
      });
    }

    return { absent };
  },
});
