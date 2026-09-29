import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Bug,
  Cpu,
  Clock,
  Eye,
  CheckCircle2,
  Hash,
  User,
  RefreshCw,
  Loader2,
  Filter,
} from 'lucide-react';
import { convexHttp as convex } from '../../lib/convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../../lib/auth';
import { logError } from '../../lib/monitoring';
import { SearchBox } from '../../components/admin/SearchBox';

/**
 * Error Reports — the admin side of `errorReports.ts`.
 *
 * One list, two kinds of evidence. A caught exception ('caught') and a member
 * saying "this is broken" ('reported') land in the same table, deliberately
 * (see errorReports.ts), but they are not the same kind of thing to READ: one
 * is a stack trace, the other is a sentence a person wrote. SourceBadge plus
 * different body content below the headline is what keeps them from reading as
 * identical rows.
 *
 * `list` already returns every field this screen needs — message, stack, note,
 * path, userEmail — in one call. Unlike EmailLogsPage's body, which is fetched
 * per-row because a mail body is a live credential, there is nothing here that
 * has to stay off the wire until a specific row is opened. The detail modal
 * therefore just renders what is already in state.
 *
 * `path` is rendered as-is: it is written path-only, server-side, specifically
 * so this screen never has a live magic-link token to display (see
 * errorReports.ts's `safePath`). Do not turn it into a link with anything else
 * appended, and never concatenate it with `context` or a query string.
 */

type ErrorReportSource = 'caught' | 'reported';
type ErrorReportStatus = 'open' | 'acknowledged' | 'resolved';

interface ErrorReport {
  id: string;
  source: ErrorReportSource;
  message: string;
  stack?: string;
  path?: string;
  context?: string;
  note?: string;
  userEmail?: string;
  status: ErrorReportStatus;
  occurrences: number;
  lastSeenAt: number;
  createdAt: number;
}

const STATUS_FILTERS: { id: 'all' | ErrorReportStatus; label: string }[] = [
  { id: 'all', label: 'All statuses' },
  { id: 'open', label: 'Open' },
  { id: 'acknowledged', label: 'Acknowledged' },
  { id: 'resolved', label: 'Resolved' },
];

const SOURCE_FILTERS: { id: 'all' | ErrorReportSource; label: string }[] = [
  { id: 'all', label: 'All sources' },
  { id: 'caught', label: 'Automatic capture' },
  { id: 'reported', label: 'Reported by a person' },
];

/** The two transitions that make sense from a given status. Reopen is always one of them. */
function nextStatusActions(status: ErrorReportStatus): { status: ErrorReportStatus; label: string }[] {
  switch (status) {
    case 'open':
      return [
        { status: 'acknowledged', label: 'Acknowledge' },
        { status: 'resolved', label: 'Resolve' },
      ];
    case 'acknowledged':
      return [
        { status: 'resolved', label: 'Resolve' },
        { status: 'open', label: 'Reopen' },
      ];
    case 'resolved':
      return [{ status: 'open', label: 'Reopen' }];
    default:
      return [];
  }
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: ErrorReportStatus }) {
  switch (status) {
    case 'open':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
          <Clock className="w-3 h-3" />
          Open
        </span>
      );
    case 'acknowledged':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
          <Eye className="w-3 h-3" />
          Acknowledged
        </span>
      );
    case 'resolved':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
          <CheckCircle2 className="w-3 h-3" />
          Resolved
        </span>
      );
    default:
      return null;
  }
}

/** Automatic vs human — a different colour family from StatusBadge's, so the two never blur into one meaning. */
function SourceBadge({ source }: { source: ErrorReportSource }) {
  if (source === 'reported') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orbit-violet-soft px-2.5 py-0.5 text-xs font-medium text-orbit-violet">
        <Bug className="w-3 h-3" />
        Reported
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
      <Cpu className="w-3 h-3" />
      Automatic
    </span>
  );
}

/** The occurrence count, sized and coloured by how much it matters. */
function OccurrenceDial({ count }: { count: number }) {
  const tier =
    count > 9
      ? 'bg-red-50 text-red-700'
      : count > 1
        ? 'bg-amber-50 text-amber-700'
        : 'bg-slate-50 text-slate-500';

  return (
    <div className={`flex flex-shrink-0 flex-col items-center justify-center rounded-lg px-3 py-2 min-w-[4.5rem] ${tier}`}>
      <span className="text-2xl font-bold leading-none">{count}</span>
      <span className="mt-0.5 text-[10px] uppercase tracking-wide">{count === 1 ? 'time' : 'times'}</span>
    </div>
  );
}

