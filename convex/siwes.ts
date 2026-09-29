import { query, mutation } from './_generated/server';
import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { QueryCtx, MutationCtx } from './_generated/server';
import { PROGRAMME_TYPES, userCarriesLogbook } from './lib/programme';
import { requireUser, requireAdmin, hasRole } from './lib/auth';
import { isIntern } from './lib/internProfile';
import { defined } from './lib/patch';

/**
 * SIWES: cohorts, departments and intern profiles.
 *
 * Replaces the orbit_siwes_* RPC family, which all went through
 * `src/lib/api/siwesRpc.ts:19` — the single cleanest seam in the app.
 *
 * The authorization model is the important part, and it is three-tiered:
 *  - an INTERN may only ever see and edit their own profile and logbook;
 *  - a SUPERVISOR (moderator, or the profile's iihSupervisorId) may review the
 *    interns assigned to them;
 *  - an ADMIN sees everything.
 *
 * orbit_siwes_can_review encoded this in SQL. Here it is `canReviewProfile`, and
 * every read and write path routes through it — a supervisor must not be able to
 * reach an intern who is not theirs by supplying an id.
 */

export async function canReviewProfile(
  ctx: QueryCtx | MutationCtx,
  intern: Doc<'users'>,
  user: Doc<'users'>,
): Promise<boolean> {
  if (hasRole(user, 'admin', 'super_admin')) return true;
  if (intern.iihSupervisorId === user._id) return true;

  // Leading a department IS the grant. `saveDepartment` is admin-gated, so
  // naming someone lead is already a deliberate act of delegation by an admin —
  // and the SQL (orbit_siwes_can_review) checked `lead_user_id` alone, with no
  // role test.
  //
  // Requiring a SECOND, separate `moderator` grant on top created a state where
  // a lead was responsible for a department's logbooks and could not open one:
  // the review queue refused them, and until this was fixed the notifier still
  // emailed them about it.
  if (intern.departmentId) {
    const dept = await ctx.db.get(intern.departmentId);
    if (dept?.leadUserId === user._id) return true;
  }
  return false;
}

/**
 * Loads an intern and asserts the caller may act on them. Owner, or reviewer.
 *
 * Takes a USER id. It used to take an internProfileId, which meant every caller
 * held a second identity for a person and had to translate — for a record that
 * was always 1:1 with the account. The profile fields live on the user now.
 */
export async function profileForCaller(
  ctx: QueryCtx | MutationCtx,
  internUserId: Id<'users'>,
  user: Doc<'users'>,
  opts: { requireReviewer?: boolean } = {},
): Promise<Doc<'users'>> {
  const profile = await ctx.db.get(internUserId);

  // Same message as an authorization failure, not 'Profile not found'. The
  // comment below already claimed this property; the early return contradicted
  // it and turned the function into an existence oracle.
  if (!profile) throw new Error('Not authorized for this intern profile');

  const isOwner = profile._id === user._id;
  const isReviewer = await canReviewProfile(ctx, profile, user);

  // Nobody reviews their own logbook — not even an admin. The SQL blocked
  // self-review explicitly, and reviewer-ness alone does not imply the caller
  // is a different person from the intern.
  if (opts.requireReviewer && isOwner) {
    throw new Error('You cannot review your own logbook');
  }

  if (opts.requireReviewer ? !isReviewer : !(isOwner || isReviewer)) {
    // Same message either way, so this cannot be used to discover which profile
    // ids exist.
    throw new Error('Not authorized for this intern profile');
  }
  return profile;
}

/**
 * The intern profile a caller's own writes belong to.
 *
 * Every SQL function that resolved "my profile" ordered
 * `(c.status = 'active') DESC, c.start_date DESC` — active cohort first, then
 * most recent. The port used `.first()` on `by_user`, which returns the LOWEST
 * `_creationTime`, i.e. the intern's first-ever profile.
 *
 * For anyone with one profile these agree. For a returning intern they do not,
 * and the failure is silent and self-contradicting: `myStatus` ported the SQL
 * ordering correctly and so read the CURRENT cohort, while every write path went
 * through `.first()` and attached to the COMPLETED one. Logs would land in last
 * year's book, `notifyLogbookSubmitted` would page last year's supervisor, the
 * dashboard would show zero logs this week, and the reminder cron would nag
 * someone who had just written one.
 *
 * One resolver, used by every path that means "mine".
 */
