import { useState, useEffect, useCallback } from 'react';
import { BookOpen, ChevronDown, ChevronUp, PenLine } from 'lucide-react';
import toast from 'react-hot-toast';
import { logbookApi } from '../lib/api/logbook';
import { internProfilesApi } from '../lib/api/internProfiles';
import { OrbitInternProfile, OrbitDailyLog, SiwesLogbookExportData } from '../types/database';
import { formatDate } from '../lib/utils/date';
import { SkeletonCard } from '../components/common/SkeletonLoader';
import { EmptyState } from '../components/common/EmptyState';
import { DailyLogForm } from '../components/logbook/DailyLogForm';
import { WeeklySummaryComposer } from '../components/logbook/WeeklySummaryComposer';
import { AttendanceCard } from '../components/logbook/AttendanceCard';
import { LogbookPrintView } from '../components/logbook/LogbookPrintView';
import { todayLocalISO, localISODate } from '../lib/utils/date';

type Tab = 'today' | 'history' | 'weekly' | 'attendance' | 'export';

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'history', label: 'History' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'export', label: 'Export' },
];

function statusPillClass(status: string): string {
  switch (status) {
    case 'draft':
      return 'bg-slate-100 text-slate-700';
    case 'submitted':
      return 'bg-amber-100 text-amber-700';
    case 'changes_requested':
      return 'bg-red-100 text-red-700';
    case 'approved':
      return 'bg-green-100 text-green-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function getTodayString(): string {
  // Local calendar date, not the UTC instant — see todayLocalISO.
  return todayLocalISO();
}

function getNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // Same UTC-vs-local hazard as getTodayString: this bounds the log window, so
  // an off-by-one here drops or duplicates a day at the edge.
  return localISODate(d);
}

interface HistoryLogCardProps {
  log: OrbitDailyLog;
  profile: OrbitInternProfile;
  onSaved: () => void;
}