export function ErrorReportsPage() {
  const [reports, setReports] = useState<ErrorReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | ErrorReportStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | ErrorReportSource>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ErrorReport | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  /** Which fetch is allowed to write state — see EmailLogsPage for why this matters on a filtered list. */
  const currentRequest = useRef(0);

  const loadReports = async () => {
    const request = ++currentRequest.current;
    try {
      setLoading(true);
      const token = authService.getToken();
      if (!token) throw new Error('Not authenticated');

      const rows = await convex.query(api.errorReports.list, {
        token,
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 200,
      });

      if (request !== currentRequest.current) return;

      setReports(
        rows.map((r) => ({
          id: r.id,
          // Normalised the same way the backend normalises it on write — belt
          // and braces against a row this screen did not create.
          source: (r.source === 'reported' ? 'reported' : 'caught') as ErrorReportSource,
          message: r.message,
          stack: r.stack,
          path: r.path,
          context: r.context,
          note: r.note,
          userEmail: r.userEmail,
          status: r.status as ErrorReportStatus,
          occurrences: r.occurrences,
          lastSeenAt: r.lastSeenAt,
          createdAt: r.createdAt,
        })),
      );
    } catch (error) {
      logError(error, { context: 'ErrorReportsPage.loadReports' });
      if (request === currentRequest.current) {
        toast.error(error instanceof Error ? error.message : 'Failed to load error reports');
      }
    } finally {
      if (request === currentRequest.current) setLoading(false);
    }
  };

  // Status is server-side filtered — a fresh fetch per filter, not a client
  // slice, so "Open" always means every open report and not just whatever page
  // happened to be loaded already.
  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const closeDetail = () => setSelected(null);

  const handleSetStatus = async (report: ErrorReport, status: ErrorReportStatus) => {
    const token = authService.getToken();
    if (!token) return;

    setActingOn(report.id);
    try {
      const result = await convex.mutation(api.errorReports.setStatus, {
        token,
        reportId: report.id as never,
        status,
      });

      if (!result.success) {
        toast.error(result.error ?? 'Could not update that report.');
        return;
      }

      toast.success('Status updated.');
      // Keeps the open modal in step with the change it just made, rather than
      // showing the old status until the list reload below resolves.
      setSelected((current) => (current && current.id === report.id ? { ...current, status } : current));
      await loadReports();
    } catch (error) {
      logError(error, { context: 'ErrorReportsPage.handleSetStatus' });
      toast.error('Could not update that report.');
    } finally {
      setActingOn(null);
    }
  };

  // Source is filtered client-side: `list` takes only `status`, and adding a
  // second server-side filter for a 200-row page is not worth a schema index.
  const shown = reports.filter((r) => {
    if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [r.message, r.note, r.context, r.userEmail, r.path]
      .filter(Boolean)
      .some((f) => String(f).toLowerCase().includes(needle));
  });

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8 gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <AlertTriangle className="w-8 h-8 text-iih-green" />
              Error Reports
            </h1>
            <p className="text-slate-600 mt-1">
              Automatic captures and member reports, newest first. A fault seen many times is one row with a count, not many rows.
            </p>
          </div>
          <button
            onClick={loadReports}
            className="flex items-center gap-2 px-4 py-2 bg-iih-green hover:bg-iih-green-dark text-white rounded-lg font-medium transition-colors flex-shrink-0"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search message, note, page, or reporter…"
              resultCount={shown.length}
              totalCount={reports.length}
              className="flex-1"
            />
            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-slate-400 flex-shrink-0" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                aria-label="Filter by status"
                className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              >
                {STATUS_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
                aria-label="Filter by source"
                className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              >
                {SOURCE_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-iih-green mx-auto mb-4" />
            <p className="text-slate-600">Loading error reports…</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <AlertTriangle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-800 mb-2">No error reports</h3>
            <p className="text-slate-600">
              {reports.length === 0
                ? 'Nothing has been captured yet.'
                : 'No report matches the current filters.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {shown.map((report) => (
              <ReportCard key={report.id} report={report} onView={() => setSelected(report)} />
            ))}
          </div>
        )}
      </div>

      {selected && (
        <ReportDetailModal
          report={selected}
          onClose={closeDetail}
          onSetStatus={handleSetStatus}
          busy={actingOn === selected.id}
        />
      )}
    </div>
  );
}

