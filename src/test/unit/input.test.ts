import { describe, it, expect } from 'vitest';
import {
  FIELD,
  InputError,
  httpUrl,
  linkOrText,
  isoDate,
  list,
  oneOf,
  optionalHttpUrl,
  optionalText,
  socialLinks,
  text,
  validate,
  wholeNumber,
  SUBMISSION_TYPES,
  TASK_POINTS,
} from '../../../convex/lib/input';

/**
 * Bounds for authenticated writes. The interesting cases are the ones where
 * being slightly wrong causes a different, worse bug than the one being fixed:
 * truncating instead of rejecting loses a member's work, coercing undefined to
 * '' wipes fields on a partial save, and a scheme check written the obvious way
 * turns a javascript: payload into a URL that passes validation.
 */

describe('text', () => {
  it('trims and accepts within bounds', () => {
    expect(text('  hello  ', 'Post', 10)).toBe('hello');
  });

  it('REJECTS rather than truncating', () => {
    // The whole reason this module is separate from lib/intake.ts, which
    // truncates. Silently slicing a logbook entry destroys work the member
    // believes they saved.
    expect(() => text('x'.repeat(11), 'Post', 10)).toThrow(InputError);
  });

  it('treats whitespace-only as missing', () => {
    expect(() => text('   ', 'Post', 10)).toThrow(InputError);
  });
});

describe('optionalText', () => {
  it('preserves undefined as undefined', () => {
    // logbook.saveDailyLog strips undefined keys before patching, so "absent"
    // has to survive as absent or a partial save wipes fields the member never
    // touched. See the next test for the other half of this.
    expect(optionalText(undefined, 'Bio', 10)).toBeUndefined();
  });

  it('keeps a blank as a blank, so a field can be CLEARED', () => {
    /**
     * This asserted the opposite, and the opposite was a bug. Mapping '' to
     * undefined meant EditProfilePage — which sends every field on every save —
     * could never clear a bio: the save reported success and changed nothing.
     * The logbook was never at risk, because its form already sends
     * `|| undefined` for optional fields.
     *
     * "Not supplied" and "supplied as empty" are different intentions and only
     * the caller knows which it meant.
     */
    expect(optionalText('', 'Bio', 10)).toBe('');
    expect(optionalText('   ', 'Bio', 10)).toBe('');
    expect(optionalText(undefined, 'Bio', 10)).toBeUndefined();
  });

  it('still enforces the bound', () => {
    expect(() => optionalText('x'.repeat(11), 'Bio', 10)).toThrow(InputError);
  });
});

describe('isoDate', () => {
  it('accepts a real date', () => {
    expect(isoDate('2026-02-28', 'Log date')).toBe('2026-02-28');
  });

  it('rejects a well-shaped date that does not exist', () => {
    // The shape check alone accepts these, and they sort correctly as strings —
    // so the failure surfaces weeks later in a report nobody connects back here.
    expect(() => isoDate('2026-02-31', 'Log date')).toThrow(InputError);
    expect(() => isoDate('2026-13-01', 'Log date')).toThrow(InputError);
  });

  it('rejects the wrong shape', () => {
    expect(() => isoDate('28/02/2026', 'Log date')).toThrow(InputError);
  });
});

describe('httpUrl', () => {
  it('accepts http and https', () => {
    expect(httpUrl('https://example.com/x', 'Link')).toBe('https://example.com/x');
  });

  it('upgrades a bare host', () => {
    expect(httpUrl('github.com/temi', 'Link')).toBe('https://github.com/temi');
  });

  it('rejects script-bearing schemes', () => {
    // These have no '://', so a scheme test written as includes('://') treats
    // them as bare hosts and prefixes them into https://javascript:alert(1) —
    // which parses, has a hostname, and would pass. The check must not launder
    // the payload.
    expect(() => httpUrl('javascript:alert(1)', 'Link')).toThrow(InputError);
    expect(() => httpUrl('data:text/html,<script>', 'Link')).toThrow(InputError);
  });

  it('rejects protocol-relative and backslash forms', () => {
    // Both parse as valid https URLs against our own origin while pointing
    // off-site.
    expect(() => httpUrl('//evil.example', 'Link')).toThrow(InputError);
    expect(() => httpUrl('/\\evil.example', 'Link')).toThrow(InputError);
  });

  it('enforces a length bound', () => {
    expect(() => httpUrl(`https://e.com/${'x'.repeat(600)}`, 'Link')).toThrow(InputError);
  });
});

