import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { CheckCircle, AlertCircle, Wand2, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { logbookApi } from '../../lib/api/logbook';
import { OrbitInternProfile, OrbitDailyLog, OrbitWeeklySummary } from '../../types/database';
import { formatDate } from '../../lib/utils/date';

interface WeeklySummaryComposerProps {
  profile: OrbitInternProfile;
  onSaved: () => void;
}

interface WeekRange {
  label: string;
  weekStart: string;
  weekEnd: string;
}

function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The LOCAL calendar date, not the UTC instant.
 *
 * `getMondayOfWeek` returns local midnight on Monday; `toISOString()` converts
 * that instant to UTC, and in WAT (UTC+1 — every browser on this programme)
 * local Monday 00:00 is Sunday 23:00 UTC, so slicing the ISO string produced
 * the SUNDAY date. That was the week label sent to `saveWeeklySummary` and the
 * key this component matches its own saved summary on, while every server-side
 * lookup keys on the UTC Monday — so summaries were filed under a week nothing
 * else ever looked at. The server now re-anchors what it receives
 * (`normalizeWeekStart`), and this makes the client agree rather than relying
 * on that correction.
 */
function toISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function buildWeekRanges(): WeekRange[] {
  const ranges: WeekRange[] = [];
  const thisMonday = getMondayOfWeek(new Date());

  for (let i = 0; i <= 8; i++) {
    const monday = new Date(thisMonday);
    monday.setDate(monday.getDate() - i * 7);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);

    const weekStart = toISODate(monday);
    const weekEnd = toISODate(sunday);
    const year = sunday.getFullYear();
    const label = `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)} ${year}`;
    ranges.push({ label, weekStart, weekEnd });
  }
  return ranges;
}

const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function weekdayLogs(logs: OrbitDailyLog[], weekStart: string): Record<string, OrbitDailyLog | undefined> {
  const map: Record<string, OrbitDailyLog | undefined> = {};
  const monday = new Date(weekStart);

  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = toISODate(d);
    map[WEEK_DAYS[i]] = logs.find((l) => l.log_date === dateStr);
  }
  return map;
}

