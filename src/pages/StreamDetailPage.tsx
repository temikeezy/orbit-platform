import toast from 'react-hot-toast';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Users, Target, Award, Settings,
  Camera, UserPlus, UserMinus, MessageCircle, TrendingUp,
  CheckCircle, CheckSquare, Clock, Loader2, Shield, Plus, Upload, Star,
  Bot,
} from 'lucide-react';
import { StreamIcon } from '../lib/streamIcon';
import { logError } from '../lib/monitoring';
import { useAuth } from '../contexts/AuthContext';
import { streamsApi, StreamMember } from '../lib/api/streams';
// Aliased: the component already has a local `isAdmin` boolean for the viewer.
import { seesProgression, isAdmin as userIsAdmin } from '../lib/roles';
import { streamCopyFor } from '../lib/streamCopy';
import { tasksApi } from '../lib/api/tasks';
import { activityApi, ActivityPost } from '../lib/api/activity';
import { ActivityItem } from '../components/activity/ActivityItem';
import { ReplyThreadModal } from '../components/activity/ReplyThreadModal';
import { CreatePostBox } from '../components/activity/CreatePostBox';
import { StreamChat } from '../components/activity/StreamChat';
import { ImageUpload } from '../components/common/ImageUpload';
import { BulkImportModal } from '../components/admin/BulkImportModal';
import { authService } from '../lib/auth';

interface Stream {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  cover_image_url?: string;
  display_photo_url?: string;
  member_count: number;
  task_count?: number;
  privacy: string;
  join_type: string;
  is_member: boolean;
  is_moderator: boolean;
}

interface Task {
  id: string;
  title: string;
  description: string;
  points: number;
  deadline: string;
  submission_type: string;
  is_active: boolean;
}

