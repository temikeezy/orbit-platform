/**
 * Notifications, live over the Convex WebSocket.
 *
 * The Supabase version subscribed to raw `postgres_changes` on
 * `orbit_notifications` filtered by user_id, and handled INSERT and UPDATE with
 * two separate callbacks that spliced the payload row into local state by hand.
 * DELETE was not handled at all, so removing a notification in another tab left
 * it on screen here until reload.
 *
 * More importantly, mark-as-read NEVER WORKED. The only UPDATE policy on the
 * table was `USING (user_id = auth.uid()) TO authenticated`, but ORBIT
 * authenticates with its own bearer token over the ANON key — so the role never
 * matched, auth.uid() was always null, RLS silently denied the write, and the
 * client's `.update()` matched zero rows while reporting success. The delete
 * below named only a row id and relied on that same policy layer for its
 * authorization.
 *
 * `useQuery` subscribes to a FUNCTION, so every push re-runs `notifications.list`
 * with the caller's own session, and every write that changes the result — from
 * any tab, of any kind — re-renders this list. The ownership check now lives in
 * the same place as the write.
 */
import { Bell, CheckCircle, Info, AlertCircle, X, Award, TrendingUp, MessageSquare, ClipboardList } from 'lucide-react';
import { useQuery, useMutation } from 'convex/react';
import toast from 'react-hot-toast';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { formatDate } from '../lib/utils/date';
import { EmptyState } from '../components/common/EmptyState';

interface Notification {
  id: string;
  type: string;
  title: string;
  content: string;
  isRead: boolean;
  createdAt: number;
}

export function NotificationsPage() {
  const token = authService.getToken();

  const notifications = useQuery(
    api.notifications.list,
    token ? { token, limit: 100 } : 'skip',
  ) as Notification[] | undefined;

  const markReadMutation = useMutation(api.notifications.markRead);
  const markAllReadMutation = useMutation(api.notifications.markAllRead);
  const removeMutation = useMutation(api.notifications.remove);

  // undefined is "the first result has not arrived"; [] is a real answer.
  const loading = notifications === undefined;

  // No reload after any of these three. The mutation invalidates the
  // subscription, so the list re-renders from the server rather than from a
  // hand-patched copy of what the client thinks happened.
  const markAsRead = async (notificationId: string) => {
    if (!token) return;
    try {
      await markReadMutation({ token, notificationId: notificationId as never });
    } catch {
      toast.error('Could not mark notification as read');
    }
  };

  const markAllAsRead = async () => {
    if (!token) return;
    try {
      await markAllReadMutation({ token });
    } catch {
      toast.error('Could not mark notifications as read');
    }
  };

  const deleteNotification = async (notificationId: string) => {
    if (!token) return;
    try {
      await removeMutation({ token, notificationId: notificationId as never });
    } catch {
      toast.error('Could not remove that notification');
    }
  };

  /**
   * The icon for a notification's type.
   *
   * The cases used to be 'success' | 'warning' | 'error', which are not values
   * this app ever produces — every notification the server writes carries a
   * type like 'new_task' or 'level_up', so every row fell to the default and
   * the whole list rendered as one undifferentiated blue Info icon.
   *
   * Level-ups and badges are given their own mark deliberately: they are the
   * only good news in the list, and a congratulation that looks identical to a
   * deadline reminder does not read as one.
   */
  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'level_up':
        return <TrendingUp className="w-5 h-5 text-iih-green" />;
      case 'badge_earned':
        return <Award className="w-5 h-5 text-amber-500" />;
      case 'new_task':
      case 'task_proposed':
        return <ClipboardList className="w-5 h-5 text-blue-600" />;
      case 'new_message':
        return <MessageSquare className="w-5 h-5 text-blue-600" />;
      /**
       * `submission_reviewed` is the REJECTED case, not the approved one.
       * `notifySubmissionReviewed` writes `approved ? 'submission_approved' :
       * 'submission_reviewed'`, so an earlier version of this switch showed the
       * green approval tick to members whose work had been sent back, and gave
       * real approvals the generic blue Info icon.
       */
      case 'submission_approved':
        return <CheckCircle className="w-5 h-5 text-green-600" />;
      case 'submission_reviewed':
        return <AlertCircle className="w-5 h-5 text-amber-600" />;
      case 'submission_unreadable':
        return <AlertCircle className="w-5 h-5 text-amber-600" />;
      default:
        return <Info className="w-5 h-5 text-blue-600" />;
    }
  };

  const unreadCount = (notifications ?? []).filter((n) => !n.isRead).length;

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading notifications...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
                  <Bell className="w-8 h-8 text-iih-green" />
                  Notifications
                </h1>
                {unreadCount > 0 && (
                  <p className="text-sm text-slate-600 mt-1">
                    You have {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllAsRead}
                className="px-4 py-2 text-sm font-medium text-iih-green hover:bg-iih-green hover:text-white rounded-lg border border-iih-green transition-colors"
              >
                Mark all as read
              </button>
            )}
          </div>
        </div>

        {notifications!.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200">
            <EmptyState
              illustration="🔔"
              title="All caught up!"
              description="You have no notifications right now. Complete tasks and interact with the community to stay in the loop."
            />
          </div>
        ) : (
          <div className="space-y-3">
            {notifications!.map((notification) => (
              <div
                key={notification.id}
                className={`bg-white rounded-xl shadow-sm border border-slate-200 p-4 transition-all ${
                  !notification.isRead ? 'bg-blue-50/50' : ''
                }`}
              >
                <div className="flex items-start gap-4">
                  <div className="mt-1">{getNotificationIcon(notification.type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold text-slate-800 mb-1">
                          {notification.title}
                        </h3>
                        <p className="text-sm text-slate-600 mb-2">{notification.content}</p>
                        <p className="text-xs text-slate-500">{formatDate(new Date(notification.createdAt).toISOString())}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {!notification.isRead && (
                          <button
                            onClick={() => markAsRead(notification.id)}
                            className="text-xs text-iih-green hover:underline"
                          >
                            Mark read
                          </button>
                        )}
                        <button
                          onClick={() => deleteNotification(notification.id)}
                          className="text-slate-400 hover:text-red-600 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
