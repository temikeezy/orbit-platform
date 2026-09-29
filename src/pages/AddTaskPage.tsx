import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Loader2, AlertCircle, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import {
  CreateTaskData,
  TaskProgrammeState,
  taskDeadlineFromWatInput,
  taskDeadlineToWatInput,
  tasksApi,
} from '../lib/api/tasks';
import { streamsApi } from '../lib/api/streams';
import { logError } from '../lib/monitoring';

interface Stream {
  id: string;
  name: string;
  is_moderator: boolean;
}

interface AddTaskPageProps {
  streamId?: string;
  onNavigate?: (page: string, id?: string) => void;
}

export function AddTaskPage({ streamId: initialStreamId, onNavigate }: AddTaskPageProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [loadingStreams, setLoadingStreams] = useState(true);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [error, setError] = useState('');
  const [programmeState, setProgrammeState] = useState<TaskProgrammeState | null>(null);
  const deadlineDirty = useRef(false);

  const [formData, setFormData] = useState({
    stream_id: initialStreamId || '',
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

  const applyProgrammeState = useCallback((state: TaskProgrammeState) => {
    setProgrammeState(state);
    if (!deadlineDirty.current && state.defaultDeadline !== null) {
      setFormData((current) => ({
        ...current,
        deadline: taskDeadlineToWatInput(state.defaultDeadline as number),
      }));
    }
    return state;
  }, []);

  const refreshProgrammeState = useCallback(async () => {
    return applyProgrammeState(await tasksApi.getTaskProgrammeState(Date.now()));
  }, [applyProgrammeState]);

  const loadStreams = useCallback(async () => {
    try {
      setLoadingStreams(true);
      const [allStreams, state] = await Promise.all([
        streamsApi.getAllStreams() as unknown as Promise<Stream[]>,
        tasksApi.getTaskProgrammeState(Date.now()),
      ]);
      applyProgrammeState(state);

      if (isAdmin) {
        setStreams(allStreams);
      } else {
        const moderatedStreams = allStreams.filter((s) => s.is_moderator);
        setStreams(moderatedStreams);
      }
    } catch (error) {
      logError(error, { context: 'AddTaskPage.loadStreams' });
      setError('Failed to load streams');
    } finally {
      setLoadingStreams(false);
    }
  }, [applyProgrammeState, isAdmin]);

  useEffect(() => {
    void loadStreams();
  }, [loadStreams]);

  useEffect(() => {
    if (!programmeState) return;

    // Poll the authoritative query instead of duplicating its definition of
    // "meaningful working time" here. Retrying also prevents one network error
    // at commencement or rollover from leaving an open form stale forever.
    const interval = window.setInterval(() => {
      void refreshProgrammeState().catch((error) => {
        logError(error, { context: 'AddTaskPage.refreshProgrammeState' });
      });
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [programmeState, refreshProgrammeState]);

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
     * 1..20, matching TASK_POINTS on the server. It rejected anything below 5
     * while the server accepts 1, so a genuinely light task could not be saved
     * here at all — which the rescored bank makes routine, since its lightest
     * tasks land at 4.
     */
    if (formData.points < 1 || formData.points > 20) {
      setError('Points must be between 5 and 20');
      return;
    }

    if (deadlineDirty.current && !formData.deadline) {
      setError('Please set a deadline');
      return;
    }

    if (deadlineDirty.current && taskDeadlineFromWatInput(formData.deadline) < Date.now()) {
      setError('Deadline must be in the future');
      return;
    }

    try {
      setLoading(true);
      setError('');

      const currentProgramme = await refreshProgrammeState();
      if (!currentProgramme.allowed) {
        setError(currentProgramme.error ?? 'Task creation is not available yet.');
        return;
      }

      const task: CreateTaskData = {
        stream_id: formData.stream_id,
        title: formData.title,
        description: formData.description,
        submission_type: formData.submission_type,
        points: formData.points,
        ...(deadlineDirty.current ? { deadline: formData.deadline } : {}),
      };
      await tasksApi.createTask(task, user.id);

      toast.success('Task created successfully');
      if (initialStreamId) {
        onNavigate?.('stream', initialStreamId);
      } else {
        navigate('/tasks');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create task';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (initialStreamId) {
      onNavigate?.('stream', initialStreamId);
    } else {
      navigate('/tasks');
    }
  };

  if (loadingStreams) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (streams.length === 0) {
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
            <h2 className="text-xl font-bold text-slate-800 mb-2">No Streams Available</h2>
            <p className="text-slate-600">
              You don't have permission to create tasks in any streams.
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
          Back
        </button>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-8">
            <h1 className="text-3xl font-bold text-slate-800 mb-6 flex items-center gap-3">
              <Plus className="w-8 h-8 text-iih-green" />
              Create New Task
            </h1>

            {error && (
              <div className="mb-6 bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            {programmeState && !programmeState.allowed && programmeState.error && (
              <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg">
                {programmeState.error}
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
                  disabled={!!initialStreamId}
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
                    Weekly deliverables use the programme's configured cadence; you can change this deadline.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button
                  type="submit"
                  disabled={loading || !programmeState?.allowed}
                  className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white font-bold py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Creating Task...
                    </>
                  ) : (
                    <>
                      <Save className="w-5 h-5" />
                      Create Task
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={loading}
                  className="px-6 py-3 border border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
