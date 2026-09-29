import { useState, FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { cohortsApi } from '../../lib/api/cohorts';
import { OrbitCohort, CohortStatus, ParticipationMode } from '../../types/database';

/** Sunday = 0, the numbering `physicalDay` and the cadence fields both use. */
const WEEKDAYS = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
];

interface CohortFormModalProps {
  cohort?: OrbitCohort | null;
  onClose: () => void;
  onSaved: () => void;
}

const COHORT_STATUSES: { value: CohortStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

const PARTICIPATION_MODES: { value: ParticipationMode; label: string }[] = [
  { value: 'virtual', label: 'Virtual' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'physical', label: 'Physical' },
];

const DAY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

const INPUT_CLS =
  'w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent';

export function CohortFormModal({ cohort, onClose, onSaved }: CohortFormModalProps) {
  const isEditing = Boolean(cohort?.id);

  const [name, setName] = useState(cohort?.name ?? '');
  const [description, setDescription] = useState(cohort?.description ?? '');
  const [startDate, setStartDate] = useState(cohort?.start_date?.slice(0, 10) ?? '');
  const [endDate, setEndDate] = useState(cohort?.end_date?.slice(0, 10) ?? '');
  const [status, setStatus] = useState<CohortStatus>(cohort?.status ?? 'draft');
  const [defaultMode, setDefaultMode] = useState<ParticipationMode>(
    cohort?.default_participation_mode ?? 'virtual'
  );
  const [physicalDay, setPhysicalDay] = useState<string>(
    cohort?.default_physical_day != null ? String(cohort.default_physical_day) : ''
  );
  const [dailyLogsRequired, setDailyLogsRequired] = useState(cohort?.daily_logs_required ?? true);
  // The weekly rhythm. Defaults match lib/cadence.ts, so a cohort saved without
  // touching these behaves exactly as cohorts did before they existed.
  const [dailyLogDays, setDailyLogDays] = useState<number[]>(
    cohort?.daily_log_days ?? [1, 2, 3, 4, 5],
  );
  const [weeklySummaryDueDay, setWeeklySummaryDueDay] = useState(
    cohort?.weekly_summary_due_day ?? 4,
  );
  const [signoffDueDay, setSignoffDueDay] = useState(cohort?.signoff_due_day ?? 5);
  const [physicalAttendanceRequired, setPhysicalAttendanceRequired] = useState(
    cohort?.physical_attendance_required ?? true,
  );
  const [weeklySummaryRequired, setWeeklySummaryRequired] = useState(
    cohort?.weekly_summary_required ?? true
  );
  const [signoffRequired, setSignoffRequired] = useState(cohort?.signoff_required ?? true);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Cohort name is required');
      return;
    }
    if (!startDate || !endDate) {
      toast.error('Start and end dates are required');
      return;
    }
    setSaving(true);
    try {
      await cohortsApi.saveCohort({
        id: cohort?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        start_date: startDate,
        end_date: endDate,
        status,
        default_participation_mode: defaultMode,
        default_physical_day: physicalDay !== '' ? Number(physicalDay) : null,
        daily_logs_required: dailyLogsRequired,
        daily_log_days: dailyLogDays,
        weekly_summary_due_day: weeklySummaryDueDay,
        signoff_due_day: signoffDueDay,
        physical_attendance_required: physicalAttendanceRequired,
        weekly_summary_required: weeklySummaryRequired,
        signoff_required: signoffRequired,
      });
      toast.success(isEditing ? 'Cohort updated' : 'Cohort created');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cohort-modal-title"
    >
      <div className="bg-white rounded-lg max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 id="cohort-modal-title" className="text-xl font-bold text-slate-800">
            {isEditing ? 'Edit Cohort' : 'New Cohort'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="cohort-form-name" className="block text-sm font-medium text-slate-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              id="cohort-form-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., SIWES 2025 Batch A"
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="cohort-form-description" className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea
              id="cohort-form-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional cohort description"
              className={INPUT_CLS}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="cohort-form-start-date" className="block text-sm font-medium text-slate-700 mb-1">
                Start Date <span className="text-red-500">*</span>
              </label>
              <input
                id="cohort-form-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label htmlFor="cohort-form-end-date" className="block text-sm font-medium text-slate-700 mb-1">
                End Date <span className="text-red-500">*</span>
              </label>
              <input
                id="cohort-form-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className={INPUT_CLS}
              />
            </div>
          </div>

          <div>
            <label htmlFor="cohort-form-status" className="block text-sm font-medium text-slate-700 mb-1">Status</label>
            <select
              id="cohort-form-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as CohortStatus)}
              className={INPUT_CLS}
            >
              {COHORT_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cohort-form-mode" className="block text-sm font-medium text-slate-700 mb-1">
              Default Participation Mode
            </label>
            <select
              id="cohort-form-mode"
              value={defaultMode}
              onChange={(e) => setDefaultMode(e.target.value as ParticipationMode)}
              className={INPUT_CLS}
            >
              {PARTICIPATION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cohort-form-physical-day" className="block text-sm font-medium text-slate-700 mb-1">
              Default Physical Day
            </label>
            <select
              id="cohort-form-physical-day"
              value={physicalDay}
              onChange={(e) => setPhysicalDay(e.target.value)}
              className={INPUT_CLS}
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-slate-700 mb-2">Cadence Requirements</legend>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dailyLogsRequired}
                  onChange={(e) => setDailyLogsRequired(e.target.checked)}
                  className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
                />
                <span className="text-sm text-slate-700">Daily logs required</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={weeklySummaryRequired}
                  onChange={(e) => setWeeklySummaryRequired(e.target.checked)}
                  className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
                />
                <span className="text-sm text-slate-700">Weekly summary required</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={signoffRequired}
                  onChange={(e) => setSignoffRequired(e.target.checked)}
                  className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
                />
                <span className="text-sm text-slate-700">Supervisor sign-off required</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={physicalAttendanceRequired}
                  onChange={(e) => setPhysicalAttendanceRequired(e.target.checked)}
                  className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
                />
                <span className="text-sm text-slate-700">
                  On-site day expected (a no-show becomes an absence)
                </span>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-slate-700 mb-2">Weekly Rhythm</legend>
            <p className="text-xs text-slate-500 mb-3">
              Drives the reminders and the deadline stated in them. Cohort 1 runs logs
              Tuesday&ndash;Thursday, deliverables due Thursday, sign-off Friday.
            </p>

            <div className="mb-3">
              <span className="block text-sm text-slate-700 mb-1">Daily log expected on</span>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((d) => (
                  <label
                    key={d.value}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2 py-1 text-sm cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={dailyLogDays.includes(d.value)}
                      onChange={(e) =>
                        setDailyLogDays((current) =>
                          e.target.checked
                            ? [...current, d.value].sort()
                            : current.filter((x) => x !== d.value),
                        )
                      }
                      className="w-4 h-4 text-iih-green rounded"
                    />
                    {d.short}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cohort-summary-due" className="block text-sm text-slate-700 mb-1">
                  Weekly summary due
                </label>
                <select
                  id="cohort-summary-due"
                  value={weeklySummaryDueDay}
                  onChange={(e) => setWeeklySummaryDueDay(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cohort-signoff-due" className="block text-sm text-slate-700 mb-1">
                  Supervisor sign-off by
                </label>
                <select
                  id="cohort-signoff-due"
                  value={signoffDueDay}
                  onChange={(e) => setSignoffDueDay(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEditing ? 'Save Changes' : 'Create Cohort'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