/**
 * `activeProfileForUser` is gone.
 *
 * It existed to choose between a person's SEVERAL intern profiles — a returning
 * intern accumulated one per cohort, and picking the wrong one attached their
 * logs to a finished cohort while the dashboard read the current one. Folding
 * the profile onto the account removed the ambiguity rather than resolving it:
 * a user has one enrolment, and it is on the user.
 */

/**
 * ISO week start (Monday) as YYYY-MM-DD, in UTC.
 *
 * `date_trunc('week', now())` in Postgres is Monday-anchored, so a Sunday-based
 * week here would count the wrong days on exactly one day in seven — the kind of
 * off-by-one that only shows up in a Monday morning bug report.
 */
export function weekStartUtc(now: number): string {
  const d = new Date(now);
  const monday = d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

/**
 * The signed-in intern's own SIWES standing. Replaces orbit_siwes_my_status.
 *
 * Returns null rather than throwing when the caller has no profile — most ORBIT
 * members are not SIWES interns, and the dashboard calls this unconditionally.
 */
export const myStatus = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    // The caller IS the profile. No lookup, so no "which of their profiles"
    // question and no null case to handle.
    const profile = user;

    const cohort = profile.cohortId ? await ctx.db.get(profile.cohortId) : null;

    const [logs, summaries] = await Promise.all([
      ctx.db.query('dailyLogs').withIndex('by_user', (q) => q.eq('userId', profile._id)).collect(),
      ctx.db.query('weeklySummaries').withIndex('by_user', (q) => q.eq('userId', profile._id)).collect(),
    ]);

    const department = profile.departmentId ? await ctx.db.get(profile.departmentId) : null;
    const supervisor = profile.iihSupervisorId ? await ctx.db.get(profile.iihSupervisorId) : null;

    const counted = logs.filter((l) => ['submitted', 'approved'].includes(l.status));
    const weekStart = weekStartUtc(Date.now());

    return {
      userId: profile._id,
      /**
       * What this member is actually on, and whether a logbook comes with it.
       *
       * The card this feeds is headed "SIWES Internship" and counts logs and
       * signed-off weeks. It was shown to every intern, so a volunteer was told
       * they were on SIWES and quietly measured against a logbook they do not
       * keep. The client hides the card outright when there are no logbook
       * duties rather than relabelling it — there is nothing on it that means
       * anything without them.
       */
      programmeType: profile.programmeType ?? null,
      carriesLogbook: userCarriesLogbook(profile),
      cohortName: cohort?.name ?? null,
      cohortStatus: cohort?.status ?? null,
      participationMode: profile.participationMode,
      status: profile.internStatus ?? 'active',
      departmentName: department?.name ?? null,
      supervisorName: supervisor?.fullName ?? null,
      // The intern's own day overrides the cohort default, as COALESCE did.
      physicalDay: profile.physicalDay ?? cohort?.defaultPhysicalDay ?? null,
      logsThisWeek: counted.filter((l) => l.logDate >= weekStart).length,
      approvedLogs: logs.filter((l) => l.status === 'approved').length,
      pendingChanges: logs.filter((l) => l.status === 'changes_requested').length,
      signedOffWeeks: summaries.filter((s) => s.status === 'signed_off').length,
      lastLogDate:
        counted.map((l) => l.logDate).sort((a, b) => b.localeCompare(a))[0] ?? null,
    };
  },
});

/**
 * Per-intern compliance across a cohort. Admin only.
 * Replaces orbit_siwes_cohort_compliance.
 */
