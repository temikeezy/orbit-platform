import { useState, useEffect } from 'react';
import { X, Heart, Send, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ActivityPost, PostReply, activityApi } from '../../lib/api/activity';
import { formatDistanceToNow } from '../../lib/utils/date';
import { logError } from '../../lib/monitoring';

interface ReplyThreadModalProps {
  post: ActivityPost;
  isOpen: boolean;
  onClose: () => void;
  onLike: (postId: string) => void;
  onReply: (postId: string, content: string) => void;
}

export function ReplyThreadModal({ post, isOpen, onClose, onLike, onReply }: ReplyThreadModalProps) {
  const [replies, setReplies] = useState<PostReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyContent, setReplyContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadReplies();
    }
  }, [isOpen, post.id]);

  const loadReplies = async () => {
    try {
      setLoading(true);
      const data = await activityApi.getReplies(post.id);
      setReplies(data);
    } catch (error) {
      logError(error, { context: 'ReplyThreadModal.loadReplies' });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyContent.trim() || submitting) return;

    try {
      setSubmitting(true);
      await onReply(post.id, replyContent);
      setReplyContent('');
      await loadReplies();
    } catch (error) {
      logError(error, { context: 'ReplyThreadModal.handleSubmitReply' });
    } finally {
      setSubmitting(false);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reply-thread-title"
    >
      <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] flex overflow-hidden shadow-2xl">
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-slate-200">
            <h2 id="reply-thread-title" className="text-lg font-bold text-slate-800">Comments</h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5 text-slate-600" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="p-6 border-b border-slate-200">
              <div className="flex gap-3">
                <div className="w-10 h-10 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-slate-900 font-bold flex-shrink-0">
                  {post.user.profile_photo_url ? (
                    <img
                      src={post.user.profile_photo_url}
                      alt={post.user.full_name}
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    getInitials(post.user.full_name)
                  )}
                </div>
                <div className="flex-1">
                  <div className="mb-2">
                    <Link to={`/users/${post.user_id || post.user?.id}`} className="font-bold text-slate-800 hover:text-iih-green-darker transition-colors">{post.user.full_name}</Link>
                    <span className="text-slate-500 text-sm ml-2">
                      {formatDistanceToNow(new Date(post.created_at))}
                    </span>
                  </div>
                  <p className="text-slate-700 whitespace-pre-wrap">{post.content}</p>
                  <div className="flex items-center gap-4 mt-3">
                    <button
                      onClick={() => onLike(post.id)}
                      // "this post", not "post": the feed's Like post/Unlike post
                      // buttons stay in the DOM behind this modal, and e2e name
                      // matching is substring — "Like post" must not match here.
                      aria-label={post.user_has_liked ? 'Unlike this post' : 'Like this post'}
                      aria-pressed={post.user_has_liked}
                      className={`flex items-center gap-1 text-sm font-medium ${
                        post.user_has_liked ? 'text-red-600' : 'text-slate-600'
                      }`}
                    >
                      <Heart className={`w-4 h-4 ${post.user_has_liked ? 'fill-current' : ''}`} />
                      {post.likes_count > 0 && <span>{post.likes_count}</span>}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-iih-green" />
                </div>
              ) : replies.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-slate-500">No comments yet. Be the first to comment!</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {replies.map((reply) => (
                    <div key={reply.id} className="flex gap-3">
                      <div className="w-8 h-8 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-slate-900 font-bold flex-shrink-0 text-xs">
                        {reply.user.profile_photo_url ? (
                          <img
                            src={reply.user.profile_photo_url}
                            alt={reply.user.full_name}
                            className="w-8 h-8 rounded-full object-cover"
                          />
                        ) : (
                          getInitials(reply.user.full_name)
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="bg-slate-50 rounded-2xl px-4 py-3">
                          <Link to={`/users/${reply.user?.id}`} className="font-bold text-slate-800 hover:text-iih-green-darker transition-colors text-sm mb-1 block">
                            {reply.user.full_name}
                          </Link>
                          <p className="text-slate-700 text-sm">{reply.content}</p>
                        </div>
                        <div className="flex items-center gap-3 mt-1 px-4">
                          <span className="text-xs text-slate-500">
                            {formatDistanceToNow(new Date(reply.created_at))}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-slate-200 p-4">
            <form onSubmit={handleSubmitReply} className="flex items-center gap-3">
              <input
                type="text"
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder="Add a comment..."
                aria-label="Add a comment"
                className="flex-1 px-4 py-2 border border-slate-200 rounded-full focus:ring-2 focus:ring-iih-green focus:border-transparent"
                disabled={submitting}
              />
              <button
                type="submit"
                disabled={!replyContent.trim() || submitting}
                className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-full font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Post
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
