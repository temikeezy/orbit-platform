import toast from 'react-hot-toast';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { CheckSquare, Clock, Award, Plus, Filter, Layers, CheckCircle, Calendar, ListTodo, Loader2, Bot } from 'lucide-react';
import { FirstStepsTasks } from '../components/tasks/FirstStepsTasks';
import { seesTaskLoop } from '../lib/roles';
import { tasksApi, TaskWithStatus as Task } from '../lib/api/tasks';
import { SkeletonTaskCard } from '../components/common/SkeletonLoader';
import { EmptyState } from '../components/common/EmptyState';
import { logError } from '../lib/monitoring';

/**
 * Navigates itself.
 *
 * It took an optional `onNavigate` prop and App.tsx renders it with no props at
 * all, so the prop was permanently undefined: the Calendar View and Create Task
 * buttons were both wrapped in `{onNavigate && …}` and therefore never rendered
 * for anyone, task titles were not clickable, and the empty state's "Browse
 * Streams" call to action did nothing. Using the router directly removes the
 * conditional entirely.
 */
export function TasksPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [filter, setFilter] = useState<'all' | 'available' | 'accepted' | 'submitted' | 'completed' | 'pending'>('all');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [acceptingTask, setAcceptingTask] = useState<string | null>(null);

  // super_admin counts as admin. The client checked only 'admin', and super
  // admins carry roles: ['super_admin'] alone, so the platform's most
  // privileged users were hidden from their own admin controls.
  const isAdmin =
    Boolean(user?.roles?.includes('admin')) || Boolean(user?.roles?.includes('super_admin'));
  const isModerator = user?.roles?.includes('moderator');
  /**
   * The intern task loop — accept, submit, my-progress filters.
   *
   * `acceptTask` and `submitWork` both refuse anyone who is not an intern and
   * throw, so showing a supervisor those buttons offers them a control that
   * cannot work. Staff still see the task LIST, because reviewing what their
   * streams have been set is their job; they just cannot take one on.
   */
  const canWorkTasks = seesTaskLoop(user);
  const [proposalCount, setProposalCount] = useState(0);

  useEffect(() => {
    loadTasks();
  }, []);

  // Staff only, and failure is silent: a supervisor whose proposal count could
  // not be fetched should still get their task list, not an error toast about a
  // badge.
  useEffect(() => {
    if (!isAdmin && !isModerator) return;
    tasksApi
      .getPendingProposals()
      .then((rows) => setProposalCount(rows.length))
      .catch(() => setProposalCount(0));
  }, [isAdmin, isModerator]);

  const loadTasks = async () => {
    try {
      setLoading(true);
      const data = await tasksApi.getUserTasksWithStatus();
      setTasks(data);
    } catch (error) {
      logError(error, { context: 'TasksPage.loadTasks' });
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptTask = async (taskId: string) => {
    try {
      setAcceptingTask(taskId);
      await tasksApi.acceptTask(taskId);
      await loadTasks();
    } catch (error) {
      logError(error, { context: 'TasksPage.handleAcceptTask' });
      toast.error(error instanceof Error ? error.message : 'Failed to accept task');
    } finally {
      setAcceptingTask(null);
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

  const filteredTasks = tasks.filter((task) => {
    if (!task.is_member_of_stream) return false;
    if (filter === 'all') return true;
    return getTaskStatus(task) === filter;
  });

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

  const getStatusBadge = (task: Task) => {
    const status = getTaskStatus(task);
    switch (status) {
      case 'submitted':
        return { label: 'You Submitted', color: 'bg-emerald-50 text-emerald-700' };
      case 'accepted':
        // 'changes_requested' lands here too, and needs its own label — telling
        // someone their returned work is "You Started" is how it gets forgotten.
        return task.user_submission?.status === 'changes_requested'
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

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <ListTodo className="w-8 h-8 text-iih-green" />
              Tasks
            </h1>
            <p className="text-slate-600 mt-1">Accept and complete tasks to earn points</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {(
              <button
                onClick={() => navigate('/task-calendar')}
                className="bg-white hover:bg-slate-50 border-2 border-slate-200 text-slate-700 font-medium py-2 px-6 rounded-lg flex items-center gap-2 transition-colors"
              >
                <Calendar className="w-5 h-5" />
                Calendar View
              </button>
            )}
            {/* The count is the whole value of this control: a supervisor
                should learn there is something to decide without opening a
                second screen to find out. Hidden entirely at zero. */}
            {(isAdmin || isModerator) && proposalCount > 0 && (
              <button
                onClick={() => navigate('/tasks/proposals')}
                className="bg-amber-50 hover:bg-amber-100 border-2 border-amber-200 text-amber-900 font-medium py-2 px-6 rounded-lg flex items-center gap-2 transition-colors"
              >
                <Bot className="w-5 h-5" />
                {proposalCount} awaiting approval
              </button>
            )}
            {/* Goes to /streams, not to a create form. AddTaskPage is only
                mounted at /streams/:streamId/add-task — a task cannot exist
                without a stream — so choosing the stream IS the first step. */}
            {(isAdmin || isModerator) && (
              <button
                onClick={() => navigate('/streams')}
                className="bg-iih-green hover:bg-iih-green-dark text-white font-medium py-2 px-6 rounded-lg flex items-center gap-2 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Create Task
              </button>
            )}
          </div>
        </div>

        {/*
          ABOVE the filter bar, deliberately outside it. These are derived, not
          `tasks` rows, so they must not appear in the filter counts — those
          enumerate real submission states and are reconciled against the review
          dashboard. Renders nothing for staff, and nothing once finished.
        */}
        <FirstStepsTasks />

        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-slate-400" />
            <div className="flex gap-2">
              {/*
                The "My ..." filters are the intern loop and are dropped for
                staff, who cannot accept or submit anything — for them those two
                tabs would always be empty, which reads as a fault rather than
                as "not applicable to you".
              */}
              {(canWorkTasks
                ? ([
                    { id: 'all', label: 'All Tasks' },
                    { id: 'available', label: 'Not Started' },
                    { id: 'accepted', label: 'My In Progress' },
                    { id: 'submitted', label: 'My Submitted' },
                  ] as const)
                : ([
                    { id: 'all', label: 'All Tasks' },
                    { id: 'available', label: 'Unstarted' },
                  ] as const)
              ).map((filterOption) => (
                <button
                  key={filterOption.id}
                  onClick={() => setFilter(filterOption.id)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    filter === filterOption.id
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {filterOption.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <SkeletonTaskCard key={i} />
            ))
          ) : (
            filteredTasks.map((task) => {
            const statusBadge = getStatusBadge(task);
            const status = getTaskStatus(task);
            const isAccepting = acceptingTask === task.id;

            return (
              <div
                key={task.id}
                className="bg-white rounded-xl shadow-sm p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div className="flex-1">
                    <h3
                      className="text-xl font-bold text-slate-800 hover:text-iih-green cursor-pointer transition-colors mb-2"
                      onClick={() => navigate(`/tasks/${task.id}`)}
                    >
                      {task.title}
                    </h3>
                    <p className="text-slate-600 mb-3">{task.description}</p>
                    {task.stream_name && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-md text-xs font-medium">
                        <Layers className="w-3.5 h-3.5" />
                        {task.stream_name}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className="flex items-center gap-2 bg-emerald-50 text-emerald-700 font-bold px-4 py-2 rounded-lg border border-emerald-200">
                      <Award className="w-5 h-5" />
                      <span className="text-lg">{task.points}</span>
                    </div>
                    <span
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${statusBadge.color}`}
                      title="Your status for this task"
                    >
                      {statusBadge.label}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2 text-slate-600">
                      <Clock className="w-4 h-4" />
                      <span className="text-sm">
                        Due: {new Date(task.deadline).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-600">
                      <CheckSquare className="w-4 h-4" />
                      <span className="text-sm capitalize">{task.submission_type}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-sm font-medium ${
                        getTimeRemaining(task.deadline) === 'Overdue'
                          ? 'text-red-600'
                          : 'text-orange-600'
                      }`}
                    >
                      {getTimeRemaining(task.deadline)}
                    </span>
                    {canWorkTasks && status === 'available' && (
                      <button
                        onClick={() => handleAcceptTask(task.id)}
                        disabled={isAccepting}
                        className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
                      >
                        {isAccepting ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Accepting...
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4" />
                            Accept Task
                          </>
                        )}
                      </button>
                    )}
                    {/* Both of these had NO onClick. They rendered, they
                        hovered, and clicking did nothing — the submission form
                        lives on the task detail page, so that is where they go. */}
                    {canWorkTasks && status === 'accepted' && (
                      <button
                        onClick={() => navigate(`/tasks/${task.id}`)}
                        className="bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                      >
                        Submit Work
                      </button>
                    )}
                    {canWorkTasks && status === 'submitted' && (
                      <button
                        onClick={() => navigate(`/tasks/${task.id}`)}
                        className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors"
                      >
                        View Submission
                      </button>
                    )}
                  </div>
                </div>

                {task.user_submission && (
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <div className="flex items-center gap-4 text-sm text-slate-600">
                      {task.user_submission.accepted_at && (
                        <span>Accepted: {new Date(task.user_submission.accepted_at).toLocaleDateString()}</span>
                      )}
                      {task.user_submission.submitted_at && (
                        <span>Submitted: {new Date(task.user_submission.submitted_at).toLocaleDateString()}</span>
                      )}
                      {/*
                        SCORED OUT OF WHAT. This read "Earned: 9 points", which
                        does not tell an intern whether 9 was nearly all the
                        marks or a quarter of them — and the task's own points
                        are already on the card, so the two numbers sat inches
                        apart without being related to each other.
                      */}
                      {task.user_submission.score != null && (
                        <span className="font-medium text-iih-green">
                          Scored: {task.user_submission.score} / {task.points} points
                        </span>
                      )}
                    </div>

                    {/*
                      Every marked submission carries written feedback, and none
                      of it was rendered anywhere an intern could reach — not on
                      this page and not on the task's own page. The full text is
                      on the task page; this is the first line of it, so the list
                      shows that feedback EXISTS and is worth opening.
                    */}
                    {task.user_submission.feedback && (
                      <p className="mt-2 text-sm text-slate-600 line-clamp-2">
                        <span className="font-medium text-orbit-ink">Feedback: </span>
                        {task.user_submission.feedback}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
          )}
        </div>

        {!loading && filteredTasks.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm">
            <EmptyState
              illustration={filter === 'completed' ? '🏆' : filter === 'pending' ? '⏳' : '📋'}
              title={filter === 'all' ? 'No tasks yet' : `No ${filter} tasks`}
              description={
                filter === 'all'
                  ? 'Join a stream to start receiving tasks and earning points.'
                  : filter === 'completed'
                  ? "You haven't completed any tasks yet. Start one!"
                  : 'No tasks match this filter right now.'
              }
              cta={filter === 'all' ? { label: 'Browse Streams', onClick: () => navigate('/streams') } : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
