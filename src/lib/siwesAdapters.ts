/**
 * Convex → the snake_case SIWES shapes the app already speaks.
 *
 * Same job as `convexAdapters.ts`, kept separate because the SIWES surface is
 * its own subsystem: seven client modules, thirty-odd calls, all reaching the
 * backend through the single seam in `api/siwesRpc.ts`. Adapting here means
 * none of those seven modules and none of their pages change.
 *
 * Fields the Convex functions deliberately do NOT return — `user_id`
 * on a log, `reviewed_by` on a review, `created_at` on rows that only ever
 * render an updated time — are filled with the safest honest value rather than
 * invented. The types declare them because PostgREST returned `select *`.
 */

import { convexSiteUrl } from './convex';

function iso(ms: number | undefined | null): string | undefined {
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}

const EPOCH = new Date(0).toISOString();

type Row = Record<string, unknown>;

export function toDailyLog(l: Row) {
  return {
    id: l.id as string,
    // The row is always read through a profile the caller is authorised for, so
    // the id is not needed to interpret it — and returning it would hand a
    // reviewer another intern's profile id for no reason.
    user_id: '',
    log_date: l.logDate as string,
    participation_mode: l.participationMode as 'physical' | 'remote',
    title: (l.title ?? '') as string,
    work_done: (l.workDone ?? '') as string,
    learned: l.learned as string | undefined,
    tools_used: l.toolsUsed as string | undefined,
    challenges: l.challenges as string | undefined,
    next_steps: l.nextSteps as string | undefined,
    hours_spent: (l.hoursSpent ?? null) as number | null,
    evidence_links: (l.evidenceLinks ?? []) as string[],
    attachment_url: l.attachmentUrl as string | undefined,
    status: l.status as 'draft' | 'submitted' | 'approved' | 'changes_requested',
    submitted_at: iso(l.submittedAt as number | undefined),
    reviewed_at: iso(l.reviewedAt as number | undefined),
    supervisor_comment: l.supervisorComment as string | undefined,
    // "Reviewed by …" on LogbookPage — a conditional render that was
    // permanently false because the name was never carried out of Convex.
    reviewer_name: (l.reviewerName ?? null) as string | null,
    created_at: iso(l.submittedAt as number | undefined) ?? EPOCH,
    updated_at: iso(l.reviewedAt as number | undefined) ?? EPOCH,
  };
}

export function toWeeklySummary(w: Row) {
  return {
    id: w.id as string,
    user_id: '',
    week_start: w.weekStart as string,
    week_end: w.weekEnd as string,
    goals: w.goals as string | undefined,
    summary: w.summary as string | undefined,
    key_learnings: w.keyLearnings as string | undefined,
    daily_log_ids: (w.dailyLogIds ?? []) as string[],
    status: w.status as 'draft' | 'submitted' | 'signed_off' | 'changes_requested',
    submitted_at: iso(w.submittedAt as number | undefined),
    signed_off_at: iso(w.signedOffAt as number | undefined),
    supervisor_comment: w.supervisorComment as string | undefined,
    signed_off_by_name: (w.signedOffByName ?? null) as string | null,
    created_at: iso(w.submittedAt as number | undefined) ?? EPOCH,
    updated_at: iso(w.signedOffAt as number | undefined) ?? EPOCH,
  };
}

export function toAttendance(a: Row) {
  return {
    id: a.id as string,
    user_id: '',
    attendance_date: a.attendanceDate as string,
    expected_mode: a.expectedMode as 'physical' | 'remote',
    check_in_time: iso(a.checkInTime as number | undefined),
    check_out_time: iso(a.checkOutTime as number | undefined),
    department_id: (a.departmentId ?? null) as string | null,
    activity_summary: a.activitySummary as string | undefined,
    status: a.status as 'present' | 'absent' | 'remote_makeup' | 'verified' | 'excused',
    verified_by_name: (a.verifiedByName ?? null) as string | null,
    created_at: EPOCH,
    updated_at: iso(a.updatedAt as number | undefined) ?? EPOCH,
  };
}

