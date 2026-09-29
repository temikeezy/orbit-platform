import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { Search, CheckCircle, XCircle, AlertCircle, Clock, FileText, Link as LinkIcon, Upload, Award, Calendar, User, Filter, ClipboardCheck } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { openSubmissionFile, tasksApi, SubmissionWithDetails } from '../../lib/api/tasks';
import { formatDate } from '../../lib/utils/date';
import { SafeLink } from '../../components/common/SafeLink';
import { logError } from '../../lib/monitoring';


export function SubmissionReviewPage() {
  const { user } = useAuth();
  const [submissions, setSubmissions] = useState<SubmissionWithDetails[]>([]);
  const [selectedSubmission, setSelectedSubmission] = useState<SubmissionWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('submitted');
  const [reviewing, setReviewing] = useState(false);
  const [reviewAction, setReviewAction] = useState<'approved' | 'changes_requested' | 'rejected' | null>(null);
  const [score, setScore] = useState<number>(0);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  /** True once a list has arrived, so later refreshes do not blank the screen. */
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  /**
   * Which fetch the screen is currently waiting for.
   *
   * Changing the filter starts a new read without cancelling the one already in
   * flight, and the two can resolve in either order. When the slower first one
   * landed last it overwrote the fresher list, so the screen showed the PENDING
   * queue underneath a filter that read "Changes Requested" — the rows and the
   * control disagreeing, with nothing on screen to suggest which was right. The
   * more loaded the deployment, the wider the window.
   *
   * A ref rather than state: it must be readable by a callback that closed over
   * an older render, which is exactly what state cannot do.
   */
  const currentRequest = useRef(0);

  /**
   * The filter as it is NOW, not as it was when a callback was created.
   *
   * `handleReview` refreshes the list after a decision, and it closes over the
   * render it was created in. Reviewing a submission and then changing the
   * filter while the write is still in flight meant that refresh fetched the
   * OLD filter — and, being the most recent request, it won: the screen settled
   * on the pending queue underneath a filter reading "Changes Requested". The
   * effect below still passes its filter explicitly, because it genuinely wants
   * the one that triggered it.
   */
  const liveStatusFilter = useRef(statusFilter);
  liveStatusFilter.current = statusFilter;

  useEffect(() => {
    void loadSubmissions(statusFilter);
  }, [statusFilter]);

  const loadSubmissions = async (filter: string = liveStatusFilter.current) => {
    const request = ++currentRequest.current;

    try {
      setLoading(true);
      // Honours the filter. It re-ran on every change and then always loaded
      // the PENDING queue, so choosing Approved or Rejected changed nothing —
      // the control looked functional and was inert.
      //
      // `filter` is passed in rather than read from state, so a request is
      // always answered against the filter it was issued for.
      const data =
        filter === 'submitted'
          ? await tasksApi.getAllPendingSubmissions()
          : await tasksApi.getSubmissionsByStatus(filter);

      // Superseded while this was in flight. Dropping it is the whole fix:
      // a stale list is worse than a slow one, because it looks current.
      if (request !== currentRequest.current) return;

      setSubmissions(data);
      setError('');
    } catch (error) {
      if (request !== currentRequest.current) return;
      logError(error, { context: 'SubmissionReviewPage.loadSubmissions' });
      setError('Failed to load submissions');
    } finally {
      // Only the newest request owns the spinner, or an early straggler ends it
      // while the list the admin actually asked for is still coming.
      if (request === currentRequest.current) {
        setLoading(false);
        setHasLoadedOnce(true);
      }
    }
  };

  const handleSelectSubmission = async (submission: SubmissionWithDetails) => {
    try {
      // The row already carries the full submission and task; the detail
      // re-read exists to pick up anything the list omits. Falling back to the
      // row rather than to null means a failed re-read cannot blank the pane.
      //
      // The task id rides along so the re-read is a single indexed lookup
      // rather than a scan over status lists — a row whose status moves while
      // the scan runs (its author resubmitting) evaded every list and came back
      // through a fallback with NO task attached. And because a DEGRADED
      // re-read is worse than the row itself, the row's task and user stand in
      // wherever the re-read lost them: rendered without a task, this pane
      // shows no submission content, a blank "Max:", and a score input clamped
      // to zero — an approval form that cannot approve.
      const fetched = await tasksApi.getSubmissionDetails(submission.id, submission.task_id);
      const details = fetched
        ? { ...fetched, task: fetched.task ?? submission.task, user: fetched.user ?? submission.user }
        : submission;
      setSelectedSubmission(details);
      setScore(details?.task?.points ?? 0);
      setFeedback('');
      setReviewAction(null);
      setError('');
    } catch (error) {
      logError(error, { context: 'SubmissionReviewPage.handleSelectSubmission' });
    }
  };

  const handleReview = async () => {
    if (!selectedSubmission || !reviewAction || !user) return;

    if (reviewAction === 'approved' && score <= 0) {
      setError('Please provide a score for approval');
      return;
    }

    if (reviewAction !== 'approved' && !feedback.trim()) {
      setError('Please provide feedback');
      return;
    }

    try {
      setReviewing(true);
      setError('');

      await tasksApi.reviewSubmission(
        selectedSubmission.id,
        {
          status: reviewAction,
          score: reviewAction === 'approved' ? score : undefined,
          feedback: feedback.trim() || undefined,
        },
        user.id
      );

      await loadSubmissions();
      setSelectedSubmission(null);
      setReviewAction(null);
      setScore(0);
      setFeedback('');
    } catch (error) {
      logError(error, { context: 'SubmissionReviewPage.handleReview' });
      setError(error instanceof Error ? error.message : 'Failed to submit review');
    } finally {
      setReviewing(false);
    }
  };

  const getSubmissionTypeIcon = (type: string) => {
    switch (type) {
      case 'text':
        return <FileText className="w-4 h-4" />;
      case 'link':
        return <LinkIcon className="w-4 h-4" />;
      case 'file':
        return <Upload className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'submitted':
        return { label: 'Pending Review', color: 'bg-amber-100 text-amber-800', icon: Clock };
      case 'approved':
        return { label: 'Approved', color: 'bg-emerald-100 text-emerald-800', icon: CheckCircle };
      case 'changes_requested':
        return { label: 'Changes Requested', color: 'bg-orange-100 text-orange-800', icon: AlertCircle };
      case 'rejected':
        return { label: 'Rejected', color: 'bg-rose-100 text-rose-800', icon: XCircle };
      default:
        return { label: status, color: 'bg-slate-100 text-slate-800', icon: Clock };
    }
  };

  const filteredSubmissions = submissions.filter((sub) => {
    const matchesSearch =
      (sub.user?.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (sub.task?.title ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (sub.task?.stream?.name ?? '').toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  /**
   * The full-screen spinner is for the FIRST load only.
   *
   * It used to cover every fetch, including the one a filter change triggers —
   * which unmounted this entire screen, the search box and the status select
   * along with it, and rebuilt them a moment later. That is why changing the
   * filter was unreliable: the `<select>` the change event belonged to was
   * destroyed before React processed it, so the choice was silently lost and
   * the control snapped back to its previous value. It also threw away
   * whatever had been typed into the search box on every refresh.
   *
   * Keeping the controls mounted and confining the spinner to the list is both
   * the fix and the better behaviour: the thing being reloaded is the list.
   */
  if (loading && !hasLoadedOnce) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto mb-4"></div>
          <p className="text-slate-600">Loading submissions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 mb-2 flex items-center gap-3">
            <ClipboardCheck className="w-8 h-8 text-iih-green" />
            Submission Review
          </h1>
          <p className="text-slate-600">Review and provide feedback on member submissions</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search submissions..."
                    aria-label="Search submissions"
                    className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                  />
                </div>
              </div>

              <div className="mb-4">
                <label htmlFor="submission-status-filter" className="block text-sm font-medium text-slate-700 mb-2">
                  <Filter className="w-4 h-4 inline mr-1" />
                  Status Filter
                </label>
                <select
                  id="submission-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                >
                  <option value="submitted">Pending Review</option>
                  <option value="approved">Approved</option>
                  <option value="changes_requested">Changes Requested</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>

              <div className="space-y-2 max-h-[600px] overflow-y-auto">
                {filteredSubmissions.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <AlertCircle className="w-12 h-12 mx-auto mb-2 text-slate-400" />
                    <p>No submissions found</p>
                  </div>
                ) : (
                  filteredSubmissions.map((sub) => {
                    const statusBadge = getStatusBadge(sub.status);
                    const StatusIcon = statusBadge.icon;

                    return (
                      <button
                        key={sub.id}
                        onClick={() => handleSelectSubmission(sub)}
                        className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                          selectedSubmission?.id === sub.id
                            ? 'border-iih-green bg-green-50'
                            : 'border-slate-200 hover:border-slate-300 bg-white'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-shrink-0 w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center">
                            <User className="w-5 h-5 text-slate-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-slate-900 truncate">{sub.user?.full_name}</div>
                            <div className="text-sm text-slate-600 truncate">{sub.task?.title}</div>
                            <div className="flex items-center gap-2 mt-2">
                              <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge.color} flex items-center gap-1`}>
                                <StatusIcon className="w-3 h-3" />
                                {statusBadge.label}
                              </span>
                              {sub.task?.stream?.emoji && (
                                <span className="text-xs">{sub.task?.stream?.emoji}</span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 mt-1">
                              {formatDate(sub.submitted_at || sub.created_at)}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            {selectedSubmission ? (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8">
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-2xl font-bold text-slate-800">{selectedSubmission.task?.title}</h2>
                    <div className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusBadge(selectedSubmission.status).color}`}>
                      {getStatusBadge(selectedSubmission.status).label}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-indigo-50 rounded-lg p-3">
                      <div className="flex items-center gap-2 text-indigo-600 mb-1">
                        <Award className="w-4 h-4" />
                        <span className="text-xs font-medium">Points</span>
                      </div>
                      <div className="text-lg font-bold text-indigo-900">{selectedSubmission.task?.points}</div>
                    </div>

                    <div className="bg-sky-50 rounded-lg p-3">
                      <div className="flex items-center gap-2 text-sky-600 mb-1">
                        <Calendar className="w-4 h-4" />
                        <span className="text-xs font-medium">Deadline</span>
                      </div>
                      <div className="text-xs font-bold text-sky-900">{selectedSubmission.task?.deadline ? formatDate(selectedSubmission.task.deadline) : ''}</div>
                    </div>

                    <div className="bg-emerald-50 rounded-lg p-3">
                      <div className="flex items-center gap-2 text-emerald-600 mb-1">
                        {getSubmissionTypeIcon(selectedSubmission.task?.submission_type ?? 'text')}
                        <span className="text-xs font-medium">Type</span>
                      </div>
                      <div className="text-xs font-bold text-emerald-900 capitalize">{selectedSubmission.task?.submission_type}</div>
                    </div>

                    <div className="bg-purple-50 rounded-lg p-3">
                      <div className="flex items-center gap-2 text-purple-600 mb-1">
                        <Clock className="w-4 h-4" />
                        <span className="text-xs font-medium">Submitted</span>
                      </div>
                      <div className="text-xs font-bold text-purple-900">
                        {formatDate(selectedSubmission.submitted_at || selectedSubmission.created_at)}
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4 mb-6">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-12 h-12 bg-slate-200 rounded-full flex items-center justify-center">
                        <User className="w-6 h-6 text-slate-600" />
                      </div>
                      <div>
                        <div className="font-medium text-slate-900">{selectedSubmission.user?.full_name}</div>
                        <div className="text-sm text-slate-600">{selectedSubmission.user?.email}</div>
                        {selectedSubmission.user?.total_points !== undefined && (
                          <div className="text-xs text-slate-500 mt-1">
                            Level {selectedSubmission.user?.current_level} • {selectedSubmission.user?.total_points} points
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mb-6">
                  <h3 className="font-bold text-slate-800 mb-3">Task Description</h3>
                  <p className="text-slate-600 whitespace-pre-wrap leading-relaxed">{selectedSubmission.task?.description}</p>
                </div>

                <div className="mb-6">
                  <h3 className="font-bold text-slate-800 mb-3">Submission</h3>
                  <div className="bg-slate-50 rounded-lg p-4">
                    {selectedSubmission.task?.submission_type === 'text' && selectedSubmission.submission_text && (
                      <p className="text-slate-700 whitespace-pre-wrap">{selectedSubmission.submission_text}</p>
                    )}
                    {/*
                      READ FROM `submission_url`. This read `submission_text`,
                      which a link submission never populates — so a reviewer
                      opened a correctly-submitted link and saw an empty panel,
                      with nothing to distinguish it from an intern who had
                      submitted nothing at all. Of the three places carrying
                      this bug, this is the one that decides whether someone's
                      work is accepted.
                    */}
                    {selectedSubmission.task?.submission_type === 'link' && selectedSubmission.submission_url && (
                      <SafeLink
                        href={selectedSubmission.submission_url}
                        className="text-iih-green hover:text-iih-green-dark underline flex items-center gap-2"
                      >
                        <LinkIcon className="w-4 h-4" />
                        {selectedSubmission.submission_url}
                      </SafeLink>
                    )}
                    {selectedSubmission.task?.submission_type === 'file' && selectedSubmission.has_file && (
                      // A button, not a link: submission files are private and
                      // served by an authenticated route, so there is no url to
                      // put in an href.
                      <button
                        type="button"
                        onClick={() =>
                          openSubmissionFile(selectedSubmission.id).catch((err: unknown) =>
                            toast.error(err instanceof Error ? err.message : 'Could not open the file'),
                          )
                        }
                        className="text-iih-green hover:text-iih-green-dark underline flex items-center gap-2"
                      >
                        <Upload className="w-4 h-4" />
                        View submitted file
                      </button>
                    )}
                  </div>
                </div>

                {selectedSubmission.status === 'submitted' && (
                  <div>
                    <h3 className="font-bold text-slate-800 mb-4">Review Submission</h3>

                    {error && (
                      <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg">
                        {error}
                      </div>
                    )}

                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Decision</label>
                        <div className="flex gap-3">
                          <button
                            onClick={() => setReviewAction('approved')}
                            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                              reviewAction === 'approved'
                                ? 'bg-emerald-500 text-white'
                                : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            }`}
                          >
                            <CheckCircle className="w-5 h-5 inline mr-2" />
                            Approve
                          </button>
                          <button
                            onClick={() => setReviewAction('changes_requested')}
                            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                              reviewAction === 'changes_requested'
                                ? 'bg-orange-500 text-white'
                                : 'bg-orange-50 text-orange-700 hover:bg-orange-100'
                            }`}
                          >
                            <AlertCircle className="w-5 h-5 inline mr-2" />
                            Request Changes
                          </button>
                          <button
                            onClick={() => setReviewAction('rejected')}
                            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                              reviewAction === 'rejected'
                                ? 'bg-rose-500 text-white'
                                : 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                            }`}
                          >
                            <XCircle className="w-5 h-5 inline mr-2" />
                            Reject
                          </button>
                        </div>
                      </div>

                      {reviewAction === 'approved' && (
                        <div>
                          <label htmlFor="review-points" className="block text-sm font-medium text-slate-700 mb-2">
                            Points to Award (Max: {selectedSubmission.task?.points})
                          </label>
                          <input
                            id="review-points"
                            type="number"
                            value={score}
                            onChange={(e) => setScore(Math.min(selectedSubmission.task?.points ?? 0, Math.max(0, parseInt(e.target.value) || 0)))}
                            min="0"
                            max={selectedSubmission.task?.points}
                            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                          />
                        </div>
                      )}

                      <div>
                        <label htmlFor="review-feedback" className="block text-sm font-medium text-slate-700 mb-2">
                          Feedback {reviewAction !== 'approved' && <span className="text-rose-500">*</span>}
                        </label>
                        <textarea
                          id="review-feedback"
                          value={feedback}
                          onChange={(e) => setFeedback(e.target.value)}
                          rows={4}
                          placeholder={
                            reviewAction === 'approved'
                              ? 'Provide positive feedback (optional)'
                              : reviewAction === 'changes_requested'
                              ? 'Explain what changes are needed...'
                              : reviewAction === 'rejected'
                              ? 'Explain why this submission is being rejected...'
                              : 'Provide your feedback...'
                          }
                          className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
                        />
                      </div>

                      <button
                        onClick={handleReview}
                        disabled={!reviewAction || reviewing}
                        className="w-full bg-iih-green hover:bg-iih-green-dark text-white font-bold py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        {reviewing ? (
                          <>
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-900"></div>
                            Submitting Review...
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-5 h-5" />
                            Submit Review
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {selectedSubmission.status !== 'submitted' && selectedSubmission.feedback && (
                  <div className="mt-6">
                    <h3 className="font-bold text-slate-800 mb-3">Review Feedback</h3>
                    <div className="bg-slate-50 rounded-lg p-4">
                      <p className="text-slate-700 whitespace-pre-wrap mb-3">{selectedSubmission.feedback}</p>
                      {selectedSubmission.reviewer && (
                        <div className="text-sm text-slate-600">
                          Reviewed by {selectedSubmission.reviewer.full_name} on {formatDate(selectedSubmission.reviewed_at!)}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
                <AlertCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-bold text-slate-400 mb-2">No Submission Selected</h3>
                <p className="text-slate-500">Select a submission from the list to review</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
