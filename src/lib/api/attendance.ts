import { callSiwesRpc } from './siwesRpc';
import { todayLocalISO } from '../utils/date';
import {
  OrbitAttendanceRecord,
  AttendanceStatus,
  DayParticipationMode,
} from '../../types/database';

export interface RecordAttendanceData {
  user_id: string;
  attendance_date: string;
  expected_mode?: DayParticipationMode;
  check_in_time?: string;
  check_out_time?: string;
  department_id?: string | null;
  activity_summary?: string;
  /** interns are limited to 'present'/'remote_makeup'; reviewers can set any */
  status?: AttendanceStatus;
}

export const attendanceApi = {
  /** Attendance records for a profile (own by default). */
  async getAttendance(
    userId?: string,
    from?: string,
    to?: string
  ): Promise<OrbitAttendanceRecord[]> {
    return callSiwesRpc<OrbitAttendanceRecord[]>('orbit_siwes_list_attendance', {
      p_user_id: userId ?? null,
      p_from: from ?? null,
      p_to: to ?? null,
    });
  },

  /** Upsert an attendance record (check-in/out or supervisor verification). */
  async recordAttendance(attendance: RecordAttendanceData): Promise<OrbitAttendanceRecord> {
    return callSiwesRpc<OrbitAttendanceRecord>('orbit_siwes_record_attendance', {
      p_attendance: attendance,
    });
  },

  /** Convenience: intern self check-in for today on their own profile. */
  async checkInToday(
    userId: string,
    departmentId?: string | null
  ): Promise<OrbitAttendanceRecord> {
    return this.recordAttendance({
      user_id: userId,
      // The local calendar day, not the UTC slice — between 00:00 and 00:59
      // WAT the UTC date is still yesterday, so a check-in in that hour landed
      // on the previous day's row while the card, reading today, kept showing
      // "not checked in". The check-in/out TIMES stay full UTC instants; only
      // the day being named is local.
      attendance_date: todayLocalISO(),
      expected_mode: 'physical',
      check_in_time: new Date().toISOString(),
      department_id: departmentId ?? null,
      status: 'present',
    });
  },

  /** Convenience: intern self check-out for today. */
  async checkOutToday(
    userId: string,
    activitySummary?: string
  ): Promise<OrbitAttendanceRecord> {
    return this.recordAttendance({
      user_id: userId,
      // Local calendar day for the same reason as checkInToday — the UTC slice
      // would address a check-out in the first hour of the WAT morning to
      // yesterday's row.
      attendance_date: todayLocalISO(),
      check_out_time: new Date().toISOString(),
      activity_summary: activitySummary,
    });
  },
};
