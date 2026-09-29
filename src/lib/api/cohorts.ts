import { callSiwesRpc } from './siwesRpc';
import { OrbitCohort, CohortStatus, ParticipationMode } from '../../types/database';

export interface SaveCohortData {
  id?: string;
  name?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  status?: CohortStatus;
  default_participation_mode?: ParticipationMode;
  default_physical_day?: number | null;
  daily_logs_required?: boolean;
  weekly_summary_required?: boolean;
  daily_log_days?: number[];
  weekly_summary_due_day?: number;
  signoff_due_day?: number;
  physical_attendance_required?: boolean;
  signoff_required?: boolean;
}

export const cohortsApi = {
  /** Admins see all cohorts; interns see cohorts they belong to. */
  async getCohorts(): Promise<OrbitCohort[]> {
    return callSiwesRpc<OrbitCohort[]>('orbit_siwes_list_cohorts');
  },

  /** Create (no id) or update (with id) a cohort. Admin only. */
  async saveCohort(cohort: SaveCohortData): Promise<OrbitCohort> {
    return callSiwesRpc<OrbitCohort>('orbit_siwes_save_cohort', {
      p_cohort: cohort,
    });
  },
};
