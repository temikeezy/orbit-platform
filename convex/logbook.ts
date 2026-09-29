import { query, mutation, internalMutation } from './_generated/server';
import { QueryCtx, MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { isIntern } from './lib/internProfile';
import { obligationsStart, recentLogDates, userCarriesLogbook } from './lib/programme';
import { cadenceFor, normalizeWeekStart, weekEndFor } from './lib/cadence';
import { Doc, Id } from './_generated/dataModel';
import { requireUser } from './lib/auth';
import { canReviewProfile, profileForCaller } from './siwes';
import {
  FIELD,
  isoDate,
  linkOrText,
  list,
  oneOf,
  optionalText,
  text,
  validate,
} from './lib/input';

/**
 * SIWES logbook: daily logs, weekly summaries, attendance and supervisor notes.
 *
 * Every path resolves the intern profile first and checks the caller against it
 * via `profileForCaller`, so a supervisor cannot reach an intern who is not
 * theirs by supplying an id — the tier model lives in siwes.ts and is applied
 * uniformly here rather than re-derived per function.
 */

const editableStatuses = ['draft', 'changes_requested'];

// Typed rather than `any`. While this returned `any`, every caller's `profile`
// was `any` too, so `ctx.db.get(profile.userId)` resolved to a union of every
// table in the schema and nothing downstream was checked at all.
/**
 * The caller, as an intern.
 *
 * A function that used to resolve a second record and could fail. The enrolment
 * is on the account now, so this cannot fail and exists only to keep the call
 * sites below reading as they did.
 */
function ownProfile(_ctx: QueryCtx | MutationCtx, user: Doc<'users'>): Doc<'users'> {
  return user;
}

// ---------------------------------------------------------------- daily logs

export const listDailyLogs = query({
  args: {
    token: v.string(),
    internUserId: v.optional(v.id('users')),
    limit: v.optional(v.number()),
    // The date window, applied HERE rather than by the caller.
    //
    // It was a client-side filter over an already-truncated list: the query cut
    // to the newest 60 and the caller then narrowed that. A SIWES term is ~120
    // weekday logs, so anything older than the newest 60 was invisible — the
    // intern's own logbook appeared to stop, the weekly-summary composer offered
    // no logs to attach for an older week, and editing an older log saved
    // server-side and then threw "Log not found after save" because the re-read
    // could not see it either.
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  handler: async (ctx, { token, internUserId, limit, from, to }) => {
    const user = await requireUser(ctx, token);

    const profile = internUserId
      ? await profileForCaller(ctx, internUserId, user)
      : ownProfile(ctx, user);

    const rows = await ctx.db
      .query('dailyLogs')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();

    const visible = rows
      .filter((l) => (!from || l.logDate >= from) && (!to || l.logDate <= to))
      .sort((a, b) => b.logDate.localeCompare(a.logDate))
      // The default covers a full term rather than a couple of months. The cap
      // still exists — an unbounded read is how a query hits Convex's limits —
      // but it is now above the size of the thing being listed.
      .slice(0, Math.min(limit ?? 400, 500));

    const out = [];
    for (const l of visible) {
      out.push({
        id: l._id,
        logDate: l.logDate,
        participationMode: l.participationMode,
        title: l.title,
        workDone: l.workDone,
        learned: l.learned,
        toolsUsed: l.toolsUsed,
        challenges: l.challenges,
        nextSteps: l.nextSteps,
        hoursSpent: l.hoursSpent,
        evidenceLinks: l.evidenceLinks,
        attachmentUrl: l.attachmentUrl,
        status: l.status,
        submittedAt: l.submittedAt,
        reviewedAt: l.reviewedAt,
        supervisorComment: l.supervisorComment,
        // "Reviewed by …" is a conditional render on LogbookPage that was
        // permanently false: the name existed only in the export payload, so
        // an attribution the pre-migration UI showed simply vanished.
        reviewerName: l.reviewedBy ? ((await ctx.db.get(l.reviewedBy))?.fullName ?? null) : null,
      });
    }
    return out;
  },
});

export const saveDailyLog = mutation({
  args: {
    token: v.string(),
    logId: v.optional(v.id('dailyLogs')),
    logDate: v.string(),
    participationMode: v.string(),
    title: v.string(),
    workDone: v.string(),
    learned: v.optional(v.string()),
    toolsUsed: v.optional(v.string()),
    challenges: v.optional(v.string()),
    nextSteps: v.optional(v.string()),
    hoursSpent: v.optional(v.number()),
    // An array of strings, not v.any(): this was an arbitrary-JSON store of
    // arbitrary size on a row any intern can create, and the values are
    // rendered as hrefs in a reviewer's browser.
    evidenceLinks: v.optional(v.array(v.string())),
    attachmentUrl: v.optional(v.string()),
    submit: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, logId, submit, ...raw }) => {
    const user = await requireUser(ctx, token);
    const profile = ownProfile(ctx, user);

    /**
     * Enforced on the SERVER, not only by hiding the tabs.
     *
     * The screens stop offering a logbook to programmes that do not keep one,
     * but a hidden control is not a rule — a direct call would still create
     * rows, and those rows would surface in a supervisor's pending queue as
     * work to review from someone who owes them none.
     */
    if (!userCarriesLogbook(profile)) {
      throw new Error('A logbook is only kept on the SIWES programme.');
    }

    const now = Date.now();

    /**
     * Bounded, and the optionals stay UNDEFINED.
     *
     * That is the load-bearing detail here. The update branch below strips
     * undefined keys before patching, precisely so a caller that omits a field
     * does not wipe it — a bug this file already carries a comment about. A
     * validator that coerced a blank optional to `''` would reintroduce it
     * through the front door, and the damage is somebody's written reflections.
     *
     * logDate and participationMode were unchecked strings on a row an intern
     * creates: the first sorts and groups every logbook view, the second decides
     * whether an entry counts as on-site attendance.
     */
    const clean = validate(() => ({
      logDate: isoDate(raw.logDate, 'Log date'),
      participationMode: oneOf(raw.participationMode, 'Participation mode', [
        'physical',
        'virtual',
        'hybrid',
      ] as const),
      /**
       * Bounded but NOT required. The form has never marked Title as required —
       * it validates only Work done — so untitled logs exist. Requiring one here
       * would make every existing untitled row unsavable: its author could not
       * save a draft, could not submit, and could not edit their way out.
       */
      title: optionalText(raw.title, 'Title', FIELD.logTitle) ?? '',
      workDone: text(raw.workDone, 'Work done', FIELD.logSection),
      learned: optionalText(raw.learned, 'What you learned', FIELD.logSection),
      toolsUsed: optionalText(raw.toolsUsed, 'Tools used', FIELD.logSection),
      challenges: optionalText(raw.challenges, 'Challenges', FIELD.logSection),
      nextSteps: optionalText(raw.nextSteps, 'Next steps', FIELD.logSection),
      hoursSpent: raw.hoursSpent,
      // Rendered as hrefs in a supervisor's browser, which this file's own
      // schema comment already noted — the array type was tightened at the
      // time and the scheme never was.
      /**
       * `linkOrText`, not `httpUrl`. This box has never validated anything, so
       * real rows hold mailto: addresses, bare filenames and "the shared Drive
       * folder". Rejecting those would block a save the intern is making for an
       * unrelated reason. Dangerous schemes are still refused; the client
       * decides what is safe to render as an actual link.
       */
      evidenceLinks: raw.evidenceLinks
        ? list(raw.evidenceLinks, 'Evidence links', {
            max: FIELD.evidenceLinkCount,
            each: (v, label) => linkOrText(v, label, FIELD.evidenceLink),
          })
        : undefined,
      attachmentUrl: raw.attachmentUrl?.trim()
        ? linkOrText(raw.attachmentUrl, 'Attachment link', FIELD.url)
        : undefined,
    }));
    if (!clean.ok) return { success: false as const, error: clean.error };

    const fields = clean.value;

    if (logId) {
      const existing = await ctx.db.get(logId);
      if (!existing || existing.userId !== profile._id) {
        throw new Error('Not your log entry');
      }

      // An approved log is a signed-off record; editing it would silently
      // rewrite something a supervisor already endorsed.
      if (!editableStatuses.includes(existing.status)) {
        return { success: false as const, error: 'This entry has been reviewed and can no longer be edited.' };
      }

      // logDate is deliberately dropped on update: the one-per-date check runs
      // only on create, so a mutable date would let an intern manufacture
      // duplicates or backdate entries.
      const { logDate: _ignored, ...editable } = fields;

      // Only fields the caller actually sent. ctx.db.patch REMOVES a key set to
      // undefined, so passing the whole args object through wiped `learned`,
      // `toolsUsed`, `challenges`, `nextSteps` and `hoursSpent` for any caller
      // that omitted them. Today's form resends everything, which is the only
      // reason this has not destroyed anyone's reflections yet.
      const supplied = Object.fromEntries(
        Object.entries(editable).filter(([, value]) => value !== undefined),
      );

      await ctx.db.patch(logId, {
        ...supplied,
        evidenceLinks: fields.evidenceLinks ?? existing.evidenceLinks,
        status: submit ? 'submitted' : existing.status,
        submittedAt: submit ? now : existing.submittedAt,
        updatedAt: now,
      });

      // Only on the transition INTO submitted. Re-saving an already-submitted
      // entry must not ping the reviewer again.
      if (submit && existing.status !== 'submitted') {
        await ctx.runMutation(internal.notificationsInternal.notifyLogbookSubmitted, {
          userId: profile._id,
          kind: 'daily_log',
          label: existing.logDate,
        });
      }

      return { success: true as const, id: logId };
    }

    // One entry per calendar date, matching the Postgres unique constraint that
    // Convex cannot express.
    const clash = await ctx.db
      .query('dailyLogs')
      .withIndex('by_user_and_date', (q) =>
        q.eq('userId', profile._id).eq('logDate', fields.logDate),
      )
      .first();

    if (clash) return { success: false as const, error: 'A log already exists for that date.' };

    const id = await ctx.db.insert('dailyLogs', {
      ...fields,
      userId: profile._id,
      evidenceLinks: fields.evidenceLinks ?? [],
      status: submit ? 'submitted' : 'draft',
      submittedAt: submit ? now : undefined,
      createdAt: now,
      updatedAt: now,
    });

    if (submit) {
      await ctx.runMutation(internal.notificationsInternal.notifyLogbookSubmitted, {
        userId: profile._id,
        kind: 'daily_log',
        label: fields.logDate,
      });
    }

    return { success: true as const, id };
  },
});

export const reviewDailyLog = mutation({
  args: {
    token: v.string(),
    logId: v.id('dailyLogs'),
    // 'draft' is the REOPEN action — a supervisor putting a submitted log back
    // in the intern's hands. The client has always offered it; the validator
    // rejected it, so the button died at the boundary.
    status: v.union(v.literal('approved'), v.literal('changes_requested'), v.literal('draft')),
    supervisorComment: v.optional(v.string()),
  },
  handler: async (ctx, { token, logId, status, supervisorComment }) => {
    const user = await requireUser(ctx, token);

    const log = await ctx.db.get(logId);
    if (!log) return { success: false as const, error: 'Log not found' };

    // requireReviewer: the owner must not be able to approve their own logbook.
    await profileForCaller(ctx, log.userId!, user, { requireReviewer: true });

    // Only a SUBMITTED entry can be reviewed. Without this a reviewer can
    // approve a draft the intern never submitted. Reopening an APPROVED log is
    // the one exception — that is what reopen is for, and it is the only way a
    // mistaken approval can be undone.
    if (log.status !== 'submitted' && !(status === 'draft' && log.status === 'approved')) {
      return { success: false as const, error: 'Only a submitted entry can be reviewed.' };
    }

    const patch: Record<string, unknown> = {
      status,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (supervisorComment !== undefined) patch.supervisorComment = supervisorComment;

    await ctx.db.patch(logId, patch);

    // The intern is told the outcome. The SQL did this through
    // orbit_siwes_notify; the port had dropped it entirely, so a member whose
    // log was sent back for changes found out only by opening the page.
    const profile = await ctx.db.get(log.userId!);
    if (profile) {
      await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
        userId: profile._id,
        type: status === 'approved' ? 'logbook_approved' : 'logbook_changes_requested',
        title:
          status === 'approved'
            ? 'Daily log approved'
            : status === 'draft'
              ? 'Daily log reopened'
              : 'Changes requested on your daily log',
        content:
          status === 'approved'
            ? `Your daily log for ${log.logDate} was approved by ${user.fullName}.`
            : status === 'draft'
              ? `Your daily log for ${log.logDate} was reopened by ${user.fullName}. You can edit and resubmit it.`
              : `Your daily log for ${log.logDate} needs changes.` +
                (supervisorComment ? ` Comment: ${supervisorComment}` : ''),
        actionUrl: '/logbook',
      });
    }

    return { success: true as const };
  },
});

