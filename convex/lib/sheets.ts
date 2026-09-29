import { Doc } from '../_generated/dataModel';

/**
 * Building and shipping the Google Sheet mirror of applications.
 *
 * IN lib/, NOT a function module, and that is load-bearing rather than tidiness.
 * Convex generates the `api`/`internal` types by inferring every exported
 * function's signature, and this project sits right at TypeScript's limit for
 * that: four functions with substantial handlers pushed it over, at which point
 * TS stops erroring and silently widens query results to `any` — eighteen call
 * sites across seven unrelated files lost their types, with no error naming the
 * cause. Four functions with THIN handlers are fine. So the work lives here,
 * where it costs the generated type nothing, and the Convex functions are
 * wrappers.
 *
 * WHY A MIRROR AT ALL: ORBIT already stores every application and shows them
 * under Admin → SIWES → Applications. The sheet is for people who work in a
 * spreadsheet. It is a MIRROR, never the source of truth — nothing reads back
 * from it, and a row edited there changes nothing in ORBIT.
 *
 * WHY AN APPS SCRIPT ENDPOINT rather than the Sheets API: the Sheets API needs a
 * Google Cloud project, a service account, and a private key living in this
 * deployment forever. A container-bound Apps Script deployed "execute as me"
 * needs none of that — the sheet stays owned by whoever created it, sharing is
 * ordinary Drive sharing, and the only secret is one we generated and can rotate
 * by redeploying the script.
 */

/** The columns, in order. */
export const SHEET_HEADERS: string[] = [
  'Reference', 'Submitted', 'Status', 'Programme',
  'Full name', 'Email', 'Phone', 'Location',
  'Institution', 'Faculty', 'Course', 'Matric number', 'Level/Year',
  'SIWES start', 'SIWES end',
  'Institution supervisor', 'Supervisor email', 'Supervisor phone',
  'Participation mode', 'Physical day', 'Tracks',
  'Skills', 'Motivation', 'Portfolio',
  'Emergency contact', 'Emergency phone',
  'Consent — logbook', 'Consent — data use',
  'Passport photo', 'SIWES letter', 'Documents',
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * One applicant as a row, in SHEET_HEADERS order.
 *
 * DELIBERATELY NO FILE CONTENT. The passport photograph and the SIWES letter
 * stay in ORBIT behind a route that checks the caller's session. A sheet is
 * shared by link and copied by export; putting an identity document in one turns
 * "share this with a colleague" into "hand over a passport photo". The row says
 * whether each document exists and where to view it.
 */
export function applicationToRow(a: Doc<'applications'>): string[] {
  const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : '');

  const row = [
    a.referenceCode,
    iso(a.createdAt),
    a.status,
    a.programmeType,
    a.fullName,
    a.email,
    a.phone,
    a.location ?? '',
    a.institutionName ?? '',
    a.faculty ?? '',
    a.courseOfStudy ?? '',
    a.matricNumber ?? '',
    a.levelOrYear ?? '',
    a.siwesStartDate ?? '',
    a.siwesEndDate ?? '',
    a.institutionSupervisorName ?? '',
    a.institutionSupervisorEmail ?? '',
    a.institutionSupervisorPhone ?? '',
    a.preferredParticipationMode,
    a.availablePhysicalDay !== undefined ? (DAYS[a.availablePhysicalDay] ?? '') : '',
    a.trackInterests.join(', '),
    a.skillsSummary ?? '',
    a.motivation ?? '',
    a.portfolioUrl ?? '',
    a.emergencyContactName ?? '',
    a.emergencyContactPhone ?? '',
    a.consentLogbook ? 'yes' : 'no',
    a.consentDataUse ? 'yes' : 'no',
    a.passportPhotoId ? 'in ORBIT' : 'none',
    a.siwesLetterId ? (a.siwesLetterFileName ?? 'in ORBIT') : 'none',
    'ORBIT → Admin → SIWES → Applications',
  ];

  // A column added to one list and not the other shifts every value after it
  // into the wrong column, and a spreadsheet gives no hint that it happened.
  if (row.length !== SHEET_HEADERS.length) {
    throw new Error(
      `Sheet row/header mismatch: ${row.length} values for ${SHEET_HEADERS.length} columns`,
    );
  }

  return row;
}