function ReportCard({ report, onView }: { report: ErrorReport; onView: () => void }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 hover:shadow-md transition-all">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <SourceBadge source={report.source} />
            <StatusBadge status={report.status} />
          </div>

          <p className="font-semibold text-slate-800 break-words">{report.message}</p>

          {/* Content differs by kind, deliberately — a note and a trace are not
              read the same way and should not look like the same thing. */}
          {report.note && (
            <p className="mt-1 text-sm text-slate-600 line-clamp-2">&ldquo;{report.note}&rdquo;</p>
          )}
          {/* The first STACK FRAME, not the trace's first line — that line is
              almost always "Error: <message>" and would just repeat the
              headline above it. The first "at …" frame says where, which the
              headline does not. */}
          {!report.note && report.stack && (
            <p className="mt-1 font-mono text-xs text-slate-500 truncate">
              {(report.stack.split('\n')[1] ?? report.stack.split('\n')[0]).trim()}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              last seen {formatDateTime(report.lastSeenAt)}
            </span>
            <span className="inline-flex items-center gap-1">
              <User className="w-3.5 h-3.5" />
              {report.userEmail ?? 'Signed out'}
            </span>
            {report.path && <span className="font-mono">{report.path}</span>}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <OccurrenceDial count={report.occurrences} />
          <button
            onClick={onView}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-sm font-medium transition-colors"
          >
            <Eye className="w-3.5 h-3.5" />
            View details
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportDetailModal({
  report,
  onClose,
  onSetStatus,
  busy,
}: {
  report: ErrorReport;
  onClose: () => void;
  onSetStatus: (report: ErrorReport, status: ErrorReportStatus) => void;
  busy: boolean;
}) {
  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="error-report-modal-title"
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between gap-4">
            <h3 id="error-report-modal-title" className="text-xl font-bold text-slate-800">
              Report detail
            </h3>
            <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 text-2xl">
              ×
            </button>
          </div>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <SourceBadge source={report.source} />
            <StatusBadge status={report.status} />
            <span className="inline-flex items-center gap-1 text-sm text-slate-500">
              <Hash className="w-3.5 h-3.5" />
              {report.occurrences} occurrence{report.occurrences === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-600">Message</label>
            <p className="text-slate-800 mt-1 whitespace-pre-wrap">{report.message}</p>
          </div>

          {report.note && (
            <div>
              <label className="text-sm font-medium text-slate-600">Reporter&rsquo;s note</label>
              <p className="mt-1 bg-orbit-violet-soft border-l-4 border-orbit-violet text-slate-700 p-3 rounded-r-lg text-sm whitespace-pre-wrap">
                {report.note}
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-slate-600">Reported by</label>
            <p className="text-slate-800 mt-1">{report.userEmail ?? 'Signed out'}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-600">Page</label>
            <p className="text-slate-800 mt-1 font-mono text-sm">{report.path ?? '—'}</p>
          </div>

          {report.context && (
            <div>
              <label className="text-sm font-medium text-slate-600">Where</label>
              <p className="text-slate-800 mt-1 font-mono text-sm">{report.context}</p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-slate-600">First seen</label>
            <p className="text-slate-800 mt-1">{formatDateTime(report.createdAt)}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-600">Last seen</label>
            <p className="text-slate-800 mt-1">{formatDateTime(report.lastSeenAt)}</p>
          </div>

          {report.stack && (
            <div>
              <label className="text-sm font-medium text-slate-600">Stack trace</label>
              <pre className="mt-1 bg-slate-900 text-slate-100 p-3 rounded-lg text-xs overflow-x-auto max-h-52 overflow-y-auto whitespace-pre-wrap">
                {report.stack}
              </pre>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {nextStatusActions(report.status).map((action) => (
              <button
                key={action.status}
                onClick={() => onSetStatus(report, action.status)}
                disabled={busy}
                className="px-4 py-2 bg-iih-green hover:bg-iih-green-dark disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {action.label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors font-medium text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
