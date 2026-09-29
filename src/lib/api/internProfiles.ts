import { callSiwesRpc } from './siwesRpc';
import {
  OrbitInternProfile,
  InternProfileStatus,
  ParticipationMode,
  SiwesComplianceRow,
  OrbitCohort,
} from '../../types/database';

export interface SaveInternProfileData {
  id?: string;
  user_id?: string;
  cohort_id?: string;
  participation_mode?: ParticipationMode;
  /** 'siwes' | 'internship' | 'nysc' | 'volunteer'. Admin only, server-side. */
  programme_type?: string;
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
  physical_day?: number | null;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  status?: InternProfileStatus;
}

export interface CohortComplianceReport {
  cohort: OrbitCohort;
  interns: SiwesComplianceRow[];
}

export const internProfilesApi = {
  /** The signed-in user's own SIWES profile (active cohort preferred), or null. */
  async getMyProfile(): Promise<OrbitInternProfile | null> {
    return callSiwesRpc<OrbitInternProfile | null>('orbit_siwes_get_my_profile');
  },

  /** Profiles visible to the caller (admin: all, supervisor/lead: assigned). */
  async getInternProfiles(cohortId?: string): Promise<OrbitInternProfile[]> {
    return callSiwesRpc<OrbitInternProfile[]>('orbit_siwes_list_intern_profiles', {
      p_cohort_id: cohortId ?? null,
    });
  },

  /**
   * Create (admin) or update a profile. Admins can change everything;
   * interns can update their own institution/emergency-contact fields.
   */
  async saveInternProfile(profile: SaveInternProfileData): Promise<OrbitInternProfile> {
    return callSiwesRpc<OrbitInternProfile>('orbit_siwes_save_intern_profile', {
      p_profile: profile,
    });
  },

  /** Per-intern logbook/attendance compliance for a cohort. Admin only. */
  async getCohortCompliance(cohortId: string): Promise<CohortComplianceReport> {
    return callSiwesRpc<CohortComplianceReport>('orbit_siwes_cohort_compliance', {
      p_cohort_id: cohortId,
    });
  },
};
