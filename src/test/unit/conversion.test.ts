import { describe, it, expect } from 'vitest';
import { approvalEmail, slugCandidate } from '../../../convex/lib/conversion';
import { appUrl } from '../../../convex/lib/appUrl';

/**
 * Approval turns an applicant into a member. These are the parts of that which
 * are decidable without a database.
 */

describe('slugCandidate', () => {
  it('makes a readable slug from a name', () => {
    expect(slugCandidate('Ada Lovelace', 'ada@example.test')).toBe('ada-lovelace');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugCandidate("O'Brien-Smith,  Jr.", 'ob@example.test')).toBe('o-brien-smith-jr');
  });

  it('falls back to the email when the name yields nothing', () => {
    // A name in a non-Latin script, or one that is only punctuation, leaves an
    // empty string — and a blank slug collides with every other blank one.
    expect(slugCandidate('***', 'zainab.bello@iih.ng')).toBe('zainab-bello');
    expect(slugCandidate('查理', 'li.wei@iih.ng')).toBe('li-wei');
  });

  it('never returns an empty string', () => {
    expect(slugCandidate('', '@')).toBeTruthy();
  });
});

describe('approvalEmail', () => {
  it('tells them they are approved and how to get in', () => {
    const mail = approvalEmail('Ada Lovelace', 'ORB-2026-ABCD1234');
    expect(mail.subject).toMatch(/approved/i);
    expect(mail.bodyHtml).toContain('ORB-2026-ABCD1234');
    expect(mail.bodyHtml).toContain(appUrl());
    expect(mail.bodyHtml).toMatch(/magic link/i);
  });

  it('NEVER contains a password or a sign-in token', () => {
    const mail = approvalEmail('Ada Lovelace', 'ORB-2026-ABCD1234');
    const body = `${mail.bodyHtml} ${mail.bodyText}`;
    // A password in an inbox outlives the email, and a link minted at approval
    // time expires long before most people read it. They request their own.
    expect(body).not.toMatch(/password:/i);
    expect(body).not.toMatch(/token=/i);
    expect(body).not.toMatch(/\/magic\?/);
  });

  it('escapes the applicant name, which is attacker-supplied', () => {
    // The name came from an unauthenticated public form.
    const mail = approvalEmail('<script>alert(1)</script>', 'ORB-1');
    expect(mail.bodyHtml).not.toContain('<script>');
    expect(mail.bodyHtml).toContain('&lt;script&gt;');
  });

  it('has a plain-text part, because the queue requires one', () => {
    const mail = approvalEmail('Ada', 'ORB-1');
    expect(mail.bodyText.length).toBeGreaterThan(40);
    expect(mail.bodyText).not.toContain('<p>');
  });
});
