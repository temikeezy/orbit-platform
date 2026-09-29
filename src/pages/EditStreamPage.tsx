import { useNavigate, useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Loader2, Edit2 } from 'lucide-react';
import { streamsApi } from '../lib/api/streams';
import { ImageUpload } from '../components/common/ImageUpload';
import { EmojiPicker } from '../components/common/EmojiPicker';


interface Stream {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  cover_image_url?: string;
  display_photo_url?: string;
}

export function EditStreamPage() {
  const navigate = useNavigate();
  const { streamId } = useParams<{ streamId: string }>();

  const [stream, setStream] = useState<Stream | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('🚀');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!streamId) {
      navigate('/streams');
      return;
    }
    loadStream();
  }, [streamId, navigate]);

  if (!streamId) return null;

  const loadStream = async () => {
    try {
      setLoading(true);
      const data = await streamsApi.getStreamById(streamId);
      if (!data) throw new Error('Stream not found');
      setStream(data);
      setName(data.name);
      setDescription(data.description || '');
      setEmoji(data.emoji || '🚀');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stream');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      await streamsApi.updateStream(streamId, {
        name,
        description,
        emoji,
        });

      navigate(`/streams/${streamId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const handleCoverUpload = async (file: File) => {
    const url = await streamsApi.uploadStreamCoverPhoto(streamId, file);
    if (stream) {
      setStream({ ...stream, cover_image_url: url });
    }
    return url;
  };

  const handleDisplayUpload = async (file: File) => {
    const url = await streamsApi.uploadStreamDisplayPhoto(streamId, file);
    if (stream) {
      setStream({ ...stream, display_photo_url: url });
    }
    return url;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  if (!stream) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-600 mb-4">Stream not found</p>
          <button
            onClick={() => navigate('/streams')}
            className="text-iih-green hover:underline"
          >
            Back to Streams
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <button
            onClick={() => navigate(`/streams/${streamId}`)}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-800 transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Stream
          </button>
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Edit2 className="w-8 h-8 text-iih-green" />
            Edit Stream
          </h1>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm p-6 space-y-6">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-2">
              Stream Name
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="Enter stream name"
            />
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-medium text-slate-700 mb-2">
              Description
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
              placeholder="Describe this stream..."
            />
          </div>

          <EmojiPicker
            label="Stream Emoji"
            value={emoji}
            onChange={setEmoji}
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-1">
              <ImageUpload
                label="Display Photo"
                currentImage={stream.display_photo_url}
                onUpload={handleDisplayUpload}
                aspectRatio="square"
              />
            </div>

            <div className="md:col-span-2">
              <ImageUpload
                label="Cover Photo"
                currentImage={stream.cover_image_url}
                onUpload={handleCoverUpload}
                aspectRatio="wide"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4">
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="flex items-center gap-2 bg-iih-green hover:bg-iih-green-dark text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save Changes
                </>
              )}
            </button>
            <button
              onClick={() => navigate(`/streams/${streamId}`)}
              className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