export interface DeliveryResult {
  ok: boolean;
  detail?: string;
  /** Reference codes the script reports as already present. */
  duplicates?: string[];
}

export function sheetConfigured(): boolean {
  return Boolean(process.env.SHEETS_WEBHOOK_URL && process.env.SHEETS_WEBHOOK_SECRET);
}

/**
 * Posts rows to the Apps Script endpoint.
 *
 * The script deduplicates on the reference code in the first column and reports
 * which it skipped, so re-sending is safe — which matters, because retrying is
 * the whole point and "did the previous attempt land before it timed out?" is
 * usually unanswerable.
 */
export async function deliver(rows: string[][]): Promise<DeliveryResult> {
  const url = process.env.SHEETS_WEBHOOK_URL;
  const secret = process.env.SHEETS_WEBHOOK_SECRET;

  // Not configured is not a failure. It is the normal state of a deployment
  // that has not been wired to a sheet, including dev and every preview.
  if (!url || !secret) return { ok: true, detail: 'not configured' };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, headers: SHEET_HEADERS, rows }),
    });
  } catch (err) {
    return { ok: false, detail: `network: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Apps Script answers 200 with a JSON body even for its own failures, and
  // redirects on the way to script.googleusercontent.com — so the status alone
  // says very little and the body has to be read.
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }

  try {
    const body = JSON.parse(text) as { ok?: boolean; error?: string; duplicates?: string[] };
    if (body.ok !== true) return { ok: false, detail: body.error ?? text.slice(0, 200) };
    return { ok: true, duplicates: body.duplicates ?? [] };
  } catch {
    // An HTML body means the deployment is not returning JSON — almost always
    // "Anyone with the link" not set, so Google served a sign-in page instead.
    return { ok: false, detail: `non-JSON response: ${text.slice(0, 120)}` };
  }
}

/** Exponential backoff, capped. Attempt 1 waits a minute, attempt 6 an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

/**
 * Given up on, rather than retried forever against a misconfigured endpoint.
 *
 * Eight attempts spans roughly three hours (1, 2, 4, 8, 16, 32, 60, 60 minutes),
 * which rides out an outage but does not hammer an endpoint that is simply
 * wrong. An abandoned row is not lost: `backfillMirror` re-queues it, which is
 * how you recover after fixing the deployment.
 */
export const MAX_MIRROR_ATTEMPTS = 8;

/**
 * Reads back only REFERENCE CODE and STATUS from the sheet.
 *
 * Deliberately not the whole row. The sync needs two columns to decide anything,
 * and an endpoint that returns applicant records is a data-exposure surface to
 * be guarded forever; one that returns `[reference, status]` pairs is not, even
 * if the URL and the secret both leak. The sheet stays the only copy of the full
 * data outside ORBIT.
 */
export async function readStatuses(): Promise<{
  ok: boolean;
  detail?: string;
  rows: { reference: string; status: string }[];
}> {
  const url = process.env.SHEETS_WEBHOOK_URL;
  const secret = process.env.SHEETS_WEBHOOK_SECRET;
  if (!url || !secret) return { ok: true, detail: 'not configured', rows: [] };

  let response: Response;
  try {
    response = await fetch(`${url}?action=statuses&secret=${encodeURIComponent(secret)}`);
  } catch (err) {
    return {
      ok: false,
      detail: `network: ${err instanceof Error ? err.message : String(err)}`,
      rows: [],
    };
  }

  const text = await response.text();
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}`, rows: [] };

  try {
    const body = JSON.parse(text) as {
      ok?: boolean;
      error?: string;
      statuses?: { reference: string; status: string }[];
    };
    if (body.ok !== true) return { ok: false, detail: body.error ?? 'refused', rows: [] };
    return { ok: true, rows: body.statuses ?? [] };
  } catch {
    return { ok: false, detail: `non-JSON response: ${text.slice(0, 120)}`, rows: [] };
  }
}

/**
 * How many sheet-driven approvals one sync will apply before refusing outright.
 *
 * A spreadsheet makes bulk mistakes easy in a way a UI does not: dragging the
 * fill handle down a column, or pasting a block into the wrong place, sets
 * hundreds of cells in one gesture — and approval is irreversible. Past this
 * count the sync applies NOTHING and reports it, so a slip needs a human to look
 * rather than silently admitting a cohort.
 */
export const MAX_SHEET_APPROVALS_PER_SYNC = 25;