// ----------------------------------------------------------- weekly summaries

export const listWeeklySummaries = query({
  args: { token: v.string(), internUserId: v.optional(v.id('users')) },
  handler: async (ctx, { token, internUserId }) => {
    const user = await requireUser(ctx, token);

    const profile = internUserId
      ? await profileForCaller(ctx, internUserId, user)
      : ownProfile(ctx, user);

    const rows = await ctx.db
      .query('weeklySummaries')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();

    // Projected, not returned raw. `collect()` hands back whole documents —
    // _id, _creationTime, legacyId and the userId — none of which the
    // page reads and the last of which is another profile's id when a reviewer
    // is looking at someone else's logbook.
    const out = [];
    for (const w of rows.sort((a, b) => b.weekStart.localeCompare(a.weekStart))) {
      out.push({
        id: w._id,
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        goals: w.goals,
        summary: w.summary,
        keyLearnings: w.keyLearnings,
        dailyLogIds: w.dailyLogIds,
        status: w.status,
        submittedAt: w.submittedAt,
        signedOffAt: w.signedOffAt,
        supervisorComment: w.supervisorComment,
        signedOffByName: w.signedOffBy
          ? ((await ctx.db.get(w.signedOffBy))?.fullName ?? null)
          : null,
      });
    }
    return out;
  },
});