export function toCohort(c: Row) {
  return {
    id: c.id as string,
    name: c.name as string,
    description: c.description as string | undefined,
    start_date: c.startDate as string,
    end_date: c.endDate as string,
    status: c.status as 'planned' | 'active' | 'completed',
    default_participation_mode: c.defaultParticipationMode as 'physical' | 'remote' | 'hybrid',
    default_physical_day: (c.defaultPhysicalDay ?? null) as number | null,
    daily_logs_required: Boolean(c.dailyLogsRequired),
    weekly_summary_required: Boolean(c.weeklySummaryRequired),
    daily_log_days: (c.dailyLogDays ?? undefined) as number[] | undefined,
    weekly_summary_due_day: (c.weeklySummaryDueDay ?? undefined) as number | undefined,
    signoff_due_day: (c.signoffDueDay ?? undefined) as number | undefined,
    physical_attendance_required: (c.physicalAttendanceRequired ?? undefined) as boolean | undefined,
    signoff_required: Boolean(c.signoffRequired),
    created_at: EPOCH,
    updated_at: EPOCH,
  };
}

export function toDepartment(d: Row) {
  const lead = d.lead as Row | null;
  return {
    id: d.id as string,
    name: d.name as string,
    description: d.description as string | undefined,
    lead_user_id: (lead?.id ?? null) as string | null,
    lead_name: lead?.fullName as string | undefined,
    is_active: Boolean(d.isActive),
    created_at: EPOCH,
    updated_at: EPOCH,
  };
}

export function toInternProfile(p: Row) {
  const intern = p.intern as Row | undefined;

  return {
    id: p.id as string,
    user_id: p.userId as string,
    cohort_id: p.cohortId as string,
    participation_mode: p.participationMode as 'physical' | 'remote' | 'hybrid',
    institution_name: p.institutionName as string | undefined,
    faculty: p.faculty as string | undefined,
    course_of_study: p.courseOfStudy as string | undefined,
    matric_number: p.matricNumber as string | undefined,
    siwes_start_date: p.siwesStartDate as string | undefined,
    siwes_end_date: p.siwesEndDate as string | undefined,
    institution_supervisor_name: p.institutionSupervisorName as string | undefined,
    institution_supervisor_email: p.institutionSupervisorEmail as string | undefined,
    institution_supervisor_phone: p.institutionSupervisorPhone as string | undefined,
    programme_type: (p.programmeType ?? null) as string | null,
    carries_logbook: Boolean(p.carriesLogbook),
    iih_supervisor_id: (p.iihSupervisorId ?? null) as string | null,
    department_id: (p.departmentId ?? null) as string | null,
    physical_day: (p.physicalDay ?? null) as number | null,
    // Returned only by `myProfile`, which is the owner reading their own row.
    // `listProfiles` omits them, and the adapter must not invent a blank.
    emergency_contact_name: p.emergencyContactName as string | undefined,
    emergency_contact_phone: p.emergencyContactPhone as string | undefined,
    status: p.status as 'pending' | 'active' | 'completed' | 'withdrawn',
    created_at: EPOCH,
    updated_at: EPOCH,
    full_name: intern?.fullName as string | undefined,
    email: intern?.email as string | undefined,
    profile_photo_url: intern?.profilePhotoUrl as string | undefined,
  };
}

export function toSupervisorNote(n: Row) {
  const author = n.author as Row | null;
  return {
    id: n.id as string,
    user_id: '',
    author_id: (author?.id ?? '') as string,
    author_name: author?.fullName as string | undefined,
    note: n.note as string,
    created_at: iso(n.createdAt as number | undefined) ?? EPOCH,
    updated_at: iso(n.createdAt as number | undefined) ?? EPOCH,
  };
}

/**
 * The review dashboard's five sections.
 *
 * Every row is already scoped server-side to the interns this reviewer may act
 * on — `canReviewProfile` runs per row rather than the client filtering a
 * whole-platform queue, which is what the RPC returned and what made that
 * filter an authorization decision taken after the data had been sent.
 */
