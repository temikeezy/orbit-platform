import { programmeLabel } from '../../convex/lib/programme';
import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Calendar, AlertTriangle, UserCheck, Loader2, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  SiwesReviewQueue,
  SiwesReviewIntern,
  SiwesPendingDailyLog,
  SiwesPendingWeeklySummary,
  SiwesMissingLogs,
  SiwesAttendanceException,
  OrbitDailyLog,
  OrbitWeeklySummary,
  DailyLogStatus,
  WeeklySummaryStatus,
  AttendanceStatus,
} from '../types/database';
import { siwesReviewApi } from '../lib/api/siwesReview';
import { logbookApi } from '../lib/api/logbook';
import { attendanceApi } from '../lib/api/attendance';
import { formatDate, formatDistanceToNow } from '../lib/utils/date';
import { EmptyState } from '../components/common/EmptyState';
import { SkeletonStats } from '../components/common/SkeletonLoader';
import { DailyLogDetail } from '../components/review/DailyLogDetail';
import { ReviewActionModal } from '../components/review/ReviewActionModal';
import { InternDetailDrawer } from '../components/review/InternDetailDrawer';
import { SearchBox } from '../components/admin/SearchBox';

// ── Status pill helpers ────────────────────────────────────────────────────────

function dailyStatusPill(status: DailyLogStatus) {
  const map: Record<DailyLogStatus, string> = {
    draft: 'bg-slate-100 text-slate-700',
    submitted: 'bg-amber-100 text-amber-800',
    changes_requested: 'bg-red-100 text-red-800',
    approved: 'bg-green-100 text-green-800',
  };
  return map[status] ?? 'bg-slate-100 text-slate-700';
}

function weeklyStatusPill(status: WeeklySummaryStatus) {
  const map: Record<WeeklySummaryStatus, string> = {
    draft: 'bg-slate-100 text-slate-700',
    submitted: 'bg-amber-100 text-amber-800',
    changes_requested: 'bg-red-100 text-red-800',
    signed_off: 'bg-green-100 text-green-800',
  };
  return map[status] ?? 'bg-slate-100 text-slate-700';
}

function attendanceStatusPill(status: AttendanceStatus) {
  const map: Record<AttendanceStatus, string> = {
    // A supervisor-confirmed day. Absent from this map the badge rendered
    // with className undefined — the one status meaning \"resolved\" looked broken.
    verified: 'bg-emerald-100 text-emerald-800',
    expected: 'bg-amber-100 text-amber-800',
    present: 'bg-green-100 text-green-800',
    absent: 'bg-red-100 text-red-800',
    excused: 'bg-blue-100 text-blue-800',
    remote_makeup: 'bg-purple-100 text-purple-800',
  };
  return map[status] ?? 'bg-slate-100 text-slate-700';
}

function modePill(mode: string) {
  return mode === 'physical'
    ? 'bg-green-100 text-green-800'
    : mode === 'hybrid'
    ? 'bg-purple-100 text-purple-800'
    : 'bg-blue-100 text-blue-800';
}

// ── Avatar ─────────────────────────────────────────────────────────────────────

function Avatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className="w-10 h-10 rounded-full object-cover flex-shrink-0" />;
  }
  return (
    <div className="w-10 h-10 rounded-full bg-iih-green flex items-center justify-center flex-shrink-0">
      <span className="text-sm font-semibold text-white">{name.charAt(0).toUpperCase()}</span>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  accentClass: string;
}

