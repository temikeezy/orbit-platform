import { useState, useEffect, useRef } from 'react';
import { X, Calendar, Award, FileText, Layers } from 'lucide-react';
import {
  TaskProgrammeState,
  taskDeadlineToWatInput,
} from '../../lib/api/tasks';

interface Stream {
  id: string;
  name: string;
}

interface CreateTaskModalProps {
  onClose: () => void;
  onSave: (task: TaskData) => void;
  streams?: Stream[];
  programmeState: TaskProgrammeState;
  refreshProgrammeState?: () => Promise<TaskProgrammeState>;
}

export interface TaskData {
  title: string;
  description: string;
  deadline?: string;
  points: number;
  submissionType: 'text' | 'link' | 'file';
  streamId?: string;
  attachments?: string[];
}

export function CreateTaskModal({
  onClose,
  onSave,
  streams,
  programmeState,
  refreshProgrammeState,
}: CreateTaskModalProps) {
  const [taskData, setTaskData] = useState<TaskData>({
    title: '',
    description: '',
    deadline: programmeState.defaultDeadline === null
      ? ''
      : taskDeadlineToWatInput(programmeState.defaultDeadline),
    points: 10,
    submissionType: 'text',
  });
  const [saving, setSaving] = useState(false);
  const [programmeError, setProgrammeError] = useState(programmeState.error ?? '');
  const deadlineDirty = useRef(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Focus moves to the close button ONCE, when the modal opens.
   *
   * This used to share the Escape effect below, and so inherited its `[onClose]`
   * dependency. The parent passes `onClose` as an inline arrow, so its identity
   * changes on every parent render — and the modal's parent re-renders on its
   * own schedule, not the typist's (the programme-state poll alone guarantees it
   * once a minute). Each of those renders re-ran the effect and pulled focus out
   * of whatever field was being filled in. The next space typed then landed on a
   * focused <button>, which activates it: the modal closed and took the
   * half-written task with it. Mount-only is the whole fix — an opening modal
   * should take focus exactly once, and never take it back afterwards.
   */
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    setProgrammeError(programmeState.error ?? '');
    if (!deadlineDirty.current && programmeState.defaultDeadline !== null) {
      setTaskData((current) => ({
        ...current,
        deadline: taskDeadlineToWatInput(programmeState.defaultDeadline as number),
      }));
    }
  }, [programmeState]);

  const handleSave = async () => {
    // No artificial delay. There was a hardcoded 1s setTimeout here before
    // onSave — a full second of fake "Saving…" on every task creation, which
    // also meant the spinner was never showing real work.
    setSaving(true);
    try {
      const currentProgramme = refreshProgrammeState
        ? await refreshProgrammeState()
        : programmeState;
      if (!currentProgramme.allowed) {
        setProgrammeError(currentProgramme.error ?? 'Task creation is not available yet.');
        return;
      }

      if (deadlineDirty.current) {
        await onSave(taskData);
      } else {
        const { deadline: _suggestedDeadline, ...withoutSuggestedDeadline } = taskData;
        await onSave(withoutSuggestedDeadline);
      }
      onClose();
    } catch (error) {
      setProgrammeError(error instanceof Error ? error.message : 'Could not create this task.');
    } finally {
      setSaving(false);
    }
  };

  const isValid = programmeState.allowed && taskData.title && taskData.description && taskData.deadline && taskData.points >= 1 && taskData.points <= 20 && (!streams || taskData.streamId);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={modalRef}
        className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <h2 id="modal-title" className="text-2xl font-bold text-slate-800">Create New Task</h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {programmeError && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {programmeError}
              </div>
            )}
            {streams && streams.length > 0 && (
              <div>
                <label htmlFor="task-stream" className="block text-sm font-medium text-slate-700 mb-2">
                  <Layers className="w-4 h-4 inline mr-1" />
                  Stream *
                </label>
                <select
                  id="task-stream"
                  value={taskData.streamId || ''}
                  onChange={(e) => setTaskData({ ...taskData, streamId: e.target.value })}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                >
                  <option value="">Select a stream</option>
                  {streams.map((stream) => (
                    <option key={stream.id} value={stream.id}>
                      {stream.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="task-title" className="block text-sm font-medium text-slate-700 mb-2">
                Task Title *
              </label>
              <input
                id="task-title"
                type="text"
                value={taskData.title}
                onChange={(e) => setTaskData({ ...taskData, title: e.target.value })}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                placeholder="e.g., Complete React Component Exercise"
              />
            </div>

            <div>
              <label htmlFor="task-description" className="block text-sm font-medium text-slate-700 mb-2">
                Description *
              </label>
              <textarea
                id="task-description"
                value={taskData.description}
                onChange={(e) => setTaskData({ ...taskData, description: e.target.value })}
                rows={4}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                placeholder="Provide detailed instructions for this task..."
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="task-deadline" className="block text-sm font-medium text-slate-700 mb-2">
                  <Calendar className="w-4 h-4 inline mr-1" />
                  Deadline *
                </label>
                <input
                  id="task-deadline"
                  type="datetime-local"
                  value={taskData.deadline}
                  onChange={(e) => {
                    deadlineDirty.current = true;
                    setTaskData({ ...taskData, deadline: e.target.value });
                  }}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Weekly deliverables use the programme's configured cadence; you can change this deadline.
                </p>
              </div>

              <div>
                <label htmlFor="task-points" className="block text-sm font-medium text-slate-700 mb-2">
                  <Award className="w-4 h-4 inline mr-1" />
                  Points *
                </label>
                {/*
                  1-20 matches the server bound (convex/lib/input.ts TASK_POINTS)
                  and LEVELS_SYSTEM.md's "max 20 points per task". This input
                  used to be min=0 step=10 with no ceiling, so it was the loosest
                  of the three creation paths and quietly set the real policy.
                */}
                <input
                  id="task-points"
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={taskData.points}
                  onChange={(e) => setTaskData({ ...taskData, points: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <span id="task-submission-type" className="block text-sm font-medium text-slate-700 mb-2">
                <FileText className="w-4 h-4 inline mr-1" />
                Submission Type *
              </span>
              {/* A group of buttons, not a form field — so it is labelled as a
                  group. A <label> here pointed at nothing. */}
              <div role="group" aria-labelledby="task-submission-type" className="grid grid-cols-3 gap-3 sm:gap-4">
                {(['text', 'link', 'file'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setTaskData({ ...taskData, submissionType: type })}
                    className={`px-4 py-3 rounded-lg font-medium transition-colors capitalize border-2 ${
                      taskData.submissionType === type
                        ? 'border-iih-green bg-green-50 text-iih-green-darker'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                {taskData.submissionType === 'text' && 'Students will submit written text'}
                {taskData.submissionType === 'link' && 'Students will submit a URL/link'}
                {taskData.submissionType === 'file' && 'Students will upload a file'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-slate-200">
          <button
            onClick={onClose}
            className="px-6 py-3 text-slate-600 hover:text-slate-800 font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  );
}
