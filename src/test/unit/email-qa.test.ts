import { describe, it, expect } from 'vitest';
import { qaEmail, qaBlocks, type QaSubject } from '../../../convex/lib/emailQa';

const ok: QaSubject = {
  emailType: 'application_approved',
  subject: 'Your ORBIT application has been approved',
  bodyHtml:
    '<img src="https://orbit2.iih.ng/orbit-logo.png" alt="ORBIT">' +
    '<p>Welcome.</p><a href="https://orbit2.iih.ng/magic#token=abc.def">Sign in</a>',
  bodyText: 'Welcome. Your placement begins immediately.',
  recipientEmail: 'someone@example.com',
};

/**
 * Each case here is something that has gone wrong, or was one deploy from it.
 * They all SEND successfully — that is the point. The message arrives, looks
 * plausible, and is acted on by someone who then cannot do what it says.
 */
describe('qaEmail', () => {
  it('passes a well-formed message', () => {
    expect(qaEmail(ok)).toEqual([]);
    expect(qaBlocks(qaEmail(ok))).toBe(false);
  });

  it('BLOCKS an unrendered placeholder', () => {
    // The sign-in link is substituted at send time; a silent failure there would
    // otherwise mail the literal token to an applicant.
    const f = qaEmail({ ...ok, bodyHtml: ok.bodyHtml.replace('abc.def', 'ORBIT_SIGN_IN_LINK_PENDING') });
    expect(qaBlocks(f)).toBe(true);
    expect(f[0].code).toBe('placeholder');
  });

  it('BLOCKS a template variable that never rendered', () => {
    expect(qaBlocks(qaEmail({ ...ok, subject: 'Hi {{FIRST_NAME}}' }))).toBe(true);
  });

  it('BLOCKS a relative link, which goes nowhere from an inbox', () => {
    const f = qaEmail({ ...ok, bodyHtml: '<a href="/tasks">Open</a>' });
    expect(f.some((x) => x.code === 'link' && x.severity === 'block')).toBe(true);
  });

  it('BLOCKS unbalanced anchors, which swallow the rest of the mail', () => {
    const f = qaEmail({ ...ok, bodyHtml: '<a href="https://orbit2.iih.ng">Open' });
    expect(f.some((x) => x.code === 'html')).toBe(true);
  });

  it('BLOCKS a SIWES acceptance whose letter failed to build', () => {
    const f = qaEmail({ ...ok, expectsAttachment: true, hasAttachment: false });
    expect(f.some((x) => x.code === 'attachment' && x.severity === 'block')).toBe(true);
  });

  it('BLOCKS an undeliverable address and an empty subject', () => {
    expect(qaBlocks(qaEmail({ ...ok, recipientEmail: 'not-an-address' }))).toBe(true);
    expect(qaBlocks(qaEmail({ ...ok, subject: '   ' }))).toBe(true);
  });

  it('WARNS on a named commencement date without blocking', () => {
    const f = qaEmail({ ...ok, bodyText: 'Your placement begins on 17 August 2026.' });
    expect(f.some((x) => x.code === 'commencement' && x.severity === 'warn')).toBe(true);
    expect(qaBlocks(f)).toBe(false);
  });

  it('WARNS when the header logo is missing', () => {
    const f = qaEmail({ ...ok, bodyHtml: '<p>No logo here</p>' });
    expect(f.some((x) => x.code === 'no-logo')).toBe(true);
  });
});

describe('QA findings never quote a credential', () => {
  it('keeps the path but drops the fragment carrying a magic-link token', () => {
    const findings = qaEmail({
      emailType: 'magic_link',
      subject: 'Sign in to ORBIT',
      // Not https, so the link check fires and quotes this URL back.
      bodyHtml: '<a href="http://localhost:5173/magic#token=SUPERSECRETVALUE">Sign in</a>',
      bodyText: 'Sign in',
      recipientEmail: 'someone@example.invalid',
    });

    const link = findings.find((f) => f.code === 'link');
    expect(link).toBeDefined();

    // A finding travels into errorMessage, the attempt log and the Convex
    // function log — all readable by any admin, and the function log by anyone
    // with dashboard access. The token must not be in any of them.
    expect(link!.detail).not.toContain('SUPERSECRETVALUE');
    expect(link!.detail).toContain('[redacted]');
    // Still actionable: the path is what tells you which link was wrong.
    expect(link!.detail).toContain('/magic');
  });

  it('leaves a credential-free URL readable', () => {
    const findings = qaEmail({
      emailType: 'general',
      subject: 'Hello',
      bodyHtml: '<a href="/dashboard">Dashboard</a>',
      bodyText: 'Dashboard',
      recipientEmail: 'someone@example.invalid',
    });

    const link = findings.find((f) => f.code === 'link');
    expect(link!.detail).toContain('/dashboard');
    expect(link!.detail).not.toContain('[redacted]');
  });
});
