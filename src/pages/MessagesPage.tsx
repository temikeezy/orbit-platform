import toast from 'react-hot-toast';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from 'convex/react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { Mail, Inbox, Trash2, Eye, EyeOff, Send, Search, Plus, X } from 'lucide-react';
import { formatDate } from '../lib/utils/date';
import { usersApi } from '../lib/api/users';
import { OrbitUser } from '../types/database';
import { EmptyState } from '../components/common/EmptyState';
import { logError } from '../lib/monitoring';

/**
 * Direct messages, live over the Convex WebSocket.
 *
 * The Supabase realtime channel here had NO FILTER — it subscribed to every
 * INSERT and UPDATE on `orbit_messages`, platform-wide. The callbacks only
 * re-ran the caller's own query, so it did not leak content, but every message
 * anyone sent woke every open tab and made it refetch its whole inbox. The
 * table also had no RLS, and none of the writes on this page carried an
 * ownership predicate:
 *
 *  - mark read / unread patched by message id alone, so anyone holding an id
 *    could flip anyone's mail and relight or clear their badge;
 *  - delete was `.delete().eq('id', ...)` with no check at all;
 *  - the thread pane was `.or('id.eq.<x>,parent_message_id.eq.<x>')`, a filter
 *    string interpolating a raw id, which returned any thread whose root id
 *    the caller could name.
 *
 * Every one of those is now a predicate inside the mutation, next to the write.
 */

interface ThreadMessage {
  id: string;
  content: string;
  senderId: string;
  recipientId: string;
  isMine: boolean;
  isRead: boolean;
  createdAt: number;
  parentMessageId?: string;
  sender: { id: string; fullName: string; profilePhotoUrl?: string } | null;
}

interface InboxMessage {
  id: string;
  content: string;
  isRead: boolean;
  createdAt: number;
  parentMessageId?: string;
  sender: { id: string; fullName: string; profileSlug?: string } | null;
}

