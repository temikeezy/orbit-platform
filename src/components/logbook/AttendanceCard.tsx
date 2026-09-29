import { useState, useEffect, useCallback } from 'react';
import { LogIn, LogOut, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import { attendanceApi } from '../../lib/api/attendance';
import { OrbitInternProfile, OrbitAttendanceRecord, AttendanceStatus } from '../../types/database';
import { formatDate } from '../../lib/utils/date';
import { SkeletonCard } from '../common/SkeletonLoader';
import { todayLocalISO } from '../../lib/utils/date';

interface AttendanceCardProps {
  profile: OrbitInternProfile;
}

function statusPillClass(status: AttendanceStatus): string {
  switch (status) {
    case 'present':
      return 'bg-green-100 text-green-700';
    case 'absent':
      return 'bg-red-100 text-red-700';
    case 'excused':
      return 'bg-amber-100 text-amber-700';
    case 'remote_makeup':
      return 'bg-blue-100 text-blue-700';
    case 'expected':
      return 'bg-slate-100 text-slate-600';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function AttendanceCard({ profile }: AttendanceCardProps) {
  const today = todayLocalISO();

  const [todayRecord, setTodayRecord] = useState<OrbitAttendanceRecord | null | undefined>(
    undefined
  );
  const [recentRecords, setRecentRecords] = useState<OrbitAttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activitySummary, setActivitySummary] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadAttendance = useCallback(async () => {
    setLoading(true);
    try {
      const [todayArr, recent] = await Promise.all([
        attendanceApi.getAttendance(profile.id, today, today),
        attendanceApi.getAttendance(profile.id),
      ]);
      setTodayRecord(todayArr[0] ?? null);
      setRecentRecords(recent.slice(0, 8));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
      setTodayRecord(null);
    } finally {
      setLoading(false);
    }
  }, [profile.id, today]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  async function handleCheckIn() {
    setSubmitting(true);
    try {
      await attendanceApi.checkInToday(profile.id, profile.department_id ?? null);
      toast.success('Checked in successfully.');
      await loadAttendance();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckOut() {
    setSubmitting(true);
    try {
      await attendanceApi.checkOutToday(profile.id, activitySummary || undefined);
      toast.success('Checked out successfully.');
      setActivitySummary('');
      await loadAttendance();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <SkeletonCard />;
  }

  const checkedIn = Boolean(todayRecord?.check_in_time);
  const checkedOut = Boolean(todayRecord?.check_out_time);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
        <h3 className="font-semibold text-slate-800 mb-4">Today — {formatDate(today)}</h3>

        {!checkedIn && (
          <button
            onClick={handleCheckIn}
            disabled={submitting}
            className="flex items-center gap-2 bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            <LogIn className="w-4 h-4" />
            Check in
          </button>
        )}

        {checkedIn && !checkedOut && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
              <Clock className="w-4 h-4" />
              Checked in at {formatTime(todayRecord?.check_in_time)}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Activity summary (optional)
              </label>
              <textarea
                value={activitySummary}
                onChange={(e) => setActivitySummary(e.target.value)}
                rows={3}
                placeholder="Brief summary of what you did today..."
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
              />
            </div>

            <button
              onClick={handleCheckOut}
              disabled={submitting}
              className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              Check out
            </button>
          </div>
        )}

        {checkedIn && checkedOut && (
          <div className="text-sm text-slate-600 space-y-1">
            <div className="flex items-center gap-2 text-green-700">
              <Clock className="w-4 h-4" />
              In: {formatTime(todayRecord?.check_in_time)} — Out: {formatTime(todayRecord?.check_out_time)}
            </div>
            {todayRecord?.activity_summary && (
              <p className="text-slate-500 text-xs mt-1">{todayRecord.activity_summary}</p>
            )}
          </div>
        )}
      </div>

      {recentRecords.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          <h3 className="font-semibold text-slate-800 mb-4">Recent attendance</h3>
          <div className="space-y-3">
            {recentRecords.map((record) => (
              <div
                key={record.id}
                className="flex items-center justify-between gap-4 py-2 border-b border-slate-100 last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800">{formatDate(record.attendance_date)}</p>
                  <p className="text-xs text-slate-500">
                    {formatTime(record.check_in_time)} — {formatTime(record.check_out_time)}
                    {record.verified_by_name && (
                      <span className="ml-2 text-slate-400">Verified by {record.verified_by_name}</span>
                    )}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold flex-shrink-0 ${statusPillClass(record.status)}`}
                >
                  {record.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
