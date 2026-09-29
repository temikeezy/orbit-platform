export type UserRole = 'admin' | 'super_admin' | 'moderator' | 'intern';

export type SubmissionStatus =
  | 'draft'
  // Accepted but not yet submitted. `acceptTask` creates the row in this
  // state, so it has always been produced — it was simply missing from the
  // union, which meant every accepted-not-submitted row was mistyped.
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'changes_requested';

export type SubmissionType = 'text' | 'link' | 'file';

export type ContentType = 'text' | 'image' | 'link' | 'poll';

export type FriendshipStatus = 'pending' | 'accepted' | 'rejected' | 'blocked';

export type NotificationType =
  | 'task_created'
  | 'deadline_reminder'
  | 'submission_scored'
  | 'message_received'
  | 'comment'
  | 'reaction'
  | 'badge_earned'
  | 'stream_assignment'
  | 'friendship_request'
  | 'logbook_reminder'
  | 'logbook_review_pending'
  | 'logbook_changes_requested'
  | 'logbook_approved'
  | 'weekly_summary_signed_off'
  | 'physical_day_reminder'
  | 'attendance_alert';

export type EmailType =
  | 'onboarding'
  | 'task_created'
  | 'deadline_reminder'
  | 'submission_confirmed'
  | 'task_scored'
  | 'welcome'
  | 'magic_link'
  | 'logbook_reminder'
  | 'logbook_review'
  | 'logbook_signoff'
  | 'physical_day_reminder'
  | 'attendance_alert';

export type SettingCategory = 'email' | 'oauth' | 'general';

/**
 * An application is either submitted or approved — see
 * convex/lib/applicationStatus.ts. It carried six states, five of which nothing
 * in the platform behaved differently for.
 */
export type OrbitApplicationStatus = 'submitted' | 'approved';

export type OrbitApplicationProgrammeType = 'siwes' | 'internship' | 'nysc' | 'volunteer';

export interface OrbitAdminSetting {
  id: string;
  setting_key: string;
  setting_value: Record<string, unknown>;
  category: SettingCategory;
  description?: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
}

export interface OrbitApplication {
  id: string;
  reference_code: string;
  programme_type: OrbitApplicationProgrammeType;
  status: OrbitApplicationStatus;
  full_name: string;
  email: string;
  phone: string;
  /** 'male' | 'female', or absent. Read only to pick the letter's pronouns. */
  gender?: string | null;
  location?: string | null;
  institution_name?: string | null;
  faculty?: string | null;
  course_of_study?: string | null;
  matric_number?: string | null;
  level_or_year?: string | null;
  siwes_start_date?: string | null;
  siwes_end_date?: string | null;
  institution_supervisor_name?: string | null;
  institution_supervisor_email?: string | null;
  institution_supervisor_phone?: string | null;
  preferred_participation_mode: ParticipationMode;
  available_physical_day?: number | null;
  track_interests: string[];
  skills_summary?: string | null;
  motivation?: string | null;
  portfolio_url?: string | null;
  passport_photo_url?: string | null;
  passport_photo_path?: string | null;
  passport_photo_mime_type?: string | null;
  passport_photo_size?: number | null;
  siwes_letter_url?: string | null;
  siwes_letter_path?: string | null;
  siwes_letter_file_name?: string | null;
  siwes_letter_mime_type?: string | null;
  siwes_letter_size?: number | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  consent_logbook: boolean;
  consent_data_use: boolean;
  notes?: string | null;
  reviewed_by?: string | null;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
  /** What review decided, as opposed to what intake derived above. */
  assigned_participation_mode?: string | null;
  assigned_physical_day?: number | null;
  assigned_stream_id?: string | null;
  assigned_supervisor_id?: string | null;
  mode_override_reason?: string | null;
}

export interface OrbitUser {
  id: string;
  email: string;
  full_name: string;
  roles: UserRole[];
  password_hash?: string;
  jwt_token?: string;
  jwt_expires_at?: string;
  profile_photo_url?: string;
  cover_photo_url?: string;
  bio?: string;
  location?: string;
  current_stream_id?: string;
  total_points: number;
  current_level: number;
  login_streak_count?: number;
  login_streak_last_date?: string;
  zoho_id?: string;
  is_active: boolean;
  last_login_at?: string;
  has_password?: boolean;
  created_at: string;
  updated_at: string;
  social_links?: { twitter?: string; linkedin?: string; github?: string; [key: string]: string | undefined };
  mcp_enabled?: boolean;
  is_dummy?: boolean;
  dummy_source?: string | null;
  dummy_marked_at?: string | null;
  deleted_at?: string;
}