describe('optionalHttpUrl', () => {
  it('lets absent and blank through as undefined', () => {
    expect(optionalHttpUrl(undefined, 'Link')).toBeUndefined();
    expect(optionalHttpUrl('  ', 'Link')).toBeUndefined();
  });

  it('still validates a present value', () => {
    expect(() => optionalHttpUrl('javascript:alert(1)', 'Link')).toThrow(InputError);
  });
});

describe('oneOf', () => {
  it('accepts a member and names the set when refusing', () => {
    expect(oneOf('hybrid', 'Mode', ['hybrid', 'virtual'] as const)).toBe('hybrid');
    expect(() => oneOf('onsite', 'Mode', ['hybrid', 'virtual'] as const)).toThrow(/hybrid, virtual/);
  });
});

describe('list', () => {
  it('bounds the count', () => {
    const many = Array.from({ length: 21 }, () => 'https://e.com');
    expect(() => list(many, 'Evidence', { max: 20, each: httpUrl })).toThrow(InputError);
  });

  it('validates each item and reports which one failed', () => {
    expect(() =>
      list(['https://ok.com', 'javascript:alert(1)'], 'Evidence', { max: 20, each: httpUrl }),
    ).toThrow(/entry 2/);
  });

  it('treats absent as empty', () => {
    expect(list(undefined, 'Evidence', { max: 20, each: httpUrl })).toEqual([]);
  });
});

describe('socialLinks', () => {
  it('drops unknown keys instead of rejecting', () => {
    // An older client sending an extra field should not start failing.
    const out = socialLinks({ twitter: 'temi', mastodon: 'x', nested: { a: 1 } });
    expect(out).toEqual({ twitter: 'temi' });
  });

  it('strips a leading @ from handles', () => {
    expect(socialLinks({ github: '@temi' })).toEqual({ github: 'temi' });
  });

  it('validates linkedin as a URL, because it is rendered as a raw href', () => {
    expect(() => socialLinks({ linkedin: 'javascript:alert(1)' })).toThrow(InputError);
    expect(socialLinks({ linkedin: 'linkedin.com/in/temi' })).toEqual({
      linkedin: 'https://linkedin.com/in/temi',
    });
  });

  it('rejects a non-object, which is what v.any() used to accept', () => {
    expect(() => socialLinks(['not', 'an', 'object'])).toThrow(InputError);
  });

  it('returns undefined for nothing usable', () => {
    expect(socialLinks(undefined)).toBeUndefined();
    expect(socialLinks({})).toBeUndefined();
  });
});

describe('validate', () => {
  it('returns the built value on success', () => {
    expect(validate(() => text('hi', 'Post', 10))).toEqual({ ok: true, value: 'hi' });
  });

  it('converts an InputError into the { success, error } convention', () => {
    const result = validate(() => text('', 'Post', 10));
    expect(result).toEqual({ ok: false, error: 'Post is required.' });
  });

  it('RETHROWS anything that is not an InputError', () => {
    // A genuine bug inside a validation block must not be reported to a member
    // as though they mistyped something — that makes it invisible, because the
    // person assumes they were at fault and nobody ever hears about it.
    expect(() =>
      validate(() => {
        throw new TypeError('a real bug');
      }),
    ).toThrow(TypeError);
  });
});

describe('FIELD bounds', () => {
  it('sits above the longest values measured in production', () => {
    // Measured 2026-08-11 against the production deployment. The longest post
    // was 2,061 characters, so a 2,000 bound would have made an existing row
    // unsavable on edit — a bug shipped as a security fix.
    expect(FIELD.postContent).toBeGreaterThan(2_061);
    expect(FIELD.taskTitle).toBeGreaterThan(54);
    expect(FIELD.taskDescription).toBeGreaterThan(226);
    expect(FIELD.fullName).toBeGreaterThan(20);
    expect(FIELD.bio).toBeGreaterThan(136);
    expect(FIELD.location).toBeGreaterThan(23);
  });
});

