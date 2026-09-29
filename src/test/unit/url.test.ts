import { describe, it, expect } from 'vitest';
import { safeExternalUrl } from '../../lib/utils/url';

/**
 * The attack this guards is stored, not reflected: an applicant plants a
 * `javascript:` portfolio link through the PUBLIC form, and an admin reviewing
 * applications clicks it. React renders `javascript:` hrefs — it only warns —
 * and the session token is in localStorage, so the click is an account takeover.
 */
describe('safeExternalUrl', () => {
  it('passes ordinary links through', () => {
    expect(safeExternalUrl('https://example.com/work')).toBe('https://example.com/work');
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/');
  });

  it('refuses script-bearing schemes', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('JavaScript:alert(1)')).toBeNull();
    // Whitespace and control characters are how the obvious filter gets beaten.
    expect(safeExternalUrl('  javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeExternalUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull();
  });

  it('refuses protocol-relative and backslash forms', () => {
    // These parse as valid https URLs against our own origin, so they would
    // pass a naive protocol check while pointing off-site.
    expect(safeExternalUrl('//evil.example')).toBeNull();
    expect(safeExternalUrl('/\\evil.example')).toBeNull();
    expect(safeExternalUrl('\\\\evil.example')).toBeNull();
  });

  it('upgrades a bare host rather than refusing it', () => {
    // People type this constantly. Refusing turns honest rows into plain text;
    // rendering it unchanged makes a relative link that navigates inside ORBIT.
    expect(safeExternalUrl('github.com/temi')).toBe('https://github.com/temi');
    expect(safeExternalUrl('www.example.com')).toBe('https://www.example.com/');
  });

  it('does not mistake a scheme for a bare host', () => {
    /**
     * The bug this pins down: `javascript:alert(1)` has no `//`, so a scheme
     * check written as `value.includes('://')` treats it as a bare host and
     * prefixes it into `https://javascript:alert(1)`. That parses successfully,
     * has protocol `https:` and a hostname, and would be handed straight back to
     * the caller as safe — the guard actively laundering the payload.
     *
     * Rejection is the whole point, so assert on it directly rather than on the
     * absence of a substring in a value that should not exist at all.
     */
    for (const scheme of ['javascript', 'data', 'mailto', 'tel', 'ftp']) {
      expect(safeExternalUrl(`${scheme}:whatever`)).toBeNull();
    }
  });

  it('treats empty and missing values as nothing to render', () => {
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl('')).toBeNull();
    expect(safeExternalUrl('   ')).toBeNull();
    expect(safeExternalUrl('https://')).toBeNull();
  });
});
