import { useState, useEffect, useId } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { logbookApi } from '../../lib/api/logbook';
import { OrbitDailyLog, OrbitInternProfile, DayParticipationMode } from '../../types/database';

interface DailyLogFormProps {
  profile: OrbitInternProfile;
  log?: OrbitDailyLog | null;
  defaultDate: string;
  onSaved: () => void;
}

interface FormState {
  log_date: string;
  participation_mode: DayParticipationMode;
  title: string;
  work_done: string;
  learned: string;
  tools_used: string;
  challenges: string;
  next_steps: string;
  hours_spent: string;
  evidence_links_text: string;
  attachment_url: string;
}

function buildInitialState(log: OrbitDailyLog | null | undefined, defaultDate: string): FormState {
  return {
    log_date: log?.log_date ?? defaultDate,
    participation_mode: log?.participation_mode ?? 'virtual',
    title: log?.title ?? '',
    work_done: log?.work_done ?? '',
    learned: log?.learned ?? '',
    tools_used: log?.tools_used ?? '',
    challenges: log?.challenges ?? '',
    next_steps: log?.next_steps ?? '',
    hours_spent: log?.hours_spent != null ? String(log.hours_spent) : '',
    evidence_links_text: log?.evidence_links?.join('\n') ?? '',
    attachment_url: log?.attachment_url ?? '',
  };
}



