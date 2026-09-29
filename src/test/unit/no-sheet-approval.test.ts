import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Approval is a decision a NAMED PERSON makes, in ORBIT.
 *
 * A five-minute cron used to read the Google Sheet's Status column and approve
 * any application it marked "approved". The audit row it wrote admitted the
 * flaw in its own note: "A spreadsheet cannot identify which person made the
 * edit, so no userId is recorded."
 *
 * That mattered less while the first intake was approved in bulk behind a
 * global email hold. It matters entirely now: approval creates the person's
 * account and sends them an acceptance carrying a sign-in link within minutes,
 * so a stray paste or an autofill drag in a shared spreadsheet admits someone
 * nobody decided to admit.
 *
 * These read the source off disk rather than importing the Convex modules — the
 * same approach, and the same reason, as convex-authz-surface.test.ts: importing
 * them drags thousands of unhit lines into the coverage figure.
 */
describe('applications are never approved from the spreadsheet', () => {
  it('has no cron pulling statuses back from the sheet', () => {
    const crons = read('convex/crons.ts');
    const live = crons
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(live).not.toMatch(/crons\.\w+\([^)]*syncFromSheet/);
    expect(live).not.toContain('sync application statuses from sheet');
  });

  it('does not write an approval in applySheetStatuses', () => {
    const src = read('convex/applications.ts');
    const start = src.indexOf('export const applySheetStatuses');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('export const', start + 10));

    // The mutation survives as a refusing stub so a leftover schedule degrades
    // to a no-op. What it must never do again is write the status.
    expect(body).not.toMatch(/status:\s*'approved'/);
    expect(body).not.toContain('ctx.db.patch');
    expect(body).toMatch(/approved:\s*0/);
  });

  it('still mirrors ORBIT to the sheet, so the sheet stays a report', () => {
    // Removing the readback must not have removed the writeback — the sheet is
    // still how admissions is read outside the app.
    const crons = read('convex/crons.ts');
    expect(crons).toMatch(/crons\.\w+\([^)]*flushMirror/);
  });
});
