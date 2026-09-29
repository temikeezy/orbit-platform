import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Mail, MailX, PenLine, Save } from 'lucide-react';
import { emailDispatchApi, EmailDispatchStatus } from '../../lib/api/emailDispatch';
import { acceptanceLettersApi } from '../../lib/api/acceptanceLetters';
import { authService } from '../../lib/auth';

/**
 * Two controls that change what ORBIT does in the world rather than how it
 * looks: whether it sends mail at all, and whose name signs the acceptance
 * letters a university files.
 *
 * Both are super-admin only and both were previously unreachable — the pause
 * needed a terminal and a deploy key, and the signatory was typed into the
 * print toolbar, where a one-off correction silently became the default for
 * every letter afterwards.
 */

interface Candidate {
  id: string;
  fullName: string;
  email: string;
}

export function OperationsSettings() {
  const isSuperAdmin = authService.hasAnyRole(['super_admin']);

  const [dispatch, setDispatch] = useState<EmailDispatchStatus | null>(null);
  /**
   * Whether the pause state is actually KNOWN.
   *
   * `dispatch` starts null and null read as "not paused", so the panel claimed
   * mail was sending normally before the first response arrived — and kept
   * claiming it if the request failed. Worse, the request was bundled into one
   * `Promise.all` with the signatory config, so an unrelated failure there
   * produced the same false reassurance about email.
   */
  const [dispatchState, setDispatchState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pauseReason, setPauseReason] = useState('');
  const [savingPause, setSavingPause] = useState(false);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [signatoryId, setSignatoryId] = useState('');
  const [signatoryTitle, setSignatoryTitle] = useState('HR Associate');
  const [savingSignatory, setSavingSignatory] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Two independent requests. One failing must not make the other lie.
    void (async () => {
      try {
        const status = await emailDispatchApi.status();
        if (cancelled) return;
        setDispatch(status);
        setPauseReason(status.reason ?? '');
        setDispatchState('ready');
      } catch (error) {
        if (cancelled) return;
        setDispatchState('error');
        toast.error(error instanceof Error ? error.message : 'Could not read the email status.');
      }
    })();

    void (async () => {
      try {
        const [config, staff] = await Promise.all([
          acceptanceLettersApi.getConfig(),
          // Only a super admin may choose, so only they are offered the list.
          isSuperAdmin ? acceptanceLettersApi.signatoryCandidates() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setCandidates(staff);
        setSignatoryId(config.signatoryUserId ?? '');
        setSignatoryTitle(config.signatoryTitle);
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Could not load the signatory.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  const togglePause = async (paused: boolean) => {
    setSavingPause(true);
    try {
      await emailDispatchApi.setPaused(paused, paused ? pauseReason : undefined);
      setDispatch(await emailDispatchApi.status());
      toast.success(
        paused
          ? 'Email held. A message already being sent may still go out; the rest wait.'
          : dispatch?.pausedByEnv
            ? 'Settings pause removed — EMAIL_PAUSED still holds the queue.'
            : 'Email resumed.',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change this.');
    } finally {
      setSavingPause(false);
    }
  };

  const saveSignatory = async () => {
    if (!signatoryId) {
      toast.error('Choose who signs.');
      return;
    }
    setSavingSignatory(true);
    try {
      await acceptanceLettersApi.saveConfig({ signatoryUserId: signatoryId, signatoryTitle });
      toast.success('Signatory saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the signatory.');
    } finally {
      setSavingSignatory(false);
    }
  };

  if (!isSuperAdmin) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Email dispatch and the acceptance-letter signatory are managed by a super admin.
      </div>
    );
  }

  const paused = dispatch?.paused ?? false;

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------ email ---- */}
      <div>
        <h3 className="mb-1 flex items-center gap-2 text-lg font-bold text-slate-800">
          {paused ? <MailX className="h-5 w-5 text-rose-600" /> : <Mail className="h-5 w-5 text-iih-green" />}
          Outgoing Email
        </h3>
        <p className="mb-4 text-sm text-slate-500">
          Holds every email ORBIT sends — reminders, receipts, approvals and sign-in links.
          Nothing is lost while it is held; it queues and goes out when you resume.
        </p>

        {/* Say nothing rather than say the wrong thing. */}
        {dispatchState !== 'ready' ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            {dispatchState === 'loading'
              ? 'Checking whether email is sending…'
              : 'Could not read the email status. Refresh before assuming mail is flowing.'}
          </div>
        ) : (
        <div
          className={`rounded-lg border p-4 ${
            paused ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-800">
                {paused ? 'Email is paused' : 'Email is sending normally'}
              </p>
              {dispatch && (
                <p className="mt-0.5 text-sm text-slate-600">
                  {dispatch.queued > 0
                    ? `${dispatch.queued}${dispatch.queuedIsCapped ? '+' : ''} message${
                        dispatch.queued === 1 ? '' : 's'
                      } waiting${paused ? ' — these send when you resume' : ''}`
                    : 'Nothing waiting in the queue'}
                </p>
              )}
              {paused && dispatch?.pausedByName && (
                <p className="mt-0.5 text-sm text-slate-500">
                  Paused by {dispatch.pausedByName}
                  {dispatch.reason ? ` — ${dispatch.reason}` : ''}
                </p>
              )}
            </div>

            <button
              onClick={() => togglePause(!dispatch?.pausedBySetting)}
              disabled={savingPause || (!dispatch?.pausedBySetting && !pauseReason.trim())}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${
                dispatch?.pausedBySetting
                  ? 'bg-iih-green hover:bg-iih-green-dark'
                  : 'bg-rose-600 hover:bg-rose-700'
              }`}
            >
              {savingPause ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {dispatch?.pausedBySetting
                ? dispatch?.pausedByEnv
                  ? 'Remove Settings pause'
                  : 'Resume sending'
                : 'Pause all email'}
            </button>
          </div>

          {dispatch?.pausedByEnv && (
            <p className="mt-3 border-t border-rose-200 pt-3 text-sm text-slate-700">
              Also held by the <code className="rounded bg-white px-1">EMAIL_PAUSED</code> setting
              on the deployment itself. Resuming here will not release it — that one is removed
              from the command line.
            </p>
          )}

          {!dispatch?.pausedBySetting && (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <label htmlFor="pause-reason" className="block text-sm font-medium text-slate-700">
                Reason <span className="text-rose-600">*</span>
              </label>
              <input
                id="pause-reason"
                type="text"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="e.g. holding while the cohort is set up"
                className="mt-1 w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-iih-green"
              />
              {/* Whoever finds mail stopped is rarely the person who stopped it. */}
              <p className="mt-1 text-xs text-slate-500">
                Required. Recorded with the pause, so anyone wondering why mail stopped can see.
              </p>
            </div>
          )}
        </div>
        )}
      </div>

      {/* -------------------------------------------------- signatory ---- */}
      <div>
        <h3 className="mb-1 flex items-center gap-2 text-lg font-bold text-slate-800">
          <PenLine className="h-5 w-5 text-iih-green" />
          Acceptance Letter Signatory
        </h3>
        <p className="mb-4 text-sm text-slate-500">
          Who signs the SIWES acceptance letters sent to universities. The name is read from
          their ORBIT account, so keeping their profile right keeps every letter right.
        </p>

        <div className="space-y-4 rounded-lg border border-slate-200 p-4">
          <div>
            <label htmlFor="signatory-user" className="block text-sm font-medium text-slate-700">
              Staff member
            </label>
            <select
              id="signatory-user"
              value={signatoryId}
              onChange={(e) => setSignatoryId(e.target.value)}
              className="mt-1 w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-iih-green"
            >
              <option value="">Select who signs</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName} ({c.email})
                </option>
              ))}
            </select>
            {candidates.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                No staff accounts found to choose from.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="signatory-title" className="block text-sm font-medium text-slate-700">
              Job title
            </label>
            <input
              id="signatory-title"
              type="text"
              value={signatoryTitle}
              onChange={(e) => setSignatoryTitle(e.target.value)}
              className="mt-1 w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-iih-green"
            />
            {/* Not on the account: ORBIT holds no job title, and the letter
                prints one under the signature. */}
            <p className="mt-1 text-xs text-slate-500">
              Printed under their name, as it appears on the approved template.
            </p>
          </div>

          <button
            onClick={saveSignatory}
            disabled={savingSignatory || !signatoryId}
            className="inline-flex items-center gap-2 rounded-lg bg-iih-green px-6 py-2 font-medium text-white transition-colors hover:bg-iih-green-dark disabled:opacity-50"
          >
            {savingSignatory ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Save className="h-5 w-5" />
            )}
            Save Signatory
          </button>
        </div>
      </div>
    </div>
  );
}
