import { Heart, MessageCircle, Award, TrendingUp, Trophy, Trash2, Pencil, X, Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ActivityPost } from '../../lib/api/activity';
import { formatDistanceToNow } from '../../lib/utils/date';
import { isAdmin } from '../../lib/roles';
import { useAuth } from '../../contexts/AuthContext';
import { AuthedImage } from '../common/AuthedImage';
import { logError } from '../../lib/monitoring';

interface ActivityItemProps {
  post: ActivityPost;
  onLike: (postId: string) => void;
  onReply: (postId: string, content: string) => void;
  onShowReplies: (postId: string) => void;
  onDelete?: (postId: string) => void;
  onEdit?: (postId: string, content: string) => Promise<void>;
}

export function ActivityItem({ post, onLike, onShowReplies, onDelete, onEdit }: ActivityItemProps) {
  const { user } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.content);
  const [saving, setSaving] = useState(false);

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const handleDelete = async () => {
    if (!onDelete || !window.confirm('Are you sure you want to delete this post?')) return;

    setDeleting(true);
    try {
      await onDelete(post.id);
    } catch (error) {
      logError(error, { context: 'ActivityItem.handleDelete' });
      alert('Failed to delete post. Please try again.');
      setDeleting(false);
    }
  };

  const isOwn = Boolean(user) && post.user_id === user?.id;
  /**
   * Deleting matches what the server permits: the author, OR an admin.
   * `posts.remove` has always allowed admins to take a post down — moderation
   * is their job — but no delete control was ever shown to them, so the only
   * way to act on a reported post was the database.
   */
  const canDelete =
    post.post_type === 'text' && (isOwn || isAdmin(user));
  /**
   * Editing is AUTHOR ONLY — narrower than deleting, which admins may also do.
   * Taking a post down is moderation; rewriting one is not, because it keeps
   * the author's name and timestamp while saying something they did not write.
   * Only plain text posts: the others are generated records of something that
   * happened, and editing those would make the record a lie.
   */
  /**
   * Editing is AUTHOR ONLY, deliberately narrower than deleting. Taking a post
   * down is moderation; rewriting one keeps the author's name and timestamp on
   * words they did not write, which nobody needs to be able to do.
   */
  const canEdit = Boolean(onEdit) && isOwn && post.post_type === 'text';

  const saveEdit = async () => {
    if (!onEdit || !draft.trim() || draft === post.content) {
      setEditing(false);
      setDraft(post.content);
      return;
    }
    setSaving(true);
    try {
      await onEdit(post.id, draft.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const getPostIcon = () => {
    switch (post.post_type) {
      case 'badge':
        return <Trophy className="w-5 h-5 text-yellow-500" />;
      case 'submission':
        return <Award className="w-5 h-5 text-blue-500" />;
      case 'leaderboard':
        return <TrendingUp className="w-5 h-5 text-green-500" />;
      default:
        return null;
    }
  };

  const getPostTypeColor = () => {
    return 'bg-white border-l-4 border-iih-green/30';
  };

  return (
    <div className={`rounded-xl shadow-sm p-6 border ${getPostTypeColor()}`}>
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
          <div className="flex items-start justify-between mb-2">
            <div>
              <div className="flex items-center gap-2">
                <Link to={`/users/${post.user_id || post.user?.id}`} className="font-bold text-slate-800 hover:text-iih-green-darker transition-colors">{post.user.full_name}</Link>
                {post.post_type !== 'text' && (
                  <span className="flex items-center gap-1">
                    {getPostIcon()}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <span>{formatDistanceToNow(new Date(post.created_at))}</span>
                {post.stream && (
                  <>
                    <span>•</span>
                    <span className="text-iih-green-darker font-medium">{post.stream.name}</span>
                  </>
                )}
              </div>
            </div>
            {canEdit && !editing && (
              <button
                onClick={() => {
                  setDraft(post.content);
                  setEditing(true);
                }}
                className="text-slate-400 hover:text-iih-green transition-colors p-2 rounded-lg hover:bg-emerald-50"
                title="Edit post"
                aria-label="Edit post"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-slate-400 hover:text-red-600 transition-colors p-2 rounded-lg hover:bg-red-50 disabled:opacity-50"
                title="Delete post"
                aria-label="Delete post"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {editing ? (
            <div className="mb-4">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                aria-label="Edit post"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={saveEdit}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-iih-green hover:bg-iih-green-dark disabled:opacity-50 text-white text-sm font-medium"
                >
                  <Check className="w-4 h-4" />
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setDraft(post.content);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-700"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-slate-700 mb-4 whitespace-pre-wrap">
              {post.content}
              {/* Says an edit happened without keeping its history — quietly
                  rewriting a post people have replied to changes what the
                  thread appears to be about. */}
              {post.edited_at && (
                <span className="ml-2 text-xs text-slate-400">(edited)</span>
              )}
            </p>
          )}

          {post.image_url && (
            <div className="mb-4">
              {/* Fetched with the session, not rendered from a public url — the
                  route re-checks the stream, so an image in a private stream is
                  not readable by anyone holding the link. */}
              <AuthedImage
                src={post.image_url}
                alt="Post image"
                className="rounded-lg max-h-96 w-auto border border-slate-100"
              />
            </div>
          )}

          <div className="flex items-center gap-4 pt-3 border-t border-slate-100">
            {/* Both buttons contained nothing but an icon and a number, so a
                screen reader announced them as "button, 3" with no indication
                of what they do — and the label carries the current state, which
                is the part a sighted user gets from the fill colour. */}
            <button
              onClick={() => onLike(post.id)}
              aria-label={post.user_has_liked ? 'Unlike post' : 'Like post'}
              aria-pressed={post.user_has_liked}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
                post.user_has_liked
                  ? 'text-red-600 bg-red-50'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Heart className={`w-4 h-4 ${post.user_has_liked ? 'fill-current' : ''}`} />
              <span className="text-sm">{post.likes_count}</span>
            </button>

            <button
              onClick={() => onShowReplies(post.id)}
              aria-label={`Show comments (${post.replies_count})`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <MessageCircle className="w-4 h-4" />
              <span className="text-sm">{post.replies_count}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