export function toReviewQueue(q: Row) {
  const person = (r: Row) => ({
    full_name: (r.fullName ?? 'Unknown') as string,
    profile_photo_url: r.profilePhotoUrl as string | undefined,
  });

  return {
    interns: (q.interns as Row[]).map((i) => ({
      id: i.id as string,
      user_id: i.userId as string,
      cohort_id: i.cohortId as string,
      participation_mode: i.participationMode as 'physical' | 'remote' | 'hybrid',
      status: i.status as 'pending' | 'active' | 'completed' | 'withdrawn',
      department_id: (i.departmentId ?? null) as string | null,
      iih_supervisor_id: (i.iihSupervisorId ?? null) as string | null,
      email: (i.email ?? '') as string,
      cohort_name: (i.cohortName ?? '') as string,
      department_name: (i.departmentName ?? null) as string | null,
      programme_type: (i.programmeType ?? null) as string | null,
      carries_logbook: Boolean(i.carriesLogbook),
      // null, not 0 — see the server comment; this row may be a volunteer.
      approved_logs: (i.approvedLogs ?? null) as number | null,
      pending_logs: (i.pendingLogs ?? null) as number | null,
      signed_off_weeks: (i.signedOffWeeks ?? null) as number | null,
      ...person(i),
    })),

    pending_daily_logs: (q.pendingDailyLogs as Row[]).map((l) => ({
      id: l.id as string,
      user_id: l.userId as string,
      log_date: l.logDate as string,
      title: (l.title ?? '') as string,
      participation_mode: l.participationMode as 'physical' | 'remote',
      hours_spent: (l.hoursSpent ?? null) as number | null,
      submitted_at: iso(l.submittedAt as number | undefined),
      status: l.status as 'draft' | 'submitted' | 'approved' | 'changes_requested',
      ...person(l),
    })),

    pending_weekly_summaries: (q.pendingWeeklySummaries as Row[]).map((w) => ({
      id: w.id as string,
      user_id: w.userId as string,
      week_start: w.weekStart as string,
      week_end: w.weekEnd as string,
      submitted_at: iso(w.submittedAt as number | undefined),
      status: w.status as 'draft' | 'submitted' | 'signed_off' | 'changes_requested',
      ...person(w),
    })),

    missing_logs: (q.missingLogs as Row[]).map((m) => ({
      user_id: m.userId as string,
      missing_days: m.missingDays as number,
      ...person(m),
    })),

    attendance_exceptions: (q.attendanceExceptions as Row[]).map((a) => ({
      id: a.id as string,
      user_id: a.userId as string,
      attendance_date: a.attendanceDate as string,
      status: a.status as 'present' | 'absent' | 'remote_makeup' | 'verified' | 'excused',
      expected_mode: a.expectedMode as 'physical' | 'remote',
      ...person(a),
    })),
  };
}

export function toMyStatus(s: Row | null) {
  if (!s) return null;

  return {
    user_id: s.userId as string,
    programme_type: (s.programmeType ?? null) as string | null,
    carries_logbook: Boolean(s.carriesLogbook),
    cohort_name: (s.cohortName ?? null) as string | null,
    cohort_status: (s.cohortStatus ?? null) as string | null,
    participation_mode: s.participationMode as 'physical' | 'remote' | 'hybrid',
    status: s.status as string,
    department_name: (s.departmentName ?? null) as string | null,
    supervisor_name: (s.supervisorName ?? null) as string | null,
    physical_day: (s.physicalDay ?? null) as number | null,
    logs_this_week: s.logsThisWeek as number,
    approved_logs: s.approvedLogs as number,
    pending_changes: s.pendingChanges as number,
    signed_off_weeks: s.signedOffWeeks as number,
    last_log_date: (s.lastLogDate ?? null) as string | null,
  };
}

export function toCompliance(c: Row) {
  const cohort = c.cohort as Row;

  return {
    cohort: {
      id: cohort.id as string,
      name: cohort.name as string,
      status: cohort.status as 'planned' | 'active' | 'completed',
      start_date: cohort.startDate as string,
      end_date: cohort.endDate as string,
      description: undefined,
      default_participation_mode: 'remote' as const,
      default_physical_day: null,
      daily_logs_required: true,
      weekly_summary_required: true,
      signoff_required: true,
      created_at: EPOCH,
      updated_at: EPOCH,
    },
    interns: (c.interns as Row[]).map((i) => ({
      user_id: i.userId as string,
      full_name: (i.fullName ?? '') as string,
      email: (i.email ?? '') as string,
      status: i.status as string,
      participation_mode: i.participationMode as string,
      department_name: (i.departmentName ?? null) as string | null,
      supervisor_name: (i.supervisorName ?? null) as string | null,
      programme_type: (i.programmeType ?? null) as string | null,
      carries_logbook: Boolean(i.carriesLogbook),
      // null, not 0 — "not measured" rather than "measured as none".
      total_logs: (i.totalLogs ?? null) as number | null,
      approved_logs: (i.approvedLogs ?? null) as number | null,
      signed_off_weeks: (i.signedOffWeeks ?? null) as number | null,
      days_present: i.daysPresent as number,
      days_absent: i.daysAbsent as number,
      last_log_date: (i.lastLogDate ?? null) as string | null,
    })),
  };
}

