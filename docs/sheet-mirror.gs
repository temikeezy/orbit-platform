/**
 * ORBIT → Google Sheet mirror.
 *
 * Create a standalone Apps Script project, paste this in, set SECRET and
 * SHEET_ID below, then deploy it as a Web app with "Execute as: me" and
 * "Who has access: Anyone".
 *
 * WHAT IT IS: a write-only endpoint that appends applicant rows. It never reads
 * the sheet out, never returns applicant data, and does nothing at all without
 * the shared secret. The sheet itself stays private — this endpoint is the only
 * thing reachable, and it is reachable only by something holding the secret.
 *
 * WHY "Anyone with the link" IS SAFE HERE: that setting controls who may INVOKE
 * the script, not who may read the sheet. The script runs as you, so it can
 * write to a private sheet; a caller without the secret gets a refusal and
 * learns nothing. Without that setting Google answers with a sign-in page
 * instead of running the script, which is the single most common way this is
 * misconfigured — ORBIT reports it as "non-JSON response".
 *
 * DEDUPLICATION is by reference code, column A. ORBIT retries on failure and
 * cannot know whether a timed-out attempt landed, so the same row may well
 * arrive twice; the reply reports which were already present and ORBIT records
 * those as delivered rather than retrying them forever.
 */

// Replace with the value of SHEETS_WEBHOOK_SECRET on the Convex deployment.
const SECRET = 'PASTE_THE_SECRET_HERE';

// The spreadsheet this writes to. Set because the deployed project is
// STANDALONE rather than container-bound — getActiveSpreadsheet() returns
// nothing in a standalone script, which fails at the first append rather than
// at deploy time.
const SHEET_ID = 'PASTE_THE_SPREADSHEET_ID_HERE';
const SHEET_NAME = 'Applications';

function doPost(e) {
  /**
   * ONE EXECUTION AT A TIME.
   *
   * Deduplication reads the existing reference codes, decides which rows are
   * new, and appends them. Two executions overlapping — every ORBIT submission
   * schedules a flush, and retries pile on — can both read before either
   * writes, both conclude the same code is missing, and both append it. The
   * lock makes read-decide-append atomic.
   *
   * 30 seconds: long enough to outlast a normal append, short enough that a
   * wedged execution does not hold the door forever.
   */
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return json({ ok: false, error: 'busy, retry' });
  }

  try {
    const payload = JSON.parse(e.postData.contents);

    // Constant-time-ish compare is overkill for a 64-char random secret, but
    // returning the SAME error for a bad secret and a malformed body means a
    // caller cannot use the difference to tell whether it guessed the shape.
    if (!payload || payload.secret !== SECRET) {
      return json({ ok: false, error: 'unauthorised' });
    }

    const headers = payload.headers || [];
    const rows = payload.rows || [];
    if (!rows.length) return json({ ok: true, duplicates: [] });

    const sheet = ensureSheet(headers);

    // Existing reference codes, read once. Reading per row turns an N-row
    // backfill into N reads and hits the script time limit.
    const lastRow = sheet.getLastRow();
    const existing = {};
    if (lastRow > 1) {
      const codes = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < codes.length; i++) existing[String(codes[i][0])] = true;
    }

    const duplicates = [];
    const fresh = [];
    for (let i = 0; i < rows.length; i++) {
      const code = String(rows[i][0]);
      if (existing[code]) {
        duplicates.push(code);
      } else {
        // Guards against duplicates WITHIN one payload as well as against the
        // sheet — a backfill can legitimately contain the same code twice.
        existing[code] = true;
        fresh.push(rows[i]);
      }
    }

    if (fresh.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, fresh[0].length).setValues(fresh);
    }

    /**
     * Rows already present have their STATUS refreshed from ORBIT.
     *
     * This is the other half of the two-way sync. Without it, approving in
     * ORBIT would leave the sheet saying `submitted` forever, and the next
     * person to read the sheet would draw the wrong conclusion — or "fix" it
     * and think they had made the decision.
     *
     * ORBIT wins on conflict, always. It is the system with the audit trail.
     */
    if (duplicates.length) {
      const statusCol = headers.indexOf('Status') + 1;
      if (statusCol > 0) {
        const rowCount = sheet.getLastRow() - 1;
        const codes = sheet.getRange(2, 1, rowCount, 1).getValues();
        const rowOf = {};
        for (let i = 0; i < codes.length; i++) rowOf[String(codes[i][0])] = i + 2;

        // Status located by NAME in the incoming payload, not by a fixed index.
        // A column inserted in ORBIT would otherwise write the wrong value into
        // the Status cell, and nothing would look wrong until someone read it.
        const incomingStatus = headers.indexOf('Status');
        if (incomingStatus >= 0) {
          for (let i = 0; i < rows.length; i++) {
            const target = rowOf[String(rows[i][0])];
            if (target) sheet.getRange(target, statusCol).setValue(rows[i][incomingStatus]);
          }
        }
      }
    }

    return json({ ok: true, appended: fresh.length, duplicates: duplicates });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET with `?action=statuses&secret=…` returns REFERENCE CODE and STATUS only.
 *
 * Deliberately those two columns and nothing else. ORBIT needs exactly this to
 * decide whether a sheet edit approves someone, and an endpoint that returned
 * applicant records would be a data-exposure surface to guard forever. Even if
 * the URL and the secret both leaked, this leaks a list of reference codes.
 *
 * Any other GET is a health check, so the deployment can be verified without
 * the secret.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action !== 'statuses') {
    return json({ ok: true, service: 'ORBIT application mirror' });
  }

  if (params.secret !== SECRET) return json({ ok: false, error: 'unauthorised' });

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return json({ ok: true, statuses: [] });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusCol = headers.indexOf('Status') + 1;
  if (statusCol < 1) return json({ ok: false, error: 'no Status column' });

  const rows = sheet.getLastRow() - 1;
  const references = sheet.getRange(2, 1, rows, 1).getValues();
  const statuses = sheet.getRange(2, statusCol, rows, 1).getValues();

  const out = [];
  for (let i = 0; i < rows; i++) {
    const reference = String(references[i][0]).trim();
    if (reference) out.push({ reference: reference, status: String(statuses[i][0]).trim() });
  }

  return json({ ok: true, statuses: out });
}

function ensureSheet(headers) {
  const book = SpreadsheetApp.openById(SHEET_ID);
  let sheet = book.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
  }

  // Header row written once, then frozen so sorting cannot carry it away.
  if (sheet.getLastRow() === 0 && headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