export const cohortCompliance = query({
  args: { token: v.string(), cohortId: v.id('cohorts') },
  handler: async (ctx, { token, cohortId }) => {
    await requireAdmin(ctx, token);

    const cohort = await ctx.db.get(cohortId);
    if (!cohort) return null;

    const profiles = await ctx.db
      .query('users')
      .withIndex('by_cohort', (q) => q.eq('cohortId', cohortId))
      .collect();

    const interns = [];

    for (const p of profiles) {
      // Staff hold enrolment fields too; a compliance report about interns
      // should not count them as interns with zero logs.
      if (p.isDeleted || !isIntern(p)) continue;

      const [logs, summaries, attendance] = await Promise.all([
        ctx.db.query('dailyLogs').withIndex('by_user', (q) => q.eq('userId', p._id)).collect(),
        ctx.db.query('weeklySummaries').withIndex('by_user', (q) => q.eq('userId', p._id)).collect(),
        ctx.db.query('attendanceRecords').withIndex('by_user', (q) => q.eq('userId', p._id)).collect(),
      ]);

      const department = p.departmentId ? await ctx.db.get(p.departmentId) : null;
      const supervisor = p.iihSupervisorId ? await ctx.db.get(p.iihSupervisorId) : null;
      const counted = logs.filter((l) => ['submitted', 'approved'].includes(l.status));

      /**
       * Logbook figures belong only to people who keep a logbook.
       *
       * Reported for everyone, they read as non-compliance: a volunteer sat in
       * this table at zero logs, zero signed-off weeks and no last-log date,
       * indistinguishable from a SIWES intern who had stopped writing. The
       * programme is carried on the row so the screen can say which is which,
       * and the counts are null — not zero — for anyone with no duties, because
       * zero is a measurement and null is "not measured".
       *
       * Attendance is NOT nulled: it is governed by participation mode, and a
       * volunteer expected on site is genuinely present or absent.
       */
      const keepsLogbook = userCarriesLogbook(p);

      interns.push({
        userId: p._id,
        status: p.internStatus ?? 'active',
        participationMode: p.participationMode ?? null,
        programmeType: p.programmeType ?? null,
        carriesLogbook: keepsLogbook,
        fullName: p.fullName ?? null,
        email: p.email ?? null,
        departmentName: department?.name ?? null,
        supervisorName: supervisor?.fullName ?? null,
        totalLogs: keepsLogbook ? counted.length : null,
        approvedLogs: keepsLogbook ? logs.filter((l) => l.status === 'approved').length : null,
        signedOffWeeks: keepsLogbook
          ? summaries.filter((s) => s.status === 'signed_off').length
          : null,
        daysPresent: attendance.filter((a) => a.status === 'present').length,
        daysAbsent: attendance.filter((a) => a.status === 'absent').length,
        lastLogDate: keepsLogbook
          ? counted.map((l) => l.logDate).sort((a, b) => b.localeCompare(a))[0] ?? null
          : null,
      });
    }

    return {
      cohort: {
        id: cohort._id,
        name: cohort.name,
        status: cohort.status,
        startDate: cohort.startDate,
        endDate: cohort.endDate,
      },
      interns: interns.sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? '')),
    };
  },
});

// ------------------------------------------------------------------ cohorts

export const listCohorts = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);
    const rows = await ctx.db.query('cohorts').collect();
    return rows
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
      .map((c) => ({
        id: c._id,
        name: c.name,
        description: c.description,
        startDate: c.startDate,
        endDate: c.endDate,
        status: c.status,
        defaultParticipationMode: c.defaultParticipationMode,
        defaultPhysicalDay: c.defaultPhysicalDay,
        dailyLogsRequired: c.dailyLogsRequired,
        weeklySummaryRequired: c.weeklySummaryRequired,
        signoffRequired: c.signoffRequired,
      }));
  },
});

