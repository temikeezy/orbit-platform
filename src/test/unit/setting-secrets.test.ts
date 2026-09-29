import { describe, it, expect } from 'vitest';
import {
  SECRET_FIELDS,
  maskSecrets,
  stripSecrets,
} from '../../../convex/lib/settingSecrets';
import { SECRET_UNCHANGED } from '../../../convex/lib/sentinels';

/**
 * The bug these cover: masking a credential on READ while still WRITING it.
 *
 * On 2026-09-20 `zeptomail_config.pass` and `zoho_oauth_config.clientSecret`
 * each held a verbatim copy of a live production credential — byte identical to
 * `SMTP_PASSWORD` and `ZOHO_CLIENT_SECRET` on the deployment. No server code
 * has ever read either row: `email.ts` and `http.ts` take both from the
 * environment. The copies existed only to be exported, backed up and missed
 * during a rotation.
 */
describe('stripSecrets', () => {
  it('never stores the SMTP password, however plainly it is sent', () => {
    const out = stripSecrets('zeptomail_config', {
      host: 'smtp.zeptomail.com',
      user: 'emailappsmtp.example',
      pass: 'a-real-password',
    }) as Record<string, unknown>;

    expect(out).not.toHaveProperty('pass');
    expect(out.host).toBe('smtp.zeptomail.com');
    expect(out.user).toBe('emailappsmtp.example');
  });

  it('never stores the Zoho client secret', () => {
    const out = stripSecrets('zoho_oauth_config', {
      clientId: '1000.EXAMPLE',
      clientSecret: 'a-real-secret',
      enabled: true,
    }) as Record<string, unknown>;

    expect(out).not.toHaveProperty('clientSecret');
    expect(out.clientId).toBe('1000.EXAMPLE');
  });

  /**
   * The old `restoreSecrets` put the stored value back when it saw the
   * sentinel. Nothing may resurrect a credential now — not even the mask's own
   * placeholder, which is what a form round trip sends.
   */
  it('drops the mask sentinel rather than resolving it back to a stored value', () => {
    const out = stripSecrets('zeptomail_config', {
      host: 'smtp.zeptomail.com',
      pass: SECRET_UNCHANGED,
    }) as Record<string, unknown>;

    expect(out).not.toHaveProperty('pass');
  });

  it('leaves settings that carry no credential completely alone', () => {
    const value = { enabled: true, value: 24 };
    expect(stripSecrets('task_approval_window_hours', value)).toEqual(value);
  });

  it.each([
    ['a bare string', 'noreply@orbit2.iih.ng'],
    ['a number', 24],
    ['null', null],
  ])('passes %s through untouched', (_label, value) => {
    expect(stripSecrets('zeptomail_config', value)).toBe(value);
  });

  it('does not mutate the object it was given', () => {
    const input = { host: 'smtp.zeptomail.com', pass: 'a-real-password' };
    stripSecrets('zeptomail_config', input);
    expect(input.pass).toBe('a-real-password');
  });
});

/**
 * Masking stays for reads and for audit rows, covering any deployment whose
 * stored copy predates the purge.
 */
describe('maskSecrets', () => {
  it('replaces a legacy stored password with the sentinel', () => {
    const out = maskSecrets('zeptomail_config', {
      host: 'smtp.zeptomail.com',
      pass: 'a-real-password',
    }) as Record<string, unknown>;

    expect(out.pass).toBe(SECRET_UNCHANGED);
    expect(out.host).toBe('smtp.zeptomail.com');
  });

  it('leaves a purged row alone rather than inventing a sentinel for it', () => {
    const out = maskSecrets('zeptomail_config', {
      host: 'smtp.zeptomail.com',
    }) as Record<string, unknown>;

    expect(out).not.toHaveProperty('pass');
  });
});

describe('SECRET_FIELDS', () => {
  /**
   * A new credential field added to a settings row without an entry here would
   * be stored in plaintext and served to every admin, silently. This is the
   * list that has to be kept honest.
   */
  it('covers both credential-bearing settings rows', () => {
    expect(SECRET_FIELDS).toEqual({
      zeptomail_config: ['pass'],
      zoho_oauth_config: ['clientSecret'],
    });
  });
});
