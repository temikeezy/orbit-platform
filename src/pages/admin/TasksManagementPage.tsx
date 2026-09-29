import toast from 'react-hot-toast';
import { useState, useEffect, useCallback } from 'react';
import { Search, Edit2, Trash2, Plus, CheckCircle, Clock, Award, Filter, AlertCircle, CheckSquare } from 'lucide-react';
import { TaskProgrammeState, tasksApi } from '../../lib/api/tasks';
import { streamsApi } from '../../lib/api/streams';
import { formatDate } from '../../lib/utils/date';
import { CreateTaskModal, TaskData } from '../../components/tasks/CreateTaskModal';
import { useAuth } from '../../contexts/AuthContext';
import { logError } from '../../lib/monitoring';

interface Task {
  id: string;
  stream_id: string;
  stream_name: string;
  title: string;
  description: string;
  points: number;
  deadline: string;
  submission_type: string;
  is_active: boolean;
  created_by_name?: string;
  created_at: string;
  is_dummy?: boolean;
  dummy_source?: string | null;
}

interface Stream {
  id: string;
  name: string;
}

interface TasksManagementPageProps {
  onNavigate?: (page: string, id?: string) => void;
}

export function TasksManagementPage({ onNavigate }: TasksManagementPageProps = {}) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [streamFilter, setStreamFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [programmeState, setProgrammeState] = useState<TaskProgrammeState | null>(null);

  const refreshProgrammeState = useCallback(async () => {
    const state = await tasksApi.getTaskProgrammeState(Date.now());
    setProgrammeState(state);
    return state;
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [allTasks, allStreams, state] = await Promise.all([
        tasksApi.getAllTasks(),
        streamsApi.getAllStreams(),
        tasksApi.getTaskProgrammeState(Date.now()),
      ]);

      setTasks(allTasks);
      setStreams(allStreams);
      setProgrammeState(state);
    } catch (error) {
      logError(error, { context: 'TasksManagementPage.loadData' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!programmeState) return;

    // The server owns rollover policy. Polling its decision avoids recreating
    // that policy in the admin UI and retries after transient network failures.
    const interval = window.setInterval(() => {
      void refreshProgrammeState().catch((error) => {
        logError(error, { context: 'TasksManagementPage.refreshProgrammeState' });
      });
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [programmeState, refreshProgrammeState]);

  const handleEdit = (taskId: string) => {
    if (onNavigate) {
      onNavigate('edit-task', taskId);
    }
  };

  const handleToggleActive = async (taskId: string, currentStatus: boolean) => {
    const action = currentStatus ? 'deactivate' : 'activate';
    if (!confirm(`Are you sure you want to ${action} this task?`)) {
      return;
    }

    try {
      setToggling(taskId);
      await tasksApi.updateTask(taskId, { is_active: !currentStatus });
      await loadData();
    } catch (error) {
      logError(error, { context: 'TasksManagementPage.handleToggleActive' });
      toast.error(error instanceof Error ? error.message : `Failed to ${action} task`);
    } finally {
      setToggling(null);
    }
  };

  const handleDelete = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task? This action cannot be undone.')) {
      return;
    }

    try {
      setDeleting(taskId);
      await tasksApi.deleteTask(taskId);
      await loadData();
    } catch (error) {
      logError(error, { context: 'TasksManagementPage.handleDelete' });
      toast.error(error instanceof Error ? error.message : 'Failed to delete task');
    } finally {
      setDeleting(null);
    }
  };

  const filteredTasks = tasks.filter((task) => {
    const matchesSearch =
      task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.stream_name?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStream = streamFilter === 'all' || task.stream_id === streamFilter;

    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && task.is_active) ||
      (statusFilter === 'inactive' && !task.is_active);

    return matchesSearch && matchesStream && matchesStatus;
  });

  const getSubmissionTypeLabel = (type: string) => {
    switch (type) {
      case 'text':
        return 'Text';
      case 'file':
        return 'File';
      case 'link':
        return 'Link';
      default:
        return type;
    }
  };

  const isDeadlinePassed = (deadline: string) => {
    return new Date(deadline) < new Date();
  };

  const handleCreateTask = async (taskData: TaskData) => {
    try {
      // These refusals THROW; they used to return. The modal awaits this
      // function and reads a resolved promise as a saved task — so a silent
      // return closed the form over whatever had been typed into it, and the
      // toast explaining why went with it. Throwing is how this function
      // already reports every other failure; see the rethrow below.
      if (!taskData.streamId) {
        throw new Error('Please select a stream for the task');
      }

      if (!user?.id) {
        throw new Error('Please log in again');
      }

      await tasksApi.createTask({
        stream_id: taskData.streamId,
        title: taskData.title,
        description: taskData.description,
        ...(taskData.deadline ? { deadline: taskData.deadline } : {}),
        points: taskData.points,
        submission_type: taskData.submissionType,
      }, user.id);

      setShowCreateModal(false);
      loadData();
    } catch (error) {
      logError(error, { context: 'TasksManagementPage.handleCreateTask' });
      toast.error(error instanceof Error ? error.message : 'Failed to create task. Please try again.');
      throw error;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading tasks...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <CheckSquare className="w-8 h-8 text-iih-green" />
              Task Management
            </h1>
            <p className="text-slate-600 mt-1">Manage all tasks across streams</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            disabled={!programmeState?.allowed}
            className="bg-iih-green hover:bg-iih-green-dark text-white font-medium py-2 px-6 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Create Task
          </button>
        </div>

        {programmeState && !programmeState.allowed && programmeState.error && (
          <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg">
            {programmeState.error}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Search tasks by title, description, or stream..."
                  aria-label="Search tasks"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                />
              </div>
              <select
                value={streamFilter}
                onChange={(e) => setStreamFilter(e.target.value)}
                // Not "…by stream": TasksManagementPage.test.tsx locates the
                // CreateTaskModal's Stream select with { name: /stream/i } while
                // this filter is also in the DOM, and name matching is substring.
                aria-label="Filter tasks"
                className="px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              >
                <option value="all">All Streams</option>
                {streams.map((stream) => (
                  <option key={stream.id} value={stream.id}>
                    {stream.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-slate-400" />
              <div className="flex gap-2">
                {(['active', 'inactive', 'all'] as const).map((status) => (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors capitalize ${
                      statusFilter === status
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {status} Tasks
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm mb-4 p-4">
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>
              Showing {filteredTasks.length} of {tasks.length} tasks
            </span>
          </div>
        </div>

        {filteredTasks.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-800 mb-2">No Tasks Found</h3>
            <p className="text-slate-600 mb-6">
              {searchQuery || streamFilter !== 'all'
                ? 'Try adjusting your filters'
                : 'Create your first task to get started'}
            </p>
            {!searchQuery && streamFilter === 'all' && (
              <button
                onClick={() => onNavigate?.('add-task')}
                disabled={!programmeState?.allowed}
                className="bg-iih-green hover:bg-iih-green-dark text-white font-medium py-2 px-6 rounded-lg inline-flex items-center gap-2 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Create Task
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTasks.map((task) => (
              <div
                key={task.id}
                className={`bg-white rounded-xl shadow-sm p-6 hover:shadow-md transition-shadow ${
                  !task.is_active ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <div className="flex items-start gap-3 mb-2">
                      <h3
                        className="text-xl font-bold text-slate-800 hover:text-iih-green cursor-pointer transition-colors flex-1"
                        onClick={() => onNavigate?.('task-detail', task.id)}
                      >
                        {task.title}
                      </h3>
                      {!task.is_active && (
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700">
                          Inactive
                        </span>
                      )}
                      {task.is_dummy && (
                        <span
                          title={task.dummy_source || 'Marked as dummy content'}
                          className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200"
                        >
                          Dummy
                        </span>
                      )}
                      {isDeadlinePassed(task.deadline) && task.is_active && (
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-orange-50 text-orange-700">
                          Expired
                        </span>
                      )}
                    </div>
                    <p className="text-slate-600 mb-3 line-clamp-2">{task.description}</p>
                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-2 text-slate-500">
                        <CheckCircle className="w-4 h-4" />
                        <span>{task.stream_name}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-500">
                        <Clock className="w-4 h-4" />
                        <span>Due {formatDate(task.deadline)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-500">
                        <span className="capitalize">{getSubmissionTypeLabel(task.submission_type)}</span>
                      </div>
                      {task.created_by_name && (
                        <div className="text-slate-500">
                          by {task.created_by_name}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 ml-4">
                    <div className="flex items-center gap-2 bg-green-100 text-slate-900 font-bold text-sm px-3 py-1 rounded-full">
                      <Award className="w-4 h-4" />
                      {task.points} pts
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-4 border-t border-slate-100 flex-wrap">
                  <button
                    onClick={() => handleEdit(task.id)}
                    className="flex items-center gap-2 px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium rounded-lg transition-colors text-sm"
                  >
                    <Edit2 className="w-4 h-4" />
                    Edit
                  </button>
                  <button
                    onClick={() => handleToggleActive(task.id, task.is_active)}
                    disabled={toggling === task.id}
                    className={`flex items-center gap-2 px-3 py-2 font-medium rounded-lg transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                      task.is_active
                        ? 'bg-amber-50 hover:bg-amber-100 text-amber-700'
                        : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {toggling === task.id ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
                        {task.is_active ? 'Deactivating...' : 'Activating...'}
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        {task.is_active ? 'Deactivate' : 'Activate'}
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(task.id)}
                    disabled={deleting === task.id}
                    className="flex items-center gap-2 px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium rounded-lg transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deleting === task.id ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-rose-700"></div>
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
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreateTask}
          streams={streams}
          programmeState={programmeState as TaskProgrammeState}
          refreshProgrammeState={refreshProgrammeState}
        />
      )}
    </div>
  );
}