export interface OrbitStream {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  member_count?: number;
  task_count?: number;
  cover_image_url?: string;
  display_photo_url?: string;
  privacy?: 'public' | 'private';
  join_type?: 'open' | 'invite';
  // Resolved server-side against the caller's own session. StreamDetailPage
  // swaps its primary button on is_member; AddTaskPage and EditTaskPage filter
  // the stream list on is_moderator. Both were previously worked out in the
  // browser by reading the memberships and moderators tables in full.
  is_member?: boolean;
  is_moderator?: boolean;
  is_dummy?: boolean;
  dummy_source?: string | null;
  dummy_marked_at?: string | null;
}

export interface OrbitStreamMembership {
  id: string;
  user_id: string;
  stream_id: string;
  assigned_by: string;
  is_active: boolean;
  started_at: string;
  ended_at?: string;
  created_at: string;
}

export interface OrbitTask {
  id: string;
  stream_id: string;
  title: string;
  description: string;
  submission_type: SubmissionType;
  points: number;
  deadline: string;
  created_by: string;
  is_active: boolean;
  is_featured?: boolean;
  created_at: string;
  updated_at: string;
  is_dummy?: boolean;
  dummy_source?: string | null;
  dummy_marked_at?: string | null;
}

export interface OrbitSubmission {
  id: string;
  task_id: string;
  user_id: string;
  submission_text?: string;
  submission_file_url?: string;
  submission_url?: string;
  /** Whether a file is attached. Convex-stored files have no public url. */
  has_file?: boolean;
  status: SubmissionStatus;
  score?: number;
  feedback?: string;
  points_awarded?: number;
  accepted_at?: string;
  started_at?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  submitted_at?: string;
  created_at: string;
  updated_at: string;
}

export interface OrbitPointsLedger {
  id: string;
  user_id: string;
  points: number;
  reason: 'task_completion' | 'bonus' | 'penalty' | 'adjustment';
  reference_id?: string;
  reference_type?: 'submission' | 'badge' | 'manual';
  created_by: string;
  created_at: string;
}

export interface OrbitBadge {
  id: string;
  name: string;
  description: string;
  icon_url?: string;
  criteria_type: 'streak' | 'quality' | 'consistency' | 'points' | 'tasks';
  criteria_value: number;
  points_bonus: number;
  is_active: boolean;
  created_at: string;
}

export interface OrbitUserBadge {
  id: string;
  user_id: string;
  badge_id: string;
  earned_at: string;
  created_at: string;
}

export interface OrbitActivityFeed {
  id: string;
  user_id: string;
  content_type: ContentType;
  content_text?: string;
  content_url?: string;
  stream_id?: string;
  is_stream_only: boolean;
  poll_options?: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrbitComment {
  id: string;
  post_id: string;
  user_id: string;
  content: string;
  parent_comment_id?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrbitReaction {
  id: string;
  user_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  emoji: string;
  created_at: string;
}

export interface OrbitFriendship {
  id: string;
  user_id: string;
  friend_id: string;
  status: FriendshipStatus;
  created_at: string;
  updated_at: string;
}

export interface OrbitMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  attachment_url?: string;
  is_read: boolean;
  read_at?: string;
  created_at: string;
}

export interface OrbitStreamChat {
  id: string;
  stream_id: string;
  user_id: string;
  content: string;
  attachment_url?: string;
  is_announcement: boolean;
  created_at: string;
}

export interface OrbitNotification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  content: string;
  reference_type?: string;
  reference_id?: string;
  action_url?: string;
  is_read: boolean;
  read_at?: string;
  created_at: string;
}

export interface OrbitEmailQueue {
  id: string;
  user_id: string;
  email_type: EmailType;
  recipient_email: string;
  subject: string;
  body_html: string;
  body_text: string;
  reference_type?: string;
  reference_id?: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at?: string;
  failed_at?: string;
  error_message?: string;
  retry_count: number;
  created_at: string;
}

// ============================================================
// ORBIT 2.0 — SIWES / Logbook layer
// ============================================================

export type ParticipationMode = 'virtual' | 'hybrid' | 'physical';

export type DayParticipationMode = 'virtual' | 'physical';

