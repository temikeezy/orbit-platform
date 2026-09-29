import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Calendar, Award, FileText, CheckCircle, User, AlertCircle, Edit2, Heart, MessageCircle, Send } from 'lucide-react';
import { seesTaskLoop } from '../lib/roles';
import { SUBMISSION_FILE_ACCEPT } from '../lib/submissionTypes';
import { useAuth } from '../contexts/AuthContext';
import { openSubmissionFile, tasksApi, TaskWithStatus as Task } from '../lib/api/tasks';
import { streamsApi } from '../lib/api/streams';
import { convexHttp as convex } from '../lib/convex';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { formatDate } from '../lib/utils/date';
import { SafeLink } from '../components/common/SafeLink';
import { logError } from '../lib/monitoring';

interface SubmissionUser {
  id: string;
  full_name: string;
  profile_photo_url?: string;
}

interface Submission {
  id: string;
  user_id: string;
  submission_text?: string;
  submission_url?: string;
  status: string;
  submitted_at: string;
  user: SubmissionUser;
  likes_count: number;
  has_liked: boolean;
  comments: Comment[];
}

// getSubmissionUser / getCommentUser are gone with the joins that needed them:
// PostgREST returned an embedded relation as an object or a one-element array
// depending on how it inferred the cardinality, so every read had to normalise.
interface CommentUser {
  full_name: string;
  profile_photo_url?: string;
}

interface Comment {
  id: string;
  content: string;
  user_id: string;
  created_at: string;
  user: CommentUser;
}

