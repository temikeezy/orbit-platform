import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Loader2, Layers, Link2, Unlink } from 'lucide-react';
import { tracksApi, Track } from '../../lib/api/tracks';
import { departmentsApi } from '../../lib/api/departments';
import { usersApi } from '../../lib/api/users';
import { streamsApi } from '../../lib/api/streams';

/**
 * The seven programme tracks, and who runs each one.
 *
 * A track is owned by a department, and that department's lead is the track
 * lead. Naming a lead here grants BOTH authorities in one action — the task and
 * announcement authority that lives in `streamModerators`, and the logbook
 * review authority that lives on the department — which previously had to be
 * granted twice through two unrelated screens, with nothing keeping them in
 * step. A half-granted lead looks exactly like a working one until they try to
 * publish Monday's tasks.
 */
export function TracksTab() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([]);
  const [streams, setStreams] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTracks(await tracksApi.list());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load tracks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    departmentsApi
      .getDepartments()
      .then((rows) => setDepartments(rows.map((d) => ({ id: d.id, name: d.name }))))
      .catch(() => setDepartments([]));
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
    streamsApi
      .getActiveStreams()
      .then((rows) => setStreams(rows.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setStreams([]));
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await action();
      toast.success(done);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
        <p className="font-medium text-slate-800">Tracks own streams; departments own tracks.</p>
        <p className="mt-1">
          Naming a lead gives them task authority over every stream in the track and review
          authority over its interns&rsquo; logbooks, in one step. A track needs an owning
          department before it can have a lead.
        </p>
      </div>

      {tracks.map((track) => (
        <div key={track.id} className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-semibold text-slate-900">
                <Layers className="h-4 w-4 text-iih-green" />
                {track.name}
              </h3>
              <p className="mt-0.5 font-mono text-xs text-slate-400">{track.slug}</p>
            </div>
            {!track.departmentId && (
              <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                No owning department
              </span>
            )}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`dept-${track.id}`}
                className="block text-sm font-medium text-slate-700"
              >
                Owning department
              </label>
              <select
                id={`dept-${track.id}`}
                value={track.departmentId ?? ''}
                disabled={busy === track.id}
                onChange={(e) =>
                  run(
                    track.id,
                    () => tracksApi.setDepartment(track.id, track.name, e.target.value || null),
                    'Owner updated',
                  )
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Not assigned</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor={`lead-${track.id}`}
                className="block text-sm font-medium text-slate-700"
              >
                Track lead
              </label>
              <select
                id={`lead-${track.id}`}
                value={track.leadUserId ?? ''}
                disabled={busy === track.id || !track.departmentId}
                onChange={(e) =>
                  e.target.value &&
                  run(
                    track.id,
                    async () => {
                      const granted = await tracksApi.setLead(track.id, e.target.value);
                      return granted;
                    },
                    'Lead set, and given authority over this track&rsquo;s streams',
                  )
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              >
                <option value="">{track.departmentId ? 'Not assigned' : 'Pick a department first'}</option>
                {staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium text-slate-700">Streams in this track</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {track.streams.length === 0 && (
                <span className="text-sm text-slate-400">None yet</span>
              )}
              {track.streams.map((s) => (
                <span
                  key={s.id}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                >
                  {s.emoji ? `${s.emoji} ` : ''}
                  {s.name}
                  <button
                    aria-label={`Remove ${s.name} from ${track.name}`}
                    onClick={() => run(track.id, () => tracksApi.detachStream(s.id), 'Stream removed')}
                    className="ml-1 text-slate-400 hover:text-red-600"
                  >
                    <Unlink className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Link2 className="h-4 w-4 text-slate-400" />
              <select
                aria-label={`Add a stream to ${track.name}`}
                value=""
                disabled={busy === track.id}
                onChange={(e) =>
                  e.target.value &&
                  run(track.id, () => tracksApi.attachStream(track.id, e.target.value), 'Stream added')
                }
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="">Add a stream…</option>
                {streams
                  .filter((s) => !track.streams.some((t) => t.id === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
