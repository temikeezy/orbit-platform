import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  Check,
  X,
  Loader2,
  Pencil,
  CalendarClock,
  Award,
  Inbox,
  Clock,
  Sparkles,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { tasksApi, ProposedTask } from '../lib/api/tasks';
import { streamsApi } from '../lib/api/streams';

/**
 * Only what the request control needs. Matches the local shape AddTaskPage
 * declares for the same query — `is_moderator` is computed per viewer on the
 * server, so this is the viewer's own scope, not a claim the client makes.
 */
interface Stream {
  id: string;
  name: string;
  is_moderator: boolean;
}

/**
 * The supervisor's approval queue for tasks the ORBIT agent drafted.
 *
 * The agent writes a weekly schedule across every stream; a supervisor decides
 * what actually reaches interns. Nothing here is visible to members — a
 * proposal is absent from the task list, the detail page and the accept path
 * until it is approved from this screen.
 *
 * Edit before approving is deliberately the same editor as any other task:
 * adjusting a deadline the agent got wrong should not be a different, lesser
 * form than writing the task by hand.
 */
export function TaskProposalsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [proposals, setProposals] = useState<ProposedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [windowHours, setWindowHours] = useState<number | null>(null);

  /**
   * Requesting a replacement task.
   *
   * Page-level, not per-row, and deliberately so: declining a proposal deletes
   * it, so a supervisor who rejects every proposal for their stream lands on
   * the empty state — which is exactly when they most need to ask for another,
   * and exactly where a per-row control would not exist.
   */
  const [moderatedStreams, setModeratedStreams] = useState<Stream[]>([]);
  const [requestStreamId, setRequestStreamId] = useState('');
  const [requesting, setRequesting] = useState(false);
  /**
   * Held inline rather than toasted. An exhausted bank is the ORDINARY outcome
   * once a stream has worked through its five prepared tasks, and it carries
   * instructions worth reading twice — a toast that disappears is the wrong
   * container for it, and a red one would call it a fault.
   */
  const [requestNotice, setRequestNotice] = useState<string | null>(null);

  const isStaff = Boolean(
    user?.roles?.some((r) => ['admin', 'super_admin', 'moderator'].includes(r)),
  );

  /**
   * Ask the bank for another task for one stream.
   *
   * The mutation is NOT idempotent — every success inserts a row — so the
   * control is disabled while this runs. A double-click would otherwise draft
   * two tasks, and the second is one nobody asked for.
   */
  const requestAnother = async () => {
    if (!requestStreamId || requesting) return;
    setRequesting(true);
    setRequestNotice(null);
    try {
      const result = await tasksApi.requestNewTask(requestStreamId);
      if (result.success) {
        toast.success(`Added "${result.title}" for approval`);
        // Refetched rather than optimistically inserted: the new row is a
        // proposal like any other and the server decides its order.
        await load();
      } else {
        // Returned, not thrown — the programme has not started, the stream is
        // not running, or the bank is used up. None is a fault.
        setRequestNotice(result.error);
      }
    } catch (error) {
      // Thrown means authorisation or network — that IS an error.
      toast.error(error instanceof Error ? error.message : 'Could not request a task');
    } finally {
      setRequesting(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [rows, hours, streams] = await Promise.all([
        tasksApi.getPendingProposals(),
        // Never blocks the queue: a supervisor who cannot see the window can
        // still approve and decline, so a failure here costs a sentence of
        // context rather than the screen.
        tasksApi.getApprovalWindow().catch(() => null),
        // Same posture — if this fails the request control hides and the queue
        // still works. `is_moderator` is computed per viewer on the server.
        streamsApi.getAllStreams().catch(() => []) as Promise<Stream[]>,
      ]);
      setWindowHours(hours);
      setProposals(rows);

      const mine = (streams as Stream[]).filter((st) => st.is_moderator);
      setModeratedStreams(mine);
      // One stream needs no choosing.
      setRequestStreamId((cur) => cur || (mine.length === 1 ? mine[0].id : ''));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load proposals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isStaff) void load();
    else setLoading(false);
  }, [isStaff, load]);

  const approve = async (task: ProposedTask) => {
    setBusyId(task.id);
    try {
      const { notified } = await tasksApi.approveProposal(task.id);
      // The count is the point of the message: approving is the moment a stream
      // is told, and it is worth seeing how many people that was.
      toast.success(
        notified > 0
          ? `Published — ${notified} member${notified === 1 ? '' : 's'} notified`
          : 'Published',
      );
      setProposals((current) => current.filter((p) => p.id !== task.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not approve this task');
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (task: ProposedTask) => {
    setBusyId(task.id);
    try {
      await tasksApi.declineProposal(task.id, reason);
      toast.success('Proposal declined');
      setProposals((current) => current.filter((p) => p.id !== task.id));
      setDecliningId(null);
      setReason('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not decline this task');
    } finally {
      setBusyId(null);
    }
  };

  if (!isStaff) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-semibold text-gray-900">Access denied</h1>
        <p className="mt-2 text-gray-600">
          Task proposals are reviewed by stream supervisors.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button
        onClick={() => navigate('/tasks')}
        className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-6"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        Back to tasks
      </button>

      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Bot className="w-6 h-6 text-emerald-500" aria-hidden="true" />
          Task proposals
        </h1>
        <p className="mt-2 text-gray-600">
          Drafted by the ORBIT agent for your streams. Nothing here is visible to members until
          you approve it — edit anything that needs adjusting first.
        </p>
        {windowHours !== null && (
          <p className="mt-2 text-sm text-gray-500">
            {windowHours > 0
              ? `Proposals you do not act on publish automatically after ${windowHours} hours, so a busy week never leaves interns without tasks. You can still edit or withdraw them afterwards.`
              : 'Automatic publishing is switched off — proposals wait here until someone decides.'}
          </p>
        )}
      </header>

      {/*
        ABOVE the loading/empty/populated fork, so it is reachable in all three.
        Declining deletes a proposal, so a supervisor who rejects everything for
        their stream sees the empty state — the moment they most need to ask for
        another, and the one place a per-row control would not exist.
      */}
      {moderatedStreams.length > 0 && (
        <section
          aria-labelledby="request-another-heading"
          className="mb-6 rounded-xl border border-gray-200 bg-white p-4"
        >
          <h2 id="request-another-heading" className="sr-only">
            Request another task
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            {/* Hidden when there is nothing to choose between. */}
            {moderatedStreams.length > 1 && (
              <select
                value={requestStreamId}
                onChange={(e) => {
                  setRequestStreamId(e.target.value);
                  setRequestNotice(null);
                }}
                aria-label="Stream to request a task for"
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">Choose a stream…</option>
                {moderatedStreams.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={requestAnother}
              disabled={!requestStreamId || requesting}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-iih-green hover:bg-iih-green-dark disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {requesting ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="w-4 h-4" aria-hidden="true" />
              )}
              {requesting ? 'Requesting…' : 'Request another task'}
            </button>

            {/*
              Always present, not conditional on the exhausted message. When the
              bank runs out the advice is "write one yourself", and that advice
              needs somewhere to click without the UI having to work out which
              failure it just received.
            */}
            {requestStreamId && (
              <button
                type="button"
                onClick={() => navigate(`/streams/${requestStreamId}/add-task`)}
                className="text-sm text-gray-600 hover:text-gray-900 underline"
              >
                or write one yourself
              </button>
            )}
          </div>

          <p className="mt-2 text-sm text-gray-500">
            Draws the next prepared task for that stream. It arrives here as a proposal —
            nothing publishes without your approval.
          </p>

          {requestNotice && (
            <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
              {requestNotice}
            </p>
          )}
        </section>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" aria-hidden="true" />
          <span className="sr-only">Loading proposals</span>
        </div>
      ) : proposals.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-gray-300 rounded-xl">
          <Inbox className="w-8 h-8 mx-auto text-gray-400" aria-hidden="true" />
          <p className="mt-3 font-medium text-gray-900">Nothing waiting</p>
          <p className="mt-1 text-sm text-gray-600">
            Proposals appear here when the agent drafts the next schedule.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {proposals.map((task) => (
            <li
              key={task.id}
              className="border border-gray-200 rounded-xl p-5 bg-white"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-gray-500">
                    {task.stream_emoji ? `${task.stream_emoji} ` : ''}
                    {task.stream_name ?? 'Unknown stream'}
                  </p>
                  <h2 className="mt-1 font-semibold text-gray-900">{task.title}</h2>
                </div>
                <span className="shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-amber-100 text-amber-800">
                  <Bot className="w-3 h-3" aria-hidden="true" />
                  Awaiting approval
                </span>
              </div>

              <p className="mt-3 text-sm text-gray-700 whitespace-pre-wrap">
                {task.description}
              </p>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-600">
                <div className="flex items-center gap-1.5">
                  <Award className="w-4 h-4" aria-hidden="true" />
                  <dt className="sr-only">Points</dt>
                  <dd>{task.points} points</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <CalendarClock className="w-4 h-4" aria-hidden="true" />
                  <dt className="sr-only">Deadline</dt>
                  <dd>Due {new Date(task.deadline).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt className="sr-only">Submission type</dt>
                  <dd className="capitalize">{task.submission_type} submission</dd>
                </div>
                {windowHours !== null && windowHours > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-700">
                    <Clock className="w-4 h-4" aria-hidden="true" />
                    <dt className="sr-only">Publishes automatically</dt>
                    <dd>
                      Publishes on its own{' '}
                      {new Date(
                        new Date(task.created_at).getTime() + windowHours * 3_600_000,
                      ).toLocaleString()}
                    </dd>
                  </div>
                )}
              </dl>

              {decliningId === task.id ? (
                <div className="mt-4">
                  <label
                    htmlFor={`reason-${task.id}`}
                    className="block text-sm font-medium text-gray-700"
                  >
                    Why are you declining this? (optional)
                  </label>
                  <textarea
                    id={`reason-${task.id}`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    placeholder="Unrealistic for week one — the stream has not covered this yet."
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Kept in the audit log so the agent&rsquo;s output can be tuned. The draft
                    itself is discarded.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => decline(task)}
                      disabled={busyId === task.id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                    >
                      {busyId === task.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <X className="w-4 h-4" aria-hidden="true" />
                      )}
                      Confirm decline
                    </button>
                    <button
                      onClick={() => {
                        setDecliningId(null);
                        setReason('');
                      }}
                      className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => approve(task)}
                    disabled={busyId === task.id}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busyId === task.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Check className="w-4 h-4" aria-hidden="true" />
                    )}
                    Approve and publish
                  </button>
                  <button
                    onClick={() => navigate(`/tasks/${task.id}/edit`)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700"
                  >
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                    Edit first
                  </button>
                  <button
                    onClick={() => {
                      // Cleared per proposal: `reason` is one piece of state, so
                      // text typed for another proposal would otherwise be
                      // attached to this one's audit log.
                      setReason('');
                      setDecliningId(task.id);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-300 text-sm text-red-700"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                    Decline
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