export type CohortStatus = 'draft' | 'active' | 'completed' | 'archived';

export type InternProfileStatus = 'pending' | 'active' | 'paused' | 'completed' | 'withdrawn';

export type DailyLogStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved';

export type WeeklySummaryStatus = 'draft' | 'submitted' | 'changes_requested' | 'signed_off';

// 'verified' is a supervisor's confirmation of a day the intern claimed, and is
// what clears a record from the review queue. It was missing here while the
// server accepted it, so the one status that resolves an exception could not be
// expressed by the client at all.
export type AttendanceStatus =
  | 'expected'
  | 'present'
  | 'absent'
  | 'excused'
  | 'remote_makeup'
  | 'verified';

export type LogbookExportType = 'print' | 'pdf' | 'csv';

export interface OrbitCohort {
  id: string;
  name: string;
  description?: string;
  start_date: string;
  end_date: string;
  status: CohortStatus;
  default_participation_mode: ParticipationMode;
  /** 0 = Sunday ... 6 = Saturday */
  default_physical_day?: number | null;
  daily_logs_required: boolean;
  weekly_summary_required: boolean;
  signoff_required: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
  /** joined field from list RPC */
  intern_count?: number;
  /** The weekly rhythm. See convex/lib/cadence.ts for defaults. */
  daily_log_days?: number[];
  weekly_summary_due_day?: number;
  signoff_due_day?: number;
  physical_attendance_required?: boolean;
}

export interface OrbitDepartment {
  id: string;
  name: string;
  description?: string;
  lead_user_id?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** joined fields from list RPC */
  lead_name?: string;
  intern_count?: number;
}

export interface OrbitInternProfile {
  id: string;
  user_id: string;
  cohort_id: string;
  participation_mode: ParticipationMode;
  /** 'siwes' | 'internship' | 'nysc' | 'volunteer', or null on older accounts. */
  programme_type?: string | null;
  /** True only for programmes that keep a logbook — SIWES today. */
  carries_logbook?: boolean;
  institution_name?: string;
  faculty?: string;
  course_of_study?: string;
  matric_number?: string;
  siwes_start_date?: string;
  siwes_end_date?: string;
  institution_supervisor_name?: string;
  institution_supervisor_email?: string;
  institution_supervisor_phone?: string;
  iih_supervisor_id?: string | null;
  department_id?: string | null;
  /** overrides cohort default when set; 0 = Sunday ... 6 = Saturday */
  physical_day?: number | null;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  status: InternProfileStatus;
  created_at: string;
  updated_at: string;
  /** joined fields from RPCs */
  full_name?: string;
  email?: string;
  profile_photo_url?: string;
  cohort_name?: string;
  cohort_status?: CohortStatus;
  department_name?: string;
  supervisor_name?: string;
  daily_logs_required?: boolean;
  weekly_summary_required?: boolean;
  signoff_required?: boolean;
}

export interface OrbitDailyLog {
  id: string;
  user_id: string;
  log_date: string;
  participation_mode: DayParticipationMode;
  stream_id?: string | null;
  department_id?: string | null;
  submission_id?: string | null;
  title: string;
  work_done: string;
  learned?: string;
  tools_used?: string;
  challenges?: string;
  next_steps?: string;
  hours_spent?: number | null;
  evidence_links: string[];
  attachment_url?: string;
  status: DailyLogStatus;
  submitted_at?: string;
  reviewed_by?: string | null;
  reviewed_at?: string;
  supervisor_comment?: string;
  created_at: string;
  updated_at: string;
  /** joined fields from RPCs */
  stream_name?: string;
  department_name?: string;
  reviewer_name?: string;
}

export interface OrbitWeeklySummary {
  id: string;
  user_id: string;
  week_start: string;
  week_end: string;
  goals?: string;
  summary?: string;
  key_learnings?: string;
  daily_log_ids: string[];
  supervisor_comment?: string;
  status: WeeklySummaryStatus;
  submitted_at?: string;
  signed_off_by?: string | null;
  signed_off_at?: string;
  created_at: string;
  updated_at: string;
  /** joined field from RPCs */
  signed_off_by_name?: string;
}