function HistoryLogCard({ log, profile, onSaved }: HistoryLogCardProps) {
  const [expanded, setExpanded] = useState(false);

  const canEdit = log.status === 'draft' || log.status === 'changes_requested';

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-800">
              {formatDate(log.log_date)}
            </span>
            {log.title && (
              <span className="text-sm text-slate-600 truncate">{log.title}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${statusPillClass(log.status)}`}
            >
              {log.status.replace('_', ' ')}
            </span>
            {log.hours_spent != null && (
              <span className="text-xs text-slate-500">{log.hours_spent}h</span>
            )}
            {log.supervisor_comment && (
              <span className="text-xs text-amber-600 italic truncate">
                "{log.supervisor_comment}"
              </span>
            )}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-slate-100 p-4">
          {canEdit ? (
            <DailyLogForm
              profile={profile}
              log={log}
              defaultDate={log.log_date}
              onSaved={() => {
                setExpanded(false);
                onSaved();
              }}
            />
          ) : (
            <div className="space-y-3 text-sm text-slate-700">
              {log.work_done && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase mb-0.5">Work done</p>
                  <p className="whitespace-pre-wrap">{log.work_done}</p>
                </div>
              )}
              {log.learned && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase mb-0.5">Learned</p>
                  <p className="whitespace-pre-wrap">{log.learned}</p>
                </div>
              )}
              {log.tools_used && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase mb-0.5">Tools used</p>
                  <p>{log.tools_used}</p>
                </div>
              )}
              {log.challenges && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase mb-0.5">Challenges</p>
                  <p>{log.challenges}</p>
                </div>
              )}
              {log.next_steps && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase mb-0.5">Next steps</p>
                  <p>{log.next_steps}</p>
                </div>
              )}
              {log.reviewer_name && (
                <p className="text-xs text-slate-400">Reviewed by {log.reviewer_name}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ExportTabProps {
  profile: OrbitInternProfile;
}

function ExportTab({ profile }: ExportTabProps) {
  const defaultFrom = profile.siwes_start_date ?? getNDaysAgo(90);
  const defaultTo = getTodayString();

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [generating, setGenerating] = useState(false);
  const [exportData, setExportData] = useState<SiwesLogbookExportData | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const data = await logbookApi.exportLogbook(profile.id, from, to, 'print');
      setExportData(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setGenerating(false);
    }
  }

  if (exportData) {
    return (
      <LogbookPrintView
        data={exportData}
        onClose={() => setExportData(null)}
      />
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200 max-w-md">
      <h3 className="font-semibold text-slate-800 mb-4">Export logbook</h3>
      <div className="space-y-4">
        <div>
          <label htmlFor="logbook-export-from" className="block text-sm font-medium text-slate-700 mb-1">From</label>
          <input
            id="logbook-export-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
          />
        </div>
        <div>
          <label htmlFor="logbook-export-to" className="block text-sm font-medium text-slate-700 mb-1">To</label>
          <input
            id="logbook-export-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
          />
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {generating ? 'Generating...' : 'Generate print view'}
        </button>
      </div>
    </div>
  );
}

export function LogbookPage() {
  const [profile, setProfile] = useState<OrbitInternProfile | null | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<Tab>('today');

  const [todayLog, setTodayLog] = useState<OrbitDailyLog | null | undefined>(undefined);
  const [historyLogs, setHistoryLogs] = useState<OrbitDailyLog[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const today = getTodayString();

  useEffect(() => {
    internProfilesApi
      .getMyProfile()
      .then((p) => setProfile(p))
      .catch(() => setProfile(null));
  }, []);

  const loadTodayLog = useCallback(async (internUserId: string) => {
    try {
      const logs = await logbookApi.getDailyLogs(internUserId, today, today);
      setTodayLog(logs[0] ?? null);
    } catch {
      setTodayLog(null);
    }
  }, [today]);

  const loadHistory = useCallback(async (internUserId: string) => {
    setLoadingHistory(true);
    try {
      const logs = await logbookApi.getDailyLogs(internUserId);
      setHistoryLogs(logs);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (!profile) return;
    loadTodayLog(profile.id);
  }, [profile, loadTodayLog]);

  useEffect(() => {
    if (!profile || activeTab !== 'history') return;
    loadHistory(profile.id);
  }, [profile, activeTab, loadHistory]);

  if (profile === undefined) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <SkeletonCard />
      </div>
    );
  }

  if (profile === null) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <EmptyState
          illustration={<BookOpen className="h-7 w-7" />}
          title="No internship profile yet"
          description="Your programme profile has not been set up yet. Please contact your programme admin."
        />
      </div>
    );
  }

  const showAttendanceTab =
    profile.participation_mode === 'hybrid' || profile.participation_mode === 'physical';

  /**
   * The logbook proper — daily entries, weekly summaries, the exportable
   * document — belongs to SIWES.
   *
   * ATTENDANCE DOES NOT, which is why this is a per-tab decision rather than a
   * hidden page. A volunteer who comes to the Hub on Mondays still checks in
   * and still needs to see their own record; taking the whole section away
   * would remove that. So a non-SIWES member keeps Attendance and loses the
   * four tabs that exist to satisfy an Industrial Liaison Unit.
   */
  const showLogbookTabs = Boolean(profile.carries_logbook);

  /**
   * The tab actually shown, which is not always the one in state.
   *
   * `today` is the initial value, so hiding the tab BUTTONS alone left a
   * non-SIWES member on the daily-log form with no way to navigate away from
   * it — the control was gone and the thing it controlled was still rendered.
   * Anyone without logbook duties is put on Attendance instead, which is the
   * only section that means anything to them.
   */
  const effectiveTab: Tab = showLogbookTabs ? activeTab : 'attendance';

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <BookOpen className="w-8 h-8 text-iih-green" />
            Logbook
          </h1>
          {profile.cohort_name && (
            <p className="text-slate-600 mt-1">{profile.cohort_name}</p>
          )}
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-slate-200 mb-6 overflow-x-auto">
          <div className="flex">
            {TABS.filter((tab) => (tab.id === 'attendance' ? showAttendanceTab : showLogbookTabs)).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-5 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
                  effectiveTab === tab.id
                    ? 'text-iih-green border-b-2 border-iih-green'
                    : 'text-slate-600 hover:text-slate-800 border-b-2 border-transparent'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          {effectiveTab === 'today' && (
            <div>
              <p className="text-sm text-slate-500 mb-4">{formatDate(today)}</p>
              {todayLog === undefined ? (
                <SkeletonCard />
              ) : (
                <DailyLogForm
                  profile={profile}
                  log={todayLog}
                  defaultDate={today}
                  onSaved={() => loadTodayLog(profile.id)}
                />
              )}
            </div>
          )}

          {effectiveTab === 'history' && (
            <div className="space-y-3">
              {loadingHistory ? (
                <SkeletonCard />
              ) : historyLogs.length === 0 ? (
                <EmptyState
                  illustration={<PenLine className="h-7 w-7" />}
                  title="No logs yet"
                  description="Your daily logs will appear here once you start writing them."
                />
              ) : (
                historyLogs.map((log) => (
                  <HistoryLogCard
                    key={log.id}
                    log={log}
                    profile={profile}
                    onSaved={() => loadHistory(profile.id)}
                  />
                ))
              )}
            </div>
          )}

          {effectiveTab === 'weekly' && (
            <WeeklySummaryComposer
              profile={profile}
              onSaved={() => {}}
            />
          )}

          {effectiveTab === 'attendance' && (
            showAttendanceTab ? (
              <AttendanceCard profile={profile} />
            ) : (
              <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200 text-sm text-slate-600">
                Attendance tracking applies to hybrid and physical interns only.
              </div>
            )
          )}

          {effectiveTab === 'export' && (
            <ExportTab profile={profile} />
          )}
        </div>
      </div>
    </div>
  );
}
