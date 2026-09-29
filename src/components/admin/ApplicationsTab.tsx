import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Check, CheckSquare, ClipboardList, Download, ExternalLink, FileText, Loader2, RefreshCw, Square } from 'lucide-react';
import { applicationsApi } from '../../lib/api/applications';
import { OrbitApplication, OrbitApplicationProgrammeType, OrbitApplicationStatus } from '../../types/database';
import { EmptyState } from '../common/EmptyState';
import { AuthedImage } from '../common/AuthedImage';
import { SafeLink } from '../common/SafeLink';
import { PlacementModal } from './PlacementModal';
import { AcceptanceLetterPrintView } from './AcceptanceLetterPrintView';
import { LetterCandidate } from '../../../convex/lib/acceptanceLetter';
import { acceptanceLettersApi } from '../../lib/api/acceptanceLetters';
import { SearchBox } from './SearchBox';
import { trackShortLabel } from '../../../convex/lib/tracks';
import { isAuthedDocumentUrl } from '../../lib/siwesAdapters';
import { authService } from '../../lib/auth';

const STATUS_OPTIONS: Array<{ value: OrbitApplicationStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
];

function statusClass(status: OrbitApplicationStatus) {
  const map: Record<OrbitApplicationStatus, string> = {
    submitted: 'bg-blue-50 text-blue-700',
    approved: 'bg-emerald-50 text-emerald-700',
  };
  return map[status];
}

/**
 * The programme someone applied to, said plainly.
 *
 * This queue is reached through a tab headed "SIWES", which is misleading: most
 * of what arrives is not SIWES. Internship and volunteer applications outnumber
 * it, and until this badge existed nothing on the row said which was which — a
 * volunteer looked exactly like a SIWES application whose institution and dates
 * had failed to save.
 */
const PROGRAMME_LABEL: Record<OrbitApplicationProgrammeType, string> = {
  siwes: 'SIWES',
  internship: 'Internship',
  nysc: 'NYSC',
  volunteer: 'Volunteer',
};

const PROGRAMME_CLASS: Record<OrbitApplicationProgrammeType, string> = {
  siwes: 'bg-emerald-50 text-emerald-700',
  internship: 'bg-sky-50 text-sky-700',
  nysc: 'bg-violet-50 text-violet-700',
  volunteer: 'bg-amber-50 text-amber-700',
};