function StatCard({ label, value, icon, accentClass }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${accentClass}`}>
        {icon}
      </div>
      <div>
        <div className="text-2xl font-bold text-slate-800">{value}</div>
        <div className="text-sm text-slate-600">{label}</div>
      </div>
    </div>
  );
}

// ── Daily log review modal ─────────────────────────────────────────────────────

interface DailyLogReviewState {
  log: OrbitDailyLog;
  pendingRow: SiwesPendingDailyLog;
  action: 'approve' | 'request_changes';
}

interface PendingLogsTabProps {
  rows: SiwesPendingDailyLog[];
  onRefresh: () => void;
}

function PendingLogsTab({ rows, onRefresh, search }: PendingLogsTabProps & { search: string }) {
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [previewLog, setPreviewLog] = useState<OrbitDailyLog | null>(null);
  const [reviewState, setReviewState] = useState<DailyLogReviewState | null>(null);

  if (rows.length === 0) {
    return <ReviewEmpty search={search} title="All caught up" description="No daily logs are awaiting your review." />;
  }

  async function openLog(row: SiwesPendingDailyLog) {
    setFetchingId(row.id);
    try {
      const logs = await logbookApi.getDailyLogs(row.user_id, row.log_date, row.log_date);
      const log = logs[0];
      if (!log) throw new Error('Log not found');
      setPreviewLog(log);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setFetchingId(null);
    }
  }

  async function handleReview(comment: string) {
    if (!reviewState) return;
    await siwesReviewApi.reviewDailyLog(reviewState.log.id, reviewState.action, comment || undefined);
    setPreviewLog(null);
    setReviewState(null);
    onRefresh();
  }

  return (
    <>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar name={row.full_name} photoUrl={row.profile_photo_url} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{row.full_name}</p>
                <p className="text-xs text-slate-500">{formatDate(row.log_date)} &mdash; {row.title}</p>
                {row.submitted_at && (
                  <p className="text-xs text-slate-400">
                    {formatDistanceToNow(new Date(row.submitted_at))}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${dailyStatusPill(row.status)}`}>
                {row.status.replace('_', ' ')}
              </span>
              <button
                onClick={() => openLog(row)}
                disabled={fetchingId === row.id}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-3 py-1.5 rounded-lg font-medium transition-colors text-sm disabled:opacity-50 flex items-center gap-1"
              >
                {fetchingId === row.id && <Loader2 className="w-3 h-3 animate-spin" />}
                Review
              </button>
            </div>
          </div>
        ))}
      </div>

      {previewLog && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-log-preview-title"
        >
          <div className="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 id="daily-log-preview-title" className="text-lg font-semibold text-slate-800 mb-4">Daily log</h2>
            <DailyLogDetail log={previewLog} />
            <div className="flex gap-2 mt-6">
              <button
                onClick={() => {
                  // Matched on the log's own id. It used to compare
                  // user_id, which `toDailyLog` deliberately blanks to
                  // '' because listDailyLogs does not return it — so the find
                  // never matched, `matchRow` was always undefined, and both of
                  // these buttons did nothing at all: no modal, no error.
                  const matchRow = rows.find((r) => r.id === previewLog.id);
                  if (matchRow) setReviewState({ log: previewLog, pendingRow: matchRow, action: 'approve' });
                }}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                Approve
              </button>
              <button
                onClick={() => {
                  // Matched on the log's own id. It used to compare
                  // user_id, which `toDailyLog` deliberately blanks to
                  // '' because listDailyLogs does not return it — so the find
                  // never matched, `matchRow` was always undefined, and both of
                  // these buttons did nothing at all: no modal, no error.
                  const matchRow = rows.find((r) => r.id === previewLog.id);
                  if (matchRow) setReviewState({ log: previewLog, pendingRow: matchRow, action: 'request_changes' });
                }}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                Request changes
              </button>
              <button
                onClick={() => setPreviewLog(null)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewState && (
        <ReviewActionModal
          title={reviewState.action === 'approve' ? 'Approve daily log' : 'Request changes'}
          actionLabel={reviewState.action === 'approve' ? 'Approve' : 'Request changes'}
          requireComment={reviewState.action === 'request_changes'}
          onConfirm={handleReview}
          onClose={() => setReviewState(null)}
        />
      )}
    </>
  );
}