export interface OrbitAttendanceRecord {
  id: string;
  user_id: string;
  attendance_date: string;
  expected_mode: DayParticipationMode;
  check_in_time?: string | null;
  check_out_time?: string | null;
  department_id?: string | null;
  activity_summary?: string;
  verified_by?: string | null;
  status: AttendanceStatus;
  created_at: string;
  updated_at: string;
  /** joined fields from RPCs */
  department_name?: string;
  verified_by_name?: string;
}

export interface OrbitSupervisorNote {
  id: string;
  user_id: string;
  author_id: string;
  note: string;
  created_at: string;
  updated_at: string;
  /** joined field from RPCs */
  author_name?: string;
}

export interface OrbitLogbookExport {
  id: string;
  user_id: string;
  exported_by?: string;
  export_type: LogbookExportType;
  date_from?: string;
  date_to?: string;
  created_at: string;
}

/** Compact SIWES status returned by orbit_siwes_my_status */
export interface SiwesMyStatus {
  user_id: string;
  /** 'siwes' | 'internship' | 'nysc' | 'volunteer', or null on older accounts. */
  programme_type?: string | null;
  /** True only for programmes that actually keep a logbook. */
  carries_logbook: boolean;
  cohort_name: string;
  cohort_status: CohortStatus;
  participation_mode: ParticipationMode;
  status: InternProfileStatus;
  department_name?: string | null;
  supervisor_name?: string | null;
  physical_day?: number | null;
  logs_this_week: number;
  approved_logs: number;
  pending_changes: number;
  signed_off_weeks: number;
  last_log_date?: string | null;
}

/** Review dashboard payload returned by orbit_siwes_review_queue */
export interface SiwesReviewQueue {
  interns: SiwesReviewIntern[];
  pending_daily_logs: SiwesPendingDailyLog[];
  pending_weekly_summaries: SiwesPendingWeeklySummary[];
  missing_logs: SiwesMissingLogs[];
  attendance_exceptions: SiwesAttendanceException[];
}

export interface SiwesReviewIntern {
  id: string;
  user_id: string;
  cohort_id: string;
  participation_mode: ParticipationMode;
  status: InternProfileStatus;
  department_id?: string | null;
  iih_supervisor_id?: string | null;
  full_name: string;
  email: string;
  profile_photo_url?: string;
  cohort_name: string;
  department_name?: string | null;
  programme_type?: string | null;
  /** False for programmes with no logbook — the counts below are then null. */
  carries_logbook?: boolean;
  /** null means "keeps no logbook", which is not the same as zero. */
  approved_logs: number | null;
  pending_logs: number | null;
  signed_off_weeks: number | null;
}

export interface SiwesPendingDailyLog {
  id: string;
  user_id: string;
  log_date: string;
  title: string;
  participation_mode: DayParticipationMode;
  hours_spent?: number | null;
  submitted_at?: string;
  status: DailyLogStatus;
  full_name: string;
  profile_photo_url?: string;
}

export interface SiwesPendingWeeklySummary {
  id: string;
  user_id: string;
  week_start: string;
  week_end: string;
  submitted_at?: string;
  status: WeeklySummaryStatus;
  full_name: string;
  profile_photo_url?: string;
}

export interface SiwesMissingLogs {
  user_id: string;
  full_name: string;
  profile_photo_url?: string;
  missing_days: number;
}

export interface SiwesAttendanceException {
  id: string;
  user_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  expected_mode: DayParticipationMode;
  full_name: string;
  profile_photo_url?: string;
}

/** Logbook export payload returned by orbit_siwes_export_logbook */
export interface SiwesLogbookExportData {
  profile: OrbitInternProfile & {
    full_name: string;
    email: string;
    cohort_start: string;
    cohort_end: string;
  };
  daily_logs: OrbitDailyLog[];
  weekly_summaries: OrbitWeeklySummary[];
  attendance: OrbitAttendanceRecord[];
  generated_at: string;
}

/** Per-intern compliance row returned by orbit_siwes_cohort_compliance */
export interface SiwesComplianceRow {
  user_id: string;
  status: InternProfileStatus;
  participation_mode: ParticipationMode;
  full_name: string;
  email: string;
  department_name?: string | null;
  supervisor_name?: string | null;
  programme_type?: string | null;
  /** False for programmes with no logbook — the counts below are then null. */
  carries_logbook?: boolean;
  /** null means "keeps no logbook", which is not the same as zero. */
  total_logs: number | null;
  approved_logs: number | null;
  signed_off_weeks: number | null;
  days_present: number;
  days_absent: number;
  last_log_date?: string | null;
}