export function MessagesPage() {
  const { recipientId } = useParams<{ recipientId?: string }>();
  const { user } = useAuth();
  const token = authService.getToken();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'unread' | 'read'>('all');
  const [showCompose, setShowCompose] = useState(false);
  const [composing, setComposing] = useState(false);
  const [users, setUsers] = useState<OrbitUser[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<OrbitUser[]>([]);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [showRecipientDropdown, setShowRecipientDropdown] = useState(false);
  const [composeForm, setComposeForm] = useState({ content: '' });
  const [replyContent, setReplyContent] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const recipientInputRef = useRef<HTMLInputElement>(null);

  const inbox = useQuery(
    api.messages.inbox,
    token ? { token, limit: 100 } : 'skip',
  ) as InboxMessage[] | undefined;

  const messageThread = (useQuery(
    api.messages.threadOf,
    token && selectedId ? { token, messageId: selectedId as never } : 'skip',
  ) as ThreadMessage[] | undefined) ?? [];

  const sendMessage = useMutation(api.messages.send);
  const replyToMessage = useMutation(api.messages.replyTo);
  const markReadMutation = useMutation(api.messages.markRead);
  const markUnreadMutation = useMutation(api.messages.markUnread);
  const removeMutation = useMutation(api.messages.remove);

  const messages = inbox ?? [];
  const loading = inbox === undefined;
  const selectedMessage = messages.find((m) => m.id === selectedId) ?? null;

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (recipientId) {
      setShowCompose(true);
      const recipient = users.find((u) => u.id === recipientId);
      if (recipient) setSelectedRecipients([recipient]);
    }
  }, [recipientId, users]);

  const loadUsers = async () => {
    try {
      const usersData = await usersApi.getActiveUsers();
      setUsers(usersData.filter((u) => u.id !== user?.id));
    } catch (error) {
      logError(error, { context: 'MessagesPage.loadUsers' });
    }
  };

  const handleAddRecipient = (recipient: OrbitUser) => {
    if (!selectedRecipients.find(r => r.id === recipient.id)) {
      setSelectedRecipients([...selectedRecipients, recipient]);
    }
    setRecipientSearch('');
    setShowRecipientDropdown(false);
  };

  const handleRemoveRecipient = (recipientId: string) => {
    setSelectedRecipients(selectedRecipients.filter(r => r.id !== recipientId));
  };

  const filteredUsers = users.filter(u =>
    (u.full_name ?? '').toLowerCase().includes(recipientSearch.toLowerCase()) ||
    (u.email ?? '').toLowerCase().includes(recipientSearch.toLowerCase())
  );

  const handleSendMessage = async () => {
    if (!token || selectedRecipients.length === 0 || !composeForm.content.trim()) {
      toast.error('Please enter a message and select at least one recipient');
      return;
    }

    try {
      setComposing(true);

      // One mutation per recipient rather than a bulk insert. Each send is
      // rate-limited on the SENDER and queues an email, so a single write
      // fanning out to N recipients would be an email-bombing primitive that
      // costs one request.
      const results = await Promise.all(
        selectedRecipients.map((recipient) =>
          sendMessage({
            token,
            recipientId: recipient.id as never,
            content: composeForm.content,
          }),
        ),
      );

      const failed = results.filter((r) => !r.success);
      if (failed.length === results.length) {
        throw new Error(failed[0]?.error ?? 'Failed to send message');
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} message${failed.length > 1 ? 's' : ''} could not be sent`);
      }

      const sent = results.length - failed.length;
      if (sent > 0) toast.success(`Message sent to ${sent} recipient${sent > 1 ? 's' : ''}`);

      setShowCompose(false);
      setComposeForm({ content: '' });
      setSelectedRecipients([]);
    } catch (error) {
      logError(error, { context: 'MessagesPage.handleSendMessage' });
      toast.error(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      setComposing(false);
    }
  };

  // None of these reload. The mutation invalidates the inbox subscription, so
  // the list re-renders from the server rather than from a hand-patched copy.
  const handleMarkAsRead = async (messageId: string) => {
    if (!token) return;
    try {
      await markReadMutation({ token, messageId: messageId as never });
    } catch (error) {
      logError(error, { context: 'MessagesPage.handleMarkAsRead' });
    }
  };

  const handleMarkAsUnread = async (messageId: string) => {
    if (!token) return;
    try {
      await markUnreadMutation({ token, messageId: messageId as never });
    } catch (error) {
      logError(error, { context: 'MessagesPage.handleMarkAsUnread' });
    }
  };

  const handleDelete = async (messageId: string) => {
    if (!token) return;
    if (!confirm('Are you sure you want to delete this message?')) return;

    try {
      await removeMutation({ token, messageId: messageId as never });
      setSelectedId(null);
    } catch (error) {
      logError(error, { context: 'MessagesPage.handleDelete' });
      toast.error(error instanceof Error ? error.message : 'Could not delete that message');
    }
  };

  const handleSelectMessage = async (message: InboxMessage) => {
    // Selecting sets the id; the thread query re-runs off it. Holding the
    // message object in state meant the pane kept rendering a stale copy after
    // the row changed.
    //
    // The draft goes with the thread it was written for. `handleSendReply`
    // resolves its destination from whatever `selectedMessage` is AT SEND TIME,
    // so a reply typed for one conversation and left in the box while the user
    // clicked another row was delivered into that other conversation — text
    // meant for one person sent to a different one. Dropping an unsent draft on
    // a deliberate thread switch is the cheaper of the two failures.
    if (message.id !== selectedId) setReplyContent('');
    setSelectedId(message.id);
    if (!message.isRead) await handleMarkAsRead(message.id);
  };

  const handleSendReply = async () => {
    if (!token || !selectedMessage || !replyContent.trim()) {
      toast.error('Please enter a reply message');
      return;
    }

    try {
      setSendingReply(true);

      // The recipient is resolved SERVER-SIDE from the parent. The page used to
      // work it out itself and pass it in, which meant the reply's destination
      // was a value the browser chose.
      const result = await replyToMessage({
        token,
        messageId: (selectedMessage.parentMessageId ?? selectedMessage.id) as never,
        content: replyContent,
      });

      if (!result.success) throw new Error(result.error);
      setReplyContent('');
    } catch (error) {
      logError(error, { context: 'MessagesPage.handleSendReply' });
      toast.error(error instanceof Error ? error.message : 'Failed to send reply');
    } finally {
      setSendingReply(false);
    }
  };

  const filteredMessages = messages.filter((msg) => {
    const matchesSearch =
      msg.content?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      msg.sender?.fullName?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesFilter =
      filterType === 'all' ||
      (filterType === 'unread' && !msg.isRead) ||
      (filterType === 'read' && msg.isRead);

    return matchesSearch && matchesFilter;
  });

  const unreadCount = messages.filter((m) => !m.isRead).length;

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-iih-green border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-600">Loading messages...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <Mail className="w-8 h-8 text-iih-green" />
              My Messages
            </h1>
            <p className="text-slate-600 mt-1">
              {unreadCount > 0 ? `${unreadCount} unread message${unreadCount !== 1 ? 's' : ''}` : 'All caught up!'}
            </p>
          </div>
          <button
            onClick={() => setShowCompose(true)}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Compose
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200">
              <div className="p-4 border-b border-slate-200">
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search messages..."
                    className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent text-sm"
                  />
                </div>

                <div className="flex gap-2">
                  {['all', 'unread', 'read'].map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setFilterType(filter as 'all' | 'unread' | 'read')}
                      className={`flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        filterType === filter
                          ? 'bg-iih-green text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {filter === 'all' ? 'All' : filter === 'unread' ? 'Unread' : 'Read'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
                {filteredMessages.length === 0 ? (
                  <EmptyState
                    illustration="💬"
                    title="No messages yet"
                    description="Your inbox is empty. Start a conversation with a fellow community member."
                    cta={{ label: 'New Message', onClick: () => setShowCompose(true) }}
                  />
                ) : (
                  filteredMessages.map((message) => (
                    <button
                      key={message.id}
                      onClick={() => handleSelectMessage(message)}
                      className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
                        selectedMessage?.id === message.id ? 'bg-slate-50' : ''
                      } ${!message.isRead ? 'border-l-4 border-iih-green' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="font-medium text-slate-800 truncate">
                          {message.sender?.fullName ?? 'ORBIT System'}
                        </div>
                        <div className="text-xs text-slate-500 flex-shrink-0">
                          {formatDate(new Date(message.createdAt).toISOString())}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        {!message.isRead && (
                          <div className="w-2 h-2 bg-iih-green rounded-full" />
                        )}
                      </div>
                      <div className="text-sm font-medium text-slate-700 truncate mb-1">
                        {message.sender?.fullName ?? 'ORBIT System'}
                      </div>
                      <div className="text-sm text-slate-500 line-clamp-2">
                        {message.content}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            {selectedMessage ? (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200">
                <div className="p-6 border-b border-slate-200">
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="text-sm text-slate-500">
                          {formatDate(new Date(selectedMessage.createdAt).toISOString())}
                        </div>
                      </div>
                      <h2 className="text-xl font-bold text-slate-800">
                        From: <span className="font-medium">{selectedMessage.sender?.fullName ?? 'ORBIT System'}</span>
                      </h2>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Opposite actions need opposite icons: both branches
                          rendered the same Eye, so the button's meaning was
                          only knowable from a hover tooltip. The aria-labels
                          are the buttons' only accessible names — the icons
                          are all a screen reader would otherwise find. */}
                      {selectedMessage.isRead ? (
                        <button
                          onClick={() => handleMarkAsUnread(selectedMessage.id)}
                          className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                          title="Mark as unread"
                          aria-label="Mark as unread"
                        >
                          <EyeOff className="w-5 h-5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleMarkAsRead(selectedMessage.id)}
                          className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                          title="Mark as read"
                          aria-label="Mark as read"
                        >
                          <Eye className="w-5 h-5" />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(selectedMessage.id)}
                        className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                        title="Delete"
                        aria-label="Delete message"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-6">
                  {messageThread.length > 0 ? (
                    <div className="space-y-4">
                      {messageThread.map((msg) => (
                        <div
                          key={msg.id}
                          className={`p-4 rounded-lg ${
                            msg.senderId === user?.id
                              ? 'bg-iih-green/10 ml-8'
                              : 'bg-slate-50 mr-8'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            {msg.sender?.profilePhotoUrl && (
                              <img
                                src={msg.sender?.profilePhotoUrl}
                                alt={msg.sender?.fullName ?? 'ORBIT System'}
                                className="w-6 h-6 rounded-full"
                              />
                            )}
                            <span className="font-medium text-sm text-slate-800">
                              {msg.sender?.fullName ?? 'ORBIT System'}
                            </span>
                            <span className="text-xs text-slate-500">
                              {formatDate(new Date(msg.createdAt).toISOString())}
                            </span>
                          </div>
                          <div className="text-slate-700 whitespace-pre-wrap">
                            {msg.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="prose max-w-none text-slate-700 whitespace-pre-wrap">
                      {selectedMessage.content}
                    </div>
                  )}

                  <div className="border-t border-slate-200 pt-4">
                    <textarea
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      placeholder="Type your reply..."
                      rows={4}
                      className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
                    />
                    <div className="flex justify-end mt-3">
                      <button
                        onClick={handleSendReply}
                        disabled={sendingReply || !replyContent.trim()}
                        className="bg-iih-green hover:bg-iih-green-dark disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-semibold transition-colors"
                      >
                        {sendingReply ? 'Sending...' : 'Send Reply'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
                <Inbox className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-bold text-slate-800 mb-2">No message selected</h3>
                <p className="text-slate-600">Select a message from the list to view it here</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {showCompose && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-2xl font-bold text-slate-800">Compose Message</h2>
              <button
                onClick={() => {
                  setShowCompose(false);
                  if (!recipientId) {
                    setComposeForm({ content: '' });
                    setSelectedRecipients([]);
                  }
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  To: {selectedRecipients.length > 0 && `(${selectedRecipients.length} recipient${selectedRecipients.length !== 1 ? 's' : ''})`}
                </label>

                <div className="flex flex-wrap gap-2 mb-2">
                  {selectedRecipients.map((recipient) => (
                    <span
                      key={recipient.id}
                      className="inline-flex items-center gap-1 bg-iih-green text-white px-3 py-1 rounded-full text-sm font-medium"
                    >
                      {recipient.full_name}
                      <button
                        onClick={() => handleRemoveRecipient(recipient.id)}
                        className="hover:text-slate-700"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </span>
                  ))}
                </div>

                <div className="relative">
                  <input
                    ref={recipientInputRef}
                    type="text"
                    value={recipientSearch}
                    onChange={(e) => {
                      setRecipientSearch(e.target.value);
                      setShowRecipientDropdown(true);
                    }}
                    onFocus={() => setShowRecipientDropdown(true)}
                    placeholder="Search for users by name or email..."
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                  />

                  {showRecipientDropdown && recipientSearch && filteredUsers.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-slate-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {filteredUsers.map((u) => (
                        <button
                          key={u.id}
                          onClick={() => handleAddRecipient(u)}
                          className="w-full px-4 py-2 text-left hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0"
                        >
                          <div className="font-medium text-slate-800">{u.full_name}</div>
                          <div className="text-sm text-slate-500">{u.email}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Message:
                </label>
                <textarea
                  value={composeForm.content}
                  onChange={(e) => setComposeForm({ ...composeForm, content: e.target.value })}
                  rows={8}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                  placeholder="Type your message here..."
                />
              </div>

              <div className="flex gap-4">
                <button
                  onClick={handleSendMessage}
                  disabled={composing || selectedRecipients.length === 0 || !composeForm.content}
                  className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-5 h-5" />
                  {composing ? 'Sending...' : `Send to ${selectedRecipients.length} recipient${selectedRecipients.length !== 1 ? 's' : ''}`}
                </button>
                <button
                  onClick={() => {
                    setShowCompose(false);
                    if (!recipientId) {
                      setComposeForm({ content: '' });
                      setSelectedRecipients([]);
                    }
                  }}
                  className="px-6 py-3 rounded-lg font-semibold text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