export const saveCohort = mutation({
  args: {
    token: v.string(),
    cohortId: v.optional(v.id('cohorts')),
    name: v.string(),
    description: v.optional(v.string()),
    startDate: v.string(),
    endDate: v.string(),
    status: v.string(),
    defaultParticipationMode: v.string(),
    defaultPhysicalDay: v.optional(v.number()),
    dailyLogsRequired: v.optional(v.boolean()),
    weeklySummaryRequired: v.optional(v.boolean()),
    signoffRequired: v.optional(v.boolean()),
    /**
     * The weekly rhythm. See lib/cadence.ts for the defaults, which reproduce
     * the previous behaviour — a cohort that sets none of these behaves exactly
     * as cohorts did before they existed.
     */
    dailyLogDays: v.optional(v.array(v.number())),
    weeklySummaryDueDay: v.optional(v.number()),
    weeklySummaryDueHourWat: v.optional(v.number()),
    signoffDueDay: v.optional(v.number()),
    signoffDueHourWat: v.optional(v.number()),
    physicalAttendanceRequired: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, cohortId, ...fields }) => {
    const admin = await requireAdmin(ctx, token);
    const now = Date.now();

    if (fields.endDate < fields.startDate) {
      return { success: false as const, error: 'End date cannot precede start date.' };
    }

    const doc = {
      ...fields,
      dailyLogsRequired: fields.dailyLogsRequired ?? true,
      weeklySummaryRequired: fields.weeklySummaryRequired ?? true,
      signoffRequired: fields.signoffRequired ?? true,
      updatedAt: now,
    };

    if (cohortId) {
      /**
       * `defined()` because an edit that omits a field must not delete it.
       *
       * Every argument here is optional, and `patch(id, {field: undefined})`
       * REMOVES the field in Convex — so saving the cohort form from a client
       * that does not send, say, `defaultPhysicalDay` silently drops the
       * programme's on-site day. Harmless-looking today; load-bearing the
       * moment the weekly cadence config lives on this row.
       */
      await ctx.db.patch(cohortId, defined(doc));
      return { success: true as const, id: cohortId };
    }

    const id = await ctx.db.insert('cohorts', { ...doc, createdBy: admin._id, createdAt: now });
    return { success: true as const, id };
  },
});

// -------------------------------------------------------------- departments

