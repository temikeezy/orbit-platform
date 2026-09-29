import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHEET_HEADERS, applicationToRow } from '../../../convex/lib/sheets';
import type { Doc } from '../../../convex/_generated/dataModel';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * The admissions export replaces the Google Sheet.
 *
 * The sheet is disconnected in both directions: its readback approved
 * applications with no person nameable as having decided, and its writeback
 * kept a permanent copy of the whole intake's names, phone numbers,
 * institutions and matriculation numbers in a document shared by link and
 * inherited by whoever had access last term.
 *
 * What must survive that removal is the INFORMATION — admissions still has to
 * be readable outside the app — and the two properties that made the sheet safe
 * to hand around: no identity documents in it, and no silent column drift.
 */
describe('the admissions export', () => {
  it('carries exactly the columns the sheet carried', () => {
    // Reused rather than restated. A second copy of this list is precisely how
    // an export drifts from the thing it replaced.
    const src = read('convex/applications.ts');
    const start = src.indexOf('export const exportRows');
    const next = src.indexOf('export const', start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body).toContain('headers: SHEET_HEADERS');
    expect(body).toContain('applicationToRow');
    expect(SHEET_HEADERS.length).toBe(31);
  });

  it('never puts an identity document in the file', () => {
    const application = {
      referenceCode: 'ORB-2026-TEST', createdAt: 0, status: 'submitted',
      programmeType: 'siwes', fullName: 'Aisha Bello', email: 'a@example.com',
      phone: '080', trackInterests: [], consentLogbook: true, consentDataUse: true,
      passportPhotoId: 'storage-id-that-must-not-appear' as never,
      siwesLetterId: 'letter-id-that-must-not-appear' as never,
      siwesLetterFileName: 'letter.pdf',
    } as unknown as Doc<'applications'>;

    const row = applicationToRow(application);
    const joined = row.join('|');

    // The row says a document EXISTS and where to view it; the storage ids stay
    // in ORBIT behind a route that checks the caller's session. A workbook is
    // forwarded exactly like a shared sheet was.
    expect(joined).not.toContain('storage-id-that-must-not-appear');
    expect(joined).not.toContain('letter-id-that-must-not-appear');
    expect(row).toContain('in ORBIT');
  });

  it('refuses to build a row that would shift every column', () => {
    // The guard that makes reusing one definition worth it: a column added to
    // the headers and not the row silently moves every later value one place
    // left, and a spreadsheet gives no hint it happened.
    const src = read('convex/lib/sheets.ts');
    expect(src).toContain('row.length !== SHEET_HEADERS.length');
  });

  it('is bounded, and says so when it truncates', () => {
    const src = read('convex/applications.ts');
    // Bounded to this function only — later functions collect legitimately
    // (a single recipient's queued mail), and a slice to end-of-file would
    // fail on theirs.
    const start = src.indexOf('export const exportRows');
    const next = src.indexOf('export const', start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    // Assert the CALL, not the absence of a string — the word `.collect()`
    // legitimately appears in the comment explaining why it is not used, and a
    // test that reads prose fails on documentation.
    const code = body.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('.collect()');
    expect(code).toMatch(/\.take\(LIMIT \+ 1\)/);
    expect(code).toContain('truncated');
  });

  it('has no cron still writing to the sheet', () => {
    const crons = read('convex/crons.ts');
    const live = crons.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(live).not.toMatch(/crons\.\w+\([^)]*flushMirror/);
    expect(live).not.toMatch(/crons\.\w+\([^)]*syncFromSheet/);
  });
});
