import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import {
  toApplication,
  toAttendance,
  toCohort,
  toCompliance,
  toDailyLog,
  toDepartment,
  toInternProfile,
  toLogbookExport,
  toMyStatus,
  toReviewQueue,
  toSupervisorNote,
  toWeeklySummary,
} from '../siwesAdapters';

/**
 * The SIWES seam.
 *
 * Seven modules — logbook, attendance, siwesReview, applications,
 * internProfiles, cohorts, departments — reach the backend through this one
 * function, by naming a Postgres RPC and passing `p_*` parameters. That was
 * deliberate: it means the whole SIWES surface, thirty-odd calls, moves to
 * Convex by rewriting THIS file and nothing else.
 *
 * Three shape mismatches had to be absorbed here rather than at the call sites:
 *
 * 1. The RPCs took ONE composite argument — `p_log`, `p_summary`, `p_profile`,
 *    `p_cohort`, `p_department`, `p_attendance` — a whole snake_case object the
 *    SQL function destructured. Convex mutations take explicit named arguments,
 *    which is the point: `saveDailyLog` could not accept a `status` of
 *    'approved' from a client even if one were passed, because there is no such
 *    argument. The mapping from object to arguments is done below.
 *
 * 2. Reviewer actions were strings the SQL branched on — `p_action` of
 *    'approve' | 'request_changes' | 'reopen'. Convex takes the resulting
 *    STATUS directly, so the branch happens here, once, instead of inside a
 *    function that also does the write.
 *
 * 3. The RPCs returned the saved row. The Convex mutations return
 *    `{ success, id }`, so the calls that must return a row re-read it.
 *
 * `orbit_siwes_send_reminders` has no entry. It was an admin-callable function
 * exposed as a button that nothing ever pressed; it is a cron now
 * (`scheduled.sendSiwesReminders`), which is what it always wanted to be.
 */

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

type Params = Record<string, unknown>;

/**
 * The Convex mutations declare some fields REQUIRED that the client's data
 * interfaces mark optional — a cohort must have a status and a participation
 * mode, a profile must have a cohort. Those interfaces were written against a
 * SQL function that COALESCEd a missing value into a default, silently. Failing
 * here names the field instead of returning a validator error that names an
 * argument the caller has never heard of.
 */
