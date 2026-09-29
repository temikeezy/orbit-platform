import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { StreamIcon } from '../lib/streamIcon';
import { Layers, Users, ArrowRight, Search, Grid, List as ListIcon, CheckSquare } from 'lucide-react';
import { streamsApi } from '../lib/api/streams';
import { SkeletonStreamCard } from '../components/common/SkeletonLoader';
import { EmptyState } from '../components/common/EmptyState';
import { logError } from '../lib/monitoring';

interface Stream {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  display_photo_url?: string;
  is_active: boolean;
  created_at: string;
  member_count?: number;
  task_count?: number;
}

type ViewMode = 'grid' | 'list';

export function StreamsPage() {
  const navigate = useNavigate();
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  useEffect(() => {
    loadStreams();
  }, []);

  const loadStreams = async () => {
    try {
      setLoading(true);
      const data = await streamsApi.getActiveStreams();
      data.sort((a, b) => a.name.localeCompare(b.name));
      setStreams(data);
    } catch (error) {
      logError(error, { context: 'StreamsPage.loadStreams' });
    } finally {
      setLoading(false);
    }
  };

  const filteredStreams = streams.filter((stream) =>
    (stream.name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (stream.description ?? '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStreamIcon = (name: string) => {
    if (name.includes('Engineering')) return '⚙️';
    if (name.includes('Design')) return '🎨';
    if (name.includes('Social')) return '📱';
    if (name.includes('Writing')) return '✍️';
    if (name.includes('Event')) return '🎉';
    if (name.includes('Research')) return '🔬';
    if (name.includes('Blockchain')) return '⛓️';
    if (name.includes('Product')) return '🧪';
    if (name.includes('Software')) return '💻';
    if (name.includes('E-Learning')) return '📚';
    if (name.includes('Admin')) return '📋';
    if (name.includes('Telecoms')) return '📡';
    return '🚀';
  };


  const StreamCard = ({ stream }: { stream: Stream }) => (
    <div
      onClick={() => navigate(`/streams/${stream.id}`)}
      className="bg-white rounded-xl shadow-sm border border-slate-200 hover:shadow-lg hover:border-iih-green transition-all cursor-pointer overflow-hidden group"
    >
      <div className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 bg-slate-100">
            {stream.display_photo_url ? (
              <img src={stream.display_photo_url} alt={stream.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-orbit-mint flex items-center justify-center text-iih-green">
                <StreamIcon name={stream.name} className="w-8 h-8" />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 px-2.5 py-1 bg-indigo-50 rounded-full">
              <Users className="w-3.5 h-3.5 text-indigo-600" />
              <span className="text-xs font-medium text-indigo-700">{stream.member_count || 0}</span>
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1 bg-amber-50 rounded-full">
              <CheckSquare className="w-3.5 h-3.5 text-amber-600" />
              <span className="text-xs font-medium text-amber-700">{stream.task_count || 0}</span>
            </div>
          </div>
        </div>

        <h3 className="text-xl font-bold text-slate-800 mb-2 group-hover:text-iih-green-darker transition-colors flex items-center gap-2">
          <span className="text-2xl">{stream.emoji || getStreamIcon(stream.name)}</span>
          {stream.name}
        </h3>
        <p className="text-slate-600 text-sm line-clamp-2 mb-4">{stream.description}</p>

        <button className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-medium py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors">
          View Stream
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const StreamListItem = ({ stream }: { stream: Stream }) => (
    <div
      onClick={() => navigate(`/streams/${stream.id}`)}
      className="bg-white rounded-lg shadow-sm border border-slate-200 hover:shadow-lg hover:border-iih-green transition-all cursor-pointer p-5 group"
    >
      <div className="flex items-center gap-5">
        <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-slate-100">
          {stream.display_photo_url ? (
            <img src={stream.display_photo_url} alt={stream.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-orbit-mint flex items-center justify-center text-iih-green">
              <StreamIcon name={stream.name} className="w-6 h-6" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4 mb-2">
            <h3 className="text-xl font-bold text-slate-800 group-hover:text-iih-green-darker transition-colors flex items-center gap-2">
              <span className="text-2xl">{stream.emoji || getStreamIcon(stream.name)}</span>
              {stream.name}
            </h3>
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="flex items-center gap-1 px-2.5 py-1 bg-indigo-50 rounded-full">
                <Users className="w-3.5 h-3.5 text-indigo-600" />
                <span className="text-xs font-medium text-indigo-700">{stream.member_count || 0}</span>
              </div>
              <div className="flex items-center gap-1 px-2.5 py-1 bg-amber-50 rounded-full">
                <CheckSquare className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-xs font-medium text-amber-700">{stream.task_count || 0}</span>
              </div>
            </div>
          </div>
          <p className="text-slate-600 text-sm line-clamp-2">{stream.description}</p>
        </div>

        <button className="bg-iih-green hover:bg-iih-green-dark text-white font-medium py-2 px-6 rounded-lg flex items-center gap-2 transition-colors flex-shrink-0">
          View
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3 mb-2">
                <Layers className="w-8 h-8 text-iih-green" />
                Streams
              </h1>
              <p className="text-slate-600">
                Join a stream to collaborate with team members and work on tasks
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                aria-pressed={viewMode === 'grid'}
                className={`p-2 rounded-lg transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-iih-green text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Grid className="w-5 h-5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
                className={`p-2 rounded-lg transition-colors ${
                  viewMode === 'list'
                    ? 'bg-iih-green text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <ListIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search streams..."
              aria-label="Search streams"
              className="w-full pl-12 pr-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent bg-white"
            />
          </div>
        </div>

        {loading ? (
          <div className={viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6' : 'space-y-4'}>
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonStreamCard key={i} />
            ))}
          </div>
        ) : filteredStreams.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm">
            <EmptyState
              illustration="🌊"
              title={searchQuery ? 'No streams match your search' : 'No streams yet'}
              description={
                searchQuery
                  ? 'Try a different search term or clear the filter.'
                  : 'Streams are where the action happens. Check back soon or ask an admin to create one.'
              }
              cta={searchQuery ? { label: 'Clear Search', onClick: () => setSearchQuery('') } : undefined}
            />
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredStreams.map((stream) => (
              <StreamCard key={stream.id} stream={stream} />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredStreams.map((stream) => (
              <StreamListItem key={stream.id} stream={stream} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
