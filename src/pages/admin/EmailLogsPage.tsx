import toast from 'react-hot-toast';
import { useState, useEffect, useRef } from 'react';
import { Mail, Search, Filter, RefreshCw, CheckCircle, XCircle, Clock, Calendar, User, Send, Loader2, Ban, RotateCcw } from 'lucide-react';
import { convexHttp as convex } from '../../lib/convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../../lib/auth';
import { EmailAttemptHistory } from '../../components/admin/EmailAttemptHistory';
import { EmailQueueHealth, type QueueHealth } from '../../components/admin/EmailQueueHealth';
import { logError } from '../../lib/monitoring';

/**
 * A row as returned by `orbit_get_email_logs`.
 *
 * `body_html` / `body_text` are deliberately absent. The queue stores
 * magic-link sign-in URLs and plaintext temporary passwords in those columns,
 * and this page never displayed them — so the RPC leaves them server-side
 * rather than shipping every user's sign-in link to an admin's browser.
 */
interface EmailLog {
  id: string;
  user_id: string;
  recipient_email: string;
  subject: string;
  email_type: string;
  /**
   * ALL FIVE, not three.
   *
   * This was `'sent' | 'failed' | 'pending'` while the backend has produced
   * `processing` and `cancelled` for as long as the claim/lease path has
   * existed — so those rows were mistyped here and fell through the badge
   * switch to an unstyled default. A status the UI cannot name is a row an
   * admin cannot act on.
   */
  status: EmailStatus;
  error_message?: string;
  sent_at?: string;
  failed_at?: string;
  created_at: string;
  retry_count?: number;
  /** Set while a row waits out its retry backoff. */
  next_attempt_at?: string;
}

type EmailStatus = 'sent' | 'failed' | 'pending' | 'processing' | 'cancelled';

interface EmailStats {
  total_sent: number;
  total_failed: number;
  total_pending: number;
  total_today: number;
}