export const saveWeeklySummary = mutation({
  args: {
    token: v.string(),
    summaryId: v.optional(v.id('weeklySummaries')),
    weekStart: v.string(),
    weekEnd: v.string(),
    goals: v.optional(v.string()),
    summary: v.optional(v.string()),
    keyLearnings: v.optional(v.string()),
    dailyLogIds: v.optional(v.array(v.string())),
    submit: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, summaryId, submit, ...raw }) => {
    const user = await requireUser(ctx, token);
    const profile = ownProfile(ctx, user);

    // Same rule as the daily log: the weekly summary is part of the logbook.
    if (!userCarriesLogbook(profile)) {
      throw new Error('A logbook is only kept on the SIWES programme.');
    }

    /**
     * Bounded, like every other authenticated write.
     *
     * These three fields had no bound at all — the only free-text columns in
     * the logbook that did not, while `saveDailyLog` next door bounds its
     * equivalents at `FIELD.logSection`. An authenticated write REJECTS rather
     * than truncates (see the header of lib/input.ts): silently cutting off
     * part of an intern's saved reflection is the worse failure here.
     */
    const bounded = validate(() => ({
      goals: optionalText(raw.goals, 'Goals', FIELD.logSection),
      summary: optionalText(raw.summary, 'Summary', FIELD.logSection),
      keyLearnings: optionalText(raw.keyLearnings, 'Key learnings', FIELD.logSection),
    }));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    const fields = { ...raw, ...bounded.value };

    const now = Date.now();

    if (summaryId) {
      const existing = await ctx.db.get(summaryId);
      if (!existing || existing.userId !== profile._id) {
        throw new Error('Not your weekly summary');
      }
      // Locked once SUBMITTED, not merely once signed off. Otherwise an intern
      // can rewrite a summary while it sits in the reviewer's queue, and the
      // reviewer signs off content that changed after submission. Daily logs
      // already used editableStatuses; this did not.
      if (!editableStatuses.includes(existing.status)) {
        return { success: false as const, error: 'This summary has been submitted and can no longer be edited.' };
      }

      // weekStart/weekEnd are DROPPED on update, exactly as logDate is for daily
      // logs. The one-summary-per-week check runs only on create, so a mutable
      // week let an intern point a fresh draft at a week that already had a
      // signed-off summary and produce two — inflating signedOffWeeks on both
      // their dashboard and the cohort compliance report, and putting duplicate
      // weeks in the logbook a university receives.
      const { weekStart: _ws, weekEnd: _we, ...editable } = fields;

      const supplied = Object.fromEntries(
        Object.entries(editable).filter(([, value]) => value !== undefined),
      );

      await ctx.db.patch(summaryId, {
        ...supplied,
        dailyLogIds: fields.dailyLogIds ?? existing.dailyLogIds,
        status: submit ? 'submitted' : existing.status,
        submittedAt: submit ? now : existing.submittedAt,
        updatedAt: now,
      });

      if (submit && existing.status !== 'submitted') {
        await ctx.runMutation(internal.notificationsInternal.notifyLogbookSubmitted, {
          userId: profile._id,
          kind: 'weekly_summary',
          label: `${existing.weekStart} to ${existing.weekEnd}`,
        });
      }

      return { success: true as const, id: summaryId };
    }

    /**
     * THE WEEK IS ANCHORED SERVER-SIDE, to Monday.
     *
     * The composer computes Monday in LOCAL time and serialises it with
     * `toISOString()`. In WAT (UTC+1 — i.e. every browser on this programme)
     * local Monday 00:00 is Sunday 23:00 UTC, so what arrived here was the
     * SUNDAY date, and it was stored verbatim. Everything that later looks a
     * summary up keys on the UTC Monday (`weekStartUtc` in scheduled.ts), so
     * nothing ever found these rows: the Thursday reminder cron told compliant
     * interns their summary was due and then overdue, every week, and the
     * Friday sign-off tally reported zero summaries awaiting review no matter
     * how many were sitting there.
     *
     * `normalizeWeekStart` was written for exactly this and had never been
     * called from anywhere. `weekEnd` is DERIVED rather than trusted, so the
     * pair cannot disagree — the client sent it from the same wrong anchor.
     */
    const weekStart = normalizeWeekStart(fields.weekStart);
    const weekEnd = weekEndFor(weekStart);

    const clash = await ctx.db
      .query('weeklySummaries')
      .withIndex('by_user_and_week', (q) =>
        q.eq('userId', profile._id).eq('weekStart', weekStart),
      )
      .first();

    if (clash) return { success: false as const, error: 'A summary already exists for that week.' };

    const id = await ctx.db.insert('weeklySummaries', {
      ...fields,
      weekStart,
      weekEnd,
      userId: profile._id,
      dailyLogIds: fields.dailyLogIds ?? [],
      status: submit ? 'submitted' : 'draft',
      submittedAt: submit ? now : undefined,
      createdAt: now,
      updatedAt: now,
    });

    if (submit) {
      await ctx.runMutation(internal.notificationsInternal.notifyLogbookSubmitted, {
        userId: profile._id,
        kind: 'weekly_summary',
        label: `${weekStart} to ${weekEnd}`,
      });
    }

    return { success: true as const, id };
  },
});