// ── Weekly sign-off tab ────────────────────────────────────────────────────────

interface WeeklySignOffTabProps {
  rows: SiwesPendingWeeklySummary[];
  onRefresh: () => void;
}

type WeeklyReviewState = { summary: OrbitWeeklySummary; action: 'sign_off' | 'request_changes' };

function WeeklySignOffTab({ rows, onRefresh, search }: WeeklySignOffTabProps & { search: string }) {
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [previewSummary, setPreviewSummary] = useState<OrbitWeeklySummary | null>(null);
  const [reviewState, setReviewState] = useState<WeeklyReviewState | null>(null);

  if (rows.length === 0) {
    return <ReviewEmpty search={search} title="All caught up" description="No weekly summaries are awaiting sign-off." />;
  }

  async function openSummary(row: SiwesPendingWeeklySummary) {
    setFetchingId(row.id);
    try {
      const summaries = await logbookApi.getWeeklySummaries(row.user_id);
      const found = summaries.find((s) => s.id === row.id);
      if (!found) throw new Error('Summary not found');
      setPreviewSummary(found);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setFetchingId(null);
    }
  }

  async function handleReview(comment: string) {
    if (!reviewState) return;
    await siwesReviewApi.reviewWeeklySummary(reviewState.summary.id, reviewState.action, comment || undefined);
    setPreviewSummary(null);
    setReviewState(null);
    onRefresh();
  }

  return (
    <>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar name={row.full_name} photoUrl={row.profile_photo_url} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{row.full_name}</p>
                <p className="text-xs text-slate-500">
                  {formatDate(row.week_start)} – {formatDate(row.week_end)}
                </p>
                {row.submitted_at && (
                  <p className="text-xs text-slate-400">{formatDistanceToNow(new Date(row.submitted_at))}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${weeklyStatusPill(row.status)}`}>
                {row.status.replace('_', ' ')}
              </span>
              <button
                onClick={() => openSummary(row)}
                disabled={fetchingId === row.id}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-3 py-1.5 rounded-lg font-medium transition-colors text-sm disabled:opacity-50 flex items-center gap-1"
              >
                {fetchingId === row.id && <Loader2 className="w-3 h-3 animate-spin" />}
                Review
              </button>
            </div>
          </div>
        ))}
      </div>

      {previewSummary && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="weekly-summary-preview-title"
        >
          <div className="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 id="weekly-summary-preview-title" className="text-lg font-semibold text-slate-800 mb-1">Weekly summary</h2>
            <p className="text-sm text-slate-500 mb-4">
              {formatDate(previewSummary.week_start)} – {formatDate(previewSummary.week_end)}
            </p>
            <div className="space-y-4">
              {previewSummary.goals && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Goals</p>
                  <p className="text-sm text-slate-800 whitespace-pre-wrap">{previewSummary.goals}</p>
                </div>
              )}
              {previewSummary.summary && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Summary</p>
                  <p className="text-sm text-slate-800 whitespace-pre-wrap">{previewSummary.summary}</p>
                </div>
              )}
              {previewSummary.key_learnings && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Key learnings</p>
                  <p className="text-sm text-slate-800 whitespace-pre-wrap">{previewSummary.key_learnings}</p>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setReviewState({ summary: previewSummary, action: 'sign_off' })}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                Sign off
              </button>
              <button
                onClick={() => setReviewState({ summary: previewSummary, action: 'request_changes' })}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                Request changes
              </button>
              <button
                onClick={() => setPreviewSummary(null)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewState && (
        <ReviewActionModal
          title={reviewState.action === 'sign_off' ? 'Sign off weekly summary' : 'Request changes'}
          actionLabel={reviewState.action === 'sign_off' ? 'Sign off' : 'Request changes'}
          requireComment={reviewState.action === 'request_changes'}
          onConfirm={handleReview}
          onClose={() => setReviewState(null)}
        />
      )}
    </>
  );
}

// ── My interns tab ─────────────────────────────────────────────────────────────

interface MyInternsTabProps {
  interns: SiwesReviewIntern[];
  onRefresh: () => void;
}

function MyInternsTab({ interns, onRefresh, search }: MyInternsTabProps & { search: string }) {
  const [selectedIntern, setSelectedIntern] = useState<SiwesReviewIntern | null>(null);

  if (interns.length === 0) {
    // Same distinction as the other tabs: "you have no interns" is a different
    // statement from "none of your interns match that name".
    return (
      <ReviewEmpty
        search={search}
        title="No interns assigned"
        description="You have no interns assigned to you yet."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {interns.map((intern) => (
          <button
            key={intern.id}
            onClick={() => setSelectedIntern(intern)}
            className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 text-left hover:shadow-md transition-shadow"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-full flex-shrink-0 overflow-hidden">
                {intern.profile_photo_url ? (
                  <img src={intern.profile_photo_url} alt={intern.full_name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-iih-green flex items-center justify-center">
                    <span className="text-lg font-semibold text-white">{intern.full_name.charAt(0).toUpperCase()}</span>
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-slate-800 truncate">{intern.full_name}</p>
                <p className="text-xs text-slate-500 truncate">{intern.email}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-3">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${modePill(intern.participation_mode)}`}>
                {intern.participation_mode}
              </span>
              <span className="rounded-full px-2 py-0.5 text-xs bg-slate-100 text-slate-600">
                {intern.cohort_name}
              </span>
              {intern.department_name && (
                <span className="rounded-full px-2 py-0.5 text-xs bg-slate-100 text-slate-600">
                  {intern.department_name}
                </span>
              )}
            </div>

            {/* Logbook figures, for the people who keep one. A volunteer shown
                three zeroes reads as someone who has stopped writing rather
                than someone who was never asked to. */}
            {intern.carries_logbook === false ? (
              <p className="text-xs text-slate-500">
                {programmeLabel(intern.programme_type)} — keeps no logbook
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-bold text-green-700">{intern.approved_logs ?? 0}</p>
                  <p className="text-xs text-slate-500">Approved</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-amber-600">{intern.pending_logs ?? 0}</p>
                  <p className="text-xs text-slate-500">Pending</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-slate-700">{intern.signed_off_weeks ?? 0}</p>
                  <p className="text-xs text-slate-500">Weeks</p>
                </div>
              </div>
            )}
          </button>
        ))}
      </div>

      {selectedIntern && (
        <InternDetailDrawer
          intern={selectedIntern}
          onClose={() => setSelectedIntern(null)}
          onChanged={() => { onRefresh(); }}
        />
      )}
    </>
  );
}