export function TaskDetailPage() {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const { user } = useAuth();
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionContent, setSubmissionContent] = useState('');
  const [submissionFile, setSubmissionFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  // Reopens the form on work that is submitted but not yet marked. The server
  // has always accepted it (`submitWork` patches any row that is not approved);
  // the page never offered it, so an intern told their link could not be opened
  // — or who spotted a mistake in their own text — had no way to act on it.
  const [editingSubmission, setEditingSubmission] = useState(false);
  const [allSubmissions, setAllSubmissions] = useState<Submission[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [commentContent, setCommentContent] = useState<{ [key: string]: string }>({});
  const [postingComment, setPostingComment] = useState<{ [key: string]: boolean }>({});

  // super_admin counts as admin. The client checked only 'admin', and super
  // admins carry roles: ['super_admin'] alone, so the platform's most
  // privileged users were hidden from their own admin controls.
  const isAdmin =
    Boolean(user?.roles?.includes('admin')) || Boolean(user?.roles?.includes('super_admin'));
  /**
   * Accepting and submitting are the intern loop; the server refuses both for
   * staff (`acceptTask` and `submitWork` check `isIntern` and throw). A
   * supervisor still opens this page constantly — to read the task, and to see
   * an intern's submission — so only the two controls go, not the page.
   */
  const canWorkTasks = seesTaskLoop(user);

  /**
   * Which fetch is allowed to write state, one ticket per loader.
   *
   * Both loads are keyed by the route's taskId, and navigating task A → task B
   * re-runs them with no cancellation — the responses can land in either
   * order, so A's slower task or peer list resolving last painted A's content
   * under B's URL. The same guard SubmissionReviewPage and EmailLogsPage
   * carry; separate refs because the task and its peer submissions load in
   * parallel and must not invalidate each other.
   */
  const currentTaskRequest = useRef(0);
  const currentPeersRequest = useRef(0);

  useEffect(() => {
    if (!taskId) {
      navigate('/tasks');
      return;
    }
    loadTask();
    loadSubmissions();
  }, [taskId, navigate]);

  if (!taskId) return null;

  const loadTask = async () => {
    const request = ++currentTaskRequest.current;
    try {
      setLoading(true);
      const data = await tasksApi.getTaskById(taskId);

      // Superseded while this was in flight. A stale task is worse than a slow
      // one, because it renders under the newer route's URL and looks current.
      if (request !== currentTaskRequest.current) return;

      setTask(data);
      if (data?.user_submission?.submission_text) {
        setSubmissionContent(data.user_submission.submission_text);
      }

      // Every branch WRITES the verdict, including the negative ones. This only
      // ever set it true, so a moderator moving from a task in a stream they
      // lead to one in a stream they do not kept the edit control from the
      // previous task — the same stale-state shape as the response race above,
      // one route param later. The server refuses the edit either way; what
      // was wrong was offering it.
      if (isAdmin) {
        setCanEdit(true);
      } else if (data?.stream_id) {
        const streams = await streamsApi.getAllStreams();
        if (request !== currentTaskRequest.current) return;
        const stream = streams.find((s) => s.id === data.stream_id) as (typeof streams[0] & { is_moderator?: boolean }) | undefined;
        setCanEdit(Boolean(stream?.is_moderator));
      } else {
        setCanEdit(false);
      }
    } catch (error) {
      if (request !== currentTaskRequest.current) return;
      logError(error, { context: 'TaskDetailPage.loadTask' });
      setError('Failed to load task details');
    } finally {
      // Only the newest request owns the spinner, or an early straggler ends
      // it while the task the reader actually navigated to is still coming.
      if (request === currentTaskRequest.current) {
        setLoading(false);
      }
    }
  };

  const handleAccept = async () => {
    if (!user) return;

    try {
      setAccepting(true);
      setError('');
      await tasksApi.acceptTask(taskId);
      await loadTask();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to accept task');
    } finally {
      setAccepting(false);
    }
  };

  const handleSubmit = async () => {
    if (!user || !task) return;

    if (task.submission_type === 'text' && !submissionContent.trim()) {
      setError('Please provide your submission content');
      return;
    }

    if (task.submission_type === 'link' && !submissionContent.trim()) {
      setError('Please provide a link');
      return;
    }

    if (task.submission_type === 'file' && !submissionFile && !task.user_submission?.submission_url) {
      setError('Please upload a file');
      return;
    }

    try {
      setSubmitting(true);
      setError('');

      if (task.submission_type === 'file' && submissionFile) {
        await tasksApi.submitTaskWithFile(taskId, submissionFile);
      } else {
        /**
         * BY NAME, because the positional call was wrong.
         *
         * The signature is (taskId, submissionUrl?, submissionText?), so
         * `submitTask(taskId, submissionContent)` filed a text task's prose as
         * its file URL. That had always been the wrong column; it became visible
         * when submissionFileUrl gained a 500-character bound and a long written
         * answer started failing with "File reference must be 500 characters or
         * fewer" — a message about a field the member never filled in.
         */
        await tasksApi.submitTask(taskId, {
          text: task.submission_type === 'link' ? undefined : submissionContent,
          url: task.submission_type === 'link' ? submissionContent : undefined,
        });
      }

      await loadTask();
      await loadSubmissions();
      setSubmissionContent('');
      setSubmissionFile(null);
      setEditingSubmission(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to submit task');
    } finally {
      setSubmitting(false);
    }
  };

  const getSubmissionTypeLabel = (type: string) => {
    switch (type) {
      case 'text':
        return 'Text Submission';
      case 'file':
        return 'File Upload';
      case 'link':
        return 'Link/URL';
      default:
        return type;
    }
  };

  const getTaskStatus = (task: Task) => {
    if (!task.user_submission) return 'available';

    switch (task.user_submission.status) {
      case 'submitted':
        return 'submitted';
      // 'in_progress', not 'accepted'. Accepting a task creates the submission
      // row in `in_progress` and always has — the UI compared against a status
      // the database has never produced, so the "Accepted" badge and its filter
      // were dead code and an accepted task showed as "Available".
      case 'in_progress':
      // Sent back for rework. It has to read as accepted so the submission form
      // renders: the form was gated on 'in_progress' alone, so a member whose
      // work was returned had NO WAY to resubmit it.
      // falls through
      case 'changes_requested':
      case 'draft':
        return 'accepted';
      case 'approved':
        return 'approved';
      case 'rejected':
        return 'rejected';
      default:
        return 'available';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'submitted':
        return { label: 'You Submitted', color: 'bg-emerald-50 text-emerald-700' };
      case 'accepted':
        // 'changes_requested' lands here too, and needs its own label — telling
        // someone their returned work is "You Started" is how it gets forgotten.
        return task?.user_submission?.status === 'changes_requested'
          ? { label: 'Changes Requested', color: 'bg-orange-50 text-orange-700' }
          : { label: 'You Started', color: 'bg-sky-50 text-sky-700' };
      case 'approved':
        return { label: 'Approved', color: 'bg-emerald-50 text-emerald-700' };
      case 'rejected':
        return { label: 'Not Approved', color: 'bg-rose-50 text-rose-700' };
      case 'available':
        return { label: 'Not Started', color: 'bg-amber-50 text-amber-700' };
      default:
        return { label: 'Not Started', color: 'bg-slate-100 text-slate-700' };
    }
  };

  const isDeadlinePassed = (deadline: string) => {
    return new Date(deadline) < new Date();
  };

  const getTimeRemaining = (deadline: string) => {
    const now = new Date();
    const dueDate = new Date(deadline);
    const diff = dueDate.getTime() - now.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (diff < 0) return 'Overdue';
    if (days > 1) return `${days} days`;
    if (hours > 1) return `${hours} hours`;
    return 'Due soon';
  };

  /**
   * The peer showcase.
   *
   * This used to be one query straight against orbit_submissions filtered only
   * by task_id and status — so any authenticated user could read any task's
   * coursework, text and links included, whether or not they were in the
   * stream — followed by TWO more queries per submission, from the browser, to
   * count its reactions and fetch its comments. `tasks.peerSubmissions` is one
   * call, gated on membership of the task's stream, and returns only submitted
   * and approved work: a draft or a rejection is not the stream's business.
   */
  const loadSubmissions = async () => {
    const token = authService.getToken();
    if (!user || !token || !taskId) return;

    const request = ++currentPeersRequest.current;
    try {
      setLoadingSubmissions(true);

      const rows = await convex.query(api.tasks.peerSubmissions, {
        token,
        taskId: taskId as never,
      });

      // A previous task's peer showcase must not repaint under this task's
      // header — with text tasks the misattribution reads as someone else's
      // written answer to a question they were never asked.
      if (request !== currentPeersRequest.current) return;

      setAllSubmissions(
        rows.map((r) => ({
          id: r.id,
          user_id: r.userId,
          submission_text: r.submissionText,
          submission_url: r.submissionUrl,
          status: r.status,
          submitted_at: new Date(r.submittedAt ?? 0).toISOString(),
          user: {
            id: r.author.id,
            full_name: r.author.fullName,
            profile_photo_url: r.author.profilePhotoUrl,
          },
          likes_count: r.likeCount,
          has_liked: r.likedByMe,
          comments: r.comments.map((c) => ({
            id: c.id,
            content: c.content,
            user_id: c.author?.id ?? '',
            created_at: new Date(c.createdAt).toISOString(),
            user: {
              full_name: c.author?.fullName ?? 'Unknown',
              profile_photo_url: c.author?.profilePhotoUrl,
            },
          })),
        })),
      );
    } catch (error) {
      if (request !== currentPeersRequest.current) return;
      logError(error, { context: 'TaskDetailPage.loadSubmissions' });
    } finally {
      if (request === currentPeersRequest.current) {
        setLoadingSubmissions(false);
      }
    }
  };

  const handleLikeSubmission = async (submissionId: string) => {
    const token = authService.getToken();
    if (!token) return;

    try {
      // One toggle. The page read its own local copy to decide whether to
      // INSERT or DELETE, then wrote the row itself with a user_id it chose —
      // so it could react as somebody else, and two tabs disagreeing about the
      // current state produced a duplicate or a no-op.
      await convex.mutation(api.reactions.toggleReaction, {
        token,
        targetType: 'submission',
        targetId: submissionId,
        emoji: '❤️',
      });
      await loadSubmissions();
    } catch (error) {
      logError(error, { context: 'TaskDetailPage.handleLikeSubmission' });
    }
  };

  const handlePostComment = async (submissionId: string) => {
    const token = authService.getToken();
    if (!token || !commentContent[submissionId]?.trim()) return;

    try {
      setPostingComment({ ...postingComment, [submissionId]: true });

      // The author comes off the session. The page inserted the row itself with
      // a user_id it supplied, against a table with no RLS.
      const result = await convex.mutation(api.reactions.addComment, {
        token,
        targetType: 'submission',
        targetId: submissionId,
        content: commentContent[submissionId],
      });
      if (!result.success) throw new Error(result.error);

      setCommentContent({ ...commentContent, [submissionId]: '' });
      await loadSubmissions();
    } catch (error) {
      logError(error, { context: 'TaskDetailPage.handlePostComment' });
    } finally {
      setPostingComment({ ...postingComment, [submissionId]: false });
    }
  };

  const getInitials = (name: string | null | undefined) => {
    return (name ?? 'U')
      .split(' ')
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading task details...</p>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <p className="text-slate-600">Task not found</p>
          <button
            onClick={() => navigate('/tasks')}
            className="mt-4 text-iih-green hover:text-iih-green-darker"
          >
            Back to Tasks
          </button>
        </div>
      </div>
    );
  }

  const taskStatus = getTaskStatus(task);
  const status = getStatusBadge(taskStatus);
  const deadlinePassed = isDeadlinePassed(task.deadline);

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => navigate('/tasks')}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Tasks
          </button>
          {canEdit && (
            <button
              onClick={() => navigate(`/tasks/${taskId}/edit`)}
              className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2 px-4 rounded-lg transition-colors"
            >
              <Edit2 className="w-4 h-4" />
              Edit Task
            </button>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-8">
            <div className="flex items-start justify-between mb-6">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-3">
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${status.color}`}>
                    {status.label}
                  </span>
                  {deadlinePassed && taskStatus !== 'submitted' && (
                    <span className="px-3 py-1 rounded-full text-sm font-medium bg-rose-50 text-rose-700">
                      Deadline Passed
                    </span>
                  )}
                </div>
                <h1 className="text-3xl font-bold text-slate-800 mb-3">{task.title}</h1>
                <button
                  onClick={() => navigate(`/streams/${task.stream_id}`)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 hover:text-indigo-800 rounded-lg text-sm font-medium transition-colors"
                >
                  <CheckCircle className="w-4 h-4" />
                  {task.stream_name}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <div className="bg-green-100 rounded-lg p-4">
                <div className="flex items-center gap-2 text-slate-700 mb-2">
                  <Award className="w-5 h-5" />
                  <span className="text-sm font-medium">Points</span>
                </div>
                <div className="text-2xl font-bold text-slate-900">{task.points}</div>
              </div>

              <div className="bg-indigo-50 rounded-lg p-4">
                <div className="flex items-center gap-2 text-indigo-600 mb-2">
                  <Calendar className="w-5 h-5" />
                  <span className="text-sm font-medium">Deadline</span>
                </div>
                <div className="text-sm font-bold text-indigo-900">{formatDate(task.deadline)}</div>
                <div className={`text-xs font-medium mt-1 ${
                  getTimeRemaining(task.deadline) === 'Overdue' ? 'text-rose-600' : 'text-orange-600'
                }`}>
                  {getTimeRemaining(task.deadline)}
                </div>
              </div>

              <div className="bg-sky-50 rounded-lg p-4">
                <div className="flex items-center gap-2 text-sky-600 mb-2">
                  <FileText className="w-5 h-5" />
                  <span className="text-sm font-medium">Type</span>
                </div>
                <div className="text-sm font-bold text-sky-900">{getSubmissionTypeLabel(task.submission_type)}</div>
              </div>

              <div className="bg-emerald-50 rounded-lg p-4">
                <div className="flex items-center gap-2 text-emerald-600 mb-2">
                  <User className="w-5 h-5" />
                  <span className="text-sm font-medium">Created By</span>
                </div>
                <div className="text-sm font-bold text-emerald-900">{task.created_by_name}</div>
              </div>
            </div>

            <div className="mb-8">
              <h2 className="text-xl font-bold text-slate-800 mb-3">Description</h2>
              <p className="text-slate-600 whitespace-pre-wrap leading-relaxed">{task.description}</p>
            </div>

            {task.user_submission?.score != null && (
              <div className="mb-8 bg-white rounded-lg p-6 border border-slate-200 shadow-orbit-sm">
                <div className="flex items-center justify-between gap-4 mb-4">
                  <h3 className="font-bold text-orbit-ink">Your result</h3>
                  {/*
                    THE DENOMINATOR IS THE POINT. The task list showed a bare
                    "Earned: 9 points", which tells an intern nothing about
                    whether 9 was most of the marks or a quarter of them.
                  */}
                  <span className="text-lg font-semibold text-iih-green whitespace-nowrap">
                    {task.user_submission.score} / {task.points} points
                  </span>
                </div>

                {task.user_submission.feedback ? (
                  <div>
                    <p className="text-xs font-medium text-orbit-muted uppercase tracking-wide mb-1">
                      Feedback
                    </p>
                    <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">
                      {task.user_submission.feedback}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-orbit-muted">
                    No written feedback was left on this one.
                  </p>
                )}

                {/*
                  Says who, when there is a who. An agent-marked submission
                  leaves `reviewed_by` unset, and claiming a person read it when
                  none did would be worse than saying nothing.
                */}
                {task.user_submission.reviewed_at && (
                  <p className="text-xs text-orbit-muted mt-4">
                    Reviewed {formatDate(task.user_submission.reviewed_at)}
                  </p>
                )}
              </div>
            )}

            {/*
              SHOWN AFTER MARKING TOO, not only while awaiting review.
              This was gated on 'submitted' alone, and `getTaskStatus` returns
              'approved' once work is marked — so at the exact moment an intern
              had a result to look at, their submission disappeared from the
              page along with any way to see what they had sent.
            */}
            {(taskStatus === 'submitted' || taskStatus === 'approved' || taskStatus === 'rejected') && (
              <div className="mb-8 bg-emerald-50 rounded-lg p-6 border border-emerald-200">
                <div className="flex items-center gap-2 text-emerald-700 mb-3">
                  <CheckCircle className="w-5 h-5" />
                  <h3 className="font-bold">Your Submission</h3>
                </div>
                <div className="text-sm text-emerald-700 mb-3">
                  Submitted on {task.user_submission?.submitted_at && formatDate(task.user_submission.submitted_at)}
                </div>
                {task.submission_type === 'text' && task.user_submission?.submission_text && (
                  <div className="bg-white rounded-lg p-4 text-slate-700">
                    {task.user_submission.submission_text}
                  </div>
                )}
                {/*
                  READ FROM `submission_url`, which is where a link is stored.
                  This read `submission_text`, which a link submission never
                  populates: `handleSubmit` sends the link as `url`, the API
                  maps it to `submissionFileUrl`, and the adapter exposes it as
                  `submission_url`. So an intern submitted a link, the write
                  succeeded, and their own submission rendered blank — nothing
                  errored anywhere, which is why it survived.
                */}
                {task.submission_type === 'link' && task.user_submission?.submission_url && (
                  <SafeLink
                    href={task.user_submission.submission_url}
                    className="text-iih-green hover:text-iih-green-darker underline"
                  >
                    {task.user_submission.submission_url}
                  </SafeLink>
                )}
                {task.submission_type === 'file' && task.user_submission?.has_file && (
                  <button
                    type="button"
                    onClick={() =>
                      openSubmissionFile(task.user_submission!.id).catch((err: unknown) =>
                        toast.error(err instanceof Error ? err.message : 'Could not open the file'),
                      )
                    }
                    className="text-iih-green hover:text-iih-green-darker underline"
                  >
                    View submitted file
                  </button>
                )}
                {canWorkTasks && taskStatus === 'submitted' && !editingSubmission && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => {
                        setSubmissionContent(
                          task.submission_type === 'link'
                            ? task.user_submission?.submission_url ?? ''
                            : task.user_submission?.submission_text ?? '',
                        );
                        setEditingSubmission(true);
                      }}
                      className="text-sm font-semibold text-iih-green hover:text-iih-green-darker underline"
                    >
                      Edit submission
                    </button>
                    <p className="text-xs text-emerald-700 mt-1">
                      You can change it until it has been marked.
                    </p>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="mb-6 bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            {canWorkTasks && taskStatus === 'available' && !deadlinePassed && (
              <button
                onClick={handleAccept}
                disabled={accepting}
                className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-bold py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {accepting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-900"></div>
                    Accepting...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-5 h-5" />
                    Accept Task
                  </>
                )}
              </button>
            )}

            {/*
              RETURNED WORK IGNORES THE DEADLINE. When the markers send work back
              (`tasks.returnForChanges`) it is often after the deadline, and the
              message says "resubmit when ready" — gating the form on the
              deadline hid it at exactly that moment, and returned work then sat
              unpaid for good, because nothing settles a `changes_requested` row.
            */}
            {canWorkTasks &&
              ((taskStatus === 'accepted' &&
                (!deadlinePassed || task.user_submission?.status === 'changes_requested')) ||
                (taskStatus === 'submitted' && editingSubmission)) && (
              <div className="space-y-4">
                <h3 className="font-bold text-slate-800">
                  {editingSubmission ? 'Update Your Submission' : 'Submit Your Work'}
                </h3>

                {task.submission_type === 'text' && (
                  <textarea
                    value={submissionContent}
                    onChange={(e) => setSubmissionContent(e.target.value)}
                    className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
                    rows={8}
                    placeholder="Enter your submission here..."
                  />
                )}

                {task.submission_type === 'link' && (
                  <input
                    type="url"
                    value={submissionContent}
                    onChange={(e) => setSubmissionContent(e.target.value)}
                    className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                    placeholder="https://..."
                  />
                )}

                {task.submission_type === 'file' && (
                  <div>
                    {/*
                      `accept` mirrors what convex/files.ts will actually take.
                      Without it the picker offered every file on the device and
                      the rejection arrived only after the upload finished — the
                      worst moment to learn it, and an expensive one on a metered
                      connection.
                    */}
                    <input
                      type="file"
                      accept={SUBMISSION_FILE_ACCEPT}
                      onChange={(e) => setSubmissionFile(e.target.files?.[0] || null)}
                      className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Documents, spreadsheets, slides, images or a zip. Up to 15&nbsp;MB.
                      For something that lives online — a deployed page, a video — use a
                      link task instead.
                    </p>
                    {submissionFile && (
                      <p className="text-sm text-slate-600 mt-2">
                        Selected: {submissionFile.name}
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-bold py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-900"></div>
                      Submitting...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-5 h-5" />
                      {editingSubmission ? 'Update Submission' : 'Submit Task'}
                    </>
                  )}
                </button>
                {editingSubmission && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSubmission(false);
                      setSubmissionContent('');
                      setSubmissionFile(null);
                      setError('');
                    }}
                    className="w-full text-sm font-semibold text-slate-600 hover:text-slate-800 py-2"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}

            {allSubmissions.length > 0 && (
              <div className="mt-8 pt-8 border-t border-slate-200">
                <h2 className="text-xl font-bold text-slate-800 mb-4">Submissions from Peers</h2>
                {loadingSubmissions ? (
                  <div className="text-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-iih-green mx-auto"></div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {allSubmissions.map((submission) => (
                      <div key={submission.id} className="bg-slate-50 rounded-lg p-6">
                        <div className="flex items-start gap-3 mb-4">
                          <div className="w-10 h-10 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-slate-900 font-bold flex-shrink-0">
                            {submission.user?.profile_photo_url ? (
                              <img
                                src={submission.user.profile_photo_url}
                                alt={submission.user?.full_name ?? ''}
                                className="w-10 h-10 rounded-full object-cover"
                              />
                            ) : (
                              getInitials(submission.user?.full_name)
                            )}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-bold text-slate-800">{submission.user?.full_name ?? 'Unknown User'}</h3>
                                <p className="text-sm text-slate-600">
                                  Submitted {formatDate(submission.submitted_at)}
                                </p>
                              </div>
                            </div>

                            <div className="mt-3 bg-white rounded-lg p-4">
                              {task.submission_type === 'text' && submission.submission_text && (
                                <p className="text-slate-700 whitespace-pre-wrap">{submission.submission_text}</p>
                              )}
                              {/* `submission_url`, for the reason at line ~555. */}
                              {task.submission_type === 'link' && submission.submission_url && (
                                <SafeLink
                                  href={submission.submission_url}
                                  className="text-iih-green hover:text-iih-green-darker underline break-all"
                                >
                                  {submission.submission_url}
                                </SafeLink>
                              )}
                              {task.submission_type === 'file' && submission.submission_url && (
                                <SafeLink
                                  href={submission.submission_url}
                                  className="text-iih-green hover:text-iih-green-darker underline"
                                >
                                  View submitted file
                                </SafeLink>
                              )}
                            </div>

                            <div className="flex items-center gap-4 mt-3">
                              <button
                                onClick={() => handleLikeSubmission(submission.id)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                                  submission.has_liked
                                    ? 'bg-rose-100 text-rose-600'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                }`}
                              >
                                <Heart className={`w-4 h-4 ${submission.has_liked ? 'fill-current' : ''}`} />
                                <span className="text-sm font-medium">{submission.likes_count}</span>
                              </button>
                              <div className="flex items-center gap-1.5 text-slate-600">
                                <MessageCircle className="w-4 h-4" />
                                <span className="text-sm font-medium">{submission.comments.length}</span>
                              </div>
                            </div>

                            {submission.comments.length > 0 && (
                              <div className="mt-4 space-y-3">
                                {submission.comments.map((comment) => (
                                  <div key={comment.id} className="flex gap-2 bg-white rounded-lg p-3">
                                    <div className="w-8 h-8 bg-gradient-to-br from-sky-400 to-sky-600 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                                      {comment.user?.profile_photo_url ? (
                                        <img
                                          src={comment.user.profile_photo_url}
                                          alt={comment.user?.full_name ?? ''}
                                          className="w-8 h-8 rounded-full object-cover"
                                        />
                                      ) : (
                                        getInitials(comment.user?.full_name)
                                      )}
                                    </div>
                                    <div className="flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="font-medium text-sm text-slate-800">{comment.user?.full_name ?? 'Unknown'}</span>
                                        <span className="text-xs text-slate-500">{formatDate(comment.created_at)}</span>
                                      </div>
                                      <p className="text-sm text-slate-700 mt-1">{comment.content}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="mt-3 flex gap-2">
                              <input
                                type="text"
                                value={commentContent[submission.id] || ''}
                                onChange={(e) => setCommentContent({ ...commentContent, [submission.id]: e.target.value })}
                                placeholder="Add a comment..."
                                className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-iih-green focus:border-transparent"
                                onKeyPress={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handlePostComment(submission.id);
                                  }
                                }}
                              />
                              <button
                                onClick={() => handlePostComment(submission.id)}
                                disabled={!commentContent[submission.id]?.trim() || postingComment[submission.id]}
                                className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                              >
                                {postingComment[submission.id] ? (
                                  <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <Send className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