/**
 * A document descriptor -> a URL the client can actually use.
 *
 * The Convex functions return `{ available, path }` for a stored document and
 * `{ available, legacyUrl }` for a pre-migration Supabase one. This used to cast
 * that OBJECT straight to `string | null`, so the moment an admin changed an
 * application's status the row re-read from `getById` and rendered
 * `<img src="[object Object]">` and a link to `/[object Object]`.
 *
 * A `path` is on the AUTHENTICATED `/applications/document` route, so it is
 * returned absolute and must be fetched with a Bearer token — `AuthedImage`
 * does that. A `legacyUrl` is a public bucket URL and is usable directly.
 */
function documentUrl(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null;

  const doc = d as { available?: boolean; path?: string; legacyUrl?: string | null };
  if (!doc.available) return null;
  if (doc.path) return `${convexSiteUrl}${doc.path}`;
  return doc.legacyUrl ?? null;
}

/** True when the URL needs a session header rather than a plain <img src>. */
export function isAuthedDocumentUrl(url: string | null): boolean {
  return Boolean(url && url.startsWith(convexSiteUrl));
}

export function toApplication(a: Row) {
  const reviewer = a.reviewer as Row | null | undefined;

  return {
    id: a.id as string,
    reference_code: a.referenceCode as string,
    programme_type: a.programmeType as 'siwes' | 'internship' | 'nysc' | 'volunteer',
    status: a.status as 'submitted' | 'under_review' | 'approved' | 'waitlisted' | 'rejected' | 'converted',
    full_name: a.fullName as string,
    email: a.email as string,
    phone: (a.phone ?? '') as string,
    gender: (a.gender ?? null) as string | null,
    location: (a.location ?? null) as string | null,
    institution_name: (a.institutionName ?? null) as string | null,
    faculty: (a.faculty ?? null) as string | null,
    course_of_study: (a.courseOfStudy ?? null) as string | null,
    matric_number: (a.matricNumber ?? null) as string | null,
    level_or_year: (a.levelOrYear ?? null) as string | null,
    siwes_start_date: (a.siwesStartDate ?? null) as string | null,
    siwes_end_date: (a.siwesEndDate ?? null) as string | null,
    institution_supervisor_name: (a.institutionSupervisorName ?? null) as string | null,
    institution_supervisor_email: (a.institutionSupervisorEmail ?? null) as string | null,
    institution_supervisor_phone: (a.institutionSupervisorPhone ?? null) as string | null,
    preferred_participation_mode: (a.preferredParticipationMode ?? 'virtual') as 'physical' | 'virtual' | 'hybrid',
    assigned_participation_mode: (a.assignedParticipationMode ?? null) as string | null,
    assigned_physical_day: (a.assignedPhysicalDay ?? null) as number | null,
    assigned_stream_id: (a.assignedStreamId ?? null) as string | null,
    assigned_supervisor_id: (a.assignedSupervisorId ?? null) as string | null,
    mode_override_reason: (a.modeOverrideReason ?? null) as string | null,
    available_physical_day: (a.availablePhysicalDay ?? null) as number | null,
    track_interests: (a.trackInterests ?? []) as string[],
    skills_summary: (a.skillsSummary ?? null) as string | null,
    motivation: (a.motivation ?? null) as string | null,
    portfolio_url: (a.portfolioUrl ?? null) as string | null,
    passport_photo_url: documentUrl(a.passportPhoto),
    siwes_letter_url: documentUrl(a.siwesLetter),
    siwes_letter_file_name: (a.siwesLetterFileName ?? null) as string | null,
    emergency_contact_name: (a.emergencyContactName ?? null) as string | null,
    emergency_contact_phone: (a.emergencyContactPhone ?? null) as string | null,
    consent_logbook: Boolean(a.consentLogbook),
    consent_data_use: Boolean(a.consentDataUse),
    notes: (a.notes ?? null) as string | null,
    reviewed_by: (reviewer?.id ?? null) as string | null,
    reviewed_by_name: (reviewer?.fullName ?? null) as string | null,
    reviewed_at: iso(a.reviewedAt as number | undefined) ?? null,
    created_at: iso(a.createdAt as number | undefined) ?? EPOCH,
    updated_at: iso(a.updatedAt as number | undefined) ?? EPOCH,
  };
}

