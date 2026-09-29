import { useNavigate, useParams } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, Save, Loader2, AlertCircle, Trash2, Edit2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import {
  TaskProgrammeState,
  UpdateTaskData,
  taskDeadlineToWatInput,
  tasksApi,
} from '../lib/api/tasks';
import { streamsApi } from '../lib/api/streams';
import { logError } from '../lib/monitoring';


interface Stream {
  id: string;
  name: string;
  is_moderator?: boolean;
}


export function EditTaskPage() {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [error, setError] = useState('');
  const [programmeState, setProgrammeState] = useState<TaskProgrammeState | null>(null);
  const deadlineDirty = useRef(false);

  const [formData, setFormData] = useState({
    stream_id: '',
    title: '',
    description: '',
    submission_type: 'text' as 'text' | 'file' | 'link',
    points: 10,
    deadline: '',
  });

  // super_admin counts as admin. A pure super_admin carries
  // roles: ['super_admin'] alone, so `includes('admin')` excluded the platform's
  // most privileged account from its own controls.
  const isAdmin = Boolean(user?.roles?.includes('admin') || user?.roles?.includes('super_admin'));

  const loadData = useCallback(async () => {
    if (!taskId) return;
    try {
      setLoadingData(true);
      const [task, allStreams, state] = await Promise.all([
        tasksApi.getTaskById(taskId),
        streamsApi.getAllStreams(),
        tasksApi.getTaskProgrammeState(Date.now()),
      ]);
      setProgrammeState(state);

      if (!task) {
        setError('Task not found');
        return;
      }

      if (isAdmin) {
        setStreams(allStreams as unknown as Stream[]);
      } else {
        const moderatedStreams = (allStreams as unknown as Stream[]).filter((s: Stream) => s.is_moderator);
        setStreams(moderatedStreams);
      }

      const formattedDeadline = taskDeadlineToWatInput(Date.parse(task.deadline));

      setFormData({
        stream_id: task.stream_id,
        title: task.title,
        description: task.description,
        submission_type: task.submission_type || 'text',
        points: task.points,
        deadline: formattedDeadline,
      });
    } catch (error) {
      logError(error, { context: 'EditTaskPage.loadData' });
      setError('Failed to load task');
    } finally {
      setLoadingData(false);
    }
  }, [isAdmin, taskId]);

  useEffect(() => {
    if (!taskId) {
      navigate('/tasks');
      return;
    }
    void loadData();
  }, [taskId, navigate, loadData]);

  useEffect(() => {
    if (!programmeState) return;
    // A retrying query lets the dated notice clear after commencement even if
    // the request at that transition fails; existing edits remain available.
    const interval = window.setInterval(() => {
      void tasksApi.getTaskProgrammeState(Date.now())
        .then(setProgrammeState)
        .catch((error) => logError(error, { context: 'EditTaskPage.refreshProgrammeState' }));
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [programmeState]);

  if (!taskId) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      setError('You must be logged in');
      return;
    }

    if (!formData.stream_id) {
      setError('Please select a stream');
      return;
    }

    if (!formData.title.trim()) {
      setError('Please provide a task title');
      return;
    }

    if (!formData.description.trim()) {
      setError('Please provide a task description');
      return;
    }

    /**
     * 1..20, matching TASK_POINTS on the server.
     *
     * This rejected anything below 5, while the server has always accepted 1 —
     * so a genuinely light task could not be saved through this form at all.
     * That mattered the moment the bank was rescored against a complexity
     * rubric: the lightest tasks land at 4.
     */
    if (formData.points < 1 || formData.points > 20) {
      setError('Points must be between 5 and 20');
      return;
    }

    if (!formData.deadline) {
      setError('Please set a deadline');
      return;
    }

    try {
      setLoading(true);
      setError('');

      const update: UpdateTaskData = {
        title: formData.title,
        description: formData.description,
        submission_type: formData.submission_type,
        points: formData.points,
        ...(deadlineDirty.current ? { deadline: formData.deadline } : {}),
      };
      await tasksApi.updateTask(taskId, update);

      toast.success('Task updated successfully');
      navigate(`/tasks/${taskId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to update task';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this task? This action cannot be undone.')) {
      return;
    }

    try {
      setDeleting(true);
      await tasksApi.deleteTask(taskId);
      toast.success('Task deleted');
      navigate('/tasks');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to delete task';
      setError(msg);
      toast.error(msg);
      setDeleting(false);
    }
  };

  const handleCancel = () => {
    navigate(`/tasks/${taskId}`);
  };

  if (loadingData) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading task...</p>
        </div>
      </div>
    );
  }

  if (streams.length === 0 && !isAdmin) {
    return (
      <div className="min-h-screen bg-orbit-canvas">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <button
            onClick={handleCancel}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
            <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-800 mb-2">No Permission</h2>
            <p className="text-slate-600">
              You don't have permission to edit tasks.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <button
          onClick={handleCancel}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Task
        </button>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-8">
            <h1 className="text-3xl font-bold text-slate-800 mb-6 flex items-center gap-3">
              <Edit2 className="w-8 h-8 text-iih-green" />
              Edit Task
            </h1>

            {error && (
              <div className="mb-6 bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            {programmeState && !programmeState.allowed && programmeState.error && (
              <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg">
                {programmeState.error} You can edit existing task content now, but the task cannot be activated before then.
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="stream" className="block text-sm font-medium text-slate-700 mb-2">
                  Stream <span className="text-rose-500">*</span>
                </label>
                <select
                  id="stream"
                  value={formData.stream_id}
                  onChange={(e) => setFormData({ ...formData, stream_id: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                  required
                >
                  <option value="">Select a stream</option>
                  {streams.map((stream) => (
                    <option key={stream.id} value={stream.id}>
                      {stream.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="title" className="block text-sm font-medium text-slate-700 mb-2">
                  Task Title <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                  placeholder="e.g., Build a Landing Page"
                  required
                  maxLength={200}
                />
              </div>

              <div>
                <label htmlFor="description" className="block text-sm font-medium text-slate-700 mb-2">
                  Description <span className="text-rose-500">*</span>
                </label>
                <textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={6}
                  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
                  placeholder="Provide detailed instructions for this task..."
                  required
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label htmlFor="submission_type" className="block text-sm font-medium text-slate-700 mb-2">
                    Submission Type <span className="text-rose-500">*</span>
                  </label>
                  <select
                    id="submission_type"
                    value={formData.submission_type}
                    onChange={(e) => setFormData({ ...formData, submission_type: e.target.value as 'text' | 'file' | 'link' })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                    required
                  >
                    <option value="text">Text</option>
                    <option value="file">File Upload</option>
                    <option value="link">Link/URL</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="points" className="block text-sm font-medium text-slate-700 mb-2">
                    Points <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    id="points"
                    value={formData.points}
                    onChange={(e) => setFormData({ ...formData, points: parseInt(e.target.value) || 0 })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                    min="1"
                    max="20"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="deadline" className="block text-sm font-medium text-slate-700 mb-2">
                    Deadline <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="datetime-local"
                    id="deadline"
                    value={formData.deadline}
                    onChange={(e) => {
                      deadlineDirty.current = true;
                      setFormData({ ...formData, deadline: e.target.value });
                    }}
                    className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                    required
                  />
                  <p className="text-xs text-slate-500 mt-2">
                    Weekly deliverables use the programme's configured cadence; existing deadlines remain editable.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button
                  type="submit"
                  disabled={loading || deleting}
                  className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white font-bold py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Updating Task...
                    </>
                  ) : (
                    <>
                      <Save className="w-5 h-5" />
                      Update Task
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={loading || deleting}
                  className="px-6 py-3 border border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={loading || deleting}
                  className="px-6 py-3 border border-rose-200 text-rose-700 font-medium rounded-lg hover:bg-rose-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {deleting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
