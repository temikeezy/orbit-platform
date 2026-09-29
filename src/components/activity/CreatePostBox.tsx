import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Image, Smile, X, Loader2, AtSign } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { activityApi } from '../../lib/api/activity';
import { usersApi } from '../../lib/api/users';
import { OrbitUser } from '../../types/database';
import { logError } from '../../lib/monitoring';

interface CreatePostBoxProps {
  onPostCreated: () => void;
  streamId?: string;
}

export function CreatePostBox({ onPostCreated, streamId }: CreatePostBoxProps) {
  const { user } = useAuth();
  const [content, setContent] = useState('');
  const [posting, setPosting] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionSuggestions, setMentionSuggestions] = useState<OrbitUser[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionCursorPos, setMentionCursorPos] = useState(0);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart ?? val.length;
    setContent(val);

    // Detect @mention: find the last @ before cursor with no spaces after it
    const textBeforeCursor = val.slice(0, cursor);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
    if (mentionMatch) {
      const query = mentionMatch[1];
      setMentionQuery(query);
      setMentionCursorPos(cursor - mentionMatch[0].length);
      setShowMentions(true);
      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
      mentionDebounceRef.current = setTimeout(async () => {
        if (query.length < 1) {
          setMentionSuggestions([]);
          return;
        }
        setMentionLoading(true);
        try {
          const results = await usersApi.searchUsers(query);
          setMentionSuggestions(results.slice(0, 6));
        } catch {
          setMentionSuggestions([]);
        } finally {
          setMentionLoading(false);
        }
      }, 300);
    } else {
      setShowMentions(false);
      setMentionSuggestions([]);
    }
  };

  const insertMention = useCallback((mentionedUser: OrbitUser) => {
    const before = content.slice(0, mentionCursorPos);
    const after = content.slice(mentionCursorPos + mentionQuery.length + 1); // +1 for @
    const newContent = `${before}@${mentionedUser.full_name ?? mentionedUser.email} ${after}`;
    setContent(newContent);
    setShowMentions(false);
    setMentionSuggestions([]);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [content, mentionCursorPos, mentionQuery]);

  // Close mention dropdown on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMentions(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() && !selectedImage) return;
    if (!user?.id) return;

    setPosting(true);
    try {
      // A storage id, not a url. createPost attaches it to the post it
      // creates, and refuses an id belonging to someone else's upload.
      let imageStorageId: string | undefined;
      if (selectedImage) {
        imageStorageId = await activityApi.uploadPostImage(selectedImage);
      }
      await activityApi.createPost(content, streamId, imageStorageId);
      setContent('');
      setSelectedImage(null);
      setImagePreview(null);
      onPostCreated();
    } catch (error) {
      logError(error, { context: 'CreatePostBox.handleSubmit' });
      toast.error(error instanceof Error ? error.message : 'Failed to create post');
    } finally {
      setPosting(false);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }

    setSelectedImage(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setContent(content + emoji);
    setShowEmojiPicker(false);
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
      <div className="flex gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-slate-900 font-bold flex-shrink-0">
          {user?.profile_photo_url ? (
            <img
              src={user.profile_photo_url}
              alt={user.full_name}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            getInitials(user?.full_name || '')
          )}
        </div>
        <form onSubmit={handleSubmit} className="flex-1">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={handleContentChange}
              placeholder="Share your thoughts… use @ to mention someone"
              aria-label="Post content"
              className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
              rows={3}
              disabled={posting}
            />

            {/* @Mention dropdown */}
            {showMentions && (
              <div className="absolute z-50 top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
                {mentionLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-4 h-4 animate-spin text-iih-green" />
                  </div>
                ) : mentionSuggestions.length === 0 ? (
                  <p className="text-sm text-slate-400 px-4 py-3">No users found</p>
                ) : (
                  mentionSuggestions.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
                      className="flex items-center gap-3 w-full px-4 py-2 hover:bg-slate-50 transition-colors text-left"
                    >
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-iih-green to-iih-green-dark flex items-center justify-center text-xs font-bold text-slate-900 flex-shrink-0">
                        {u.profile_photo_url ? (
                          <img src={u.profile_photo_url} alt={u.full_name ?? ''} className="w-8 h-8 rounded-full object-cover" />
                        ) : (
                          getInitials(u.full_name ?? u.email ?? '')
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{u.full_name ?? u.email}</p>
                        {u.full_name && <p className="text-xs text-slate-400 truncate">{u.email}</p>}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {imagePreview && (
            <div className="mt-3 relative inline-block">
              <img
                src={imagePreview}
                alt="Preview"
                className="h-32 rounded-lg object-cover border border-slate-200"
              />
              <button
                type="button"
                onClick={handleRemoveImage}
                aria-label="Remove image"
                className="absolute -top-2 -right-2 bg-rose-500 text-white rounded-full p-1 hover:bg-rose-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
                aria-label="Image attachment"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                title="Add image"
                aria-label="Add image"
                disabled={posting}
              >
                <Image className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  const pos = textareaRef.current?.selectionStart ?? content.length;
                  const newContent = content.slice(0, pos) + '@' + content.slice(pos);
                  setContent(newContent);
                  setTimeout(() => {
                    if (textareaRef.current) {
                      textareaRef.current.focus();
                      textareaRef.current.setSelectionRange(pos + 1, pos + 1);
                    }
                  }, 0);
                }}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                title="Mention someone"
                aria-label="Mention someone"
                disabled={posting}
              >
                <AtSign className="w-5 h-5" />
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                  title="Add emoji"
                  aria-label="Add emoji"
                  disabled={posting}
                >
                  <Smile className="w-5 h-5" />
                </button>
                {showEmojiPicker && (
                  <div className="absolute bottom-full left-0 mb-2 z-50">
                    <div
                      className="fixed inset-0"
                      onClick={() => setShowEmojiPicker(false)}
                    />
                    <div className="relative bg-white border border-slate-200 rounded-xl shadow-xl p-4 pr-6 max-h-96 overflow-y-auto">
                      <h4 className="text-sm font-semibold text-slate-700 mb-3">Select an emoji</h4>
                      <div className="grid grid-cols-8 gap-8">
                        {['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '👍', '👎', '👏', '🙌', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '❤️', '🧡', '💛', '💚', '💙', '💜', '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🔥', '⭐', '✨', '💫', '🌟', '💯', '✅', '❌', '⚠️', '📌', '📍', '🚀', '💡', '🎯'].map((emoji, index) => (
                          <button
                            key={index}
                            type="button"
                            onClick={() => handleEmojiSelect(emoji)}
                            className="w-8 h-8 flex items-center justify-center text-xl hover:bg-slate-100 rounded transition-colors"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <button
              type="submit"
              disabled={(!content.trim() && !selectedImage) || posting}
              className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {posting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Post
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