export function StreamDetailPage() {
  const navigate = useNavigate();
  const { streamId } = useParams<{ streamId: string }>();
  const { user } = useAuth();

  const [stream, setStream] = useState<Stream | null>(null);
  const [activeTab, setActiveTab] = useState<'activity' | 'members' | 'tasks' | 'stats' | 'chat'>('activity');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  const [feed, setFeed] = useState<ActivityPost[]>([]);
  const [members, setMembers] = useState<StreamMember[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedPost, setSelectedPost] = useState<ActivityPost | null>(null);
  const [isReplyModalOpen, setIsReplyModalOpen] = useState(false);
  const [showCoverUpload, setShowCoverUpload] = useState(false);
  const [showDisplayUpload, setShowDisplayUpload] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [streamStats, setStreamStats] = useState<{
    submissionsTotal: number;
    submissionsApproved: number;
    weeklyPoints: number;
    topContributors: { id: string; full_name: string; profile_photo_url?: string; points: number }[];
  } | null>(null);

  // super_admin counts as admin. A pure super_admin carries
  // roles: ['super_admin'] alone, so `includes('admin')` excluded the platform's
  // most privileged account from its own controls.
  const isAdmin = Boolean(user?.roles?.includes('admin') || user?.roles?.includes('super_admin'));

  /**
   * Which fetch is allowed to write state, one ticket per loader.
   *
   * Every load here is keyed by the route's streamId, and navigating stream
   * A → stream B re-runs them with no cancellation — so A's slower response
   * landing last painted A's header, feed, roster or tasks under B's URL. The
   * same guard SubmissionReviewPage and EmailLogsPage carry; one ref per
   * loader because the tab loads run independently and must not invalidate
   * each other.
   */
  const currentStreamRequest = useRef(0);
  const currentFeedRequest = useRef(0);
  const currentMembersRequest = useRef(0);
  const currentTasksRequest = useRef(0);
  const currentStatsRequest = useRef(0);
  const isModerator = stream?.is_moderator;
  const canEdit = isAdmin || isModerator;

  useEffect(() => {
    if (!streamId) {
      navigate('/streams');
      return;
    }
    loadStreamData();
  }, [streamId, navigate]);

  /**
   * Tab contents load only once membership is known, and only for a viewer the
   * server will actually serve.
   *
   * A private stream's feed, members and tasks are all refused to a non-member,
   * and this effect used to fire before `stream` had arrived — so opening a
   * stream you had not joined issued three requests that were always going to
   * be rejected, and logged each rejection as an error. The page renders its
   * join prompt in that state; it does not need the contents.
   */
  const canViewContents = Boolean(stream && (stream.is_member || isAdmin));

  /**
   * Leaving a stream while the Chat tab is open would otherwise strand you on a
   * tab that no longer exists, showing nothing at all.
   */
  useEffect(() => {
    if (activeTab === 'chat' && !canViewContents) setActiveTab('activity');
  }, [activeTab, canViewContents]);

  useEffect(() => {
    if (!streamId || !canViewContents) return;
    if (activeTab === 'activity') {
      loadFeed();
    } else if (activeTab === 'members') {
      loadMembers();
    } else if (activeTab === 'tasks') {
      loadTasks();
    } else if (activeTab === 'stats' && !streamStats) {
      loadStreamStats();
    }
  }, [activeTab, streamId, canViewContents]);

  if (!streamId) return null;

  const loadStreamData = async () => {
    const request = ++currentStreamRequest.current;
    try {
      setLoading(true);
      const data = await streamsApi.getStreamById(streamId);
      if (request !== currentStreamRequest.current) return;
      setStream(data as unknown as Stream);
    } catch (error) {
      if (request !== currentStreamRequest.current) return;
      logError(error, { context: 'StreamDetailPage.loadStreamData' });
    } finally {
      if (request === currentStreamRequest.current) {
        setLoading(false);
      }
    }
  };

  const loadFeed = async () => {
    const request = ++currentFeedRequest.current;
    try {
      // Filtered server-side. Fetching the global feed and narrowing it in the
      // browser meant this was really "the newest 30 posts platform-wide, then
      // filtered" — so an active stream's own feed was usually empty, and the
      // posts that were discarded had already been sent to a browser that may
      // not have had access to them.
      const data = await activityApi.getFeed(30, undefined, streamId);
      if (request !== currentFeedRequest.current) return;
      setFeed(data);
    } catch (error) {
      if (request !== currentFeedRequest.current) return;
      logError(error, { context: 'StreamDetailPage.loadFeed' });
    }
  };

  const loadMembers = async () => {
    const request = ++currentMembersRequest.current;
    try {
      const data = await streamsApi.getStreamMembers(streamId);
      if (request !== currentMembersRequest.current) return;
      setMembers(data);
    } catch (error) {
      if (request !== currentMembersRequest.current) return;
      logError(error, { context: 'StreamDetailPage.loadMembers' });
    }
  };

  const loadTasks = async () => {
    const request = ++currentTasksRequest.current;
    try {
      const streamTasks = await tasksApi.getTasksByStream(streamId);
      if (request !== currentTasksRequest.current) return;
      setTasks(streamTasks);
    } catch (error) {
      if (request !== currentTasksRequest.current) return;
      logError(error, { context: 'StreamDetailPage.loadTasks' });
    }
  };

  const loadStreamStats = async () => {
    if (!streamId) return;
    const request = ++currentStatsRequest.current;
    try {
      // One server-side call. The page used to run three queries straight
      // against the tables from the browser, one of which selected every
      // member's id, name, photo and exact point total ordered by points — a
      // leaderboard of the stream, assembled client-side, with no regard for
      // who opted out of appearing on one. `streams.stats` applies the same
      // opt-out the leaderboard does, and is gated on membership.
      const stats = await streamsApi.getStreamStats(streamId);
      if (request !== currentStatsRequest.current) return;

      setStreamStats({
        submissionsTotal: stats.submissionCount,
        submissionsApproved: stats.approvedCount,
        weeklyPoints: stats.weeklyPoints,
        topContributors: stats.topContributors.map((u) => ({
          id: u.id,
          full_name: u.fullName,
          profile_photo_url: u.profilePhotoUrl,
          points: u.points,
        })),
      });
    } catch (err) {
      if (request !== currentStatsRequest.current) return;
      logError(err, { context: 'StreamDetailPage.loadStreamStats' });
    }
  };

  const handleJoinLeave = async () => {
    if (!stream) return;

    try {
      setJoining(true);
      const wasMember = stream.is_member;

      if (wasMember) {
        await streamsApi.leaveStream(streamId);
      } else {
        await streamsApi.joinStream(streamId);
      }
      await loadStreamData();

      // Leaving gives up the right to read the roster — `streams.members`
      // refuses a non-member outright. Reloading it unconditionally meant every
      // successful "Leave Stream" was immediately followed by a rejected request
      // and a logged error, on the one path where the refusal is expected.
      if (wasMember && !isAdmin) {
        setMembers([]);
      } else {
        await loadMembers();
      }
    } catch (error) {
      logError(error, { context: 'StreamDetailPage.handleJoinLeave' });
      toast.error(error instanceof Error ? error.message : 'Failed to join/leave stream');
    } finally {
      setJoining(false);
    }
  };

  const handleLike = async (postId: string) => {
    try {
      await activityApi.toggleLike(postId);
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'StreamDetailPage.handleLike' });
    }
  };

  const handleReply = async (postId: string, content: string) => {
    try {
      await activityApi.createReply(postId, content);
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'StreamDetailPage.handleReply' });
    }
  };

  const handleShowReplies = (postId: string) => {
    const post = feed.find((p) => p.id === postId);
    if (post) {
      setSelectedPost(post);
      setIsReplyModalOpen(true);
    }
  };

  const handleDelete = async (postId: string) => {
    try {
      await activityApi.deletePost(postId);
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'StreamDetailPage.handleDelete' });
      throw error;
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
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  if (!stream) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">Stream not found</h2>
          <button
            onClick={() => navigate('/streams')}
            className="text-iih-green hover:underline"
          >
            Back to streams
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div
        className="h-64 bg-slate-200 relative"
        style={
          stream.cover_image_url
            ? { backgroundImage: `url(${stream.cover_image_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : undefined
        }
      >
        {canEdit && (
          <button
            onClick={() => setShowCoverUpload(true)}
            className="absolute top-4 right-4 bg-black/50 hover:bg-black/70 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Camera className="w-4 h-4" />
            Change Cover
          </button>
        )}

        <button
          onClick={() => navigate('/streams')}
          className="absolute top-4 left-4 bg-black/50 hover:bg-black/70 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative -mt-20 mb-6">
          <div className="flex flex-col md:flex-row gap-6 items-start md:items-end">
            <div className="relative">
              <div className="w-40 h-40 bg-white rounded-xl shadow-lg flex items-center justify-center border-4 border-white overflow-hidden">
                {stream.display_photo_url ? (
                  <img
                    src={stream.display_photo_url}
                    alt={stream.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-orbit-mint flex items-center justify-center text-iih-green">
                    <StreamIcon name={stream.name} className="w-9 h-9" />
                  </div>
                )}
              </div>
              {canEdit && (
                <button
                  onClick={() => setShowDisplayUpload(true)}
                  className="absolute bottom-2 right-2 bg-white hover:bg-slate-50 p-2 rounded-full shadow-lg transition-colors border-2 border-white"
                >
                  <Camera className="w-4 h-4 text-slate-600" />
                </button>
              )}
            </div>

            <div className="flex-1">
              <div className="bg-white rounded-xl shadow-sm p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h1 className="text-3xl font-bold text-slate-800 mb-2 flex items-center gap-3">
                      <span className="text-4xl">{stream.emoji || '🚀'}</span>
                      {stream.name}
                    </h1>
                    {/*
                      An admin-written description wins; the curated copy is the
                      fallback. The streams shipped with one-line fragments from
                      the programme spreadsheet, which answer "which row is this"
                      rather than the question someone actually arrives with —
                      is this me, and what will I be doing.
                    */}
                    <p className="text-slate-600">
                      {stream.description && stream.description.length > 60
                        ? stream.description
                        : streamCopyFor(stream.name).description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {canEdit && (
                      <button
                        onClick={() => navigate(`/streams/${streamId}/edit`)}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
                      >
                        <Settings className="w-4 h-4" />
                        Edit
                      </button>
                    )}
                    {!isAdmin && (
                      <button
                        onClick={handleJoinLeave}
                        disabled={joining}
                        className={`flex items-center gap-2 px-6 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 ${
                          stream.is_member
                            ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                            : 'bg-iih-green hover:bg-iih-green-dark text-white'
                        }`}
                      >
                        {joining ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : stream.is_member ? (
                          <>
                            <UserMinus className="w-4 h-4" />
                            Leave Stream
                          </>
                        ) : (
                          <>
                            <UserPlus className="w-4 h-4" />
                            Join Stream
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-6 text-sm text-slate-600">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    <span>{stream.member_count} members</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckSquare className="w-4 h-4" />
                    <span>{tasks.length} tasks</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4" />
                    <span className="capitalize">{stream.privacy}</span>
                  </div>
                  {stream.is_member && (
                    <span className="px-3 py-1 bg-iih-green/10 text-iih-green-dark rounded-full font-medium">
                      Member
                    </span>
                  )}
                  {isModerator && (
                    <span className="px-3 py-1 bg-rose-50 text-rose-700 rounded-full font-medium flex items-center gap-1">
                      <Shield className="w-3 h-3" />
                      Moderator
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm mb-6">
          <div className="border-b border-slate-200">
            <div className="flex gap-1 p-2">
              {[
                { id: 'activity', label: 'Activity', icon: MessageCircle },
                { id: 'members', label: 'Members', icon: Users },
                { id: 'tasks', label: 'Tasks', icon: CheckCircle },
                { id: 'stats', label: 'Stats', icon: TrendingUp },
                /**
                 * Chat is members-only, and the SERVER enforces that — stream
                 * chat used to be readable by anyone who knew a stream id.
                 * Offering the tab to a non-member therefore rendered a
                 * component whose query throws, and the throw reached the error
                 * boundary: clicking Chat on a stream you had not joined
                 * replaced the whole page with "Something went wrong". Reported
                 * from production. Not offering the tab is the fix; the refusal
                 * stays where it belongs.
                 */
                ...(canViewContents
                  ? [{ id: 'chat', label: 'Chat', icon: MessageCircle }]
                  : []),
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as 'activity' | 'members' | 'tasks' | 'stats' | 'chat')}
                  className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-iih-green/10 text-iih-green-dark'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6">
            {activeTab === 'activity' && (
              <div className="space-y-4">
                {/*
                  The ORBIT Agent's greeting, pinned above the feed.

                  Rendered rather than POSTED. A real post would need writing
                  into fourteen streams, would age out of the feed as soon as
                  anyone else posted, and would be one more thing to clean up —
                  the last seeded-content sweep removed six such posts. This
                  says the same thing, stays at the top where a new member
                  actually lands, and belongs to no author's timeline.
                */}
                {stream.is_member && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-full bg-white border border-emerald-200 flex items-center justify-center shrink-0">
                        <Bot className="w-4 h-4 text-iih-green" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800">
                          ORBIT Agent
                        </p>
                        <p className="text-sm text-slate-700 mt-1">
                          {streamCopyFor(stream.name).welcome}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {stream.is_member && <CreatePostBox onPostCreated={loadFeed} streamId={streamId} />}

                {feed.length === 0 ? (
                  <div className="text-center py-12">
                    <MessageCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">No activity yet in this stream</p>
                    {stream.is_member && (
                      <p className="text-slate-500 text-sm mt-2">Be the first to post!</p>
                    )}
                  </div>
                ) : (
                  feed.map((post) => (
                    <ActivityItem
                      key={post.id}
                      post={post}
                      onLike={handleLike}
                      onReply={handleReply}
                      onShowReplies={handleShowReplies}
                      onDelete={handleDelete}
                    />
                  ))
                )}
              </div>
            )}

            {activeTab === 'members' && (
              <div className="space-y-4">
                {/* Bulk import ends at users.adminCreateUser, which is super
                    admin only. A stream moderator pressing this reached a
                    four-step wizard that failed every row. */}
                {canEdit && authService.isSuperAdmin() && (
                  <button
                    onClick={() => setShowBulkImport(true)}
                    className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-medium py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors"
                  >
                    <Upload className="w-5 h-5" />
                    Bulk Import Members
                  </button>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {members.length === 0 ? (
                    <div className="col-span-full text-center py-12">
                      <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                      <p className="text-slate-600">No members yet</p>
                    </div>
                  ) : (
                    members.map((member) => (
                      <div key={member.id} className="bg-slate-50 rounded-lg p-4 flex items-center gap-4 hover:bg-slate-100 transition-colors">
                        <div className="w-12 h-12 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-slate-900 font-bold flex-shrink-0">
                          {member.profile_photo_url ? (
                            <img
                              src={member.profile_photo_url}
                              alt={member.full_name}
                              className="w-12 h-12 rounded-full object-cover"
                            />
                          ) : (
                            getInitials(member.full_name)
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-bold text-slate-800 truncate">{member.full_name}</h3>
                          {/*
                            Progression is an intern device. A supervisor in the
                            roster showed "Level 1 • 0 pts" — true, useless, and
                            it reads as a person who has done nothing rather
                            than a person for whom the ladder does not apply.
                            Their role is the useful thing to show instead.
                          */}
                          {seesProgression(member) ? (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Award className="w-3 h-3" />
                              <span>Level {member.current_level}</span>
                              <span>•</span>
                              <span>{member.total_points} pts</span>
                            </div>
                          ) : (
                            <div className="text-sm text-slate-500">
                              {userIsAdmin(member) ? 'Admin' : 'Supervisor'}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {activeTab === 'tasks' && (
              <div className="space-y-4">
                {(canEdit || isModerator) && (
                  <button
                    onClick={() => navigate(`/streams/${streamId}/add-task`)}
                    className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-medium py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors"
                  >
                    <Plus className="w-5 h-5" />
                    Create New Task
                  </button>
                )}
                {tasks.length === 0 ? (
                  <div className="text-center py-12">
                    <CheckCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">No tasks yet in this stream</p>
                  </div>
                ) : (
                  tasks.map((task) => (
                    <div
                      key={task.id}
                      className="bg-slate-50 rounded-lg p-6 hover:shadow-md transition-shadow cursor-pointer"
                      onClick={() => navigate(`/tasks/${task.id}`)}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <h3 className="text-lg font-bold text-slate-800 hover:text-iih-green transition-colors">{task.title}</h3>
                        <span className="px-3 py-1 bg-green-100 text-slate-900 rounded-full text-sm font-bold">
                          {task.points} pts
                        </span>
                      </div>
                      <p className="text-slate-600 text-sm mb-4 line-clamp-2">{task.description}</p>
                      <div className="flex items-center gap-4 text-sm text-slate-500">
                        <div className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          Due {new Date(task.deadline).toLocaleDateString()}
                        </div>
                        <span className="capitalize">{task.submission_type}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === 'stats' && (
              <div className="space-y-6">
                {/* Core stat cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                  <div className="bg-white border border-slate-200 rounded-lg p-6">
                    <Users className="w-8 h-8 text-emerald-600 mb-3" />
                    <div className="text-3xl font-bold text-slate-800 mb-1">{stream.member_count}</div>
                    <div className="text-slate-600 font-medium">Total Members</div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-lg p-6">
                    <CheckSquare className="w-8 h-8 text-emerald-600 mb-3" />
                    <div className="text-3xl font-bold text-slate-800 mb-1">{stream.task_count ?? 0}</div>
                    <div className="text-slate-600 font-medium">Active Tasks</div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-lg p-6">
                    <MessageCircle className="w-8 h-8 text-emerald-600 mb-3" />
                    <div className="text-3xl font-bold text-slate-800 mb-1">{feed.length}</div>
                    <div className="text-slate-600 font-medium">Recent Posts</div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-lg p-6">
                    <TrendingUp className="w-8 h-8 text-emerald-600 mb-3" />
                    <div className="text-3xl font-bold text-slate-800 mb-1">
                      {streamStats ? streamStats.weeklyPoints.toLocaleString() : '—'}
                    </div>
                    <div className="text-slate-600 font-medium">Points This Week</div>
                  </div>
                </div>

                {/* Submission completion rate */}
                {streamStats && streamStats.submissionsTotal > 0 && (
                  <div className="bg-white border border-slate-200 rounded-lg p-6">
                    <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-emerald-600" />
                      Submission Completion Rate
                    </h3>
                    <div className="flex items-center gap-4">
                      <div className="flex-1 h-4 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-iih-green to-iih-green-dark rounded-full transition-all"
                          style={{
                            width: `${Math.round((streamStats.submissionsApproved / streamStats.submissionsTotal) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="text-lg font-bold text-iih-green-darker whitespace-nowrap">
                        {Math.round((streamStats.submissionsApproved / streamStats.submissionsTotal) * 100)}%
                      </span>
                    </div>
                    <p className="text-sm text-slate-600 mt-2">
                      {streamStats.submissionsApproved} approved of {streamStats.submissionsTotal} submitted
                    </p>
                  </div>
                )}

                {/* Top contributors */}
                {streamStats && streamStats.topContributors.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-lg p-6">
                    <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                      <Star className="w-5 h-5 text-emerald-600" />
                      Top Contributors
                    </h3>
                    <div className="space-y-3">
                      {streamStats.topContributors.map((member, idx) => (
                        <div key={member.id} className="flex items-center gap-3">
                          <span className="w-6 text-center font-bold text-slate-500 text-sm">
                            #{idx + 1}
                          </span>
                          <div className="w-9 h-9 rounded-full bg-iih-green flex items-center justify-center text-white text-xs font-bold overflow-hidden flex-shrink-0">
                            {member.profile_photo_url ? (
                              <img src={member.profile_photo_url} alt={member.full_name} className="w-9 h-9 object-cover" />
                            ) : (
                              getInitials(member.full_name)
                            )}
                          </div>
                          <span className="flex-1 font-medium text-slate-800">{member.full_name}</span>
                          <span className="font-bold text-iih-green">{member.points.toLocaleString()} pts</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!streamStats && (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
                  </div>
                )}
              </div>
            )}

            {activeTab === 'chat' && stream && canViewContents && (
              <StreamChat streamId={streamId} isModerator={canEdit} />
            )}
          </div>
        </div>
      </div>

      {selectedPost && (
        <ReplyThreadModal
          post={selectedPost}
          isOpen={isReplyModalOpen}
          onClose={() => {
            setIsReplyModalOpen(false);
            setSelectedPost(null);
          }}
          onLike={handleLike}
          onReply={handleReply}
        />
      )}

      {showCoverUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full">
            <h3 className="text-xl font-bold text-slate-800 mb-4">Upload Cover Photo</h3>
            <ImageUpload
              label="Cover Photo"
              currentImage={stream?.cover_image_url}
              onUpload={async (file) => {
                await streamsApi.uploadStreamCoverPhoto(streamId, file);
                await loadStreamData();
                setShowCoverUpload(false);
                return '';
              }}
              aspectRatio="wide"
            />
            <button
              onClick={() => setShowCoverUpload(false)}
              className="mt-4 w-full bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showDisplayUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full">
            <h3 className="text-xl font-bold text-slate-800 mb-4">Upload Display Photo</h3>
            <ImageUpload
              label="Display Photo"
              currentImage={stream?.display_photo_url}
              onUpload={async (file) => {
                await streamsApi.uploadStreamDisplayPhoto(streamId, file);
                await loadStreamData();
                setShowDisplayUpload(false);
                return '';
              }}
              aspectRatio="square"
            />
            <button
              onClick={() => setShowDisplayUpload(false)}
              className="mt-4 w-full bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showBulkImport && stream && (
        <BulkImportModal
          onClose={() => setShowBulkImport(false)}
          onComplete={() => {
            setShowBulkImport(false);
            loadMembers();
            loadStreamData();
          }}
          streamId={streamId}
          streamName={stream.name}
        />
      )}
    </div>
  );
}