export const signOffWeeklySummary = mutation({
  args: {
    token: v.string(),
    summaryId: v.id('weeklySummaries'),
    supervisorComment: v.optional(v.string()),
    approve: v.boolean(),
  },
  handler: async (ctx, { token, summaryId, supervisorComment, approve }) => {
    const user = await requireUser(ctx, token);

    const summary = await ctx.db.get(summaryId);
    if (!summary) return { success: false as const, error: 'Summary not found' };

    await profileForCaller(ctx, summary.userId!, user, { requireReviewer: true });

    if (summary.status !== 'submitted') {
      return { success: false as const, error: 'Only a submitted summary can be signed off.' };
    }

    const patch: Record<string, unknown> = {
      status: approve ? 'signed_off' : 'changes_requested',
      updatedAt: Date.now(),
    };
    if (supervisorComment !== undefined) patch.supervisorComment = supervisorComment;
    if (approve) {
      patch.signedOffBy = user._id;
      patch.signedOffAt = Date.now();
    }

    await ctx.db.patch(summaryId, patch);

    const signoffProfile = await ctx.db.get(summary.userId!);
    if (signoffProfile) {
      await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
        userId: signoffProfile._id,
        type: approve ? 'weekly_summary_signed_off' : 'logbook_changes_requested',
        title: approve ? 'Weekly summary signed off' : 'Changes requested on your weekly summary',
        content: approve
          ? `Your weekly summary (${summary.weekStart} to ${summary.weekEnd}) was signed off by ${user.fullName}.`
          : `Your weekly summary (${summary.weekStart} to ${summary.weekEnd}) needs changes.` +
            (supervisorComment ? ` Comment: ${supervisorComment}` : ''),
        actionUrl: '/logbook',
      });
    }

    return { success: true as const };
  },
});

// ----------------------------------------------------------------- attendance

export const listAttendance = query({
  args: { token: v.string(), internUserId: v.optional(v.id('users')) },
  handler: async (ctx, { token, internUserId }) => {
    const user = await requireUser(ctx, token);

    const profile = internUserId
      ? await profileForCaller(ctx, internUserId, user)
      : ownProfile(ctx, user);

    const rows = await ctx.db
      .query('attendanceRecords')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();

    // Projected for the same reason listWeeklySummaries is.
    const out = [];
    for (const a of rows.sort((x, y) => y.attendanceDate.localeCompare(x.attendanceDate))) {
      out.push({
        id: a._id,
        attendanceDate: a.attendanceDate,
        expectedMode: a.expectedMode,
        checkInTime: a.checkInTime,
        checkOutTime: a.checkOutTime,
        departmentId: a.departmentId,
        activitySummary: a.activitySummary,
        status: a.status,
        updatedAt: a.updatedAt,
        verifiedByName: a.verifiedBy ? ((await ctx.db.get(a.verifiedBy))?.fullName ?? null) : null,
      });
    }
    return out;
  },
});

