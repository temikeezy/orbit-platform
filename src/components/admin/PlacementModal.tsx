import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Loader2, X } from 'lucide-react';
import { applicationsApi } from '../../lib/api/applications';
import { streamsApi } from '../../lib/api/streams';
import { usersApi } from '../../lib/api/users';
import { OrbitApplication } from '../../types/database';

/**
 * Where an admin decides an applicant's placement, before approving them.
 *
 * The concept note says ORBIT assigns participation mode after review and that
 * applicants do not choose it. Until this existed the mode was inferred from
 * the applicant's typed location and copied straight into their account, so the
 * approval email announced a decision nobody had made.
 *
 * The derived mode is shown beside the field rather than hidden: it is the
 * applicant's own statement of where they are, and overriding it is a decision
 * about someone's travel for twelve weeks, so the reason box appears the moment
 * the two disagree — the server refuses without it either way.
 */

const MODES = [
  { value: 'virtual', label: 'Virtual — takes part online' },
  { value: 'hybrid', label: 'Hybrid — on site one day a week' },
  { value: 'physical', label: 'Physical — on site' },
];

const DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
];

interface Props {
  application: OrbitApplication;
  onClose: () => void;
  onSaved: () => void;
}

export function PlacementModal({ application, onClose, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [streams, setStreams] = useState<{ id: string; name: string }[]>([]);
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([]);

  const derived = application.preferred_participation_mode;

  const [mode, setMode] = useState<string>(application.assigned_participation_mode ?? derived);
  const [day, setDay] = useState<number>(
    application.assigned_physical_day ?? application.available_physical_day ?? 1,
  );
  const [streamId, setStreamId] = useState(application.assigned_stream_id ?? '');
  const [supervisorId, setSupervisorId] = useState(application.assigned_supervisor_id ?? '');
  const [reason, setReason] = useState(application.mode_override_reason ?? '');

  const overriding = mode !== derived;
  const onSite = mode !== 'virtual';

  useEffect(() => {
    // Both lists are advisory — a placement can be saved with neither, so a
    // failure here must not block the decision.
    streamsApi
      .getActiveStreams()
      .then((rows) => setStreams(rows.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setStreams([]));

    usersApi
      .getActiveUsers()
      .then((rows) =>
        setStaff(
          rows
            .filter((u) =>
              (u.roles ?? []).some((r) => ['admin', 'super_admin', 'moderator'].includes(r)),
            )
            .map((u) => ({ id: u.id, full_name: u.full_name })),
        ),
      )
      .catch(() => setStaff([]));
  }, []);

  const save = async () => {
    if (overriding && !reason.trim()) {
      toast.error('Give a short reason for changing the participation mode.');
      return;
    }

    setSaving(true);
    try {
      await applicationsApi.assignPlacement(application.id, {
        participationMode: mode,
        physicalDay: onSite ? day : undefined,
        streamId: streamId || undefined,
        supervisorId: supervisorId || undefined,
        modeOverrideReason: overriding ? reason : undefined,
      });
      toast.success('Placement saved');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this placement');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="placement-modal-title"
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="placement-modal-title" className="font-semibold text-slate-900">Assign placement</h2>
            <p className="text-sm text-slate-500">
              {application.full_name} · {application.reference_code}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label htmlFor="placement-mode" className="block text-sm font-medium text-slate-700">
              Participation mode
            </label>
            <select
              id="placement-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Their location ({application.location}) suggests <strong>{derived}</strong>.
            </p>
          </div>

          {overriding && (
            <div>
              <label htmlFor="placement-reason" className="block text-sm font-medium text-slate-700">
                Why the change? <span className="text-red-500">*</span>
              </label>
              <textarea
                id="placement-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Relocating to Ilorin for the placement."
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          )}

          {onSite && (
            <div>
              <label htmlFor="placement-day" className="block text-sm font-medium text-slate-700">
                On-site day
              </label>
              <select
                id="placement-day"
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {DAYS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="placement-stream" className="block text-sm font-medium text-slate-700">
              Stream
            </label>
            <select
              id="placement-stream"
              value={streamId}
              onChange={(e) => setStreamId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Decide later</option>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="placement-supervisor" className="block text-sm font-medium text-slate-700">
              Supervisor
            </label>
            <select
              id="placement-supervisor"
              value={supervisorId}
              onChange={(e) => setSupervisorId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Decide later</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Without a supervisor or a department, nobody can review this person&rsquo;s logbook.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save placement
          </button>
        </div>
      </div>
    </div>
  );
}
