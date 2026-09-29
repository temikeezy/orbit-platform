import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { SearchBox } from '../../components/admin/SearchBox';
import { streamsApi } from '../../lib/api/streams';
import { OrbitStream } from '../../types/database';
import { Plus, Users, Edit2, Trash2, Loader2, CheckCircle, XCircle, Layers } from 'lucide-react';

export function StreamsManagementPage() {
  const { user } = useAuth();
  const [streams, setStreams] = useState<OrbitStream[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingStream, setEditingStream] = useState<OrbitStream | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadStreams();
  }, []);

  const loadStreams = async () => {
    try {
      setLoading(true);
      // The management screen is the one place deactivated streams must show:
      // deleteStream deactivates, so they would otherwise vanish with no way back.
      const data = await streamsApi.getAllStreamsIncludingInactive();
      setStreams(data);
    } catch {
      setError('Failed to load streams');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateStream = async (name: string, description: string) => {
    try {
      await streamsApi.createStream({ name, description }, user!.id);
      await loadStreams();
      setShowCreateModal(false);
    } catch (err) {
      // Also RETHROWN. The page-level banner sits behind the modal's own
      // overlay, so on failure the admin saw the spinner stop and nothing else —
      // the modal stayed open with no explanation. The modal reports it inline;
      // the banner remains for when the modal has already closed.
      setError('Failed to create stream');
      throw err;
    }
  };

  const handleUpdateStream = async (id: string, name: string, description: string, isActive: boolean) => {
    try {
      await streamsApi.updateStream(id, { name, description, is_active: isActive });
      await loadStreams();
      setEditingStream(null);
    } catch (err) {
      // Rethrown for the modal — see handleCreateStream.
      setError('Failed to update stream');
      throw err;
    }
  };

  const handleDeleteStream = async (id: string) => {
    if (!confirm('Are you sure you want to delete this stream?')) return;

    try {
      await streamsApi.deleteStream(id);
      await loadStreams();
    } catch {
      setError('Failed to delete stream');
    }
  };

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return streams;
    return streams.filter((st) =>
      [st.name, st.description].filter(Boolean).some((f) => String(f).toLowerCase().includes(needle)),
    );
  }, [streams, search]);

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <Layers className="w-8 h-8 text-iih-green" />
              Stream Management
            </h1>
            <p className="text-slate-600 mt-1">Create and manage program streams</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-3 rounded-lg font-medium flex items-center gap-2 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Create Stream
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search stream name or description…"
          resultCount={shown.length}
          totalCount={streams.length}
          className="mb-4 max-w-lg"
        />

        {/* Named rather than silent: a filtered list that looks empty is the
            same shape as a platform with no streams in it. */}
        {search.trim() && shown.length === 0 && (
          <p className="mb-4 text-sm text-slate-500">
            No stream matches &ldquo;{search.trim()}&rdquo;.
          </p>
        )}

        <div className="space-y-4">
          {shown.map((stream) => (
            <StreamListItem
              key={stream.id}
              stream={stream}
              onEdit={setEditingStream}
              onDelete={handleDeleteStream}
            />
          ))}
        </div>

        {streams.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-800 mb-2">No streams yet</h3>
            <p className="text-slate-600 mb-6">Create your first stream to get started</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium transition-colors"
            >
              Create Stream
            </button>
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateStreamModal onClose={() => setShowCreateModal(false)} onCreate={handleCreateStream} />
      )}

      {editingStream && (
        <EditStreamModal
          stream={editingStream}
          onClose={() => setEditingStream(null)}
          onUpdate={handleUpdateStream}
        />
      )}
    </div>
  );
}

function StreamListItem({
  stream,
  onEdit,
  onDelete,
}: {
  stream: OrbitStream;
  onEdit: (stream: OrbitStream) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6 hover:shadow-md transition-all">
      <div className="flex items-center justify-between gap-6">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="text-xl font-bold text-slate-800">{stream.name}</h3>
            {stream.is_active ? (
              <CheckCircle className="w-5 h-5 text-green-600" />
            ) : (
              <XCircle className="w-5 h-5 text-red-600" />
            )}
          </div>
          <p className="text-slate-600 text-sm line-clamp-1 mb-3">{stream.description || 'No description'}</p>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-slate-500" />
              <span className="text-sm font-medium text-slate-700">{stream.member_count || 0} Members</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-slate-500" />
              <span className="text-sm font-medium text-slate-700">{stream.task_count || 0} Tasks</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onEdit(stream)}
            className="px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg font-medium flex items-center gap-2 transition-colors"
          >
            <Edit2 className="w-4 h-4" />
            Edit
          </button>
          <button
            onClick={() => onDelete(stream.id)}
            className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg font-medium flex items-center gap-2 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateStreamModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onCreate(name, description);
    } catch {
      // Reported HERE, inside the overlay the admin is looking at.
      setError('Could not create the stream. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-stream-modal-title"
    >
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <h2 id="create-stream-modal-title" className="text-2xl font-bold text-slate-800 mb-4">Create New Stream</h2>
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="create-stream-name" className="block text-sm font-medium text-slate-700 mb-2">Stream Name</label>
            <input
              id="create-stream-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., Web Development Track"
            />
          </div>
          <div>
            <label htmlFor="create-stream-description" className="block text-sm font-medium text-slate-700 mb-2">Description</label>
            <textarea
              id="create-stream-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Describe the stream's focus and goals..."
            />
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditStreamModal({
  stream,
  onClose,
  onUpdate,
}: {
  stream: OrbitStream;
  onClose: () => void;
  onUpdate: (id: string, name: string, description: string, isActive: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(stream.name);
  const [description, setDescription] = useState(stream.description || '');
  const [isActive, setIsActive] = useState(stream.is_active);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onUpdate(stream.id, name, description, isActive);
    } catch {
      // Inside the overlay — see CreateStreamModal.
      setError('Could not save the stream. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-stream-modal-title"
    >
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <h2 id="edit-stream-modal-title" className="text-2xl font-bold text-slate-800 mb-4">Edit Stream</h2>
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-stream-name" className="block text-sm font-medium text-slate-700 mb-2">Stream Name</label>
            <input
              id="edit-stream-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="edit-stream-description" className="block text-sm font-medium text-slate-700 mb-2">Description</label>
            <textarea
              id="edit-stream-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="is-active"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
            />
            <label htmlFor="is-active" className="text-sm font-medium text-slate-700">
              Stream is active
            </label>
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Update
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