export function EmailLogsPage() {
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<EmailStats>({
    total_sent: 0,
    total_failed: 0,
    total_pending: 0,
    total_today: 0,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | EmailStatus>('all');
  const [selectedLog, setSelectedLog] = useState<EmailLog | null>(null);
  // Body text for the open detail modal, fetched per-email rather than
  // returned with the list (see openLogDetail).
  const [selectedBody, setSelectedBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [health, setHealth] = useState<QueueHealth | null>(null);
  /** The row an action is currently running against, so only its buttons spin. */
  const [actingOn, setActingOn] = useState<string | null>(null);

  const loadHealth = async () => {
    try {
      const token = authService.getToken();
      if (!token) return;
      const result = await convex.query(api.emailQueue.adminQueueHealth, { token });
      setHealth(result as QueueHealth);
    } catch {
      // The header is a summary of the list below it; if it fails the list is
      // still the answer, and an error banner for a summary is noise.
      setHealth(null);
    }
  };

  /**
   * Requeue a failed or cancelled message.
   *
   * Reloads BOTH the list and the header — a retry moves a row between the
   * exact counts the header exists to show, and a stale header contradicting
   * the list it sits above is worse than no header.
   */
  const handleRetry = async (log: EmailLog) => {
    const token = authService.getToken();
    if (!token) return;
    setActingOn(log.id);
    try {
      const result = await convex.mutation(api.emailQueue.adminRetry, {
        token,
        emailId: log.id as never,
      });
      if (result.success) {
        toast.success(`Requeued for ${log.recipient_email}`);
      } else {
        toast.error(result.error ?? 'Could not requeue that email.');
      }
      await Promise.all([loadLogs(), loadHealth()]);
    } catch (error) {
      logError(error, { context: 'EmailLogsPage.handleRetry' });
      toast.error('Could not requeue that email.');
    } finally {
      setActingOn(null);
    }
  };

  /**
   * Stop a message that has not gone out.
   *
   * Confirmed because it is terminal from the recipient's point of view: the
   * person expecting this email will not get it, and nothing else in the system
   * will notice. Requeueable afterwards, which is why the wording says stopped
   * rather than deleted.
   */
  const handleCancel = async (log: EmailLog) => {
    if (
      !window.confirm(
        `Stop this email to ${log.recipient_email}?\n\n"${log.subject}"\n\nIt will not be sent. You can requeue it afterwards if this was a mistake.`,
      )
    ) {
      return;
    }

    const token = authService.getToken();
    if (!token) return;
    setActingOn(log.id);
    try {
      const result = await convex.mutation(api.emailQueue.adminCancel, {
        token,
        emailId: log.id as never,
      });
      if (result.success) {
        toast.success('Email cancelled.');
      } else {
        toast.error(result.error ?? 'Could not cancel that email.');
      }
      await Promise.all([loadLogs(), loadHealth()]);
    } catch (error) {
      logError(error, { context: 'EmailLogsPage.handleCancel' });
      toast.error('Could not cancel that email.');
    } finally {
      setActingOn(null);
    }
  };

  /**
   * Which fetch is allowed to write state, for the list and the detail modal.
   *
   * Refs, not state: each is read by a callback created in an earlier render,
   * which is exactly what state cannot do. This is the same guard
   * SubmissionReviewPage and ApplicationsTab already carry; this page never got
   * it. For the modal it matters more than usual — an email body here contains
   * live sign-in links and temporary passwords, so a body rendered under
   * another email's header is not a cosmetic mix-up, it misattributes a
   * credential to the wrong recipient.
   */
  const currentListRequest = useRef(0);
  const currentBodyRequest = useRef(0);

  useEffect(() => {
    loadLogs();
  }, [statusFilter]);

  // Health is filter-independent — it describes the queue, not the current
  // view — so it loads once rather than on every filter change.
  useEffect(() => {
    loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Load rows and stats in one call.
   *
   * Reads through `orbit_get_email_logs` rather than querying
   * `orbit_email_queue` directly: the table's anon RLS policies were removed
   * because the queue carries sign-in links and temp passwords, so the browser
   * can no longer select from it. The RPC re-grants exactly this page's needs
   * behind a server-side admin check on the caller's token. Stats are computed
   * in SQL over the whole table rather than over the fetched page, which also
   * fixes the previous counts being capped at whatever the client had loaded.
   */
  /**
   * Rows and stats in one call.
   *
   * Reads through `emailQueue.adminList` rather than querying the table: the
   * queue carries sign-in links and plaintext temporary passwords, so nothing
   * client-side may select from it. The stats are computed over the WHOLE
   * table server-side — counted from the fetched page they were capped at
   * whatever had loaded, so "3 failed" meant "3 failed among the 100 rows on
   * screen".
   */
  const loadLogs = async () => {
    const request = ++currentListRequest.current;
    try {
      setLoading(true);
      const token = authService.getToken();
      if (!token) throw new Error('Not authenticated');

      const result = await convex.query(api.emailQueue.adminList, {
        token,
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });

      // A stale filter's response must not repaint the list under the newer
      // filter's heading — the same reason the modal guards its body below.
      if (request !== currentListRequest.current) return;

      setLogs(
        result.logs.map((e) => ({
          id: e.id,
          user_id: '',
          recipient_email: e.recipientEmail,
          subject: e.subject,
          email_type: e.emailType,
          status: e.status as EmailStatus,
          error_message: e.errorMessage,
          sent_at: e.sentAt ? new Date(e.sentAt).toISOString() : undefined,
          failed_at: e.failedAt ? new Date(e.failedAt).toISOString() : undefined,
          created_at: new Date(e.createdAt).toISOString(),
          retry_count: e.retryCount,
          next_attempt_at: e.nextAttemptAt ? new Date(e.nextAttemptAt).toISOString() : undefined,
        })),
      );

      setStats({
        total_sent: result.stats.sent,
        total_failed: result.stats.failed,
        total_pending: result.stats.pending,
        total_today: result.stats.today,
      });
    } catch (error) {
      logError(error, { context: 'EmailLogsPage.loadLogs' });
      if (request === currentListRequest.current) {
        toast.error(error instanceof Error ? error.message : 'Failed to load email logs');
      }
    } finally {
      if (request === currentListRequest.current) setLoading(false);
    }
  };

  /**
   * Opens the detail modal and pulls that one email's body.
   *
   * SUPER ADMIN ONLY, and audited — a magic-link body is a live sign-in
   * credential for whoever it was addressed to, so reading one is
   * impersonation with extra steps and leaves a trace naming who looked. It is
   * fetched per-email rather than arriving with the list so those credentials
   * stay server-side for the other 99 rows.
   */
  const openLogDetail = async (log: EmailLog) => {
    const request = ++currentBodyRequest.current;
    setSelectedLog(log);
    setSelectedBody(null);
    try {
      setBodyLoading(true);
      const token = authService.getToken();
      if (!token) throw new Error('Not authenticated');

      const result = await convex.mutation(api.emailQueue.adminGetBody, {
        token,
        emailId: log.id as never,
      });
      if (!result.success) throw new Error(result.error);

      if (request !== currentBodyRequest.current) return;
      setSelectedBody(result.bodyText ?? '(no plain-text body stored)');
    } catch (error) {
      logError(error, { context: 'EmailLogsPage.openLogDetail' });
      if (request !== currentBodyRequest.current) return;
      setSelectedBody(
        `Could not load body: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      // Only the newest request owns the spinner, or an older one resolving
      // late clears it while the current fetch is still running.
      if (request === currentBodyRequest.current) setBodyLoading(false);
    }
  };

  const closeLogDetail = () => {
    // Retires any in-flight body fetch, so one resolving after the modal closes
    // cannot populate it again behind the admin's back.
    currentBodyRequest.current++;
    setSelectedLog(null);
    setSelectedBody(null);
    setBodyLoading(false);
  };

  /**
   * Runs the queue now rather than waiting for the two-minute cron.
   *
   * The old version POSTed to a Supabase edge function with the ANON KEY as
   * its Authorization header — an unauthenticated endpoint that drained the
   * mail queue, callable by anyone who read the bundle. This is admin-gated
   * and audited, and it SCHEDULES: the send is an action, and holding the
   * request open for a batch would time out on any real backlog.
   */
  const processEmailQueue = async () => {
    if (processing) return;

    try {
      setProcessing(true);
      const token = authService.getToken();
      if (!token) throw new Error('Not authenticated');

      const result = await convex.mutation(api.emailQueue.adminProcessNow, { token });

      toast.success(
        result.queued > 0
          ? `Sending ${result.queued} queued email${result.queued > 1 ? 's' : ''}…`
          : 'Nothing pending in the queue.',
      );

      // The send runs in the background, so the list is refreshed a moment
      // later rather than immediately — an instant reload would show the same
      // pending rows and read as a button that does nothing.
      setTimeout(() => void loadLogs(), 2000);
    } catch (error) {
      logError(error, { context: 'EmailLogsPage.processEmailQueue' });
      toast.error(error instanceof Error ? error.message : 'Failed to process email queue');
    } finally {
      setProcessing(false);
    }
  };

  const filteredLogs = logs.filter((log) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      log.recipient_email.toLowerCase().includes(query) ||
      log.subject.toLowerCase().includes(query) ||
      log.email_type.toLowerCase().includes(query)
    );
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sent':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
            <CheckCircle className="w-3 h-3" />
            Sent
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            <XCircle className="w-3 h-3" />
            Failed
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
            <Clock className="w-3 h-3" />
            Pending
          </span>
        );
      // Both of these reached the screen with no badge at all before, because
      // the switch only knew the three statuses the type declared.
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
            <Loader2 className="w-3 h-3 animate-spin" />
            Sending
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
            <Ban className="w-3 h-3" />
            Cancelled
          </span>
        );
      default:
        return null;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
                <Mail className="w-8 h-8 text-iih-green" />
                Email Logs
              </h1>
              <p className="text-slate-600 mt-1">Monitor and track all email communications</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={processEmailQueue}
                disabled={processing || stats.total_pending === 0}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
              >
                {processing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Processing...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Send Pending ({stats.total_pending})
                  </>
                )}
              </button>
              <button
                onClick={loadLogs}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
            </div>
          </div>
        </div>

        {/*
          Above the totals deliberately. The totals say how much mail there has
          been; this says whether any of it is moving, which is the question
          someone opening this page during a hold is actually asking.
        */}
        <EmailQueueHealth health={health} />

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-green-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">Total Sent</p>
                <p className="text-3xl font-bold text-slate-800 mt-2">{stats.total_sent}</p>
              </div>
              <CheckCircle className="w-12 h-12 text-green-500 opacity-20" />
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-red-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">Total Failed</p>
                <p className="text-3xl font-bold text-slate-800 mt-2">{stats.total_failed}</p>
              </div>
              <XCircle className="w-12 h-12 text-red-500 opacity-20" />
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-yellow-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">Pending</p>
                <p className="text-3xl font-bold text-slate-800 mt-2">{stats.total_pending}</p>
              </div>
              <Clock className="w-12 h-12 text-yellow-500 opacity-20" />
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-blue-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">Today</p>
                <p className="text-3xl font-bold text-slate-800 mt-2">{stats.total_today}</p>
              </div>
              <Calendar className="w-12 h-12 text-blue-500 opacity-20" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by recipient, subject, or type..."
                aria-label="Search email logs"
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-slate-400" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                aria-label="Filter by status"
                className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              >
                <option value="all">All Status</option>
                <option value="sent">Sent</option>
                <option value="failed">Failed</option>
                <option value="pending">Pending</option>
                {/*
                  Both of these are real statuses the queue produces. Without
                  them a cancelled message could not be found at all: it is not
                  sent, failed or pending, so every filter excluded it and only
                  "All Status" would ever show it.
                */}
                <option value="processing">Sending now</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
            <p className="text-slate-600">Loading email logs...</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Recipient
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Subject
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                        No email logs found
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-slate-400" />
                            <span className="text-sm font-medium text-slate-800">{log.recipient_email}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm text-slate-600">{log.subject}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-xs font-medium text-slate-500 uppercase">
                            {log.email_type.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {getStatusBadge(log.status)}
                          {/*
                            A row waiting out a backoff is SCHEDULED, not stuck.
                            Shown next to the badge because "pending" alone sent
                            people looking for a fault that was not there.
                          */}
                          {log.next_attempt_at &&
                            new Date(log.next_attempt_at).getTime() > Date.now() && (
                              <p className="mt-1 text-xs text-slate-500">
                                retry {formatDate(log.next_attempt_at)}
                              </p>
                            )}
                          {(log.retry_count ?? 0) > 0 && (
                            <p className="mt-1 text-xs text-slate-500">
                              {log.retry_count} attempt{log.retry_count === 1 ? '' : 's'} failed
                            </p>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm text-slate-600">
                            {formatDate(log.sent_at || log.created_at)}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => openLogDetail(log)}
                              className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                            >
                              View Details
                            </button>

                            {/*
                              Shown only where the mutation would succeed. The
                              server refuses `sent` and `processing` anyway, so
                              offering the button there would be a control whose
                              only outcome is an error toast.
                            */}
                            {(log.status === 'failed' || log.status === 'cancelled') && (
                              <button
                                onClick={() => handleRetry(log)}
                                disabled={actingOn === log.id}
                                className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-900 disabled:opacity-50 text-sm font-medium"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                Requeue
                              </button>
                            )}

                            {log.status === 'pending' && (
                              <button
                                onClick={() => handleCancel(log)}
                                disabled={actingOn === log.id}
                                className="inline-flex items-center gap-1 text-slate-600 hover:text-red-700 disabled:opacity-50 text-sm font-medium"
                              >
                                <Ban className="w-3.5 h-3.5" />
                                Stop
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {selectedLog && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={closeLogDetail}
          role="dialog"
          aria-modal="true"
          aria-labelledby="email-details-modal-title"
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <h3 id="email-details-modal-title" className="text-xl font-bold text-slate-800">Email Details</h3>
                <button
                  onClick={closeLogDetail}
                  className="text-slate-400 hover:text-slate-600 text-2xl"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto max-h-96">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-600">Recipient</label>
                  <p className="text-slate-800 mt-1">{selectedLog.recipient_email}</p>
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-600">Subject</label>
                  <p className="text-slate-800 mt-1">{selectedLog.subject}</p>
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-600">Type</label>
                  <p className="text-slate-800 mt-1 capitalize">
                    {selectedLog.email_type.replace(/_/g, ' ')}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-600">Status</label>
                  <div className="mt-1">{getStatusBadge(selectedLog.status)}</div>
                </div>

                {selectedLog.error_message && (
                  <div>
                    <label className="text-sm font-medium text-slate-600">
                      Most recent error
                    </label>
                    <p className="text-red-600 mt-1 bg-red-50 p-3 rounded-lg text-sm">
                      {selectedLog.error_message}
                    </p>
                  </div>
                )}

                {/*
                  The full history, not just the last error above.
                  `emailQueue.errorMessage` is overwritten on every failure, so
                  it cannot say whether three failures had three causes — which
                  is the difference between a bad address and a provider outage.
                */}
                <div>
                  <label className="text-sm font-medium text-slate-600">
                    Delivery attempts
                  </label>
                  <div className="mt-2">
                    <EmailAttemptHistory emailId={selectedLog.id} />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-600">Created At</label>
                  <p className="text-slate-800 mt-1">{formatDate(selectedLog.created_at)}</p>
                </div>

                {selectedLog.sent_at && (
                  <div>
                    <label className="text-sm font-medium text-slate-600">Sent At</label>
                    <p className="text-slate-800 mt-1">{formatDate(selectedLog.sent_at)}</p>
                  </div>
                )}

                {selectedLog.failed_at && (
                  <div>
                    <label className="text-sm font-medium text-slate-600">Failed At</label>
                    <p className="text-slate-800 mt-1">{formatDate(selectedLog.failed_at)}</p>
                  </div>
                )}

                {selectedLog.retry_count !== undefined && selectedLog.retry_count > 0 && (
                  <div>
                    <label className="text-sm font-medium text-slate-600">Retry Count</label>
                    <p className="text-slate-800 mt-1">{selectedLog.retry_count}</p>
                  </div>
                )}

                <div>
                  <label className="text-sm font-medium text-slate-600">Email Body (Text)</label>
                  <pre className="mt-1 bg-slate-50 p-3 rounded-lg text-xs overflow-x-auto max-h-40 overflow-y-auto">
                    {bodyLoading ? 'Loading…' : selectedBody ?? ''}
                  </pre>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50">
              <button
                onClick={closeLogDetail}
                className="w-full px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