function statusPillClass(status: string): string {
  switch (status) {
    case 'draft':
      return 'bg-slate-100 text-slate-700';
    case 'submitted':
      return 'bg-amber-100 text-amber-700';
    case 'changes_requested':
      return 'bg-red-100 text-red-700';
    case 'signed_off':
      return 'bg-green-100 text-green-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

export function WeeklySummaryComposer({ profile, onSaved }: WeeklySummaryComposerProps) {
  const weekRanges = buildWeekRanges();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [weekLogs, setWeekLogs] = useState<OrbitDailyLog[]>([]);
  const [allSummaries, setAllSummaries] = useState<OrbitWeeklySummary[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [saving, setSaving] = useState(false);

  const [goals, setGoals] = useState('');
  const [summary, setSummary] = useState('');
  const [keyLearnings, setKeyLearnings] = useState('');

  const selectedRange = weekRanges[selectedIndex];

  const existingSummary = allSummaries.find(
    (s) => s.week_start === selectedRange.weekStart
  ) ?? null;

  const isLocked =
    existingSummary?.status === 'submitted' ||
    existingSummary?.status === 'signed_off';

  /**
   * Which week's load is allowed to fill the editor.
   *
   * Flipping the week selector starts a new fetch without cancelling the old
   * one. When the earlier week's response landed last it populated the editor
   * with THAT week's text while the header showed the newly selected week —
   * and `handleSave` writes whatever is in the boxes under
   * `selectedRange.weekStart`, so pressing "Save draft" filed one week's
   * reflection as another week's, overwriting it.
   */
  const currentLoad = useRef(0);

  const loadData = useCallback(async () => {
    const request = ++currentLoad.current;
    setLoadingLogs(true);
    try {
      const [logs, summaries] = await Promise.all([
        logbookApi.getDailyLogs(profile.id, selectedRange.weekStart, selectedRange.weekEnd),
        logbookApi.getWeeklySummaries(profile.id),
      ]);
      if (request !== currentLoad.current) return;

      setWeekLogs(logs);
      setAllSummaries(summaries);

      const existing = summaries.find((s) => s.week_start === selectedRange.weekStart);
      if (existing) {
        setGoals(existing.goals ?? '');
        setSummary(existing.summary ?? '');
        setKeyLearnings(existing.key_learnings ?? '');
      } else {
        setGoals('');
        setSummary('');
        setKeyLearnings('');
      }
    } catch (err) {
      if (request === currentLoad.current) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
      }
    } finally {
      if (request === currentLoad.current) setLoadingLogs(false);
    }
  }, [profile.id, selectedRange.weekStart, selectedRange.weekEnd]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function autoFill() {
    const submittedOrApproved = weekLogs.filter(
      (l) => l.status === 'submitted' || l.status === 'approved'
    );

    const workLines = submittedOrApproved
      .map((l) => `- ${l.title}: ${l.work_done}`)
      .join('\n');

    const learnedLines = submittedOrApproved
      .filter((l) => l.learned)
      .map((l) => `- ${l.learned}`)
      .join('\n');

    setSummary(workLines || summary);
    setKeyLearnings(learnedLines || keyLearnings);
  }

  async function handleSave(submitStatus: 'draft' | 'submitted') {
    const submittableLogIds = weekLogs
      .filter((l) => l.status === 'submitted' || l.status === 'approved')
      .map((l) => l.id);

    const dayMap = weekdayLogs(weekLogs, selectedRange.weekStart);
    const missingDays = WEEK_DAYS.filter((day) => {
      const log = dayMap[day];
      return !log || (log.status !== 'submitted' && log.status !== 'approved');
    });

    if (submitStatus === 'submitted' && missingDays.length > 0) {
      const ok = window.confirm(
        `You have missing or unsubmitted logs for: ${missingDays.join(', ')}. Submit anyway?`
      );
      if (!ok) return;
    }

    setSaving(true);
    try {
      await logbookApi.saveWeeklySummary({
        id: existingSummary?.id,
        user_id: profile.id,
        week_start: selectedRange.weekStart,
        week_end: selectedRange.weekEnd,
        goals: goals || undefined,
        summary: summary || undefined,
        key_learnings: keyLearnings || undefined,
        daily_log_ids: submittableLogIds,
        status: submitStatus,
      });
      toast.success(
        submitStatus === 'submitted' ? 'Weekly summary submitted for sign-off.' : 'Draft saved.'
      );
      onSaved();
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  const dayMap = weekdayLogs(weekLogs, selectedRange.weekStart);
  const fid = useId();

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
        <div className="flex flex-col md:flex-row md:items-center gap-4 mb-6">
          <div className="flex-1">
            <label htmlFor={`${fid}-week`} className="block text-sm font-medium text-slate-700 mb-1">
              Select week
            </label>
            <select
              id={`${fid}-week`}
              value={selectedIndex}
              onChange={(e) => setSelectedIndex(Number(e.target.value))}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            >
              {weekRanges.map((range, i) => (
                <option key={range.weekStart} value={i}>
                  {range.label}
                  {i === 0 ? ' (This week)' : ''}
                </option>
              ))}
            </select>
          </div>

          {existingSummary && (
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold self-end md:self-auto ${statusPillClass(existingSummary.status)}`}
            >
              {existingSummary.status.replace('_', ' ')}
            </span>
          )}
        </div>

        <div className="mb-4">
          <p className="text-xs font-medium text-slate-600 uppercase tracking-wide mb-2">
            Weekday log checklist
          </p>
          <div className="flex flex-wrap gap-2">
            {WEEK_DAYS.map((day) => {
              const log = dayMap[day];
              const ok = log?.status === 'submitted' || log?.status === 'approved';
              return (
                <div
                  key={day}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                    ok
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-600 border border-red-200'
                  }`}
                >
                  {ok ? (
                    <CheckCircle className="w-3.5 h-3.5" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5" />
                  )}
                  {day}
                </div>
              );
            })}
          </div>
        </div>

        {isLocked ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-slate-500 mb-2">
              <Lock className="w-4 h-4" />
              <span>This summary is locked.</span>
            </div>
            {existingSummary?.supervisor_comment && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-700">
                <p className="font-medium mb-1">Supervisor note</p>
                <p>{existingSummary.supervisor_comment}</p>
              </div>
            )}
            {goals && (
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase mb-1">Goals</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{goals}</p>
              </div>
            )}
            {summary && (
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase mb-1">Summary of work done</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{summary}</p>
              </div>
            )}
            {keyLearnings && (
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase mb-1">Key learning outcomes</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{keyLearnings}</p>
              </div>
            )}
            {existingSummary?.signed_off_by_name && (
              <p className="text-xs text-slate-500">
                Signed off by {existingSummary.signed_off_by_name}
                {existingSummary.signed_off_at
                  ? ` on ${formatDate(existingSummary.signed_off_at)}`
                  : ''}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {!loadingLogs && (
              <button
                onClick={autoFill}
                className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors text-sm"
              >
                <Wand2 className="w-4 h-4" />
                Auto-fill from daily logs
              </button>
            )}

            <div>
              <label htmlFor={`${fid}-goals`} className="block text-sm font-medium text-slate-700 mb-1">Goals for the week</label>
              <textarea
                id={`${fid}-goals`}
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
                rows={3}
                placeholder="What did you set out to achieve this week?"
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
              />
            </div>

            <div>
              <label htmlFor={`${fid}-summary`} className="block text-sm font-medium text-slate-700 mb-1">Summary of work done</label>
              <textarea
                id={`${fid}-summary`}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={5}
                placeholder="Summarise the work completed this week..."
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
              />
            </div>

            <div>
              <label htmlFor={`${fid}-learnings`} className="block text-sm font-medium text-slate-700 mb-1">Key learning outcomes</label>
              <textarea
                id={`${fid}-learnings`}
                value={keyLearnings}
                onChange={(e) => setKeyLearnings(e.target.value)}
                rows={3}
                placeholder="What were your main takeaways?"
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => handleSave('draft')}
                disabled={saving || loadingLogs}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                Save draft
              </button>
              <button
                onClick={() => handleSave('submitted')}
                disabled={saving || loadingLogs}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                Submit for sign-off
              </button>
            </div>
          </div>
        )}
      </div>

      {allSummaries.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
            Past summaries
          </h3>
          {allSummaries.map((s) => (
            <div
              key={s.id}
              className="bg-white rounded-lg shadow-sm p-4 border border-slate-200 flex items-center justify-between gap-4"
            >
              <div>
                <p className="text-sm font-medium text-slate-800">
                  {formatDate(s.week_start)} – {formatDate(s.week_end)}
                </p>
                {s.summary && (
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{s.summary}</p>
                )}
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold flex-shrink-0 ${statusPillClass(s.status)}`}
              >
                {s.status.replace('_', ' ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