function programmeLabel(type: OrbitApplicationProgrammeType): string {
  return PROGRAMME_LABEL[type] ?? type;
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The application row, as an acceptance letter sees it.
 *
 * `course_of_study` is the ACADEMIC department — the one that sends the student
 * — and is what the letter names. It is not `assigned_department_id`, which is
 * the IIH team the intern joins once they arrive; naming that one would tell the
 * university their student studies in a department it has never heard of.
 *
 * Faculty is NOT a fallback. It reads as one, but the letter says "of the
 * Department of {X}", and a faculty answer is typically "Faculty of
 * Engineering" — which prints as "of the Department of Faculty of Engineering"
 * and, worse, suppresses the missing-department warning that would have had
 * someone correct the record. A blank department is flagged; a wrong one is not.
 */
function toLetterCandidate(app: OrbitApplication): LetterCandidate {
  return {
    fullName: app.full_name,
    levelOrYear: app.level_or_year,
    department: app.course_of_study,
    university: app.institution_name,
    gender: app.gender,
  };
}

/**
 * Only SIWES applicants get a SIWES acceptance letter.
 *
 * The queue holds internship, NYSC and volunteer applications too, and any of
 * them can be approved. The letter is titled "FOR SIWES PLACEMENT" and
 * addressed to a university's Industrial Liaison Unit — an office a volunteer
 * applicant has no relationship with.
 */
function takesAcceptanceLetter(app: OrbitApplication): boolean {
  return app.programme_type === 'siwes';
}

/**
 * Opens an authenticated document in a new tab.
 *
 * The route reads a Bearer header, which a link cannot send, so the bytes are
 * fetched and handed over as an object URL. Revoked shortly after so the tab
 * keeps working but the URL does not outlive the click.
 */
async function openDocument(url: string) {
  const token = authService.getToken();
  if (!token) return;

  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(String(response.status));

    const objectUrl = URL.createObjectURL(await response.blob());
    window.open(objectUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    toast.error('Could not open that document.');
  }
}

interface ApplicationsTabProps {
  /**
   * Restricts the screen to one programme.
   *
   * The SIWES section passes 'siwes' so it shows SIWES candidates and nothing
   * else; the general Applications page passes nothing and shows all four. It
   * is enforced on the SERVER, so a scoped screen cannot show a row it should
   * not whatever happens on the client.
   */
  programmeType?: string;
  /** Shown above the table, so each screen can say what it is. */
  heading?: string;
  description?: string;
}

type SortKey = 'submitted' | 'name' | 'programme';

export function ApplicationsTab({
  programmeType,
  heading = 'Applications',
  description = 'Review public applications before creating user and intern profiles.',
}: ApplicationsTabProps = {}) {
  const [applications, setApplications] = useState<OrbitApplication[]>([]);
  const [status, setStatus] = useState<OrbitApplicationStatus | ''>('submitted');
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState('');
  const [placementFor, setPlacementFor] = useState<OrbitApplication | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approvingBulk, setApprovingBulk] = useState(false);
  const [lettersFor, setLettersFor] = useState<LetterCandidate[] | null>(null);
  /** Non-null only when a batch run hit the server's ceiling. */
  const [lettersTruncatedAt, setLettersTruncatedAt] = useState<number | null>(null);
  const [loadingLetters, setLoadingLetters] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('submitted');
  /**
   * The term the SERVER has been asked about, a beat behind what is typed.
   *
   * Searching runs against the whole table rather than the page in front of
   * you, so it is a round trip — one per keystroke would be both slow and
   * pointless. A short delay means the request is made once, when typing
   * stops.
   */
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  /**
   * Which request the table is currently waiting for.
   *
   * Changing the status or typing starts a new read without cancelling the one
   * in flight, and they can resolve in either order — so a slow response for a
   * filter the admin has already moved on from could land last and sit there.
   * Only the newest response is applied.
   */
  const request = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const rows = await applicationsApi.list(status, debouncedSearch, programmeType);
      if (mine !== request.current) return;
      setApplications(rows);
    } catch (error) {
      if (mine !== request.current) return;
      toast.error(error instanceof Error ? error.message : 'Could not load applications');
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, [status, debouncedSearch, programmeType]);

  useEffect(() => {
    load();
    // Cleared whenever the query changes. A selection that survives a filter
    // change is a selection of rows the admin can no longer see, and the bulk
    // button would act on them anyway.
    setSelected(new Set());
  }, [load]);

  /**
   * The order the table is read in.
   *
   * Newest first by default, because the queue is worked from the top: the
   * question is almost always "what has come in", not "who is alphabetically
   * first". The other two exist for the other two questions people actually
   * ask — finding a name in a long list, and reading one programme at a time.
   */
  const sorted = useMemo(() => {
    const rows = [...applications];
    if (sortKey === 'name') {
      return rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    if (sortKey === 'programme') {
      return rows.sort(
        (a, b) =>
          a.programme_type.localeCompare(b.programme_type) ||
          a.full_name.localeCompare(b.full_name),
      );
    }
    return rows.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [applications, sortKey]);

  /**
   * Counts from their OWN scan, not from the rows on screen.
   *
   * `applications` has already been narrowed by the server to one status and
   * whatever was typed, so counting it gave every tab but the active one a
   * count of zero, and turned the active one into a match count the moment
   * somebody searched.
   */
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    applicationsApi
      .counts(programmeType)
      .then((c) => {
        if (!cancelled) setCounts(c.byStatus);
      })
      .catch(() => {
        // A missing badge is better than a wrong one; the list still works.
        if (!cancelled) setCounts({});
      });
    return () => {
      cancelled = true;
    };
    // Recounted after a decision changes one, which is what `applications`
    // moving stands in for here.
  }, [programmeType, applications]);

  /**
   * Opens the batch run: every approved applicant, asked for by name.
   *
   * NOT `applications.filter(status === 'approved')`. This table arrives capped
   * at 100 rows and carries whatever status filter is currently selected, so a
   * batch built from it would be the first hundred of the current filter while
   * presenting itself as everyone accepted — and the letters that were never
   * printed are noticed by a university in September, not here. The server
   * query reads the approved index directly and reports its own ceiling.
   */
  const openBatchLetters = async () => {
    setLoadingLetters(true);
    try {
      const batch = await acceptanceLettersApi.acceptedCandidates();
      if (batch.candidates.length === 0) {
        toast.error('No applications have been approved yet.');
        return;
      }

      setLettersTruncatedAt(batch.truncated ? batch.ceiling : null);
      setLettersFor(batch.candidates);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load approved applicants');
    } finally {
      setLoadingLetters(false);
    }
  };

  const openSingleLetter = (app: OrbitApplication) => {
    setLettersTruncatedAt(null);
    setLettersFor([toLetterCandidate(app)]);
  };

  /**
   * Approving asks first, because it cannot be undone.
   *
   * The whole point of a one-way decision is that there is no recovery from a
   * misclick, so the confirmation names the applicant rather than saying "are
   * you sure" — reading a name is what catches the wrong row.
   */
  // Only pending rows are selectable: an approved application has nothing that
  // can be done to it, so offering a checkbox would promise an action that does
  // not exist.
  const selectable = applications.filter((a) => a.status !== 'approved');
  const allSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectable.map((a) => a.id)));

  const approveSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Approve ${ids.length} application${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;

    setApprovingBulk(true);
    try {
      const { updated, skipped } = await applicationsApi.approveMany(ids);
      setSelected(new Set());
      await load();

      // Skipped rows are REPORTED, not swallowed. Silently approving 18 of 20
      // and saying "done" is how someone believes a decision was recorded when
      // it was not.
      if (skipped.length) {
        toast(`Approved ${updated}. Skipped ${skipped.length}: ${skipped[0].reason}`, {
          icon: '\u26a0\ufe0f',
        });
      } else {
        toast.success(`Approved ${updated} application${updated === 1 ? '' : 's'}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not approve the selection');
    } finally {
      setApprovingBulk(false);
    }
  };

  const approve = async (app: OrbitApplication) => {
    if (!confirm(`Approve ${app.full_name}? This cannot be undone.`)) return;
    await updateStatus(app, 'approved');
  };

  const updateStatus = async (app: OrbitApplication, nextStatus: OrbitApplicationStatus) => {
    setUpdatingId(app.id);
    try {
      const updated = await applicationsApi.updateStatus(app.id, nextStatus);
      setApplications((current) => current.map((item) => (item.id === app.id ? { ...item, ...updated } : item)));
      toast.success('Application updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update application');
    } finally {
      setUpdatingId('');
    }
  };

  /**
   * Downloads every application as a workbook.
   *
   * REPLACES THE GOOGLE SHEET, which is now disconnected in both directions —
   * its readback was an approval path no person could be named for, and its
   * writeback kept a permanent copy of the intake's names, phone numbers,
   * institutions and matriculation numbers in a document shared by link and
   * inherited by whoever had access last term. This produces the same columns
   * on demand, for an admin who is signed in, and leaves no second copy behind.
   *
   * `xlsx` is imported lazily. It is the largest dependency in the app and this
   * is a button most admins press rarely, so loading it with the tab would cost
   * every page view for a feature used occasionally — on the connections a lot
   * of this cohort is browsing on, that is a real difference.
   */
  const [exporting, setExporting] = useState(false);

  const downloadWorkbook = async () => {
    setExporting(true);
    try {
      const { headers, rows, truncated } = await applicationsApi.exportRows();

      const XLSX = await import('xlsx');
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

      // Sized so the columns people actually read are legible without dragging.
      ws['!cols'] = headers.map((h) =>
        h === 'Motivation' || h === 'Skills' ? { wch: 60 }
          : h === 'Email' || h === 'Institution' ? { wch: 32 }
            : { wch: Math.max(12, h.length + 2) },
      );
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Applications');

      // Dated, because this is a snapshot. An undated export sitting in a
      // downloads folder is indistinguishable from a current one.
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `orbit_applications_${stamp}.xlsx`);

      if (truncated) {
        // Never silently partial — a short roll that looks complete is worse
        // than an error.
        toast.error('Export capped at 5,000 rows. Some applications are not included.');
      } else {
        toast.success(`Downloaded ${rows.length} application${rows.length === 1 ? '' : 's'}.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not build the export');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">{heading}</h2>
          <p className="text-sm text-slate-500">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Matches what the server matches — named so nobody has to guess
              whether a reference code will work. */}
          <button
            type="button"
            onClick={downloadWorkbook}
            disabled={exporting}
            title="Download every application as an Excel workbook"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-iih-green hover:text-iih-green disabled:opacity-50"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {exporting ? 'Building…' : 'Export to Excel'}
          </button>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search name, email or reference code…"
            className="w-full sm:w-80"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label="Sort applications"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-iih-green focus:ring-2 focus:ring-iih-green/20"
          >
            <option value="submitted">Newest first</option>
            <option value="name">Name A–Z</option>
            {/* Pointless on a screen already showing one programme. */}
            {!programmeType && <option value="programme">Programme</option>}
          </select>
          {/* Always offered, and never labelled with a count: the number of
              approved applicants is not knowable from this table, and a count
              taken from it would be the reassuring wrong one. */}
          <button
            onClick={openBatchLetters}
            disabled={loadingLetters}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loadingLetters ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            Acceptance letters
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/*
        Which pile you are working, as a control rather than a dropdown.
        Pending and approved are different jobs — one is a decision queue, the
        other is a record you print letters from — and a <select> buried among
        the filters made them look like the same list seen through a lens. The
        count is on the tab because "how many are waiting" is the question this
        screen exists to answer.
      */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {STATUS_OPTIONS.map((item) => {
          const active = status === item.value;
          const count = item.value ? counts[item.value] : undefined;
          return (
            <button
              key={item.value || 'all'}
              onClick={() => setStatus(item.value)}
              aria-current={active ? 'true' : undefined}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-iih-green text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {item.label}
              {count !== undefined && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-iih-green/30 bg-orbit-mint px-4 py-3">
          <span className="text-sm font-medium text-orbit-ink">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-white/60"
            >
              Clear
            </button>
            <button
              onClick={approveSelected}
              disabled={approvingBulk}
              className="inline-flex items-center gap-2 rounded-lg bg-iih-green px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-iih-green-dark disabled:opacity-50"
            >
              {approvingBulk ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Approve {selected.size}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-52 items-center justify-center rounded-lg border border-slate-200 bg-white">
          <Loader2 className="h-8 w-8 animate-spin text-iih-green" />
        </div>
      ) : sorted.length === 0 ? (
        // An empty list has two very different causes, and telling someone
        // "applications will appear here" when they have just searched for a
        // name is unhelpful — they know applications exist; they want to know
        // this one does not match.
        debouncedSearch ? (
          <EmptyState
            illustration={<ClipboardList className="h-7 w-7" />}
            title={`Nothing matches "${debouncedSearch}"`}
            description="Searches applicant name, email address and reference code. Check the status filter too — it applies alongside the search."
          />
        ) : (
          <EmptyState
            illustration={<ClipboardList className="h-7 w-7" />}
            title="No applications found"
            description="New public applications will appear here after applicants submit the ORBIT form."
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left">
                  <button
                    onClick={toggleAll}
                    aria-label={allSelected ? 'Deselect all applications' : 'Select all applications'}
                    disabled={selectable.length === 0}
                    className="text-slate-500 hover:text-slate-700 disabled:opacity-30"
                  >
                    {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                  </button>
                </th>
                {['Applicant', 'Programme', 'Mode / Tracks', 'Status', 'Submitted', 'Actions'].map((heading) => (
                  <th key={heading} className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {sorted.map((app) => (
                <tr key={app.id} className="align-top hover:bg-slate-50">
                  <td className="px-4 py-4">
                    {app.status !== 'approved' && (
                      <button
                        onClick={() => toggle(app.id)}
                        aria-label={`${selected.has(app.id) ? 'Deselect' : 'Select'} ${app.full_name}`}
                        className="text-slate-500 hover:text-slate-700"
                      >
                        {selected.has(app.id) ? (
                          <CheckSquare className="h-4 w-4 text-iih-green" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-start gap-3">
                      {/* AuthedImage, not <img src>. A stored passport photo is
                          served by /applications/document, which checks the
                          session and audits the read — it has no public URL. */}
                      {app.passport_photo_url && isAuthedDocumentUrl(app.passport_photo_url) ? (
                        <AuthedImage
                          src={app.passport_photo_url}
                          alt={app.full_name}
                          className="h-12 w-12 rounded-lg border border-slate-200 object-cover"
                        />
                      ) : app.passport_photo_url ? (
                        <img
                          src={app.passport_photo_url}
                          alt={app.full_name}
                          className="h-12 w-12 rounded-lg border border-slate-200 object-cover"
                        />
                      ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-sm font-bold text-slate-500">
                          {app.full_name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-slate-900">{app.full_name}</p>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PROGRAMME_CLASS[app.programme_type] ?? 'bg-slate-100 text-slate-600'}`}>
                            {programmeLabel(app.programme_type)}
                          </span>
                        </div>
                        <p className="text-sm text-slate-600">{app.email}</p>
                        <p className="text-sm text-slate-600">{app.phone}</p>
                        <p className="mt-1 text-xs font-medium text-slate-400">{app.reference_code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-700">
                    {/* Only what this applicant actually supplied. These fields
                        are required for SIWES and optional for everyone else, so
                        rendering them unconditionally printed "-" three times and
                        a date line reading "- to -" on the majority of rows — a
                        record that looks like it failed to save rather than one
                        that was never asked for these details. */}
                    <p className="font-medium">{programmeLabel(app.programme_type)}</p>
                    {app.institution_name && <p>{app.institution_name}</p>}
                    {app.course_of_study && <p>{app.course_of_study}</p>}
                    {app.matric_number && <p>{app.matric_number}</p>}
                    {(app.siwes_start_date || app.siwes_end_date) && (
                      <p className="text-slate-500">
                        {formatDate(app.siwes_start_date)} to {formatDate(app.siwes_end_date)}
                      </p>
                    )}
                    {app.institution_supervisor_name && (
                      <p className="mt-1 text-xs text-slate-500">Supervisor: {app.institution_supervisor_name}</p>
                    )}
                    {app.siwes_letter_url && (
                      isAuthedDocumentUrl(app.siwes_letter_url) ? (
                        // Fetched with the session and opened as a blob. A
                        // plain href would hit the route without an
                        // Authorization header and 404.
                        <button
                          onClick={() => void openDocument(app.siwes_letter_url!)}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-iih-green hover:underline"
                        >
                          SIWES form/letter <ExternalLink className="h-3 w-3" />
                        </button>
                      ) : (
                        // Not one of ours, so it is a value the applicant
                        // supplied — same untrusted-href path as portfolio_url.
                        <SafeLink
                          href={app.siwes_letter_url}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-iih-green hover:underline"
                        >
                          SIWES form/letter <ExternalLink className="h-3 w-3" />
                        </SafeLink>
                      )
                    )}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-700">
                    {app.assigned_participation_mode ? (
                      <p className="capitalize">
                        <span className="font-semibold">{app.assigned_participation_mode}</span>
                        {app.assigned_participation_mode !== app.preferred_participation_mode && (
                          // Named, because the difference is the decision. Without
                          // it the row just looks like intake got it wrong.
                          <span
                            className="ml-1 text-xs font-normal text-amber-700"
                            title={app.mode_override_reason ?? undefined}
                          >
                            (assigned, was {app.preferred_participation_mode})
                          </span>
                        )}
                      </p>
                    ) : (
                      <p className="capitalize text-slate-500">
                        {app.preferred_participation_mode}
                        <span className="ml-1 text-xs">(not yet assigned)</span>
                      </p>
                    )}
                    <div className="mt-2 flex max-w-xs flex-wrap gap-1">
                      {app.track_interests?.length ? app.track_interests.map((track) => (
                        <span key={track} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                          {trackShortLabel(track)}
                        </span>
                      )) : <span className="text-slate-400">No track selected</span>}
                    </div>
                    {app.portfolio_url && (
                      <SafeLink href={app.portfolio_url} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-iih-green hover:underline">
                        Portfolio <ExternalLink className="h-3 w-3" />
                      </SafeLink>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClass(app.status)}`}>
                      {app.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-600">
                    {formatDate(app.created_at)}
                  </td>
                  <td className="px-5 py-4">
                    {/* A button, not a dropdown. There is one decision to make,
                        and it is irreversible — a select implies you can pick
                        your way back, which you cannot. An approved row offers
                        nothing, because there is nothing left to do to it. */}
                    {app.status === 'approved' && takesAcceptanceLetter(app) ? (
                      // Not "nothing left to do" after all: the decision is
                      // final, but the letter the university needs follows from
                      // it and is reprinted whenever one goes astray. Named
                      // "Acceptance letter" and not "…Approved…" deliberately —
                      // Playwright matches accessible names by substring, and
                      // the intake spec asserts an approved row offers no
                      // button matching "Approve".
                      <button
                        onClick={() => openSingleLetter(app)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        <FileText className="h-4 w-4" />
                        Acceptance letter
                      </button>
                    ) : app.status === 'approved' ? (
                      // Approved, but not a SIWES applicant: no letter follows,
                      // and there is nothing else left to do to the row.
                      <span className="text-sm text-slate-400">Approved</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                      {/*
                        Named "Assign", NOT "Assign & Approve": Playwright matches
                        an accessible name by substring, so a second button
                        containing "Approve" would make the intake spec's row
                        locator resolve two elements and fail on strict mode.
                      */}
                      <button
                        onClick={() => setPlacementFor(app)}
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        Assign
                      </button>
                      <button
                        onClick={() => approve(app)}
                        disabled={updatingId === app.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-iih-green px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-iih-green-dark disabled:opacity-50"
                      >
                        {updatingId === app.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        Approve
                      </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {placementFor && (
        <PlacementModal
          application={placementFor}
          onClose={() => setPlacementFor(null)}
          onSaved={load}
        />
      )}

      {lettersFor && (
        <AcceptanceLetterPrintView
          candidates={lettersFor}
          truncatedAt={lettersTruncatedAt}
          onClose={() => setLettersFor(null)}
        />
      )}
    </div>
  );
}