describe('httpUrl bare-host handling', () => {
  it('refuses free text that only accidentally parses as a host', () => {
    // Gate B finding: `https://` + 'N/A' parses, has a hostname, and would have
    // been stored as a valid URL — then rendered as a link going nowhere. Free
    // text laundered into an anchor is worse than a refusal, because it looks
    // deliberate.
    for (const junk of ['N/A', 'notes', 'see attached', 'TBD']) {
      expect(() => httpUrl(junk, 'Link')).toThrow(InputError);
    }
  });

  it('still upgrades things that genuinely look like hosts', () => {
    expect(httpUrl('github.com/temi', 'Link')).toBe('https://github.com/temi');
    expect(httpUrl('example.co.uk', 'Link')).toBe('https://example.co.uk/');
  });
});

describe('linkOrText', () => {
  it('accepts the legacy free text that already lives in evidence links', () => {
    // These rows exist. Rejecting them would block a save an intern is making
    // for an unrelated reason, on a field that has never validated anything.
    expect(linkOrText('the shared Drive folder', 'Evidence', 500)).toBe('the shared Drive folder');
    expect(linkOrText('mailto:someone@example.com', 'Evidence', 500)).toBe('mailto:someone@example.com');
  });

  it('still refuses schemes that execute', () => {
    expect(() => linkOrText('javascript:alert(1)', 'Evidence', 500)).toThrow(InputError);
    expect(() => linkOrText('data:text/html,<script>', 'Evidence', 500)).toThrow(InputError);
    expect(() => linkOrText('//evil.example', 'Evidence', 500)).toThrow(InputError);
  });
});

describe('wholeNumber', () => {
  it('accepts the range and both of its ends', () => {
    expect(wholeNumber(1, 'Points', 1, 20)).toBe(1);
    expect(wholeNumber(20, 'Points', 1, 20)).toBe(20);
    expect(wholeNumber(7, 'Points', 1, 20)).toBe(7);
  });

  it('rejects outside the range', () => {
    expect(() => wholeNumber(0, 'Points', 1, 20)).toThrow(InputError);
    expect(() => wholeNumber(21, 'Points', 1, 20)).toThrow(InputError);
    expect(() => wholeNumber(-5, 'Points', 1, 20)).toThrow(InputError);
  });

  /**
   * The reason this helper exists rather than a bare comparison: `v.number()`
   * accepts all three of these, and every one of them reaches the points ledger
   * as a number that arithmetic then propagates silently. NaN in particular
   * fails BOTH `< min` and `> max`, so a range check written the obvious way
   * lets it straight through.
   */
  it('rejects the values a range check alone would miss', () => {
    expect(() => wholeNumber(NaN, 'Points', 1, 20)).toThrow(InputError);
    expect(() => wholeNumber(Infinity, 'Points', 1, 20)).toThrow(InputError);
    expect(() => wholeNumber(10.5, 'Points', 1, 20)).toThrow(InputError);
  });

  it('names the field, so the message is actionable', () => {
    expect(() => wholeNumber(99, 'Score', 0, 20)).toThrow(/Score must be between 0 and 20/);
  });
});

describe('task bounds', () => {
  /**
   * 20 is stated in LEVELS_SYSTEM.md and the level thresholds are built on it.
   * Pinning it here so a change to the economy has to be a deliberate edit to
   * a test that says why, rather than a number quietly raised in one caller.
   */
  it('caps a task at the documented 20 points', () => {
    expect(TASK_POINTS.max).toBe(20);
    expect(TASK_POINTS.min).toBe(1);
  });

  it('knows exactly the three submission types every renderer handles', () => {
    expect([...SUBMISSION_TYPES]).toEqual(['text', 'link', 'file']);
    expect(() => oneOf('video', 'Submission type', SUBMISSION_TYPES)).toThrow(InputError);
  });
});
