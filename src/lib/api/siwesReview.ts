import { callSiwesRpc } from './siwesRpc';
import {
  OrbitDailyLog,
  OrbitWeeklySummary,
  OrbitSupervisorNote,
  SiwesReviewQueue,
} from '../../types/database';

export type DailyLogReviewAction = 'approve' | 'request_changes' | 'reopen';
export type WeeklySummaryReviewAction = 'sign_off' | 'request_changes';

export const siwesReviewApi = {
  /**
   * Everything the supervisor dashboard needs in one call: assigned interns,
   * pending daily logs, summaries awaiting sign-off, missing logs this week,
   * and attendance exceptions.
   */
  async getReviewQueue(): Promise<SiwesReviewQueue> {
    return callSiwesRpc<SiwesReviewQueue>('orbit_siwes_review_queue');
  },

  /** Approve, request changes on, or reopen a daily log. */
  async reviewDailyLog(
    logId: string,
    action: DailyLogReviewAction,
    comment?: string
  ): Promise<OrbitDailyLog> {
    return callSiwesRpc<OrbitDailyLog>('orbit_siwes_review_daily_log', {
      p_log_id: logId,
      p_action: action,
      p_comment: comment ?? null,
    });
  },

  /** Sign off or request changes on a weekly summary. */
  async reviewWeeklySummary(
    summaryId: string,
    action: WeeklySummaryReviewAction,
    comment?: string
  ): Promise<OrbitWeeklySummary> {
    return callSiwesRpc<OrbitWeeklySummary>('orbit_siwes_review_weekly_summary', {
      p_summary_id: summaryId,
      p_action: action,
      p_comment: comment ?? null,
    });
  },

  /** Add a private supervisor note (never visible to interns). */
  async addSupervisorNote(
    userId: string,
    note: string
  ): Promise<OrbitSupervisorNote> {
    return callSiwesRpc<OrbitSupervisorNote>('orbit_siwes_add_supervisor_note', {
      p_user_id: userId,
      p_note: note,
    });
  },

  /** Private supervisor notes for an intern (reviewers/admins only). */
  async getSupervisorNotes(userId: string): Promise<OrbitSupervisorNote[]> {
    return callSiwesRpc<OrbitSupervisorNote[]>('orbit_siwes_list_supervisor_notes', {
      p_user_id: userId,
    });
  },

  /** Queue daily-log and physical-day reminder notifications. Admin only. */
  async sendReminders(): Promise<{ daily_log_reminders: number; physical_day_reminders: number }> {
    return callSiwesRpc('orbit_siwes_send_reminders');
  },
};