function need<T>(value: unknown, field: string): T {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${field} is required`);
  }
  return value as T;
}

/** `undefined` for a null or absent value — Convex optionals reject null. */
function opt<T>(v: unknown): T | undefined {
  return v === null || v === undefined ? undefined : (v as T);
}

/**
 * The RPCs accepted a date RANGE on three of the list calls. The Convex queries
 * do not: a logbook is bounded by the cohort, and every caller in the app
 * passes `undefined` for both ends. Rather than add unused arguments to the
 * server, the window is applied here, on the field each row actually carries.
 */
function withinRange<T>(rows: T[], from: unknown, to: unknown, field: keyof T): T[] {
  if (!from && !to) return rows;

  return rows.filter((row) => {
    const value = String(row[field] ?? '');
    if (from && value < String(from)) return false;
    if (to && value > String(to)) return false;
    return true;
  });
}

const DAILY_LOG_STATUS: Record<string, string> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  reopen: 'draft',
};

export async function callSiwesRpc<T>(fn: string, params: Params = {}): Promise<T> {
  const token = requireToken();

  switch (fn) {
    // ------------------------------------------------------------- cohorts
    case 'orbit_siwes_list_cohorts':
      return (await convex.query(api.siwes.listCohorts, { token })).map(toCohort) as T;

    case 'orbit_siwes_save_cohort': {
      const c = params.p_cohort as Params;
      const result = await convex.mutation(api.siwes.saveCohort, {
        token,
        cohortId: opt<never>(c.id),
        name: need<string>(c.name, 'Cohort name'),
        description: opt<string>(c.description),
        startDate: need<string>(c.start_date, 'Start date'),
        endDate: need<string>(c.end_date, 'End date'),
        status: (c.status ?? 'planned') as string,
        defaultParticipationMode: (c.default_participation_mode ?? 'remote') as string,
        defaultPhysicalDay: opt<number>(c.default_physical_day),
        dailyLogsRequired: opt<boolean>(c.daily_logs_required),
        weeklySummaryRequired: opt<boolean>(c.weekly_summary_required),
        dailyLogDays: c.daily_log_days as never,
        weeklySummaryDueDay: opt<number>(c.weekly_summary_due_day),
        signoffDueDay: opt<number>(c.signoff_due_day),
        physicalAttendanceRequired: opt<boolean>(c.physical_attendance_required),
        signoffRequired: opt<boolean>(c.signoff_required),
      });
      if (!result.success) throw new Error(result.error);

      const cohorts = await convex.query(api.siwes.listCohorts, { token });
      const saved = cohorts.find((x) => x.id === result.id);
      if (!saved) throw new Error('Cohort not found after save');
      return toCohort(saved) as T;
    }

    // --------------------------------------------------------- departments
    case 'orbit_siwes_list_departments':
      return (await convex.query(api.siwes.listDepartments, { token })).map(toDepartment) as T;

    case 'orbit_siwes_save_department': {
      const d = params.p_department as Params;
      // saveDepartment and recordAttendance cannot fail softly — they either
      // write or throw — so there is no `success: false` branch to read.
      const result = await convex.mutation(api.siwes.saveDepartment, {
        token,
        departmentId: opt<never>(d.id),
        name: need<string>(d.name, 'Department name'),
        description: opt<string>(d.description),
        leadUserId: opt<never>(d.lead_user_id),
        isActive: opt<boolean>(d.is_active),
      });

      const departments = await convex.query(api.siwes.listDepartments, {
        token,
        includeInactive: true,
      });
      const saved = departments.find((x) => x.id === result.id);
      if (!saved) throw new Error('Department not found after save');
      return toDepartment(saved) as T;
    }

    // ------------------------------------------------------------ profiles
    case 'orbit_siwes_get_my_profile': {
      const profile = await convex.query(api.siwes.myProfile, { token });
      return (profile ? toInternProfile(profile) : null) as T;
    }

    case 'orbit_siwes_list_intern_profiles':
      return (
        await convex.query(api.siwes.listProfiles, {
          token,
          cohortId: opt<never>(params.p_cohort_id),
        })
      ).map(toInternProfile) as T;

    case 'orbit_siwes_save_intern_profile': {
      const p = params.p_profile as Params;

      /**
       * TWO mutations, and the ADMIN-GATED one goes first.
       *
       * iih_supervisor_id, department_id and status are admin-only; the
       * institution details are editable by the intern. The RPC took them in
       * one object, so the function a member may call to edit their own profile
       * also accepted the fields that assign their supervisor.
       *
       * Ordering matters because two mutations are not one transaction: with
       * the profile save first, a non-admin whose form happens to carry a
       * status got a committed half-save followed by "Admin access required".
       * Running the gated call first means an unauthorised attempt writes
       * nothing at all.
       */
      const assigning =
        p.iih_supervisor_id !== undefined ||
        p.department_id !== undefined ||
        p.status !== undefined;

      if (assigning && p.id) {
        const assigned = await convex.mutation(api.siwes.assignProfile, {
          token,
          internUserId: p.id as never,
          iihSupervisorId: opt<never>(p.iih_supervisor_id),
          departmentId: opt<never>(p.department_id),
          status: opt<string>(p.status),
        });
        if (!assigned.success) throw new Error(assigned.error);
      }

      const result = await convex.mutation(api.siwes.saveProfile, {
        token,
        internUserId: opt<never>(p.id),
        userId: opt<never>(p.user_id),
        cohortId: need<never>(p.cohort_id, 'Cohort'),
        participationMode: (p.participation_mode ?? 'remote') as string,
        programmeType: opt<string>(p.programme_type),
        institutionName: opt<string>(p.institution_name),
        faculty: opt<string>(p.faculty),
        courseOfStudy: opt<string>(p.course_of_study),
        matricNumber: opt<string>(p.matric_number),
        siwesStartDate: opt<string>(p.siwes_start_date),
        siwesEndDate: opt<string>(p.siwes_end_date),
        institutionSupervisorName: opt<string>(p.institution_supervisor_name),
        institutionSupervisorEmail: opt<string>(p.institution_supervisor_email),
        institutionSupervisorPhone: opt<string>(p.institution_supervisor_phone),
        emergencyContactName: opt<string>(p.emergency_contact_name),
        emergencyContactPhone: opt<string>(p.emergency_contact_phone),
        physicalDay: opt<number>(p.physical_day),
      });
      // saveProfile now upserts and always returns an id — it refuses by
      // throwing (a non-admin naming someone else), never by returning a
      // failure shape.

      // A profile being CREATED has no id to assign against until it exists,
      // so that one case still assigns second.
      if (assigning && !p.id) {
        const assigned = await convex.mutation(api.siwes.assignProfile, {
          token,
          internUserId: result.id as never,
          iihSupervisorId: opt<never>(p.iih_supervisor_id),
          departmentId: opt<never>(p.department_id),
          status: opt<string>(p.status),
        });
        if (!assigned.success) throw new Error(assigned.error);
      }

      const profiles = await convex.query(api.siwes.listProfiles, { token });
      const saved = profiles.find((x) => x.id === (p.id ?? result.id));
      if (!saved) throw new Error('Profile not found after save');
      return toInternProfile(saved) as T;
    }

    case 'orbit_siwes_cohort_compliance': {
      const report = await convex.query(api.siwes.cohortCompliance, {
        token,
        cohortId: params.p_cohort_id as never,
      });
      if (!report) throw new Error('Cohort not found');
      return toCompliance(report) as T;
    }

    case 'orbit_siwes_my_status':
      return toMyStatus(await convex.query(api.siwes.myStatus, { token })) as T;

    // ----------------------------------------------------------- daily logs
    case 'orbit_siwes_list_daily_logs': {
      // The window goes to the SERVER now. Filtering here ran after the query
      // had already truncated to its newest N, so a range outside that window
      // came back empty however many logs existed.
      const rows = (
        await convex.query(api.logbook.listDailyLogs, {
          token,
          internUserId: opt<never>(params.p_user_id),
          from: opt<string>(params.p_from),
          to: opt<string>(params.p_to),
        })
      ).map(toDailyLog);
      return rows as T;
    }

    case 'orbit_siwes_save_daily_log': {
      const log = params.p_log as Params;

      const result = await convex.mutation(api.logbook.saveDailyLog, {
        token,
        logId: opt<never>(log.id),
        logDate: log.log_date as string,
        participationMode: (log.participation_mode ?? 'remote') as string,
        title: (log.title ?? '') as string,
        workDone: (log.work_done ?? '') as string,
        learned: opt<string>(log.learned),
        toolsUsed: opt<string>(log.tools_used),
        challenges: opt<string>(log.challenges),
        nextSteps: opt<string>(log.next_steps),
        hoursSpent: opt<number>(log.hours_spent),
        evidenceLinks: opt<string[]>(log.evidence_links),
        attachmentUrl: opt<string>(log.attachment_url),
        // A BOOLEAN, not a status. The RPC took the status column, so 'approved'
        // was a value an intern could put in their own log.
        submit: log.status === 'submitted',
      });
      if (!result.success) throw new Error(result.error);

      const logs = await convex.query(api.logbook.listDailyLogs, { token });
      const saved = logs.find((x) => x.id === result.id);
      if (!saved) throw new Error('Log not found after save');
      return toDailyLog(saved) as T;
    }

    case 'orbit_siwes_review_daily_log': {
      const status = DAILY_LOG_STATUS[params.p_action as string];
      if (!status) throw new Error(`Unknown review action: ${params.p_action}`);

      const result = await convex.mutation(api.logbook.reviewDailyLog, {
        token,
        logId: params.p_log_id as never,
        status: status as 'approved' | 'changes_requested' | 'draft',
        supervisorComment: opt<string>(params.p_comment),
      });
      if (!result.success) throw new Error(result.error);

      return { id: params.p_log_id, status } as T;
    }

    // ------------------------------------------------------ weekly summaries
    case 'orbit_siwes_list_weekly_summaries':
      return (
        await convex.query(api.logbook.listWeeklySummaries, {
          token,
          internUserId: opt<never>(params.p_user_id),
        })
      ).map(toWeeklySummary) as T;

    case 'orbit_siwes_save_weekly_summary': {
      const s = params.p_summary as Params;

      const result = await convex.mutation(api.logbook.saveWeeklySummary, {
        token,
        summaryId: opt<never>(s.id),
        weekStart: s.week_start as string,
        weekEnd: s.week_end as string,
        goals: opt<string>(s.goals),
        summary: opt<string>(s.summary),
        keyLearnings: opt<string>(s.key_learnings),
        dailyLogIds: opt<string[]>(s.daily_log_ids),
        submit: s.status === 'submitted',
      });
      if (!result.success) throw new Error(result.error);

      const summaries = await convex.query(api.logbook.listWeeklySummaries, { token });
      const saved = summaries.find((x) => x.id === result.id);
      if (!saved) throw new Error('Summary not found after save');
      return toWeeklySummary(saved) as T;
    }

    case 'orbit_siwes_review_weekly_summary': {
      const result = await convex.mutation(api.logbook.signOffWeeklySummary, {
        token,
        summaryId: params.p_summary_id as never,
        supervisorComment: opt<string>(params.p_comment),
        approve: params.p_action === 'sign_off',
      });
      if (!result.success) throw new Error(result.error);

      return { id: params.p_summary_id } as T;
    }

    // ------------------------------------------------------------ attendance
    case 'orbit_siwes_list_attendance': {
      const rows = (
        await convex.query(api.logbook.listAttendance, {
          token,
          internUserId: opt<never>(params.p_user_id),
        })
      ).map(toAttendance);
      return withinRange(rows, params.p_from, params.p_to, 'attendance_date') as T;
    }

    case 'orbit_siwes_record_attendance': {
      const a = params.p_attendance as Params;

      /**
       * Routed on WHICH OPERATION the caller is performing, detected by the
       * fields it actually sends.
       *
       * A check-in/check-out carries a time; a supervisor's verification
       * carries only a status. The previous rule keyed on `a.id`, and NO CALLER
       * HAS ONE — both review surfaces send profile + date + status, and
       * `RecordAttendanceData` has no id field — so the verification branch was
       * unreachable and every supervisor action fell through to the intern's own
       * check-in path, writing a bogus row against the SUPERVISOR's profile and
       * reporting success.
       *
       * Neither branch carries authorization: verifyAttendance requires a
       * reviewer for that profile, and recordAttendance has no status argument
       * and resolves the caller's own profile.
       */
      const isCheckInOut = a.check_in_time !== undefined || a.check_out_time !== undefined;

      if (!isCheckInOut && a.status) {
        const verified = await convex.mutation(api.logbook.verifyAttendance, {
          token,
          internUserId: need<never>(a.user_id, 'Intern profile'),
          attendanceDate: need<string>(a.attendance_date, 'Attendance date'),
          status: a.status as string,
          expectedMode: opt<string>(a.expected_mode),
          activitySummary: opt<string>(a.activity_summary),
        });
        if (!verified.success) throw new Error(verified.error);

        const rows = await convex.query(api.logbook.listAttendance, {
          token,
          internUserId: a.user_id as never,
        });
        const saved = rows.find((x) => x.attendanceDate === a.attendance_date);
        return (saved ? toAttendance(saved) : { id: '', status: a.status }) as T;
      }

      const result = await convex.mutation(api.logbook.recordAttendance, {
        token,
        attendanceDate: a.attendance_date as string,
        expectedMode: (a.expected_mode ?? 'remote') as string,
        checkIn: a.check_in_time !== undefined,
        checkOut: a.check_out_time !== undefined,
        activitySummary: opt<string>(a.activity_summary),
        departmentId: opt<never>(a.department_id),
      });

      const rows = await convex.query(api.logbook.listAttendance, { token });
      const saved = rows.find((x) => x.id === result.id);
      if (!saved) throw new Error('Attendance record not found after save');
      return toAttendance(saved) as T;
    }

    // --------------------------------------------------------------- review
    case 'orbit_siwes_review_queue':
      return toReviewQueue(await convex.query(api.logbook.reviewQueue, { token })) as T;

    case 'orbit_siwes_list_supervisor_notes':
      return (
        await convex.query(api.logbook.listSupervisorNotes, {
          token,
          internUserId: params.p_user_id as never,
        })
      ).map(toSupervisorNote) as T;

    case 'orbit_siwes_add_supervisor_note': {
      const result = await convex.mutation(api.logbook.addSupervisorNote, {
        token,
        internUserId: params.p_user_id as never,
        note: params.p_note as string,
      });
      if (!result.success) throw new Error(result.error);
      return { id: result.id, note: params.p_note } as T;
    }

    // --------------------------------------------------------- applications
    case 'orbit_siwes_application_counts':
      return (await convex.query(api.applications.counts, {
        token,
        programmeType: opt<string>(params.p_programme_type),
      })) as T;

    case 'orbit_siwes_list_applications':
      return (
        await convex.query(api.applications.list, {
          token,
          status: opt<string>(params.p_status),
          search: opt<string>(params.p_search),
          programmeType: opt<string>(params.p_programme_type),
          limit: opt<number>(params.p_limit),
        })
      ).map(toApplication) as T;

    case 'orbit_siwes_update_application_status': {
      const result = await convex.mutation(api.applications.updateStatus, {
        token,
        applicationId: params.p_application_id as never,
        status: params.p_status as string,
        notes: opt<string>(params.p_notes),
      });
      if (!result.success) throw new Error(result.error);

      const row = await convex.query(api.applications.getById, {
        token,
        applicationId: params.p_application_id as never,
      });
      if (!row) throw new Error('Application not found after update');
      return toApplication(row) as T;
    }

    // ---------------------------------------------------------------- export
    case 'orbit_siwes_export_logbook': {
      const result = await convex.mutation(api.logbook.exportLogbook, {
        token,
        internUserId: opt<never>(params.p_user_id),
        from: opt<string>(params.p_from),
        to: opt<string>(params.p_to),
        exportType: (params.p_export_type ?? 'print') as string,
      });
      if (!result.success) throw new Error(result.error);

      // Adapted, not passed through. This was the one case returning the raw
      // Convex payload, so the print view destructured `daily_logs` out of an
      // object holding `dailyLogs` and threw before rendering anything.
      return toLogbookExport(result.data as Record<string, unknown>) as T;
    }

    default:
      // Loud. A silent fall-through here would look like an empty logbook.
      throw new Error(`No Convex mapping for ${fn}`);
  }
}
