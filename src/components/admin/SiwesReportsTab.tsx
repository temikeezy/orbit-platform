import { useState, useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { Download, BarChart3, GraduationCap } from 'lucide-react';
import { internProfilesApi, CohortComplianceReport } from '../../lib/api/internProfiles';
import { OrbitCohort, SiwesComplianceRow, ParticipationMode } from '../../types/database';
import { programmeLabel } from '../../../convex/lib/programme';
import { formatDate } from '../../lib/utils/date';
import { SkeletonList } from '../common/SkeletonLoader';
import { EmptyState } from '../common/EmptyState';

interface SiwesReportsTabProps {
  cohorts: OrbitCohort[];
}

function ModeLabel({ mode }: { mode: ParticipationMode }) {
  const map: Record<ParticipationMode, string> = {
    virtual: 'Virtual',
    hybrid: 'Hybrid',
    physical: 'Physical',
  };
  return <span className="text-sm text-slate-700">{map[mode]}</span>;
}

function escapeCSVCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadCSV(rows: SiwesComplianceRow[], cohortName: string) {
  const headers = [
    'Name',
    'Email',
    'Mode',
    'Programme',
    'Department',
    'Supervisor',
    'Status',
    'Total Logs',
    'Approved Logs',
    'Signed-off Weeks',
    'Days Present',
    'Days Absent',
    'Last Log Date',
  ];

  const csvLines = [
    headers.map(escapeCSVCell).join(','),
    ...rows.map((r) =>
      [
        r.full_name,
        r.email,
        r.participation_mode,
        programmeLabel(r.programme_type),
        r.department_name ?? '',
        r.supervisor_name ?? '',
        r.status,
        r.total_logs ?? '',
        r.approved_logs ?? '',
        r.signed_off_weeks ?? '',
        r.days_present,
        r.days_absent,
        r.last_log_date ?? '',
      ]
        .map(escapeCSVCell)
        .join(',')
    ),
  ];

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `siwes-compliance-${cohortName.replace(/\s+/g, '-').toLowerCase()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SiwesReportsTab({ cohorts }: SiwesReportsTabProps) {
  const [selectedCohortId, setSelectedCohortId] = useState('');
  const [report, setReport] = useState<CohortComplianceReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const loadReport = useCallback(async (cohortId: string) => {
    if (!cohortId) return;
    setLoadingReport(true);
    setReport(null);
    try {
      const data = await internProfilesApi.getCohortCompliance(cohortId);
      setReport(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoadingReport(false);
    }
  }, []);

  const handleCohortChange = (id: string) => {
    setSelectedCohortId(id);
    if (id) {
      loadReport(id);
    } else {
      setReport(null);
    }
  };

  const rows = report?.interns ?? [];
  // Summed over people who actually keep a logbook. Counting a volunteer's
  // absent figures as zero drags every average down and makes a compliant
  // cohort look like a failing one.
  const totalLogs = rows.reduce((s, r) => s + (r.total_logs ?? 0), 0);
  const totalApproved = rows.reduce((s, r) => s + (r.approved_logs ?? 0), 0);
  const totalSignedOff = rows.reduce((s, r) => s + (r.signed_off_weeks ?? 0), 0);
  const selectedCohort = cohorts.find((c) => c.id === selectedCohortId);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <h2 className="text-lg font-semibold text-slate-800">Compliance Reports</h2>
        {/* "Send Reminders Now" removed. It called orbit_siwes_send_reminders,
            which the dispatcher has no mapping for, so every press produced a
            raw "No Convex mapping" error toast. Reminders are a daily cron
            (scheduled.sendSiwesReminders, 16:00 UTC) — a button that fires them
            manually is not needed and was never reliable. */}
        <p className="text-sm text-slate-500">Reminders are sent automatically each weekday.</p>
      </div>

      <div className="flex items-center gap-3">
        <label htmlFor="siwes-report-cohort" className="text-sm font-medium text-slate-700 whitespace-nowrap">
          Select cohort:
        </label>
        <select
          id="siwes-report-cohort"
          value={selectedCohortId}
          onChange={(e) => handleCohortChange(e.target.value)}
          className="px-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-iih-green focus:border-transparent"
        >
          <option value="">— choose a cohort —</option>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {!selectedCohortId && (
        <EmptyState
          illustration={<BarChart3 className="h-7 w-7" />}
          title="Select a cohort"
          description="Choose a cohort above to view the compliance report."
        />
      )}

      {selectedCohortId && loadingReport && <SkeletonList count={4} />}

      {selectedCohortId && !loadingReport && report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'Total Interns', value: rows.length },
              { label: 'Total Logs', value: totalLogs },
              { label: 'Approved Logs', value: totalApproved },
              { label: 'Signed-off Weeks', value: totalSignedOff },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-white rounded-lg shadow-sm p-6 border border-slate-200"
              >
                <p className="text-2xl font-bold text-slate-800">{value}</p>
                <p className="text-sm text-slate-500 mt-1">{label}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">{rows.length} intern(s)</p>
            {rows.length > 0 && (
              <button
                onClick={() => downloadCSV(rows, selectedCohort?.name ?? 'cohort')}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download CSV
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <EmptyState
              illustration={<GraduationCap className="h-7 w-7" />}
              title="No interns in this cohort"
              description="Assign interns to this cohort to see compliance data."
            />
          ) : (
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    {[
                      'Intern',
                      'Mode',
                      'Programme',
                      'Total Logs',
                      'Approved',
                      'Signed-off Wks',
                      'Present',
                      'Absent',
                      'Last Log',
                    ].map((h) => (
                      <th
                        key={h}
                        className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-200">
                  {rows.map((r) => (
                    <tr key={r.user_id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <p className="text-sm font-semibold text-slate-800">{r.full_name}</p>
                        <p className="text-xs text-slate-400">{r.email}</p>
                      </td>
                      <td className="px-6 py-4">
                        <ModeLabel mode={r.participation_mode} />
                      </td>
                      {/* Names the reason for the dashes in this row. */}
                      <td className="px-6 py-4 text-sm text-slate-700">
                        {programmeLabel(r.programme_type)}
                      </td>
                      {/* An em dash, not a zero: this person keeps no logbook,
                          which is not the same as keeping an empty one. */}
                      <td className="px-6 py-4 text-sm text-slate-700">{r.total_logs ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-slate-700">{r.approved_logs ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-slate-700">{r.signed_off_weeks ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-slate-700">{r.days_present}</td>
                      <td className="px-6 py-4 text-sm text-slate-700">{r.days_absent}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {r.last_log_date ? formatDate(r.last_log_date) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