// ── Missing logs tab ───────────────────────────────────────────────────────────

function MissingLogsTab({ rows, search }: { rows: SiwesMissingLogs[]; search: string }) {
  if (rows.length === 0) {
    return <ReviewEmpty search={search} title="All caught up" description="No interns are missing logs this week." />;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.user_id} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden">
            {row.profile_photo_url ? (
              <img src={row.profile_photo_url} alt={row.full_name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-iih-green flex items-center justify-center">
                <span className="text-sm font-semibold text-white">{row.full_name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{row.full_name}</p>
            <p className="text-xs text-slate-500">
              {row.missing_days} weekday log{row.missing_days !== 1 ? 's' : ''} missing this week
            </p>
          </div>
          <span className="rounded-full px-3 py-1 text-xs font-semibold bg-red-100 text-red-800 flex-shrink-0">
            {row.missing_days} missing
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Attendance exceptions tab ──────────────────────────────────────────────────

function AttendanceExceptionsTab({ rows, onRefresh, search }: { rows: SiwesAttendanceException[]; onRefresh: () => void; search: string }) {
  const [markingId, setMarkingId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <ReviewEmpty search={search} title="All caught up" description="No attendance exceptions to review." />;
  }

  async function markStatus(row: SiwesAttendanceException, status: AttendanceStatus) {
    setMarkingId(row.id);
    try {
      await attendanceApi.recordAttendance({
        user_id: row.user_id,
        attendance_date: row.attendance_date,
        status,
      });
      toast.success('Attendance updated');
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setMarkingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.id} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden">
              {row.profile_photo_url ? (
                <img src={row.profile_photo_url} alt={row.full_name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-iih-green flex items-center justify-center">
                  <span className="text-sm font-semibold text-white">{row.full_name.charAt(0).toUpperCase()}</span>
                </div>
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">{row.full_name}</p>
              <p className="text-xs text-slate-500">{formatDate(row.attendance_date)}</p>
            </div>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${attendanceStatusPill(row.status)}`}>
            {row.status.replace('_', ' ')}
          </span>
          {(row.status === 'absent' || row.status === 'expected') && (
            <div className="flex gap-1.5 flex-shrink-0">
              {markingId === row.id ? (
                <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
              ) : (
                <>
                  <button
                    onClick={() => markStatus(row, 'excused')}
                    className="text-xs bg-blue-100 hover:bg-blue-200 text-blue-800 px-3 py-1.5 rounded-lg font-medium transition-colors"
                  >
                    Mark excused
                  </button>
                  <button
                    onClick={() => markStatus(row, 'present')}
                    className="text-xs bg-green-100 hover:bg-green-200 text-green-800 px-3 py-1.5 rounded-lg font-medium transition-colors"
                  >
                    Mark present
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Page tabs ──────────────────────────────────────────────────────────────────

type PageTab = 'pending' | 'signoffs' | 'interns' | 'missing' | 'attendance';

// ── Main page ──────────────────────────────────────────────────────────────────

/**
 * Filters any of this page's row shapes by the person's name.
 *
 * They come from five different queries and spell the name two different ways,
 * so this reads whichever is present rather than making each tab remember.
 */
function byName<T extends { full_name?: string | null; fullName?: string | null }>(
  rows: T[],
  search: string,
): T[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => (r.full_name ?? r.fullName ?? '').toLowerCase().includes(needle));
}

/**
 * The empty state for a review list, which depends on WHY it is empty.
 *
 * "All caught up" beside a tab badge reading 12 is simply false, and that is
 * what a filtered-to-nothing list used to say: the badges count the unfiltered
 * queue while the lists render the filtered one. A search that matches nobody
 * is not an empty queue.
 */
function ReviewEmpty({ search, title, description }: { search: string; title: string; description: string }) {
  if (search.trim()) {
    return (
      <EmptyState
        illustration={<UserCheck className="h-7 w-7" />}
        title={`Nothing matches "${search.trim()}"`}
        description="Clear the search to see everything still waiting on you."
      />
    );
  }
  return <EmptyState illustration={<UserCheck className="h-7 w-7" />} title={title} description={description} />;
}

export function ReviewDashboardPage() {
  const [queue, setQueue] = useState<SiwesReviewQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [activeTab, setActiveTab] = useState<PageTab>('pending');
  const [search, setSearch] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setAccessDenied(false);
    try {
      const data = await siwesReviewApi.getReviewQueue();
      setQueue(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      if (message.toLowerCase().includes('reviewer access required')) {
        setAccessDenied(true);
      } else {
        toast.error(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const tabs: { key: PageTab; label: string }[] = [
    { key: 'pending', label: 'Pending logs' },
    { key: 'signoffs', label: 'Sign-offs' },
    { key: 'interns', label: 'My interns' },
    { key: 'missing', label: 'Missing logs' },
    { key: 'attendance', label: 'Attendance' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <div className="h-8 bg-slate-200 rounded w-48 mb-2 animate-pulse" />
            <div className="h-4 bg-slate-200 rounded w-72 animate-pulse" />
          </div>
          <SkeletonStats />
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-orbit-canvas">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <EmptyState
            illustration={<Lock className="h-7 w-7" />}
            title="Supervisor access required"
            description="This page is for supervisors and admins only. Contact your administrator if you believe you should have access."
          />
        </div>
      </div>
    );
  }

  if (!queue) return null;

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800">Review Dashboard</h1>
          <p className="text-slate-600 mt-1">Monitor intern progress, review submissions, and manage attendance.</p>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <StatCard
            label="Pending daily logs"
            value={queue.pending_daily_logs.length}
            icon={<ClipboardList className="w-6 h-6 text-white" />}
            accentClass="bg-amber-500"
          />
          <StatCard
            label="Summaries awaiting sign-off"
            value={queue.pending_weekly_summaries.length}
            icon={<Calendar className="w-6 h-6 text-white" />}
            accentClass="bg-blue-500"
          />
          <StatCard
            label="Missing logs this week"
            value={queue.missing_logs.length}
            icon={<AlertTriangle className="w-6 h-6 text-white" />}
            accentClass="bg-red-500"
          />
          <StatCard
            label="Attendance exceptions"
            value={queue.attendance_exceptions.length}
            icon={<UserCheck className="w-6 h-6 text-white" />}
            accentClass="bg-purple-500"
          />
        </div>

        {/* Tab bar */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 mb-6 overflow-x-auto">
          <div className="flex">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-4 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                  activeTab === tab.key
                    ? 'border-iih-green text-iih-green'
                    : 'border-transparent text-slate-600 hover:text-slate-800'
                }`}
              >
                {tab.label}
                {tab.key === 'pending' && queue.pending_daily_logs.length > 0 && (
                  <span className="ml-1.5 bg-amber-100 text-amber-800 text-xs rounded-full px-2 py-0.5 font-semibold">
                    {queue.pending_daily_logs.length}
                  </span>
                )}
                {tab.key === 'signoffs' && queue.pending_weekly_summaries.length > 0 && (
                  <span className="ml-1.5 bg-blue-100 text-blue-800 text-xs rounded-full px-2 py-0.5 font-semibold">
                    {queue.pending_weekly_summaries.length}
                  </span>
                )}
                {tab.key === 'missing' && queue.missing_logs.length > 0 && (
                  <span className="ml-1.5 bg-red-100 text-red-800 text-xs rounded-full px-2 py-0.5 font-semibold">
                    {queue.missing_logs.length}
                  </span>
                )}
                {tab.key === 'attendance' && queue.attendance_exceptions.length > 0 && (
                  <span className="ml-1.5 bg-purple-100 text-purple-800 text-xs rounded-full px-2 py-0.5 font-semibold">
                    {queue.attendance_exceptions.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* One box across every tab. A supervisor looking for a person does not
            think in tabs — they think of the name, and want it found wherever
            it is. Each list filters on the same term. */}
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search by intern name…"
          className="mb-4 max-w-lg"
        />

        {/* Tab content */}
        <div>
          {activeTab === 'pending' && (
            <PendingLogsTab rows={byName(queue.pending_daily_logs, search)} onRefresh={loadQueue} search={search} />
          )}
          {activeTab === 'signoffs' && (
            <WeeklySignOffTab
              rows={byName(queue.pending_weekly_summaries, search)}
              onRefresh={loadQueue}
              search={search}
            />
          )}
          {activeTab === 'interns' && (
            <MyInternsTab interns={byName(queue.interns, search)} onRefresh={loadQueue} search={search} />
          )}
          {activeTab === 'missing' && <MissingLogsTab rows={byName(queue.missing_logs, search)} search={search} />}
          {activeTab === 'attendance' && (
            <AttendanceExceptionsTab
              rows={byName(queue.attendance_exceptions, search)}
              onRefresh={loadQueue}
              search={search}
            />
          )}
        </div>
      </div>
    </div>
  );
}
