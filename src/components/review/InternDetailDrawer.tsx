import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Loader2, Info, Calendar, ClipboardList, NotebookTabs, StickyNote } from 'lucide-react';
import toast from 'react-hot-toast';
import { SiwesReviewIntern, OrbitDailyLog, OrbitWeeklySummary, OrbitAttendanceRecord, OrbitSupervisorNote, DailyLogStatus, WeeklySummaryStatus, AttendanceStatus } from '../../types/database';
import { logbookApi } from '../../lib/api/logbook';
import { attendanceApi } from '../../lib/api/attendance';
import { siwesReviewApi } from '../../lib/api/siwesReview';
import { formatDate } from '../../lib/utils/date';
import { DailyLogDetail } from './DailyLogDetail';
import { ReviewActionModal } from './ReviewActionModal';
import { EmptyState } from '../common/EmptyState';
import { SkeletonList } from '../common/SkeletonLoader';

type DrawerTab = 'logs' | 'weekly' | 'attendance' | 'notes';

interface InternDetailDrawerProps {
  intern: SiwesReviewIntern;
  onClose: () => void;
  onChanged: () => void;
}

// ── Status pill helpers ────────────────────────────────────────────────────────

function dailyLogStatusPill(status: DailyLogStatus) {
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

function Avatar({ name, photoUrl, size = 'md' }: { name: string; photoUrl?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'w-16 h-16 text-xl' : size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className={`${sizeClass} rounded-full object-cover flex-shrink-0`} />;
  }
  return (
    <div className={`${sizeClass} rounded-full bg-iih-green flex items-center justify-center flex-shrink-0`}>
      <span className="font-semibold text-white">{name.charAt(0).toUpperCase()}</span>
    </div>
  );
}

// ── Logs tab ──────────────────────────────────────────────────────────────────

interface LogsTabProps {
  internId: string;
  onChanged: () => void;
}

type DailyLogReviewModal = { log: OrbitDailyLog; action: 'approve' | 'request_changes' | 'reopen' };

function LogsTab({ internId, onChanged }: LogsTabProps) {
  const [logs, setLogs] = useState<OrbitDailyLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewModal, setReviewModal] = useState<DailyLogReviewModal | null>(null);

  /**
   * Which fetch is allowed to write state.
   *
   * Switching the drawer to another intern re-renders this tab with a new
   * internId rather than remounting it, so the old load is never cancelled —
   * and resolving last it painted one intern's logs under another intern's
   * name and email, in the surface whose whole job is attribution. The same
   * guard SubmissionReviewPage and EmailLogsPage carry.
   */
  const currentRequest = useRef(0);

  const loadLogs = useCallback(async () => {
    const request = ++currentRequest.current;
    setLoading(true);
    try {
      const data = await logbookApi.getDailyLogs(internId);
      if (request !== currentRequest.current) return;
      setLogs(data);
    } catch (err) {
      if (request !== currentRequest.current) return;
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (request === currentRequest.current) setLoading(false);
    }
  }, [internId]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  async function handleReview(comment: string) {
    if (!reviewModal) return;
    await siwesReviewApi.reviewDailyLog(reviewModal.log.id, reviewModal.action, comment || undefined);
    await loadLogs();
    onChanged();
  }

  if (loading) return <SkeletonList count={3} />;
  if (logs.length === 0) return <EmptyState illustration={<NotebookTabs className="h-7 w-7" />} title="No logs yet" description="This intern has not submitted any daily logs." />;

  return (
    <>
      <div className="space-y-3">
        {logs.map((log) => {
          const isExpanded = expandedId === log.id;
          return (
            <div key={log.id} className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-slate-800 truncate">{log.title}</span>
                  <span className="text-xs text-slate-500 whitespace-nowrap">{formatDate(log.log_date)}</span>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ml-3 whitespace-nowrap ${dailyLogStatusPill(log.status)}`}>
                  {log.status.replace('_', ' ')}
                </span>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-slate-100">
                  <div className="pt-4">
                    <DailyLogDetail log={log} />
                  </div>

                  {log.status === 'submitted' && (
                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => setReviewModal({ log, action: 'approve' })}
                        className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => setReviewModal({ log, action: 'request_changes' })}
                        className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
                      >
                        Request changes
                      </button>
                    </div>
                  )}

                  {log.status === 'approved' && (
                    <div className="mt-4">
                      <button
                        onClick={() => setReviewModal({ log, action: 'reopen' })}
                        className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg font-medium transition-colors text-xs"
                      >
                        Reopen
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {reviewModal && (
        <ReviewActionModal
          title={
            reviewModal.action === 'approve'
              ? 'Approve daily log'
              : reviewModal.action === 'reopen'
              ? 'Reopen daily log'
              : 'Request changes'
          }
          actionLabel={
            reviewModal.action === 'approve'
              ? 'Approve'
              : reviewModal.action === 'reopen'
              ? 'Reopen'
              : 'Request changes'
          }
          requireComment={reviewModal.action === 'request_changes'}
          onConfirm={handleReview}
          onClose={() => setReviewModal(null)}
        />
      )}
    </>
  );
}

// ── Weekly tab ────────────────────────────────────────────────────────────────

interface WeeklyTabProps {
  internId: string;
  onChanged: () => void;
}

type WeeklyReviewModal = { summary: OrbitWeeklySummary; action: 'sign_off' | 'request_changes' };

function WeeklyTab({ internId, onChanged }: WeeklyTabProps) {
  const [summaries, setSummaries] = useState<OrbitWeeklySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewModal, setReviewModal] = useState<WeeklyReviewModal | null>(null);

  // Same stale-response guard as LogsTab — see the comment there.
  const currentRequest = useRef(0);

  const loadSummaries = useCallback(async () => {
    const request = ++currentRequest.current;
    setLoading(true);
    try {
      const data = await logbookApi.getWeeklySummaries(internId);
      if (request !== currentRequest.current) return;
      setSummaries(data);
    } catch (err) {
      if (request !== currentRequest.current) return;
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (request === currentRequest.current) setLoading(false);
    }
  }, [internId]);

  useEffect(() => { loadSummaries(); }, [loadSummaries]);

  async function handleReview(comment: string) {
    if (!reviewModal) return;
    await siwesReviewApi.reviewWeeklySummary(reviewModal.summary.id, reviewModal.action, comment || undefined);
    await loadSummaries();
    onChanged();
  }

  if (loading) return <SkeletonList count={3} />;
  if (summaries.length === 0) return <EmptyState illustration={<Calendar className="h-7 w-7" />} title="No weekly summaries" description="This intern has not submitted any weekly summaries." />;

  return (
    <>
      <div className="space-y-3">
        {summaries.map((s) => {
          const isExpanded = expandedId === s.id;
          return (
            <div key={s.id} className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : s.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-slate-800 whitespace-nowrap">
                    {formatDate(s.week_start)} – {formatDate(s.week_end)}
                  </span>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ml-3 whitespace-nowrap ${weeklyStatusPill(s.status)}`}>
                  {s.status.replace('_', ' ')}
                </span>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-slate-100 pt-4 space-y-3">
                  {s.goals && (
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Goals</p>
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{s.goals}</p>
                    </div>
                  )}
                  {s.summary && (
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Summary</p>
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{s.summary}</p>
                    </div>
                  )}
                  {s.key_learnings && (
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Key learnings</p>
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{s.key_learnings}</p>
                    </div>
                  )}
                  {s.supervisor_comment && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
                      <span className="font-semibold">Supervisor note: </span>{s.supervisor_comment}
                    </div>
                  )}

                  {s.status === 'submitted' && (
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => setReviewModal({ summary: s, action: 'sign_off' })}
                        className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
                      >
                        Sign off
                      </button>
                      <button
                        onClick={() => setReviewModal({ summary: s, action: 'request_changes' })}
                        className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
                      >
                        Request changes
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {reviewModal && (
        <ReviewActionModal
          title={reviewModal.action === 'sign_off' ? 'Sign off weekly summary' : 'Request changes'}
          actionLabel={reviewModal.action === 'sign_off' ? 'Sign off' : 'Request changes'}
          requireComment={reviewModal.action === 'request_changes'}
          onConfirm={handleReview}
          onClose={() => setReviewModal(null)}
        />
      )}
    </>
  );
}

// ── Attendance tab ────────────────────────────────────────────────────────────

interface AttendanceTabProps {
  internId: string;
}

function AttendanceTab({ internId }: AttendanceTabProps) {
  const [records, setRecords] = useState<OrbitAttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);

  // Same stale-response guard as LogsTab — see the comment there. Here it
  // also protects a write: the Excused/Present buttons act on the rows shown,
  // so a stale list would let a supervisor mark the WRONG intern's day.
  const currentRequest = useRef(0);

  const loadRecords = useCallback(async () => {
    const request = ++currentRequest.current;
    setLoading(true);
    try {
      const data = await attendanceApi.getAttendance(internId);
      if (request !== currentRequest.current) return;
      setRecords(data);
    } catch (err) {
      if (request !== currentRequest.current) return;
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (request === currentRequest.current) setLoading(false);
    }
  }, [internId]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  async function markStatus(record: OrbitAttendanceRecord, status: AttendanceStatus) {
    setMarkingId(record.id);
    try {
      await attendanceApi.recordAttendance({
        user_id: internId,
        attendance_date: record.attendance_date,
        status,
      });
      await loadRecords();
      toast.success('Attendance updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setMarkingId(null);
    }
  }

  if (loading) return <SkeletonList count={3} />;
  if (records.length === 0) return <EmptyState illustration={<ClipboardList className="h-7 w-7" />} title="No attendance records" description="No attendance records found for this intern." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-slate-200">
            <th className="pb-2 text-xs font-semibold text-slate-500 pr-4">Date</th>
            <th className="pb-2 text-xs font-semibold text-slate-500 pr-4">Status</th>
            <th className="pb-2 text-xs font-semibold text-slate-500 pr-4">Mode</th>
            <th className="pb-2 text-xs font-semibold text-slate-500">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {records.map((rec) => {
            const isMarking = markingId === rec.id;
            const canMark = rec.status === 'absent' || rec.status === 'expected';
            return (
              <tr key={rec.id}>
                <td className="py-2.5 pr-4 text-slate-700 whitespace-nowrap">{formatDate(rec.attendance_date)}</td>
                <td className="py-2.5 pr-4">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${attendanceStatusPill(rec.status)}`}>
                    {rec.status.replace('_', ' ')}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-slate-600 capitalize">{rec.expected_mode}</td>
                <td className="py-2.5">
                  {isMarking ? (
                    <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                  ) : canMark ? (
                    <div className="flex gap-1 flex-wrap">
                      <button
                        onClick={() => markStatus(rec, 'excused')}
                        className="text-xs bg-blue-100 hover:bg-blue-200 text-blue-800 px-2 py-1 rounded font-medium transition-colors"
                      >
                        Excused
                      </button>
                      <button
                        onClick={() => markStatus(rec, 'present')}
                        className="text-xs bg-green-100 hover:bg-green-200 text-green-800 px-2 py-1 rounded font-medium transition-colors"
                      >
                        Present
                      </button>
                      <button
                        onClick={() => markStatus(rec, 'remote_makeup')}
                        className="text-xs bg-purple-100 hover:bg-purple-200 text-purple-800 px-2 py-1 rounded font-medium transition-colors"
                      >
                        Remote
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Notes tab ─────────────────────────────────────────────────────────────────

interface NotesTabProps {
  internId: string;
}

function NotesTab({ internId }: NotesTabProps) {
  const [notes, setNotes] = useState<OrbitSupervisorNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);

  // Same stale-response guard as LogsTab — see the comment there. These are
  // private supervisor notes, so a stale list shows one intern's private
  // assessment under another intern's header.
  const currentRequest = useRef(0);

  const loadNotes = useCallback(async () => {
    const request = ++currentRequest.current;
    setLoading(true);
    try {
      const data = await siwesReviewApi.getSupervisorNotes(internId);
      if (request !== currentRequest.current) return;
      setNotes(data);
    } catch (err) {
      if (request !== currentRequest.current) return;
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (request === currentRequest.current) setLoading(false);
    }
  }, [internId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  async function handleAddNote() {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      await siwesReviewApi.addSupervisorNote(internId, noteText.trim());
      setNoteText('');
      await loadNotes();
      toast.success('Note added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-2 items-start">
        <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-800">Private notes are only visible to supervisors and admins. Interns never see these.</p>
      </div>

      <div>
        <textarea
          className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
          rows={3}
          placeholder="Add a private note about this intern..."
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          disabled={saving}
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={handleAddNote}
            disabled={saving || !noteText.trim()}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Add private note
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonList count={2} />
      ) : notes.length === 0 ? (
        <EmptyState illustration={<StickyNote className="h-7 w-7" />} title="No notes yet" description="Notes you add here are private and never shown to the intern." />
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <div key={note.id} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-slate-700">{note.author_name ?? 'Supervisor'}</span>
                <span className="text-xs text-slate-400">{formatDate(note.created_at)}</span>
              </div>
              <p className="text-sm text-slate-800 whitespace-pre-wrap">{note.note}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────

export function InternDetailDrawer({ intern, onClose, onChanged }: InternDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('logs');

  const tabs: { key: DrawerTab; label: string }[] = [
    { key: 'logs', label: 'Logs' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'attendance', label: 'Attendance' },
    { key: 'notes', label: 'Private notes' },
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-4 p-6 border-b border-slate-200 flex-shrink-0">
          <Avatar name={intern.full_name} photoUrl={intern.profile_photo_url} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-slate-800">{intern.full_name}</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${modePill(intern.participation_mode)}`}>
                {intern.participation_mode}
              </span>
            </div>
            <p className="text-sm text-slate-500 truncate">{intern.email}</p>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <span className="text-xs text-slate-600">{intern.cohort_name}</span>
              {intern.department_name && (
                <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{intern.department_name}</span>
              )}
              <span className="text-xs text-green-700 font-medium">{intern.approved_logs} approved</span>
              <span className="text-xs text-amber-700 font-medium">{intern.pending_logs} pending</span>
              <span className="text-xs text-slate-600">{intern.signed_off_weeks} signed-off weeks</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 flex-shrink-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                activeTab === tab.key
                  ? 'border-iih-green text-iih-green'
                  : 'border-transparent text-slate-600 hover:text-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'logs' && <LogsTab internId={intern.id} onChanged={onChanged} />}
          {activeTab === 'weekly' && <WeeklyTab internId={intern.id} onChanged={onChanged} />}
          {activeTab === 'attendance' && <AttendanceTab internId={intern.id} />}
          {activeTab === 'notes' && <NotesTab internId={intern.id} />}
        </div>
      </div>
    </div>
  );
}