export const listDepartments = query({
  args: { token: v.string(), includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { token, includeInactive }) => {
    await requireUser(ctx, token);

    const rows = await ctx.db.query('departments').collect();
    const out = [];
    for (const d of rows.filter((d) => includeInactive || d.isActive)) {
      const lead = d.leadUserId ? await ctx.db.get(d.leadUserId) : null;
      out.push({
        id: d._id,
        name: d.name,
        description: d.description,
        isActive: d.isActive,
        lead: lead ? { id: lead._id, fullName: lead.fullName } : null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const saveDepartment = mutation({
  args: {
    token: v.string(),
    departmentId: v.optional(v.id('departments')),
    name: v.string(),
    description: v.optional(v.string()),
    leadUserId: v.optional(v.id('users')),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, departmentId, ...fields }) => {
    await requireAdmin(ctx, token);
    const now = Date.now();

    if (departmentId) {
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      await ctx.db.patch(departmentId, { ...clean, updatedAt: now });
      return { success: true as const, id: departmentId };
    }

    const id = await ctx.db.insert('departments', {
      ...fields,
      isActive: fields.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    });
    return { success: true as const, id };
  },
});

// ----------------------------------------------------------- intern profiles

function profileShape(p: Doc<'users'>) {
  return {
    id: p._id,
    userId: p._id,
    cohortId: p.cohortId,
    participationMode: p.participationMode,
    // Which programme they are on, and whether a logbook comes with it. The
    // Logbook screen keeps Attendance for everyone and shows the logbook tabs
    // only to those who actually keep one.
    programmeType: p.programmeType,
    carriesLogbook: userCarriesLogbook(p),
    institutionName: p.institutionName,
    faculty: p.faculty,
    courseOfStudy: p.courseOfStudy,
    matricNumber: p.matricNumber,
    siwesStartDate: p.siwesStartDate,
    siwesEndDate: p.siwesEndDate,
    institutionSupervisorName: p.institutionSupervisorName,
    institutionSupervisorEmail: p.institutionSupervisorEmail,
    institutionSupervisorPhone: p.institutionSupervisorPhone,
    iihSupervisorId: p.iihSupervisorId,
    departmentId: p.departmentId,
    physicalDay: p.physicalDay,
    status: p.internStatus ?? 'active',
    // Emergency contacts are deliberately NOT in the general shape — see
    // getProfileDetail, which returns them only to the owner or a reviewer.
  };
}

export const myProfile = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    // Never null now: the enrolment is on the account, so anyone signed in has
    // one. The page's "no internship profile yet" branch is dead code.
    return {
      ...profileShape(user),
      emergencyContactName: user.emergencyContactName,
      emergencyContactPhone: user.emergencyContactPhone,
    };
  },
});

export const listProfiles = query({
  args: { token: v.string(), cohortId: v.optional(v.id('cohorts')) },
  handler: async (ctx, { token, cohortId }) => {
    const user = await requireUser(ctx, token);

    // No role gate — `canReviewProfile` below is the gate, and it grants a
    // department lead authority over their own department's interns without
    // any elevated role. Requiring `moderator` here locked those leads out of
    // the roster they are responsible for.
    const rows = cohortId
      ? await ctx.db
          .query('users')
          .withIndex('by_cohort', (q) => q.eq('cohortId', cohortId))
          .collect()
      : await ctx.db.query('users').collect();

    // A moderator sees only the interns they can actually review; an admin sees
    // all. Filtering here rather than in the client is the point.
    const out = [];
    for (const p of rows) {
      if (p.isDeleted) continue;
      if (!(await canReviewProfile(ctx, p, user))) continue;
      const intern = p;

      /**
       * STAFF ARE NOT INTERNS.
       *
       * Every account carries a profile so the logbook works for anyone without
       * a setup step — but a profile is a capability, not a claim about who
       * someone is. Without this filter the intern roster listed every admin and
       * moderator on the platform, and the people responsible for reviewing
       * interns appeared in the list of interns to review.
       *
       * The ROLE is what separates them: staff sign in through Zoho and are
       * moderators; interns are created by approval or by an admin.
       */
      if (!isIntern(intern)) continue;
      out.push({
        ...profileShape(p),
        // Emergency contacts ARE returned here. `profileShape` defers them to a
        // `getProfileDetail` that does not exist, so the only place they were
        // readable was the owner's own `myProfile` — a reviewer could not see
        // an intern's emergency contact anywhere, which is the one situation
        // the field exists for. This query is already reviewer-gated per row.
        emergencyContactName: p.emergencyContactName,
        emergencyContactPhone: p.emergencyContactPhone,
        intern: intern
          ? {
              id: intern._id,
              fullName: intern.fullName,
              // The roster renders an email column; without this it was blank
              // for every intern.
              email: intern.email,
              profileSlug: intern.profileSlug,
              profilePhotoUrl: intern.profilePhotoUrl,
            }
          : null,
      });
    }
    return out;
  },
});

export const saveProfile = mutation({
  args: {
    token: v.string(),
    internUserId: v.optional(v.id('users')),
    userId: v.optional(v.id('users')),
    cohortId: v.id('cohorts'),
    participationMode: v.string(),
    /**
     * Which programme this intern is on. Editable here because it decides
     * whether they keep a logbook, and an account created by hand or by import
     * arrives with none — without this there is no way to set it, and no way to
     * correct one set wrongly.
     */
    programmeType: v.optional(v.string()),
    institutionName: v.optional(v.string()),
    faculty: v.optional(v.string()),
    courseOfStudy: v.optional(v.string()),
    matricNumber: v.optional(v.string()),
    siwesStartDate: v.optional(v.string()),
    siwesEndDate: v.optional(v.string()),
    institutionSupervisorName: v.optional(v.string()),
    institutionSupervisorEmail: v.optional(v.string()),
    institutionSupervisorPhone: v.optional(v.string()),
    emergencyContactName: v.optional(v.string()),
    emergencyContactPhone: v.optional(v.string()),
    physicalDay: v.optional(v.number()),
  },
  handler: async (ctx, { token, internUserId, userId, ...fields }) => {
    const user = await requireUser(ctx, token);
    const now = Date.now();

    // Validated once, for both the update and the create path below. Deliberately
    // NOT added to the non-admin `editable` set: whether someone keeps a logbook
    // is the same class of decision as which cohort they are in, and a
    // supervisor editing an address should not be able to change it.
    if (fields.programmeType && !PROGRAMME_TYPES.includes(fields.programmeType as never)) {
      return {
        success: false as const,
        error: `Programme must be one of: ${PROGRAMME_TYPES.join(', ')}.`,
      };
    }

    if (internUserId) {
      const existing = await profileForCaller(ctx, internUserId, user);
      const isAdmin = hasRole(user, 'admin', 'super_admin');

      /**
       * Cohort, participation mode, physical day and the SIWES dates are ADMIN
       * ONLY — the same class of authority as assigning a supervisor, which is
       * already its own admin-gated mutation.
       *
       * The whitelist used to apply only to the profile's owner, so anyone
       * `profileForCaller` accepts as a reviewer — the assigned supervisor, or
       * merely the lead of the intern's department, neither of whom needs any
       * elevated role — could move an intern between cohorts (out of one
       * compliance report and into another) or flip them to remote and shed
       * their physical-day attendance expectations, on every save. cohortId and
       * participationMode are REQUIRED arguments, so a reviewer editing an
       * address rewrote them whether or not they meant to.
       */
      const editable = new Set([
        'institutionName', 'faculty', 'courseOfStudy', 'matricNumber',
        'institutionSupervisorName', 'institutionSupervisorEmail',
        'institutionSupervisorPhone', 'emergencyContactName', 'emergencyContactPhone',
      ]);

      const clean = Object.fromEntries(
        Object.entries(fields).filter(
          ([k, v]) => v !== undefined && (isAdmin || editable.has(k)),
        ),
      );

      await ctx.db.patch(existing._id, { ...clean, updatedAt: now });
      return { success: true as const, id: existing._id };
    }

    /**
     * Creation is ADMIN only, and must name its subject.
     *
     * It was staff-only with `userId ?? user._id`, so a global moderator could
     * create an active intern profile for anyone — including themselves. They
     * gained no review authority from it, but enrolling someone in a cohort is
     * an admin act, and the `?? user._id` fallback made self-enrolment the
     * DEFAULT for anyone who forgot the argument, which the comment beside it
     * claimed was impossible.
     */
    if (!hasRole(user, 'admin', 'super_admin')) {
      throw new Error('Only an admin can create an intern profile');
    }
    if (!userId) throw new Error('An intern must be named');
    const subject = userId;

    /**
     * ALWAYS AN UPDATE. There is nothing to create.
     *
     * The enrolment lives on the account, so the subject either exists — in
     * which case this writes their details — or does not exist at all, which is
     * a bad id rather than a missing profile. The old branch that refused
     * because "this user already has a profile" made the admin's own Assign
     * Intern form permanently unusable once every account carried one.
     */
    const subjectUser = await ctx.db.get(subject);
    if (!subjectUser) return { success: false as const, error: 'User not found' };

    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    await ctx.db.patch(subject, { ...clean, internStatus: subjectUser.internStatus ?? 'active', updatedAt: now });

    return { success: true as const, id: subject };
  },
});

/**
 * Assignment of supervisor and department. Staff only — an intern must not be
 * able to reassign their own reviewer, which `saveProfile` would otherwise allow
 * if these fields lived in it.
 */
export const assignProfile = mutation({
  args: {
    token: v.string(),
    internUserId: v.id('users'),
    iihSupervisorId: v.optional(v.id('users')),
    departmentId: v.optional(v.id('departments')),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { token, internUserId, status, ...patch }) => {
    // ADMIN ONLY. Allowing moderators here was a privilege-escalation chain: a
    // moderator could set iihSupervisorId = self on any intern, which makes
    // canReviewProfile pass, granting full read/write over that intern's logs,
    // attendance and private supervisor notes plus sign-off power. In Postgres,
    // assignment lived only in the admin branch of save_intern_profile.
    await requireAdmin(ctx, token);

    if (status !== undefined && !['active', 'completed', 'withdrawn'].includes(status)) {
      return { success: false as const, error: 'Invalid status' };
    }

    const profile = await ctx.db.get(internUserId);
    if (!profile) return { success: false as const, error: 'Profile not found' };

    const clean: Record<string, unknown> = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    // `status` on the wire, `internStatus` on the account — the account already
    // has a `status`-shaped concept (isActive) and conflating the two would let
    // an enrolment change silently lock someone out.
    if (status !== undefined) clean.internStatus = status;
    await ctx.db.patch(internUserId, { ...clean, updatedAt: Date.now() });
    return { success: true as const };
  },
});
