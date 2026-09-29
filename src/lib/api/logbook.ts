import { callSiwesRpc } from './siwesRpc';
import {
  OrbitDailyLog,
  OrbitWeeklySummary,
  DayParticipationMode,
  SiwesMyStatus,
  SiwesLogbookExportData,
  LogbookExportType,
} from '../../types/database';

export interface SaveDailyLogData {
  id?: string;
  user_id?: string;
  log_date?: string;
  participation_mode?: DayParticipationMode;
  stream_id?: string | null;
  department_id?: string | null;
  submission_id?: string | null;
  title?: string;
  work_done?: string;
  learned?: string;
  tools_used?: string;
  challenges?: string;
  next_steps?: string;
  hours_spent?: number | null;
  evidence_links?: string[];
  attachment_url?: string;
  /** interns may only set 'draft' or 'submitted' */
  status?: 'draft' | 'submitted';
}

export interface SaveWeeklySummaryData {
  id?: string;
  user_id?: string;
  week_start?: string;
  week_end?: string;
  goals?: string;
  summary?: string;
  key_learnings?: string;
  daily_log_ids?: string[];
  /** interns may only set 'draft' or 'submitted' */
  status?: 'draft' | 'submitted';
}

export const logbookApi = {
  /** Daily logs for a profile (own by default; reviewers pass a profile id). */
  async getDailyLogs(
    userId?: string,
    from?: string,
    to?: string
  ): Promise<OrbitDailyLog[]> {
    return callSiwesRpc<OrbitDailyLog[]>('orbit_siwes_list_daily_logs', {
      p_user_id: userId ?? null,
      p_from: from ?? null,
      p_to: to ?? null,
    });
  },

  /** Create or update a daily log; set status 'submitted' to send for review. */
  async saveDailyLog(log: SaveDailyLogData): Promise<OrbitDailyLog> {
    return callSiwesRpc<OrbitDailyLog>('orbit_siwes_save_daily_log', {
      p_log: log,
    });
  },

  /** Weekly summaries for a profile (own by default). */
  async getWeeklySummaries(userId?: string): Promise<OrbitWeeklySummary[]> {
    return callSiwesRpc<OrbitWeeklySummary[]>('orbit_siwes_list_weekly_summaries', {
      p_user_id: userId ?? null,
    });
  },

  /** Create or update a weekly summary; 'submitted' sends it for sign-off. */
  async saveWeeklySummary(summary: SaveWeeklySummaryData): Promise<OrbitWeeklySummary> {
    return callSiwesRpc<OrbitWeeklySummary>('orbit_siwes_save_weekly_summary', {
      p_summary: summary,
    });
  },

  /** Compact SIWES status panel for My Orbit; null when no profile exists. */
  async getMyStatus(): Promise<SiwesMyStatus | null> {
    return callSiwesRpc<SiwesMyStatus | null>('orbit_siwes_my_status');
  },

  /**
   * Full logbook payload for export/print. Records an audit row server-side.
   */
  async exportLogbook(
    userId?: string,
    from?: string,
    to?: string,
    exportType: LogbookExportType = 'print'
  ): Promise<SiwesLogbookExportData> {
    return callSiwesRpc<SiwesLogbookExportData>('orbit_siwes_export_logbook', {
      p_user_id: userId ?? null,
      p_from: from ?? null,
      p_to: to ?? null,
      p_export_type: exportType,
    });
  },
};
