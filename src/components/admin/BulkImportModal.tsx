/**
 * BulkImportModal — CSV & Excel user import with:
 *  • Robust CSV parsing (handles quoted fields with commas/newlines)
 *  • Excel parsing via ArrayBuffer (modern, non-deprecated)
 *  • Interactive column mapping UI
 *  • Per-row validation in preview
 *  • Stream name → ID resolution
 *  • Progress tracking during import
 *  • Downloadable CSV and Excel templates
 */
import { useState, useCallback } from 'react';
import {
  Upload, X, CheckCircle, XCircle, AlertCircle,
  Loader2, ArrowRight, RefreshCw, FileText, Table,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { usersApi } from '../../lib/api/users';
import { streamsApi } from '../../lib/api/streams';
import { useAuth } from '../../contexts/AuthContext';
import { OrbitStream } from '../../types/database';

/* ─── Types ─────────────────────────────────────────────────────────────── */

type ImportField = 'full_name' | 'email' | 'stream' | 'ignore';

interface ParsedRow {
  _raw: string[];
  full_name: string;
  email: string;
  stream: string;
  validationError?: string;
}

interface ImportResult extends ParsedRow {
  status: 'success' | 'error' | 'skipped';
  error?: string;
  action?: 'created' | 'assigned' | 'skipped';
  /**
   * The one and only copy of a newly created account's password.
   *
   * `adminCreateUser` hashes a random temp password and deliberately does NOT
   * store the plaintext (convex/users.ts) — it is returned to the creating
   * admin exactly once and is unrecoverable afterwards. CreateUserModal treats
   * displaying it as critical for that reason; this modal used to drop it on
   * the floor, so a 100-row import produced 100 accounts that nobody on earth
   * could sign into, and reported all 100 as "created".
   */
  tempPassword?: string;
}

interface BulkImportModalProps {
  onClose: () => void;
  onComplete?: () => void;
  streamId?: string;
  streamName?: string;
}

type Step = 'upload' | 'map' | 'preview' | 'results';

/* ─── CSV parser (RFC 4180 compliant) ───────────────────────────────────── */

function parseCSVText(text: string): string[][] {
  // Normalise line endings and strip BOM
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;

  while (i < src.length) {
    if (src[i] === '"') {
      // Quoted field
      let field = '';
      i++; // skip opening quote
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (src[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += src[i++];
        }
      }
      row.push(field);
      // skip separator/newline after closing quote
      if (src[i] === ',') i++;
    } else if (src[i] === ',') {
      row.push('');
      i++;
    } else if (src[i] === '\n') {
      rows.push(row);
      row = [];
      i++;
    } else {
      let field = '';
      while (i < src.length && src[i] !== ',' && src[i] !== '\n') {
        field += src[i++];
      }
      row.push(field.trim());
      if (src[i] === ',') i++;
    }
  }
  if (row.length > 0 && row.some((c) => c !== '')) rows.push(row);

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ─── Column guesser ─────────────────────────────────────────────────────── */

const NAME_HINTS = ['name', 'full name', 'fullname', 'student name', 'intern name'];
const EMAIL_HINTS = ['email', 'e-mail', 'mail', 'email address'];
const STREAM_HINTS = ['stream', 'track', 'cohort', 'group', 'programme', 'program'];

function guessField(header: string): ImportField {
  const h = header.toLowerCase().trim();
  if (NAME_HINTS.some((k) => h.includes(k))) return 'full_name';
  if (EMAIL_HINTS.some((k) => h.includes(k))) return 'email';
  if (STREAM_HINTS.some((k) => h.includes(k))) return 'stream';
  return 'ignore';
}

/* ─── Template generator ─────────────────────────────────────────────────── */

const TEMPLATE_HEADERS = ['Full Name', 'Email', 'Stream (optional)'];
const TEMPLATE_ROWS = [
  ['John Doe', 'john.doe@example.com', 'Web Development'],
  ['Jane Smith', 'jane.smith@example.com', 'Data Analytics'],
  ['', '', '— Leave Stream blank to assign later —'],
];

async function downloadCSVTemplate() {
  const lines = [TEMPLATE_HEADERS, ...TEMPLATE_ROWS].map((r) =>
    r.map((v) => (v.includes(',') ? `"${v}"` : v)).join(',')
  );
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'orbit_import_template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The created accounts' credentials, as a file the admin actually keeps.
 *
 * Rendering a hundred passwords into the results table is not a usable handover
 * and invites a screenshot; a download is. This is the only moment these values
 * exist — once this modal closes they are gone, and the sole remaining route
 * into those accounts is a per-user password reset or the magic-link flow.
 */
function downloadCredentials(rows: ImportResult[]) {
  const withPasswords = rows.filter((r) => r.tempPassword);
  if (withPasswords.length === 0) return;

  /**
   * CSV-quoted AND formula-neutralised.
   *
   * Names and emails here come verbatim from a spreadsheet the admin was sent,
   * so they are applicant-supplied text. Excel and Sheets execute a cell
   * beginning `=`, `+`, `-` or `@` as a formula on open — and this particular
   * file has a temporary password in the very next column, which is exactly
   * what a `=HYPERLINK(...&B2&C2)` payload would exfiltrate. A leading
   * apostrophe makes the cell literal text. `\r` is quoted too: alone it is a
   * row break in some readers, and the previous test only looked for `\n`.
   */
  const esc = (v: string) => {
    const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [
    ['Full Name', 'Email', 'Temporary Password'].join(','),
    ...withPasswords.map((r) => [r.full_name, r.email, r.tempPassword!].map(esc).join(',')),
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'orbit_new_account_credentials.csv';
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadExcelTemplate() {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...TEMPLATE_ROWS]);
  // Column widths
  ws['!cols'] = [{ wch: 24 }, { wch: 32 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Users');
  XLSX.writeFile(wb, 'orbit_import_template.xlsx');
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function BulkImportModal({ onClose, onComplete, streamId, streamName }: BulkImportModalProps) {
  const { user } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [columnMap, setColumnMap] = useState<ImportField[]>([]);
  const [preview, setPreview] = useState<ParsedRow[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [streams, setStreams] = useState<OrbitStream[]>([]);
  const [loadingStreams, setLoadingStreams] = useState(false);

  /* Load streams for name→id resolution */
  const ensureStreams = useCallback(async () => {
    if (streams.length > 0) return;
    setLoadingStreams(true);
    try {
      const list = await streamsApi.getActiveStreams();
      setStreams(list);
    } catch {
      // silently continue — stream assignment will fail if name can't be resolved
    } finally {
      setLoadingStreams(false);
    }
  }, [streams]);

  /* ── File parsing ─────────────────────────────────────────────────────── */

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const ext = file.name.split('.').pop()?.toLowerCase();
    let headers: string[] = [];
    let rows: string[][] = [];

    try {
      if (ext === 'csv') {
        const text = await file.text();
        const parsed = parseCSVText(text);
        if (parsed.length === 0) { toast.error('The CSV file appears to be empty.'); return; }
        headers = parsed[0].map((h) => h.trim());
        rows = parsed.slice(1);
      } else if (ext === 'xlsx' || ext === 'xls') {
        const buffer = await file.arrayBuffer();
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
        if (data.length === 0) { toast.error('The Excel file appears to be empty.'); return; }
        headers = (data[0] as string[]).map((h) => String(h).trim());
        rows = (data.slice(1) as string[][]).map((r) => r.map((c) => String(c)));
      } else {
        toast.error('Unsupported file type. Please upload a .csv or .xlsx file.');
        return;
      }
    } catch (err) {
      toast.error('Failed to read file: ' + (err instanceof Error ? err.message : 'Unknown error'));
      return;
    }

    // Filter out entirely empty rows
    rows = rows.filter((r) => r.some((c) => c.trim() !== ''));

    setRawHeaders(headers);
    setRawRows(rows);
    setColumnMap(headers.map(guessField));
    setStep('map');
    await ensureStreams();
  }, [ensureStreams]);

  /* ── Build preview from column map ───────────────────────────────────── */

  const buildPreview = useCallback(() => {
    const nameIdx = columnMap.indexOf('full_name');
    const emailIdx = columnMap.indexOf('email');
    const streamIdx = columnMap.indexOf('stream');

    const rows: ParsedRow[] = rawRows.map((r) => {
      const row: ParsedRow = {
        _raw: r,
        full_name: nameIdx >= 0 ? (r[nameIdx] ?? '').trim() : '',
        email: emailIdx >= 0 ? (r[emailIdx] ?? '').trim() : '',
        stream: streamId ? (streamName ?? '') : (streamIdx >= 0 ? (r[streamIdx] ?? '').trim() : ''),
      };
      // Validation
      if (!row.full_name) row.validationError = 'Missing Full Name';
      else if (!row.email) row.validationError = 'Missing Email';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) row.validationError = 'Invalid email format';
      return row;
    });

    setPreview(rows);
    setStep('preview');
  }, [columnMap, rawRows, streamId, streamName]);

  /* ── Import ───────────────────────────────────────────────────────────── */

  const handleImport = async () => {
    if (!user?.id) return;
    setImporting(true);
    setImportProgress(0);

    const importResults: ImportResult[] = [];
    const validRows = preview.filter((r) => !r.validationError);
    const invalidRows = preview.filter((r) => r.validationError);

    // Add invalid rows immediately as errors
    for (const row of invalidRows) {
      importResults.push({ ...row, status: 'error', error: row.validationError });
    }

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      setImportProgress(Math.round(((i + 1) / validRows.length) * 100));

      try {
        // Resolve stream ID from name
        let resolvedStreamId = streamId;
        if (!resolvedStreamId && row.stream) {
          const match = streams.find(
            (s) => s.name.toLowerCase().trim() === row.stream.toLowerCase().trim()
          );
          resolvedStreamId = match?.id;
        }

        const existingUser = await usersApi.getUserByEmail(row.email);

        if (existingUser) {
          // Existing user — assign to stream if needed
          if (resolvedStreamId && existingUser.current_stream_id !== resolvedStreamId) {
            await streamsApi.assignMemberToStream(
              { user_id: existingUser.id, stream_id: resolvedStreamId },
              user.id
            );
            importResults.push({ ...row, status: 'success', action: 'assigned' });
          } else {
            importResults.push({ ...row, status: 'skipped', action: 'skipped' });
          }
        } else {
          // New user
          const newUser = await usersApi.createUser({
            email: row.email,
            full_name: row.full_name,
            roles: ['intern'],
            // Stated, not left to a fallback. An imported intern with no
            // programme carries no logbook, and the enrolment-data guess only
            // rescues them if a matric number happens to come across too.
            programme_type: 'siwes',
            stream_id: resolvedStreamId,
          });

          if (resolvedStreamId && newUser?.id) {
            await streamsApi.assignMemberToStream(
              { user_id: newUser.id, stream_id: resolvedStreamId },
              user.id
            );
          }
          importResults.push({
            ...row,
            status: 'success',
            action: 'created',
            tempPassword: newUser?.temp_password,
          });
        }
      } catch (err) {
        importResults.push({
          ...row,
          status: 'error',
          error: err instanceof Error ? err.message : 'Import failed',
        });
      }
    }

    setResults(importResults);
    setImporting(false);
    setStep('results');
    onComplete?.();
  };

  /* ── Reset ────────────────────────────────────────────────────────────── */

  const reset = () => {
    setStep('upload');
    setFileName('');
    setRawHeaders([]);
    setRawRows([]);
    setColumnMap([]);
    setPreview([]);
    setResults([]);
    setImporting(false);
    setImportProgress(0);
  };

  /* ── Derived counts ───────────────────────────────────────────────────── */

  const validCount = preview.filter((r) => !r.validationError).length;
  const invalidCount = preview.filter((r) => r.validationError).length;
  const successCount = results.filter((r) => r.status === 'success').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const errorCount = results.filter((r) => r.status === 'error').length;
  const credentialCount = results.filter((r) => r.tempPassword).length;

  const FIELD_COLORS: Record<ImportField, string> = {
    full_name: 'bg-blue-100 text-blue-700',
    email: 'bg-green-100 text-green-700',
    stream: 'bg-purple-100 text-purple-700',
    ignore: 'bg-slate-100 text-slate-500',
  };

  const nameMapped = columnMap.includes('full_name');
  const emailMapped = columnMap.includes('email');

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-import-modal-title"
    >
      <div className="bg-white rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h2 id="bulk-import-modal-title" className="text-xl font-bold text-slate-800">
              {streamId ? `Import Users to ${streamName}` : 'Bulk User Import'}
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">CSV or Excel — up to 500 rows</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step progress */}
        <div className="flex items-center gap-0 px-6 py-3 bg-slate-50 border-b border-slate-200 text-xs font-medium shrink-0">
          {(['upload', 'map', 'preview', 'results'] as Step[]).map((s, idx) => (
            <div key={s} className="flex items-center">
              <span className={`px-3 py-1 rounded-full ${step === s ? 'bg-iih-green text-white' : 'text-slate-400'}`}>
                {idx + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
              </span>
              {idx < 3 && <ArrowRight className="w-3 h-3 text-slate-300 mx-1" />}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-6">

          {/* ── STEP 1: Upload ── */}
          {step === 'upload' && (
            <div className="space-y-6">
              {/* Template downloads */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
                <h3 className="font-semibold text-blue-900 mb-1">Step 1: Download a template</h3>
                <p className="text-sm text-blue-700 mb-4">
                  Use our template to ensure your file has the right columns. Required: <strong>Full Name</strong> and <strong>Email</strong>.
                  {!streamId && <> Optional: <strong>Stream</strong> (must match an existing stream name exactly).</>}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={downloadCSVTemplate}
                    className="flex items-center gap-2 bg-white border border-blue-300 text-blue-700 hover:bg-blue-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    <FileText className="w-4 h-4" />
                    Download CSV Template
                  </button>
                  <button
                    onClick={downloadExcelTemplate}
                    className="flex items-center gap-2 bg-white border border-green-300 text-green-700 hover:bg-green-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Table className="w-4 h-4" />
                    Download Excel Template
                  </button>
                </div>
              </div>

              {/* File drop zone */}
              <div>
                <h3 className="font-semibold text-slate-800 mb-3">Step 2: Upload your file</h3>
                <label className="flex flex-col items-center justify-center w-full h-44 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:border-iih-green hover:bg-green-50/30 transition-colors">
                  <Upload className="w-10 h-10 text-slate-400 mb-3" />
                  <p className="font-medium text-slate-600">Click to choose a file</p>
                  <p className="text-sm text-slate-400 mt-1">CSV, XLS, or XLSX — max 500 rows</p>
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    onChange={handleFile}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Format hints */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-slate-600">
                <div className="bg-slate-50 rounded-lg p-4">
                  <p className="font-semibold text-slate-700 mb-2">Accepted column names</p>
                  <ul className="space-y-1 text-slate-500">
                    <li><span className="font-mono text-blue-600">Full Name</span> — or "Name", "Student Name"</li>
                    <li><span className="font-mono text-green-600">Email</span> — or "Email Address", "E-mail"</li>
                    {!streamId && <li><span className="font-mono text-purple-600">Stream</span> — or "Track", "Cohort", "Group"</li>}
                  </ul>
                </div>
                <div className="bg-slate-50 rounded-lg p-4">
                  <p className="font-semibold text-slate-700 mb-2">How it works</p>
                  <ul className="space-y-1 text-slate-500">
                    <li>• New emails → create user account</li>
                    <li>• Existing emails → assign to stream</li>
                    <li>• Passwords emailed to new users</li>
                    <li>• Duplicate rows are skipped</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* ── STEP 2: Map columns ── */}
          {step === 'map' && (
            <div className="space-y-5">
              <div>
                <h3 className="font-semibold text-slate-800 mb-1">Map your columns</h3>
                <p className="text-sm text-slate-500">
                  We auto-detected the field for each column. Correct any that are wrong, then click <strong>Continue</strong>.
                </p>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left px-4 py-3 text-slate-600 font-medium w-1/3">Your Column</th>
                      <th className="text-left px-4 py-3 text-slate-600 font-medium w-1/3">Maps To</th>
                      <th className="text-left px-4 py-3 text-slate-600 font-medium">Sample Values</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rawHeaders.map((header, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">{header}</td>
                        <td className="px-4 py-3">
                          <select
                            value={columnMap[idx]}
                            aria-label={`Map column ${header}`}
                            onChange={(e) => {
                              const next = [...columnMap];
                              next[idx] = e.target.value as ImportField;
                              setColumnMap(next);
                            }}
                            className={`text-xs font-medium px-2 py-1 rounded-lg border-0 ring-1 ring-slate-200 cursor-pointer ${FIELD_COLORS[columnMap[idx]]}`}
                          >
                            <option value="full_name">Full Name ✓</option>
                            <option value="email">Email ✓</option>
                            <option value="stream">Stream</option>
                            <option value="ignore">Ignore</option>
                          </select>
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs truncate max-w-xs">
                          {rawRows.slice(0, 3).map((r) => r[idx]).filter(Boolean).join(' · ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(!nameMapped || !emailMapped) && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    {!nameMapped && !emailMapped ? 'Map at least one column to "Full Name" and one to "Email" to continue.'
                      : !nameMapped ? 'Please map a column to "Full Name".'
                      : 'Please map a column to "Email".'}
                  </span>
                </div>
              )}

              <div className="text-sm text-slate-500">
                File: <span className="font-medium text-slate-700">{fileName}</span> · {rawRows.length} data rows detected
              </div>
            </div>
          )}

          {/* ── STEP 3: Preview ── */}
          {step === 'preview' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800">Review before importing</h3>
                  <p className="text-sm text-slate-500 mt-0.5">
                    <span className="text-green-600 font-medium">{validCount} valid</span>
                    {invalidCount > 0 && <> · <span className="text-red-600 font-medium">{invalidCount} with errors</span></>}
                    {loadingStreams && <> · <Loader2 className="inline w-3 h-3 animate-spin ml-1" /> loading streams</>}
                  </p>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium w-8">#</th>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Full Name</th>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Email</th>
                        {!streamId && <th className="text-left px-4 py-3 text-slate-500 font-medium">Stream</th>}
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.map((row, i) => (
                        <tr key={i} className={row.validationError ? 'bg-red-50' : 'hover:bg-slate-50'}>
                          <td className="px-4 py-2.5 text-slate-400 text-xs">{i + 1}</td>
                          <td className="px-4 py-2.5 text-slate-800">{row.full_name || <span className="text-red-400 italic">missing</span>}</td>
                          <td className="px-4 py-2.5 text-slate-600">{row.email || <span className="text-red-400 italic">missing</span>}</td>
                          {!streamId && <td className="px-4 py-2.5 text-slate-500">{row.stream || <span className="text-slate-300">—</span>}</td>}
                          <td className="px-4 py-2.5">
                            {row.validationError
                              ? <span className="text-xs text-red-600 flex items-center gap-1"><XCircle className="w-3 h-3" />{row.validationError}</span>
                              : <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle className="w-3 h-3" />Ready</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {invalidCount > 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
                  Rows with errors will be skipped during import. Fix them in your file and re-upload, or proceed and import only the valid rows.
                </p>
              )}

              {importing && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Importing…</span>
                    <span>{importProgress}%</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2">
                    <div
                      className="bg-iih-green h-2 rounded-full transition-all duration-300"
                      style={{ width: `${importProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 4: Results ── */}
          {step === 'results' && (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                  <p className="text-3xl font-bold text-green-700">{successCount}</p>
                  <p className="text-sm text-green-600 mt-1">Imported</p>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
                  <p className="text-3xl font-bold text-amber-700">{skippedCount}</p>
                  <p className="text-sm text-amber-600 mt-1">Skipped</p>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
                  <p className="text-3xl font-bold text-red-700">{errorCount}</p>
                  <p className="text-sm text-red-600 mt-1">Failed</p>
                </div>
              </div>

              {credentialCount > 0 && (
                /**
                 * Shown once, because the passwords exist once. Leaving this
                 * screen discards them permanently — there is no second copy on
                 * the server to fall back to.
                 */
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold text-amber-900">
                      {credentialCount} new {credentialCount === 1 ? 'account has' : 'accounts have'} a
                      temporary password — download it now
                    </p>
                    <p className="text-sm text-amber-700 mt-0.5">
                      These passwords are not stored anywhere and cannot be shown again once you
                      close this window. Without them, each member has to use a password reset or a
                      magic link to get in for the first time.
                    </p>
                    <button
                      onClick={() => downloadCredentials(results)}
                      className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg"
                    >
                      <FileText className="w-4 h-4" />
                      Download credentials CSV
                    </button>
                  </div>
                </div>
              )}

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Status</th>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Full Name</th>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Email</th>
                        <th className="text-left px-4 py-3 text-slate-500 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {results.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-4 py-2.5">
                            {r.status === 'success'
                              ? <CheckCircle className="w-4 h-4 text-green-600" />
                              : r.status === 'skipped'
                              ? <span className="w-4 h-4 text-amber-500 inline-block text-center">→</span>
                              : <XCircle className="w-4 h-4 text-red-600" />}
                          </td>
                          <td className="px-4 py-2.5 text-slate-800">{r.full_name}</td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs">{r.email}</td>
                          <td className="px-4 py-2.5 text-xs">
                            {r.status === 'success'
                              ? <span className="text-green-600">{r.action === 'created' ? 'Account created' : 'Assigned to stream'}</span>
                              : r.status === 'skipped'
                              ? <span className="text-amber-600">Already in stream</span>
                              : <span className="text-red-600">{r.error}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 bg-slate-50 shrink-0 gap-3">
          <div>
            {step !== 'upload' && step !== 'results' && (
              <button
                onClick={() => setStep(step === 'map' ? 'upload' : 'map')}
                className="flex items-center gap-2 text-slate-600 hover:text-slate-900 text-sm font-medium"
                disabled={importing}
              >
                ← Back
              </button>
            )}
            {step === 'results' && (
              <button onClick={reset} className="flex items-center gap-2 text-slate-600 hover:text-slate-900 text-sm font-medium">
                <RefreshCw className="w-4 h-4" />
                Import Another File
              </button>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-100"
              disabled={importing}
            >
              {step === 'results' ? 'Close' : 'Cancel'}
            </button>

            {step === 'map' && (
              <button
                onClick={buildPreview}
                disabled={!nameMapped || !emailMapped}
                className="px-5 py-2 bg-iih-green hover:bg-iih-green-dark text-white rounded-lg text-sm font-medium disabled:opacity-40 transition-colors"
              >
                Continue →
              </button>
            )}

            {step === 'preview' && (
              <button
                onClick={handleImport}
                disabled={validCount === 0 || importing}
                className="px-5 py-2 bg-iih-green hover:bg-iih-green-dark text-white rounded-lg text-sm font-medium disabled:opacity-40 flex items-center gap-2 transition-colors"
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Importing…</>
                  : <><CheckCircle className="w-4 h-4" />Import {validCount} User{validCount !== 1 ? 's' : ''}</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
