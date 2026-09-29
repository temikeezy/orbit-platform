import { describe, it, expect } from 'vitest';
import { normaliseOrigin, appUrl, DEFAULT_APP_URL } from '../../../convex/lib/appUrl';

/**
 * These are the refusals, and the refusals ARE the security property: this
 * module decides the origin a live sign-in link is mailed to.
 */
describe('normaliseOrigin', () => {
  it('reduces a configured URL to a bare origin', () => {
    expect(normaliseOrigin('https://orbit2.iih.ng/')).toBe('https://orbit2.iih.ng');
    expect(normaliseOrigin('  https://orbit2.iih.ng/a?b#c  ')).toBe('https://orbit2.iih.ng');
  });

  it('refuses schemes that are not http(s)', () => {
    // `.origin` is the literal STRING "null" for these, which is truthy — so a
    // presence check written the obvious way lets them into an href.
    expect(normaliseOrigin('javascript:alert(1)')).toBeNull();
    expect(normaliseOrigin('data:text/html,<b>')).toBeNull();
    expect(normaliseOrigin('mailto:a@b.com')).toBeNull();
  });

  it('refuses plaintext anywhere but a local machine', () => {
    expect(normaliseOrigin('http://orbit2.iih.ng')).toBeNull();
    expect(normaliseOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normaliseOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('is not fooled by userinfo', () => {
    // The host here is evil.example; orbit2.iih.ng is a USERNAME. Judging the
    // string by eye reads as ORBIT; `.origin` is what makes it visible.
    expect(normaliseOrigin('https://orbit2.iih.ng@evil.example/')).toBe('https://evil.example');
  });

  it('refuses what the parser refuses rather than repairing it', () => {
    expect(normaliseOrigin('orbit2.iih.ng')).toBeNull();
    expect(normaliseOrigin('//evil.example')).toBeNull();
    expect(normaliseOrigin('')).toBeNull();
    expect(normaliseOrigin(undefined)).toBeNull();
  });
});

describe('appUrl', () => {
  it('falls back to production when APP_URL is unset', () => {
    // Which is the state of the production deployment itself, and the reason
    // the default is production rather than a throw.
    expect(appUrl()).toBe(DEFAULT_APP_URL);
  });
});