export const recordAttendance = mutation({
  args: {
    token: v.string(),
    attendanceDate: v.string(),
    expectedMode: v.string(),
    checkIn: v.optional(v.boolean()),
    checkOut: v.optional(v.boolean()),
    activitySummary: v.optional(v.string()),
    departmentId: v.optional(v.id('departments')),
  },
  handler: async (ctx, { token, attendanceDate, expectedMode, checkIn, checkOut, activitySummary, departmentId }) => {
    const user = await requireUser(ctx, token);
    const profile = ownProfile(ctx, user);
    const now = Date.now();

    const existing = await ctx.db
      .query('attendanceRecords')
      .withIndex('by_user_and_date', (q) =>
        q.eq('userId', profile._id).eq('attendanceDate', attendanceDate),
      )
      .first();

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (checkIn && !existing.checkInTime) patch.checkInTime = now;
      if (checkOut) patch.checkOutTime = now;
      if (activitySummary !== undefined) patch.activitySummary = activitySummary;

      /**
       * Checking in settles an open day.
       *
       * Rows are now pre-created as `'expected'` each morning, so without this a
       * participant who checked in stayed `'expected'` forever and sat in their
       * supervisor's exception queue having done nothing wrong. Promoting an
       * unverified `'absent'` too is intentional: a late arrival is a present.
       *
       * `!existing.verifiedBy` is the guard that matters — once a supervisor has
       * ruled on the day, a later check-in must not overwrite their decision.
       */
      if (checkIn && !existing.verifiedBy && ['expected', 'absent'].includes(existing.status)) {
        patch.status = 'present';
      }

      await ctx.db.patch(existing._id, patch);
      return { success: true as const, id: existing._id };
    }

    const id = await ctx.db.insert('attendanceRecords', {
      userId: profile._id,
      attendanceDate,
      expectedMode,
      checkInTime: checkIn ? now : undefined,
      checkOutTime: checkOut ? now : undefined,
      departmentId,
      activitySummary,
      status: 'present',
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

/**
 * A reviewer confirms or corrects an attendance record.
 *
 * `recordAttendance` is the intern's own check-in and deliberately cannot set
 * `status` — the SQL let the status through from the request body and then
 * overrode it for non-reviewers (`v_status := 'present'`), which is the right
 * outcome reached by a route that only works if you remember the override. Here
 * the intern's mutation has no status argument at all, and this one is the only
 * way `status` and `verifiedBy` are written.
 */
// 'verified' included: without it a supervisor could confirm a day only by
// re-stating what the intern already claimed, and `reviewQueue` treated
// anything that was not 'verified' or 'present' as an outstanding exception —
// so a day settled as 'excused' or 'remote_makeup' sat in the queue forever.
const VERIFIABLE_STATUSES = ['present', 'absent', 'remote_makeup', 'excused', 'verified'];

export const verifyAttendance = mutation({
  args: {
    token: v.string(),
    // Addressed by (profile, date), NOT by an attendance row id.
    //
    // It took an `attendanceId`, and NO CALLER HAS ONE: both review surfaces
    // send `user_id` + `attendance_date` + `status`, and the client
    // type has no id field at all. So the dispatcher's verification branch was
    // unreachable and every supervisor action fell through to the intern's own
    // check-in mutation, which ignores both the profile and the status and
    // resolves the CALLER's profile — writing a bogus 'present' row against the
    // supervisor's own attendance, on the intern's date, and reporting success.
    //
    // Keyed on (profile, date) it also subsumes markAbsent: the day a reviewer
    // most needs to record is the one the intern never checked in on, which has
    // no row to address by id.
    internUserId: v.id('users'),
    attendanceDate: v.string(),
    status: v.string(),
    expectedMode: v.optional(v.string()),
    activitySummary: v.optional(v.string()),
  },
  handler: async (ctx, { token, internUserId, attendanceDate, status, expectedMode, activitySummary }) => {
    const user = await requireUser(ctx, token);
    await profileForCaller(ctx, internUserId, user, { requireReviewer: true });

    if (!VERIFIABLE_STATUSES.includes(status)) {
      return {
        success: false as const,
        error: `Status must be one of: ${VERIFIABLE_STATUSES.join(', ')}`,
      };
    }

    const existing = await ctx.db
      .query('attendanceRecords')
      .withIndex('by_user_and_date', (q) =>
        q.eq('userId', internUserId).eq('attendanceDate', attendanceDate),
      )
      .first();

    const now = Date.now();

    if (existing) {
      const patch: Record<string, unknown> = { status, verifiedBy: user._id, updatedAt: now };
      if (activitySummary !== undefined) patch.activitySummary = activitySummary;
      await ctx.db.patch(existing._id, patch);
      return { success: true as const, id: existing._id };
    }

    const id = await ctx.db.insert('attendanceRecords', {
      userId: internUserId,
      attendanceDate,
      expectedMode: expectedMode ?? 'physical',
      activitySummary,
      status,
      verifiedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

/**
 * Marks an intern absent for a day they never checked in on.
 *
 * Without this a reviewer can only correct records the intern created, so the
 * one case that matters — someone who simply did not turn up — has no record at
 * all and the compliance report counts it as neither present nor absent.
 */
export const markAbsent = mutation({
  args: {
    token: v.string(),
    internUserId: v.id('users'),
    attendanceDate: v.string(),
    expectedMode: v.string(),
    activitySummary: v.optional(v.string()),
  },
  handler: async (ctx, { token, internUserId, attendanceDate, expectedMode, activitySummary }) => {
    const user = await requireUser(ctx, token);
    await profileForCaller(ctx, internUserId, user, { requireReviewer: true });

    const existing = await ctx.db
      .query('attendanceRecords')
      .withIndex('by_user_and_date', (q) =>
        q.eq('userId', internUserId).eq('attendanceDate', attendanceDate),
      )
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'absent',
        verifiedBy: user._id,
        activitySummary: activitySummary ?? existing.activitySummary,
        updatedAt: now,
      });
      return { success: true as const, id: existing._id };
    }

    const id = await ctx.db.insert('attendanceRecords', {
      userId: internUserId,
      attendanceDate,
      expectedMode,
      activitySummary,
      verifiedBy: user._id,
      status: 'absent',
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

// --------------------------------------------------------------------- export

/**
 * The whole logbook for one intern, for printing or export.
 *
 * Replaces orbit_siwes_export_logbook. Two things it does beyond returning
 * rows: it resolves the caller's own profile when none is named (so an intern
 * can export their own book without knowing its id), and it records the export
 * in `logbookExports` — which is the only reason that table exists, and which
 * the port had left permanently empty.
 *
 * Only SUBMITTED and APPROVED entries are included. A draft is not part of the
 * record, and the printed logbook is what a university sees.
 */
export const exportLogbook = mutation({
  args: {
    token: v.string(),
    internUserId: v.optional(v.id('users')),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    exportType: v.optional(v.string()),
  },
  handler: async (ctx, { token, internUserId, from, to, exportType }) => {
    const user = await requireUser(ctx, token);

    const profile = internUserId
      ? await profileForCaller(ctx, internUserId, user)
      : ownProfile(ctx, user);

    const type = exportType ?? 'print';
    if (!['print', 'pdf', 'csv'].includes(type)) {
      return { success: false as const, error: 'Unknown export type' };
    }

    const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);

    const [logs, summaries, attendance] = await Promise.all([
      ctx.db.query('dailyLogs').withIndex('by_user', (q) => q.eq('userId', profile._id)).collect(),
      ctx.db.query('weeklySummaries').withIndex('by_user', (q) => q.eq('userId', profile._id)).collect(),
      ctx.db.query('attendanceRecords').withIndex('by_user', (q) => q.eq('userId', profile._id)).collect(),
    ]);

    // Fetched one at a time rather than through Promise.all: `ctx.db.get` is
    // typed per-table, and collecting differently-typed gets into one array
    // widens them all to a union of every table in the schema.
    // The intern IS the profile now — no second fetch, and no chance of the two
    // disagreeing about whose logbook this is.
    const intern = profile;
    const cohort = profile.cohortId ? await ctx.db.get(profile.cohortId) : null;
    const department = profile.departmentId ? await ctx.db.get(profile.departmentId) : null;
    const supervisor = profile.iihSupervisorId ? await ctx.db.get(profile.iihSupervisorId) : null;

    const reviewerName = async (id?: Id<'users'>) =>
      id ? ((await ctx.db.get(id))?.fullName ?? null) : null;

    const dailyLogs = [];
    for (const l of logs
      .filter((l) => ['submitted', 'approved'].includes(l.status) && inRange(l.logDate))
      .sort((a, b) => a.logDate.localeCompare(b.logDate))) {
      dailyLogs.push({
        logDate: l.logDate,
        participationMode: l.participationMode,
        title: l.title,
        workDone: l.workDone,
        learned: l.learned,
        toolsUsed: l.toolsUsed,
        challenges: l.challenges,
        nextSteps: l.nextSteps,
        hoursSpent: l.hoursSpent,
        evidenceLinks: l.evidenceLinks,
        status: l.status,
        supervisorComment: l.supervisorComment,
        reviewedAt: l.reviewedAt,
        reviewerName: await reviewerName(l.reviewedBy),
      });
    }

    const weeklySummaries = [];
    for (const w of summaries
      .filter((w) => ['submitted', 'signed_off'].includes(w.status))
      .filter((w) => (!from || w.weekEnd >= from) && (!to || w.weekStart <= to))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))) {
      weeklySummaries.push({
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        goals: w.goals,
        summary: w.summary,
        keyLearnings: w.keyLearnings,
        status: w.status,
        supervisorComment: w.supervisorComment,
        signedOffAt: w.signedOffAt,
        signedOffByName: await reviewerName(w.signedOffBy),
      });
    }

    const attendanceRows = [];
    for (const a of attendance
      .filter((a) => inRange(a.attendanceDate))
      .sort((x, y) => x.attendanceDate.localeCompare(y.attendanceDate))) {
      attendanceRows.push({
        attendanceDate: a.attendanceDate,
        expectedMode: a.expectedMode,
        checkInTime: a.checkInTime,
        checkOutTime: a.checkOutTime,
        activitySummary: a.activitySummary,
        status: a.status,
        verifiedByName: await reviewerName(a.verifiedBy),
      });
    }

    await ctx.db.insert('logbookExports', {
      userId: profile._id,
      exportedBy: user._id,
      exportType: type,
      dateFrom: from,
      dateTo: to,
      createdAt: Date.now(),
    });

    return {
      success: true as const,
      data: {
        profile: {
          fullName: intern?.fullName ?? null,
          email: intern?.email ?? null,
          institutionName: profile.institutionName,
          faculty: profile.faculty,
          courseOfStudy: profile.courseOfStudy,
          matricNumber: profile.matricNumber,
          participationMode: profile.participationMode,
          siwesStartDate: profile.siwesStartDate,
          siwesEndDate: profile.siwesEndDate,
          institutionSupervisorName: profile.institutionSupervisorName,
          cohortName: cohort?.name ?? null,
          cohortStart: cohort?.startDate ?? null,
          cohortEnd: cohort?.endDate ?? null,
          departmentName: department?.name ?? null,
          supervisorName: supervisor?.fullName ?? null,
        },
        dailyLogs,
        weeklySummaries,
        attendance: attendanceRows,
        generatedAt: Date.now(),
      },
    };
  },
});

// ----------------------------------------------------------- supervisor notes

/**
 * Supervisor notes are PRIVATE to reviewers. The intern must never read them —
 * they are the reviewer's working record, not feedback.
 */
export const listSupervisorNotes = query({
  args: { token: v.string(), internUserId: v.id('users') },
  handler: async (ctx, { token, internUserId }) => {
    const user = await requireUser(ctx, token);
    await profileForCaller(ctx, internUserId, user, { requireReviewer: true });

    const rows = await ctx.db
      .query('supervisorNotes')
      .withIndex('by_user', (q) => q.eq('userId', internUserId))
      .collect();

    const out = [];
    for (const n of rows.sort((a, b) => b.createdAt - a.createdAt)) {
      const author = await ctx.db.get(n.authorId);
      out.push({
        id: n._id,
        note: n.note,
        createdAt: n.createdAt,
        author: author ? { id: author._id, fullName: author.fullName } : null,
      });
    }
    return out;
  },
});

export const addSupervisorNote = mutation({
  args: { token: v.string(), internUserId: v.id('users'), note: v.string() },
  handler: async (ctx, { token, internUserId, note }) => {
    const user = await requireUser(ctx, token);
    await profileForCaller(ctx, internUserId, user, { requireReviewer: true });

    const trimmed = note.trim();
    if (!trimmed) return { success: false as const, error: 'Note cannot be empty' };

    const now = Date.now();
    const id = await ctx.db.insert('supervisorNotes', {
      userId: internUserId,
      authorId: user._id,
      note: trimmed,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});

// --------------------------------------------------------------- review queue

/**
 * Everything ReviewDashboardPage renders, scoped to what this reviewer may act
 * on: their assigned interns, pending logs and summaries, who is behind on
 * logs, and attendance that needs verifying.
 *
 * `canReviewProfile` runs on every row rather than returning the whole queue
 * and filtering in the client — that filter is an authorization decision, and
 * the rows it discarded had already been sent.
 */
export const reviewQueue = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    /**
     * No role gate. `canReviewProfile` IS the gate, and it deliberately grants
     * a department lead — who needs no elevated role — review authority over
     * their own department's interns. Requiring `moderator` here locked those
     * leads out of the queue they are responsible for, while the per-row check
     * below already returns nothing to anyone with no reviewable interns.
     */
    // Accounts, not profile rows — the enrolment is on the account.
    const profiles = await ctx.db.query('users').collect();

    // Resolved once. Every section below needs the same intern, cohort and
    // reviewability answer, and re-deriving them per row made this O(rows x
    // moderator lookups).
    const reviewable = new Map<
      string,
      {
        profile: Doc<'users'>;
        intern: Doc<'users'> | null;
        cohort: Doc<'cohorts'> | null;
        department: Doc<'departments'> | null;
      }
    >();

    for (const profile of profiles) {
      if (profile.isDeleted || !profile.isActive) continue;
      if (profile.internStatus && profile.internStatus !== 'active') continue;

      // Staff are not interns — see lib/internProfile.ts. Every account carries
      // an enrolment now, so without this a reviewer's queue lists their
      // colleagues, and moderators appear as people to be reviewed.
      if (!isIntern(profile)) continue;
      if (!(await canReviewProfile(ctx, profile, user))) continue;

      reviewable.set(profile._id, {
        profile,
        intern: profile,
        cohort: profile.cohortId ? await ctx.db.get(profile.cohortId) : null,
        department: profile.departmentId ? await ctx.db.get(profile.departmentId) : null,
      });
    }

    // Nothing to review — return early rather than reading three more tables in
    // full to filter every row out. A reviewer with no assigned interns was
    // otherwise the most expensive caller this query had.
    if (reviewable.size === 0) {
      return {
        interns: [],
        pendingDailyLogs: [],
        pendingWeeklySummaries: [],
        missingLogs: [],
        attendanceExceptions: [],
      };
    }

    /**
     * Read PER REVIEWABLE PROFILE, on by_profile, rather than collecting the
     * whole of dailyLogs, weeklySummaries and attendanceRecords and discarding
     * almost all of it. The old shape also collected dailyLogs TWICE — once
     * filtered to submitted, once in full for the counts — so the busiest
     * reviewer screen scanned four tables end to end and hit Convex's
     * per-transaction read limit as data grew.
     */
    const logs: Doc<'dailyLogs'>[] = [];
    const allLogs: Doc<'dailyLogs'>[] = [];
    const summaries: Doc<'weeklySummaries'>[] = [];
    const attendance: Doc<'attendanceRecords'>[] = [];

    for (const id of reviewable.keys()) {
      const internUserId = id as Id<'users'>;

      const [theirLogs, theirSummaries, theirAttendance] = await Promise.all([
        ctx.db.query('dailyLogs').withIndex('by_user', (q) => q.eq('userId', internUserId)).collect(),
        ctx.db.query('weeklySummaries').withIndex('by_user', (q) => q.eq('userId', internUserId)).collect(),
        ctx.db.query('attendanceRecords').withIndex('by_user', (q) => q.eq('userId', internUserId)).collect(),
      ]);

      allLogs.push(...theirLogs);
      logs.push(...theirLogs.filter((l) => l.status === 'submitted'));
      summaries.push(...theirSummaries);
      attendance.push(...theirAttendance);
    }

    const mine = <T extends { userId?: Id<'users'> }>(rows: T[]) =>
      rows.filter((r) => r.userId !== undefined && reviewable.has(r.userId));

    const myLogs = mine(logs);
    const mySummaries = mine(summaries);
    const myAttendance = mine(attendance);

    const logsByProfile = new Map<string, Doc<'dailyLogs'>[]>();
    for (const l of allLogs) {
      logsByProfile.set(l.userId!, [...(logsByProfile.get(l.userId!) ?? []), l]);
    }

    const interns = [...reviewable.values()].map(({ profile, intern, cohort, department }) => {
      const theirLogs = logsByProfile.get(profile._id) ?? [];
      return {
        id: profile._id,
        userId: profile._id,
        cohortId: profile.cohortId,
        participationMode: profile.participationMode,
        status: profile.internStatus ?? 'active',
        departmentId: profile.departmentId ?? null,
        iihSupervisorId: profile.iihSupervisorId ?? null,
        fullName: intern?.fullName ?? 'Unknown',
        email: intern?.email ?? '',
        profilePhotoUrl: intern?.profilePhotoUrl,
        cohortName: cohort?.name ?? '',
        departmentName: department?.name ?? null,
        // Same rule as the compliance report: logbook figures belong to people
        // who keep a logbook, and null says "not measured" where zero would
        // read as "measured, and nothing there".
        programmeType: profile.programmeType ?? null,
        carriesLogbook: userCarriesLogbook(profile),
        approvedLogs: userCarriesLogbook(profile)
          ? theirLogs.filter((l) => l.status === 'approved').length
          : null,
        pendingLogs: userCarriesLogbook(profile)
          ? theirLogs.filter((l) => l.status === 'submitted').length
          : null,
        signedOffWeeks: userCarriesLogbook(profile)
          ? mySummaries.filter((w) => w.userId === profile._id && w.status === 'signed_off').length
          : null,
      };
    });

    const who = (id: Id<'users'>) => {
      const entry = reviewable.get(id);
      return {
        fullName: entry?.intern?.fullName ?? 'Unknown',
        profilePhotoUrl: entry?.intern?.profilePhotoUrl,
      };
    };

    const pendingDailyLogs = myLogs
      .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))
      .map((l) => ({
        id: l._id,
        userId: l.userId,
        logDate: l.logDate,
        title: l.title,
        participationMode: l.participationMode,
        hoursSpent: l.hoursSpent ?? null,
        submittedAt: l.submittedAt,
        status: l.status,
        ...who(l.userId!),
      }));

    const pendingWeeklySummaries = mySummaries
      .filter((w) => w.status === 'submitted')
      .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))
      .map((w) => ({
        id: w._id,
        userId: w.userId,
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        submittedAt: w.submittedAt,
        status: w.status,
        ...who(w.userId!),
      }));

    /**
     * Days in the last week this intern was actually expected to log, and did not.
     *
     * This used to be a hardcoded Monday-to-Friday window applied to every
     * intern, which made the headline number on the Review Dashboard wrong in
     * three separate ways at once:
     *
     *  - it ignored the cohort's own cadence. ORBIT 2.0 logs Tuesday to
     *    Thursday, so every intern was reported two days short every week, for
     *    doing exactly what was asked of them.
     *  - it ignored `dailyLogsRequired`, and programme type entirely, so
     *    volunteers were counted against a logbook they do not keep.
     *  - it ignored when someone started, so a member enrolled yesterday was
     *    reported as having missed the previous week.
     *
     * A supervisor acts on this number, so being wrong in the alarming
     * direction is not a harmless inaccuracy — it buries the real gaps.
     */
    const today = new Date().toISOString().slice(0, 10);
    const windowStart = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    /**
     * The last seven days as {date, weekday}, newest first.
     *
     * The weekday is derived FROM THE DATE STRING, not from the timestamp.
     * Pairing a UTC date with a WAT weekday disagrees for the hour between
     * 23:00 and 24:00 UTC — and these are reactive queries, so a dashboard left
     * open re-evaluates inside that window. Every entry's weekday would sit one
     * day ahead of its own date, which against a Tuesday-to-Thursday cadence
     * silently expects Monday to Wednesday: an intern who logged exactly what
     * was asked shows a missing day, and a genuinely missed Thursday does not
     * show at all. `logDate` is written as a UTC date everywhere, so the date
     * is the right convention and the weekday has to follow it.
     */
    const lastWeek = recentLogDates(Date.now());

    const missingLogs = [...reviewable.values()]
      .map(({ profile, intern, cohort }) => {
        // The logbook is a SIWES artefact; nobody else is measured against one.
        if (!userCarriesLogbook(profile) || !cohort?.dailyLogsRequired) return null;

        const expectedDows = cadenceFor(cohort).dailyLogDays;
        /**
         * Nobody is behind on days that precede their own start — the LATER of
         * the cohort's start and their own.
         *
         * `?? ` was wrong here and quietly dead: `cohorts.startDate` is
         * required, so the personal date was never once consulted, and someone
         * who joined an already-running cohort was reported as missing the week
         * before they arrived. Both are `YYYY-MM-DD`, which compares correctly
         * as text.
         */
        const startedOn = obligationsStart(cohort.startDate, profile.siwesStartDate);

        const expected = lastWeek
          .filter((d) => expectedDows.includes(d.dow))
          .filter((d) => !startedOn || d.date >= startedOn)
          .map((d) => d.date);

        if (expected.length === 0) return null;

        const dates = new Set(
          (logsByProfile.get(profile._id) ?? [])
            .filter((l) => l.logDate >= windowStart && l.logDate <= today)
            .map((l) => l.logDate),
        );

        return {
          userId: profile._id,
          fullName: intern?.fullName ?? 'Unknown',
          profilePhotoUrl: intern?.profilePhotoUrl,
          missingDays: expected.filter((d) => !dates.has(d)).length,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null && row.missingDays > 0)
      .sort((a, b) => b.missingDays - a.missingDays);

    // Anything a supervisor has not yet signed off. `verifiedBy` is the signal,
    // not the status: a day settled as 'excused' or 'remote_makeup' IS resolved,
    // and filtering on status alone left those in the queue permanently.
    const attendanceExceptions = myAttendance
      .filter((a) => !a.verifiedBy && a.status !== 'present')
      .sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate))
      .slice(0, 100)
      .map((a) => ({
        id: a._id,
        userId: a.userId,
        attendanceDate: a.attendanceDate,
        status: a.status,
        expectedMode: a.expectedMode,
        ...who(a.userId!),
      }));

    return {
      interns,
      pendingDailyLogs,
      pendingWeeklySummaries,
      missingLogs,
      attendanceExceptions,
    };
  },
});

/**
 * Re-anchors weekly summaries written before the week label was normalized.
 *
 * Every row saved by the shipped composer carries the SUNDAY that precedes its
 * week rather than the Monday that starts it — local Monday midnight in WAT is
 * Sunday 23:00 UTC, and `toISOString()` was what produced the stored label. See
 * the comment in `saveWeeklySummary`. Both sides now agree on Monday, but the
 * existing rows are still filed under a week nothing looks at, so the reminder
 * cron and the sign-off tally stay wrong for them until this runs.
 *
 * Idempotent: a row already on a Monday is left alone, so it is safe to run
 * more than once.
 *
 * Run with:
 *   npx convex run logbook:backfillWeeklySummaryAnchor '{}'
 */
export const backfillWeeklySummaryAnchor = internalMutation({
  args: {},
  returns: v.object({
    moved: v.number(),
    alreadyMonday: v.number(),
    skippedCollision: v.number(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query('weeklySummaries').collect();

    // Where each user's summaries already sit, so a re-anchor cannot land on
    // top of a row that is already there. One pass, rather than a query per
    // row inside the loop.
    const occupied = new Set(rows.map((r) => `${r.userId}:${r.weekStart}`));

    let moved = 0;
    let alreadyMonday = 0;
    let skippedCollision = 0;

    for (const row of rows) {
      const weekStart = normalizeWeekStart(row.weekStart);

      if (weekStart === row.weekStart) {
        alreadyMonday++;
        continue;
      }

      /**
       * A user with BOTH a Sunday-anchored row and a Monday-anchored one for
       * the same week. Moving the Sunday row would produce two summaries for
       * one week — the exact duplication `saveWeeklySummary`'s clash check
       * exists to prevent, and which inflates signedOffWeeks on the dashboard
       * and in the logbook a university receives. Left in place and counted, to
       * be reconciled by hand rather than silently merged.
       */
      if (occupied.has(`${row.userId}:${weekStart}`)) {
        skippedCollision++;
        continue;
      }

      await ctx.db.patch(row._id, {
        weekStart,
        weekEnd: weekEndFor(weekStart),
        updatedAt: Date.now(),
      });

      occupied.delete(`${row.userId}:${row.weekStart}`);
      occupied.add(`${row.userId}:${weekStart}`);
      moved++;
    }

    return { moved, alreadyMonday, skippedCollision };
  },
});