export function DailyLogForm({ profile, log, defaultDate, onSaved }: DailyLogFormProps) {
  const [form, setForm] = useState<FormState>(() => buildInitialState(log, defaultDate));
  const [saving, setSaving] = useState(false);
  const fid = useId();

  /**
   * The id of the log this form has saved, held locally.
   *
   * `log` only arrives after the parent re-reads it, which happens one round
   * trip after a save. In that window a second save still sent no id, so the
   * server treated it as a new log for a date that already had one and refused
   * with "A log already exists for that date". Saving a draft and then pressing
   * Submit for review is an ordinary thing to do, and it produced a confusing
   * error whenever the second press beat the re-read.
   */
  const [savedId, setSavedId] = useState<string | undefined>(log?.id);

  useEffect(() => {
    setForm(buildInitialState(log, defaultDate));
    if (log?.id) setSavedId(log.id);
  }, [log, defaultDate]);

  const isLocked =
    log?.status === 'submitted' || log?.status === 'approved';
  const isEditing = Boolean(log?.id);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(submitStatus: 'draft' | 'submitted') {
    if (!form.work_done.trim()) {
      toast.error('Work done is required.');
      return;
    }

    if (submitStatus === 'submitted') {
      const confirmed = window.confirm(
        'Submitting for review will lock this log until your supervisor acts on it. Continue?'
      );
      if (!confirmed) return;
    }

    const evidenceLinks = form.evidence_links_text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const hoursValue = form.hours_spent !== '' ? parseFloat(form.hours_spent) : null;

    setSaving(true);
    try {
      const saved = await logbookApi.saveDailyLog({
        id: log?.id ?? savedId,
        user_id: profile.id,
        log_date: form.log_date,
        participation_mode: form.participation_mode,
        title: form.title,
        work_done: form.work_done,
        learned: form.learned || undefined,
        tools_used: form.tools_used || undefined,
        challenges: form.challenges || undefined,
        next_steps: form.next_steps || undefined,
        hours_spent: hoursValue,
        evidence_links: evidenceLinks,
        attachment_url: form.attachment_url || undefined,
        status: submitStatus,
      });
      if (saved?.id) setSavedId(saved.id);
      toast.success(submitStatus === 'submitted' ? 'Log submitted for review.' : 'Draft saved.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
      {log?.status === 'changes_requested' && log.supervisor_comment && (
        <div className="mb-4 flex gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800 mb-1">Supervisor feedback</p>
            <p className="text-sm text-amber-700">{log.supervisor_comment}</p>
          </div>
        </div>
      )}

      {isLocked && (
        <div className="mb-4 flex gap-3 bg-slate-50 border border-slate-200 rounded-lg p-4">
          <Lock className="w-5 h-5 text-slate-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-slate-600">
            Locked — ask your supervisor to reopen it.
          </p>
        </div>
      )}

      <fieldset disabled={isLocked} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor={`${fid}-date`} className="block text-sm font-medium text-slate-700 mb-1">
              Date
            </label>
            <input
              id={`${fid}-date`}
              type="date"
              value={form.log_date}
              disabled={isEditing}
              onChange={(e) => setField('log_date', e.target.value)}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent disabled:bg-slate-100 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label htmlFor={`${fid}-mode`} className="block text-sm font-medium text-slate-700 mb-1">
              Mode
            </label>
            <select
              id={`${fid}-mode`}
              value={form.participation_mode}
              onChange={(e) =>
                setField('participation_mode', e.target.value as DayParticipationMode)
              }
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            >
              <option value="virtual">Virtual</option>
              <option value="physical">Physical</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor={`${fid}-title`} className="block text-sm font-medium text-slate-700 mb-1">
            Title
          </label>
          <input
            id={`${fid}-title`}
            type="text"
            value={form.title}
            onChange={(e) => setField('title', e.target.value)}
            placeholder="Brief title for today's work"
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
          />
        </div>

        <div>
          <label htmlFor={`${fid}-work-done`} className="block text-sm font-medium text-slate-700 mb-1">
            Work done <span className="text-red-500">*</span>
          </label>
          <textarea
            id={`${fid}-work-done`}
            value={form.work_done}
            onChange={(e) => setField('work_done', e.target.value)}
            rows={5}
            placeholder="Describe what you worked on today..."
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
          />
        </div>

        <div>
          <label htmlFor={`${fid}-learned`} className="block text-sm font-medium text-slate-700 mb-1">
            What I learned
          </label>
          <textarea
            id={`${fid}-learned`}
            value={form.learned}
            onChange={(e) => setField('learned', e.target.value)}
            rows={3}
            placeholder="Key insights or skills gained..."
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
          />
        </div>

        <div>
          <label htmlFor={`${fid}-tools`} className="block text-sm font-medium text-slate-700 mb-1">
            Tools / resources used
          </label>
          <textarea
            id={`${fid}-tools`}
            value={form.tools_used}
            onChange={(e) => setField('tools_used', e.target.value)}
            rows={2}
            placeholder="Libraries, documentation, tools..."
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
          />
        </div>

        <div>
          <label htmlFor={`${fid}-challenges`} className="block text-sm font-medium text-slate-700 mb-1">
            Challenges / blockers
          </label>
          <textarea
            id={`${fid}-challenges`}
            value={form.challenges}
            onChange={(e) => setField('challenges', e.target.value)}
            rows={2}
            placeholder="Issues encountered..."
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
          />
        </div>

        <div>
          <label htmlFor={`${fid}-next-steps`} className="block text-sm font-medium text-slate-700 mb-1">
            Next steps
          </label>
          <textarea
            id={`${fid}-next-steps`}
            value={form.next_steps}
            onChange={(e) => setField('next_steps', e.target.value)}
            rows={2}
            placeholder="What's planned for tomorrow..."
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor={`${fid}-hours`} className="block text-sm font-medium text-slate-700 mb-1">
              Hours spent
            </label>
            <input
              id={`${fid}-hours`}
              type="number"
              min={0}
              max={24}
              step={0.5}
              value={form.hours_spent}
              onChange={(e) => setField('hours_spent', e.target.value)}
              placeholder="e.g. 6.5"
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor={`${fid}-attachment`} className="block text-sm font-medium text-slate-700 mb-1">
              Attachment URL
            </label>
            <input
              id={`${fid}-attachment`}
              type="text"
              value={form.attachment_url}
              onChange={(e) => setField('attachment_url', e.target.value)}
              placeholder="https://..."
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${fid}-evidence`} className="block text-sm font-medium text-slate-700 mb-1">
            Evidence links
            <span className="ml-1 text-xs text-slate-500">(one URL per line)</span>
          </label>
          <textarea
            id={`${fid}-evidence`}
            value={form.evidence_links_text}
            onChange={(e) => setField('evidence_links_text', e.target.value)}
            rows={3}
            placeholder={'https://github.com/...\nhttps://docs.google.com/...'}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-y font-mono text-sm"
          />
        </div>
      </fieldset>

      {!isLocked && (
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => handleSave('draft')}
            disabled={saving}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            onClick={() => handleSave('submitted')}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            Submit for review
          </button>
        </div>
      )}
    </div>
  );
}
