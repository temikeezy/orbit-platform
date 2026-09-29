import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Calendar, Loader2, Home, Star } from 'lucide-react';
import { CreatePostBox } from '../components/activity/CreatePostBox';
import { OnboardingChecklist } from '../components/home/OnboardingChecklist';
import toast from 'react-hot-toast';
import { ActivityItem } from '../components/activity/ActivityItem';
import { ReplyThreadModal } from '../components/activity/ReplyThreadModal';
import { activityApi, ActivityPost } from '../lib/api/activity';
import { tasksApi } from '../lib/api/tasks';
import { logError } from '../lib/monitoring';

interface UpcomingTask {
  id: string;
  title: string;
  deadline: string;
  points_reward: number;
  stream_name: string;
}

interface FeaturedTask {
  id: string;
  title: string;
  description: string;
  points: number;
  deadline: string;
  stream_name: string;
}

export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [feed, setFeed] = useState<ActivityPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedPost, setSelectedPost] = useState<ActivityPost | null>(null);
  const [isReplyModalOpen, setIsReplyModalOpen] = useState(false);
  const [upcomingTasks, setUpcomingTasks] = useState<UpcomingTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [featuredTask, setFeaturedTask] = useState<FeaturedTask | null>(null);
  const POSTS_PER_PAGE = 10;

  useEffect(() => {
    loadFeed();
    loadTaskPanels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  /**
   * The featured task and the upcoming deadlines, both derived from the ONE
   * membership-gated query the tasks page already uses.
   *
   * Both used to be queries the browser ran straight against the tables. The
   * featured one selected `is_featured = true AND is_active = true` across the
   * whole platform with `.single()` — so it showed a task from a stream the
   * reader is not in, and threw whenever more than one task was featured. The
   * upcoming one read orbit_stream_memberships to find the reader's streams
   * before querying tasks, which meant the browser could ask that table for
   * anyone's memberships by changing the filter.
   */
  const loadTaskPanels = async () => {
    try {
      setLoadingTasks(true);
      if (!user) return;

      const tasks = await tasksApi.getUserTasksWithStatus();
      const mine = tasks.filter((t) => t.is_member_of_stream && t.is_active);

      const featured = mine.find((t) => t.is_featured);
      setFeaturedTask(
        featured
          ? {
              id: featured.id,
              title: featured.title,
              description: featured.description,
              points: featured.points,
              deadline: featured.deadline,
              stream_name: featured.stream_name || 'Unknown Stream',
            }
          : null,
      );

      const now = Date.now();
      setUpcomingTasks(
        mine
          .filter((t) => new Date(t.deadline).getTime() >= now)
          .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
          .slice(0, 5)
          .map((t) => ({
            id: t.id,
            title: t.title,
            deadline: t.deadline,
            points_reward: t.points,
            stream_name: t.stream_name || 'Unknown Stream',
          })),
      );
    } catch (error) {
      logError(error, { context: 'HomePage.loadTaskPanels' });
    } finally {
      setLoadingTasks(false);
    }
  };

  const loadFeed = async () => {
    try {
      setLoading(true);
      const data = await activityApi.getFeed(POSTS_PER_PAGE);
      setFeed(data);
      setHasMore(data.length === POSTS_PER_PAGE);
    } catch (error) {
      logError(error, { context: 'HomePage.loadFeed' });
    } finally {
      setLoading(false);
    }
  };

  /**
   * In flight, as a ref: a ref flips synchronously, state does not. Guarding
   * on `loadingMore` alone let two clicks that both arrived before its
   * re-render both pass, so the same page was fetched and appended twice —
   * every post on it duplicated.
   */
  const loadingMoreRef = useRef(false);

  /**
   * Pages by CURSOR, not offset.
   *
   * With OFFSET, every post created while someone is reading shifts the whole
   * window down by one — so the next page repeats a post and skips none, or
   * skips one and repeats none, depending on which way the feed moved. The
   * timestamp of the last post already rendered is stable under insertion.
   */
  const loadMore = async () => {
    if (loadingMoreRef.current || !hasMore) return;

    const oldest = feed[feed.length - 1]?.created_at_ms;
    if (!oldest) return;

    loadingMoreRef.current = true;
    try {
      setLoadingMore(true);
      const data = await activityApi.getFeed(POSTS_PER_PAGE, oldest);

      if (data.length === 0) {
        setHasMore(false);
      } else {
        // Appended to the feed as it is NOW, not as it was at click time — a
        // like or reply refreshing the list while this page was in flight was
        // otherwise silently overwritten by the closed-over copy.
        setFeed((cur) => [...cur, ...data]);
        setHasMore(data.length === POSTS_PER_PAGE);
      }
    } catch (error) {
      logError(error, { context: 'HomePage.loadMore' });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const handleLike = async (postId: string) => {
    try {
      await activityApi.toggleLike(postId);
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'HomePage.handleLike' });
    }
  };

  const handleReply = async (postId: string, content: string) => {
    try {
      await activityApi.createReply(postId, content);
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'HomePage.handleReply' });
    }
  };

  const handleShowReplies = (postId: string) => {
    const post = feed.find((p) => p.id === postId);
    if (post) {
      setSelectedPost(post);
      setIsReplyModalOpen(true);
    }
  };

  const handleEdit = async (postId: string, content: string) => {
    // The SAVE and the REFRESH are separated deliberately. Wrapping both meant
    // a failed refetch reported an edit that had already been written as though
    // it had failed, and left the editor open over saved content — so the
    // author would edit and save again.
    try {
      await activityApi.editPost(postId, content);
    } catch (error) {
      logError(error, { context: 'HomePage.handleEdit' });
      toast.error(error instanceof Error ? error.message : 'Could not edit that post');
      throw error;
    }

    // Refetched rather than patched in place: the server sets `editedAt`, and
    // the "(edited)" marker has to come from it rather than be assumed. A
    // failure here costs a stale line until the next load, not the edit.
    try {
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'HomePage.handleEdit.refresh' });
    }
  };

  const handleDelete = async (postId: string) => {
    try {
      await activityApi.deletePost(postId);
      await loadFeed();
    } catch (error) {
      logError(error, { context: 'HomePage.handleDelete' });
      throw error;
    }
  };

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-orbit-ink flex items-center gap-3">
            <Home className="w-8 h-8 text-iih-green" />
            Welcome back, {user?.full_name}!
          </h1>
          <p className="text-orbit-muted mt-1">Your stream activity, programme signals, and community updates.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            {/* Renders nothing for staff, and nothing once it is finished. */}
            <OnboardingChecklist />
            <CreatePostBox onPostCreated={loadFeed} />

            {loading ? (
              <div className="orbit-panel p-12 flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
              </div>
            ) : feed.length === 0 ? (
              <div className="orbit-panel p-12 text-center">
                <p className="text-orbit-muted">No activity yet. Start the first ORBIT update.</p>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  {feed.map((post) => (
                    <ActivityItem
                      key={post.id}
                      post={post}
                      onLike={handleLike}
                      onReply={handleReply}
                      onShowReplies={handleShowReplies}
                      onDelete={handleDelete}
                      onEdit={handleEdit}
                    />
                  ))}
                </div>

                {hasMore && (
                  <div className="mt-6 flex justify-center">
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="rounded-lg border border-orbit-line bg-orbit-surface px-6 py-3 font-semibold text-orbit-graphite transition-colors hover:bg-orbit-subtle disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {loadingMore ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading more...
                        </span>
                      ) : (
                        'Load More Posts'
                      )}
                    </button>
                  </div>
                )}
              </>
            )}

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
          </div>

          <div className="space-y-6">
            {/* Challenge of the Week */}
            {featuredTask && (
              <div
                className="orbit-panel cursor-pointer p-5 transition-shadow hover:shadow-orbit-md"
                onClick={() => navigate(`/tasks/${featuredTask.id}`)}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Star className="w-5 h-5 text-orbit-amber fill-orbit-amber" />
                  <span className="text-xs font-bold text-orbit-amber uppercase">
                    Priority Task
                  </span>
                </div>
                <h3 className="font-bold text-orbit-ink text-lg mb-2">{featuredTask.title}</h3>
                <p className="text-orbit-muted text-sm mb-4 line-clamp-2">{featuredTask.description}</p>
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-orbit-mint px-3 py-1 text-sm font-semibold orbit-data">
                    +{featuredTask.points} pts
                  </span>
                  <span className="text-orbit-muted text-xs">
                    {featuredTask.stream_name}
                  </span>
                </div>
              </div>
            )}

            <div className="orbit-panel p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-orbit-ink flex items-center gap-2">
                  <Calendar className="w-5 h-5" />
                  Upcoming Deadlines
                </h2>
                <button
                  onClick={() => navigate('/tasks')}
                  className="text-sm text-iih-green hover:text-iih-green-dark font-medium"
                >
                  View All
                </button>
              </div>
              {loadingTasks ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-iih-green" />
                </div>
              ) : upcomingTasks.length === 0 ? (
                <p className="text-sm text-orbit-muted text-center py-6">No upcoming deadlines</p>
              ) : (
                <div className="space-y-3">
                  {upcomingTasks.map((task) => {
                    const deadlineDate = new Date(task.deadline);
                    const formattedDate = deadlineDate.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric'
                    });
                    const formattedTime = deadlineDate.toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit'
                    });

                    return (
                      <div
                        key={task.id}
                        className="cursor-pointer rounded-lg border border-orbit-line bg-orbit-subtle p-3 transition-colors hover:bg-orbit-mint/50"
                        onClick={() => navigate(`/tasks/${task.id}`)}
                      >
                        <h3 className="font-semibold text-orbit-ink text-sm">{task.title}</h3>
                        <p className="text-xs text-orbit-muted mt-1">
                          {task.stream_name}
                        </p>
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex flex-col">
                            <span className="text-xs font-medium orbit-data">{formattedDate}</span>
                            <span className="text-xs text-orbit-muted">{formattedTime}</span>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-orbit-muted">Points</div>
                            <div className="text-sm font-bold orbit-data">{task.points_reward}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="orbit-panel p-5">
              <h2 className="text-lg font-bold text-orbit-ink mb-2">Your Level</h2>
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full border-4 border-iih-green bg-orbit-mint text-4xl font-bold orbit-data">
                {user?.current_level || 1}
              </div>
              <p className="text-orbit-muted text-sm mb-4">
                {user?.total_points || 0} total points
              </p>
              <button
                onClick={() => navigate('/profile')}
                className="w-full bg-iih-green text-orbit-ink px-4 py-2 rounded-lg font-bold hover:bg-iih-green-dark hover:text-white transition-colors"
              >
                View My ORBIT
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
