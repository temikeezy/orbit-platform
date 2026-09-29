import { describe, it, expect } from 'vitest';
import { applicationToRow, SHEET_HEADERS, retryDelayMs, MAX_MIRROR_ATTEMPTS } from '../../../convex/lib/sheets';

/**
 * The row builder and the backoff, tested as pure functions.
 *
 * These live in convex/lib deliberately — a Convex function module with a
 * substantial handler pushes the generated `api` type past TypeScript's
 * inference limit, which silently untypes call sites all over the app. Keeping
 * the logic here also makes it testable without a deployment.
 */

const application = (over: Record<string, unknown> = {}) =>
  ({
    referenceCode: 'ORB-2026-ABCD1234',
    createdAt: 1_785_000_000_000,
    status: 'submitted',
    programmeType: 'internship',
    fullName: 'Ada Lovelace',
    email: 'ada@example.test',
    phone: '08000000000',
    trackInterests: ['design-media-content', 'research-documentation-reporting'],
    preferredParticipationMode: 'hybrid',
    consentLogbook: true,
    consentDataUse: true,
    ...over,
  }) as never;

describe('applicationToRow', () => {
  it('produces exactly one value per column', () => {
    expect(applicationToRow(application())).toHaveLength(SHEET_HEADERS.length);
  });

  it('puts the reference code first, because dedup keys on column A', () => {
    // The Apps Script reads column A to decide what it already has. A column
    // inserted before it would silently break deduplication rather than error.
    expect(SHEET_HEADERS[0]).toBe('Reference');
    expect(applicationToRow(application())[0]).toBe('ORB-2026-ABCD1234');
  });

  it('never carries the passport photograph, only whether one exists', () => {
    const withPhoto = applicationToRow(application({ passportPhotoId: 'storage-id-here' }));
    const without = applicationToRow(application());

    // A sheet is shared by link and copied by export. An identity document in
    // one turns "share this with a colleague" into "hand over a passport photo".
    expect(withPhoto.join('|')).not.toContain('storage-id-here');
    expect(withPhoto[SHEET_HEADERS.indexOf('Passport photo')]).toBe('in ORBIT');
    expect(without[SHEET_HEADERS.indexOf('Passport photo')]).toBe('none');
  });

  it('flattens track interests rather than dropping them', () => {
    const row = applicationToRow(application());
    expect(row[SHEET_HEADERS.indexOf('Tracks')]).toBe(
      'design-media-content, research-documentation-reporting',
    );
  });

  it('renders the physical day as a name, including Sunday', () => {
    // 0 is Sunday and also falsy — a truthiness check here would blank it.
    const sunday = applicationToRow(application({ availablePhysicalDay: 0 }));
    expect(sunday[SHEET_HEADERS.indexOf('Physical day')]).toBe('Sunday');

    const wednesday = applicationToRow(application({ availablePhysicalDay: 3 }));
    expect(wednesday[SHEET_HEADERS.indexOf('Physical day')]).toBe('Wednesday');
  });

  it('writes empty strings for absent optional fields, not "undefined"', () => {
    const row = applicationToRow(application());
    expect(row).not.toContain(undefined);
    expect(row.join('|')).not.toContain('undefined');
  });

  it('records consent as a readable yes/no', () => {
    const row = applicationToRow(application({ consentLogbook: false }));
    expect(row[SHEET_HEADERS.indexOf('Consent — logbook')]).toBe('no');
    expect(row[SHEET_HEADERS.indexOf('Consent — data use')]).toBe('yes');
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and then stops growing', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);

    // Capped at an hour: an endpoint down for a day should be retried hourly,
    // not at intervals that grow past ever recovering on their own.
    expect(retryDelayMs(7)).toBe(60 * 60_000);
    expect(retryDelayMs(50)).toBe(60 * 60_000);

    // The whole retry window is about three hours before a row is abandoned —
    // long enough to ride out an outage, short enough not to hammer an endpoint
    // that is simply misconfigured. An abandoned row is recoverable via
    // backfillMirror, which is the only reason giving up is acceptable.
    let total = 0;
    for (let i = 1; i < MAX_MIRROR_ATTEMPTS; i++) total += retryDelayMs(i);
    expect(total).toBeGreaterThan(2 * 60 * 60_000);
    expect(total).toBeLessThan(4 * 60 * 60_000);
  });
});
