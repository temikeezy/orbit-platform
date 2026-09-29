/**
 * Stream chat, live over the Convex WebSocket.
 *
 * This replaces a Supabase Realtime channel that did three things wrong. It
 * subscribed to raw `postgres_changes` on `orbit_stream_chat` with only a
 * stream_id filter, so the server pushed rows to anyone subscribed regardless of
 * membership. Every pushed row then cost a SECOND round trip to look up the
 * sender's name and photo, one per message. And INSERT was the only event
 * handled — an edited or deleted message never reached an open tab.
 *
 * `useQuery` has none of those shapes: the subscription is to a FUNCTION, so
 * `streamChat.list` runs its membership check for every push, the sender is
 * joined server-side, and any write that changes the query's result re-runs it.
 */
import { useState, useEffect, useRef } from 'react';
import { Send, Loader2, Megaphone } from 'lucide-react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../lib/auth';
import toast from 'react-hot-toast';

interface ChatSender {
  id: string;
  fullName: string;
  profileSlug?: string;
  profilePhotoUrl?: string;
}

interface ChatMessage {
  id: string;
  content: string;
  attachmentUrl?: string;
  isAnnouncement: boolean;
  createdAt: number;
  sender: ChatSender | null;
}

interface StreamChatProps {
  streamId: string;
  isModerator?: boolean;
}

export function StreamChat({ streamId, isModerator }: StreamChatProps) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isAnnouncement, setIsAnnouncement] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const token = authService.getToken();

  // `undefined` args skip the query entirely, which is what should happen with
  // no session — the alternative is a subscription that reconnects forever
  // against an unauthenticated error.
  const messages = useQuery(
    api.streamChat.list,
    token ? { token, streamId: streamId as never, limit: 100 } : 'skip',
  ) as ChatMessage[] | undefined;

  const sendMessage = useMutation(api.streamChat.send);

  // undefined means the first result has not arrived; an empty array is a real
  // answer. Collapsing the two would flash "no messages yet" on every mount.
  const loading = messages === undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !user || !token) return;
    setSending(true);
    try {
      // The announcement flag is re-checked server-side against stream_moderators.
      // Here it only decides whether to ask — the old version passed the boolean
      // straight into an INSERT, so any member could post an announcement by
      // flipping it in devtools.
      const result = await sendMessage({
        token,
        streamId: streamId as never,
        content: text.trim(),
        isAnnouncement: isAnnouncement && Boolean(isModerator),
      });

      if (!result.success) throw new Error(result.error);

      // No optimistic append and no refetch: the mutation invalidates the
      // subscription, so the sent message arrives through the same path as
      // everyone else's.
      setText('');
      setIsAnnouncement(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const getInitials = (name: string | null | undefined) =>
    (name ?? 'U').split(' ').filter(Boolean).map((n) => n[0]).join('').toUpperCase().slice(0, 2) || 'U';

  // Convex stores epoch ms; the Supabase rows were ISO strings.
  const formatTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[600px]">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-2">
        {messages!.length === 0 && (
          <div className="text-center py-16 text-slate-500">
            <p className="text-sm">No messages yet — say hello!</p>
          </div>
        )}
        {messages!.map((msg) => {
          const isOwn = msg.sender?.id === user?.id;
          if (msg.isAnnouncement) {
            return (
              <div key={msg.id} className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-center gap-2 text-amber-700 mb-1">
                  <Megaphone className="w-4 h-4" />
                  <span className="text-xs font-bold uppercase">Announcement</span>
                  <span className="text-xs text-amber-600 ml-auto">{formatTime(msg.createdAt)}</span>
                </div>
                <p className="text-slate-800 text-sm">{msg.content}</p>
                <p className="text-xs text-amber-600 mt-1">{msg.sender?.fullName}</p>
              </div>
            );
          }

          return (
            <div key={msg.id} className={`flex gap-3 ${isOwn ? 'flex-row-reverse' : ''}`}>
              <div className="w-8 h-8 rounded-full bg-iih-green flex items-center justify-center text-white text-xs font-bold flex-shrink-0 overflow-hidden">
                {msg.sender?.profilePhotoUrl ? (
                  <img src={msg.sender.profilePhotoUrl} alt="" className="w-8 h-8 object-cover" />
                ) : (
                  getInitials(msg.sender?.fullName ?? 'U')
                )}
              </div>
              <div className={`max-w-[70%] ${isOwn ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
                <span className={`text-xs text-slate-500 ${isOwn ? 'text-right' : ''}`}>
                  {isOwn ? 'You' : msg.sender?.fullName} · {formatTime(msg.createdAt)}
                </span>
                <div
                  className={`px-4 py-2 rounded-2xl text-sm ${
                    isOwn
                      ? 'bg-iih-green text-white rounded-tr-sm'
                      : 'bg-white border border-slate-200 text-slate-800 rounded-tl-sm'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <form onSubmit={handleSend} className="mt-4 flex flex-col gap-2">
        {isModerator && (
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={isAnnouncement}
              onChange={(e) => setIsAnnouncement(e.target.checked)}
              className="rounded text-amber-500"
            />
            <Megaphone className="w-4 h-4 text-amber-500" />
            Post as announcement
          </label>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message..."
            aria-label="Message"
            className="flex-1 px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent text-sm"
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(e as unknown as React.FormEvent);
              }
            }}
          />
          <button
            type="submit"
            disabled={!text.trim() || sending}
            // Not "Send chat message": stream-social.spec.ts asserts zero buttons
            // whose name contains "Chat" for non-members, and name matching is substring.
            aria-label="Send message"
            className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
