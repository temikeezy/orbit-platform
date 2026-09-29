import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import { SiwesLogbookExportData } from '../../types/database';
import { formatDate } from '../../lib/utils/date';

interface LogbookPrintViewProps {
  data: SiwesLogbookExportData;
  onClose: () => void;
}

function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * The printable logbook.
 *
 * Portalled to <body>, and marking the body while it is open, for the same
 * reason the acceptance letter is: a `position: fixed` overlay rendered inside
 * the app tree looks right on screen and prints wrong. The browser lays the
 * fixed layer onto the first page and then prints the whole application beneath
 * it, so an export came out as page one of the logbook followed by the logbook
 * PAGE — nav, sidebar and all. Hiding #root is the only reliable way to print a
 * document from inside an SPA; see the `@media print` block in index.css.
 */
export function LogbookPrintView({ data, onClose }: LogbookPrintViewProps) {
  const { profile, daily_logs, weekly_summaries, attendance } = data;

  useEffect(() => {
    document.body.classList.add('orbit-printing');
    return () => document.body.classList.remove('orbit-printing');
  }, []);

  return createPortal(
    <div className="orbit-print-root fixed inset-0 bg-white z-50 overflow-y-auto">
      <div className="print:hidden sticky top-0 bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between gap-4">
        <span className="font-semibold text-slate-800">Logbook Export Preview</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <X className="w-4 h-4" />
            Close
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-8 py-10 text-sm text-black">
        <div className="text-center mb-8 border-b border-slate-300 pb-6">
          <h1 className="text-2xl font-bold mb-1">SIWES Logbook</h1>
          <h2 className="text-lg font-semibold">{profile.full_name}</h2>
          {profile.institution_name && (
            <p className="text-slate-600">{profile.institution_name}</p>
          )}
          {profile.course_of_study && (
            <p className="text-slate-600">{profile.course_of_study}</p>
          )}
          {profile.matric_number && (
            <p className="text-slate-500 text-xs">Matric No: {profile.matric_number}</p>
          )}
          <p className="text-slate-600 mt-2">
            Cohort: {profile.cohort_name} &nbsp;|&nbsp;{' '}
            {formatDate(profile.cohort_start)} – {formatDate(profile.cohort_end)}
          </p>
          {profile.supervisor_name && (
            <p className="text-slate-600">Supervisor: {profile.supervisor_name}</p>
          )}
          {profile.department_name && (
            <p className="text-slate-600">Department: {profile.department_name}</p>
          )}
          <p className="text-xs text-slate-400 mt-2">
            Generated {formatDate(data.generated_at)}
          </p>
        </div>

        <section className="mb-10">
          <h3 className="text-base font-bold mb-3 border-b border-slate-300 pb-1">Daily Logs</h3>
          {daily_logs.length === 0 ? (
            <p className="text-slate-400 italic">No daily logs in this range.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-24">Date</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Title</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Work done</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Learned</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-10">Hrs</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-20">Status</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Reviewed by</th>
                </tr>
              </thead>
              <tbody>
                {daily_logs.map((log) => (
                  <tr key={log.id} className="align-top">
                    <td className="border border-slate-300 px-2 py-1.5">{formatDate(log.log_date)}</td>
                    <td className="border border-slate-300 px-2 py-1.5 font-medium">{log.title}</td>
                    <td className="border border-slate-300 px-2 py-1.5 whitespace-pre-wrap">{log.work_done}</td>
                    <td className="border border-slate-300 px-2 py-1.5 whitespace-pre-wrap">{log.learned ?? '—'}</td>
                    <td className="border border-slate-300 px-2 py-1.5 text-center">
                      {log.hours_spent != null ? log.hours_spent : '—'}
                    </td>
                    <td className="border border-slate-300 px-2 py-1.5 capitalize">{log.status.replace('_', ' ')}</td>
                    <td className="border border-slate-300 px-2 py-1.5">{log.reviewer_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="mb-10">
          <h3 className="text-base font-bold mb-3 border-b border-slate-300 pb-1">Weekly Summaries</h3>
          {weekly_summaries.length === 0 ? (
            <p className="text-slate-400 italic">No weekly summaries in this range.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-36">Week</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Summary</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-24">Status</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Signed off by</th>
                </tr>
              </thead>
              <tbody>
                {weekly_summaries.map((ws) => (
                  <tr key={ws.id} className="align-top">
                    <td className="border border-slate-300 px-2 py-1.5">
                      {formatDate(ws.week_start)}<br />
                      <span className="text-slate-400">to {formatDate(ws.week_end)}</span>
                    </td>
                    <td className="border border-slate-300 px-2 py-1.5 whitespace-pre-wrap">{ws.summary ?? '—'}</td>
                    <td className="border border-slate-300 px-2 py-1.5 capitalize">{ws.status.replace('_', ' ')}</td>
                    <td className="border border-slate-300 px-2 py-1.5">{ws.signed_off_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="mb-10">
          <h3 className="text-base font-bold mb-3 border-b border-slate-300 pb-1">Attendance</h3>
          {attendance.length === 0 ? (
            <p className="text-slate-400 italic">No attendance records in this range.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-28">Date</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold w-24">Status</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Check in</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Check out</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Verified by</th>
                </tr>
              </thead>
              <tbody>
                {attendance.map((rec) => (
                  <tr key={rec.id} className="align-top">
                    <td className="border border-slate-300 px-2 py-1.5">{formatDate(rec.attendance_date)}</td>
                    <td className="border border-slate-300 px-2 py-1.5 capitalize">{rec.status.replace('_', ' ')}</td>
                    <td className="border border-slate-300 px-2 py-1.5">{formatTime(rec.check_in_time)}</td>
                    <td className="border border-slate-300 px-2 py-1.5">{formatTime(rec.check_out_time)}</td>
                    <td className="border border-slate-300 px-2 py-1.5">{rec.verified_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