/**
 * The logbook export payload, for the print view.
 *
 * This was the ONLY case in `callSiwesRpc` returning the Convex result
 * unadapted (`return result.data as T`), so `LogbookPrintView` — which
 * destructures `daily_logs` / `weekly_summaries` — received `dailyLogs` /
 * `weeklySummaries` and threw a TypeError on `daily_logs.length` the moment an
 * intern pressed Print. Every cell inside it read a snake_case key that did not
 * exist either.
 *
 * It is also the one path that resolves reviewer names, which is why they are
 * carried through here rather than dropped.
 */
export function toLogbookExport(d: Row) {
  const p = (d.profile ?? {}) as Row;

  return {
    profile: {
      full_name: (p.fullName ?? '') as string,
      email: (p.email ?? '') as string,
      institution_name: p.institutionName as string | undefined,
      faculty: p.faculty as string | undefined,
      course_of_study: p.courseOfStudy as string | undefined,
      matric_number: p.matricNumber as string | undefined,
      participation_mode: p.participationMode as string,
      siwes_start_date: p.siwesStartDate as string | undefined,
      siwes_end_date: p.siwesEndDate as string | undefined,
      institution_supervisor_name: p.institutionSupervisorName as string | undefined,
      cohort_name: (p.cohortName ?? null) as string | null,
      cohort_start: (p.cohortStart ?? null) as string | null,
      cohort_end: (p.cohortEnd ?? null) as string | null,
      department_name: (p.departmentName ?? null) as string | null,
      supervisor_name: (p.supervisorName ?? null) as string | null,
    },

    daily_logs: ((d.dailyLogs ?? []) as Row[]).map((l) => ({
      log_date: l.logDate as string,
      participation_mode: l.participationMode as string,
      title: (l.title ?? '') as string,
      work_done: (l.workDone ?? '') as string,
      learned: l.learned as string | undefined,
      tools_used: l.toolsUsed as string | undefined,
      challenges: l.challenges as string | undefined,
      next_steps: l.nextSteps as string | undefined,
      hours_spent: (l.hoursSpent ?? null) as number | null,
      evidence_links: (l.evidenceLinks ?? []) as string[],
      status: l.status as string,
      supervisor_comment: l.supervisorComment as string | undefined,
      reviewed_at: iso(l.reviewedAt as number | undefined),
      reviewer_name: (l.reviewerName ?? null) as string | null,
    })),

    weekly_summaries: ((d.weeklySummaries ?? []) as Row[]).map((w) => ({
      week_start: w.weekStart as string,
      week_end: w.weekEnd as string,
      goals: w.goals as string | undefined,
      summary: w.summary as string | undefined,
      key_learnings: w.keyLearnings as string | undefined,
      status: w.status as string,
      supervisor_comment: w.supervisorComment as string | undefined,
      signed_off_at: iso(w.signedOffAt as number | undefined),
      signed_off_by_name: (w.signedOffByName ?? null) as string | null,
    })),

    attendance: ((d.attendance ?? []) as Row[]).map((a) => ({
      attendance_date: a.attendanceDate as string,
      expected_mode: a.expectedMode as string,
      check_in_time: iso(a.checkInTime as number | undefined),
      check_out_time: iso(a.checkOutTime as number | undefined),
      activity_summary: a.activitySummary as string | undefined,
      status: a.status as string,
      verified_by_name: (a.verifiedByName ?? null) as string | null,
    })),

    generated_at: iso(d.generatedAt as number | undefined) ?? new Date().toISOString(),
  };
}
