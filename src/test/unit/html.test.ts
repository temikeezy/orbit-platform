import { describe, it, expect } from 'vitest';
import { escapeHtml, isSafeActionUrl } from '../../../convex/lib/html';

/**
 * The escape layer for outbound email.
 *
 * These two functions are the whole defence between an authenticated member and
 * arbitrary markup in a message sent from ORBIT's own domain, and until now
 * nothing imported them from a test — a dropped `.replace`, a reordered chain,
 * or a loosened pattern would have passed typecheck, unit tests and every
 * end-to-end spec, because the damage only shows up in a recipient's inbox.
 *
 * The cases below are chosen for the ways this specific pair fails rather than
 * for coverage: ampersand ordering (escape it last and every other entity gets
 * double-escaped), the quote characters that matter only inside an attribute,
 * and the four URL shapes a browser resolves off-origin despite the leading
 * slash that makes them look internal.
 */

describe('escapeHtml', () => {
  it('neutralises the tag characters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes the ampersand FIRST, so entities are not double-escaped', () => {
    // Replacing `&` after `<` would turn `&lt;` back into `&amp;lt;` and the
    // recipient would read the escape sequence instead of the character.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3');
  });

  it('escapes both quote characters, which only matter inside an attribute', () => {
    // A body interpolated into href="..." or title='...' breaks out on the
    // matching quote; the tag characters alone would not stop that.
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('closes the paragraph-break-out that made this file necessary', () => {
    // The original defect verbatim: a direct message body that closes ORBIT's
    // own <p> and opens an anchor of the sender's choosing.
    const attack = '</p><a href="https://evil.example">Click here</a><p>';
    const escaped = escapeHtml(attack);
    expect(escaped).not.toContain('<a');
    expect(escaped).not.toContain('</p>');
    expect(escaped).toContain('&lt;/p&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Your submission was approved. Nice work!')).toBe(
      'Your submission was approved. Nice work!',
    );
    expect(escapeHtml('')).toBe('');
  });

  it('is idempotent in the sense that escaping twice is visible, not silent', () => {
    // Double-escaping is a display bug, not a security one — but it should be
    // detectable rather than looking like clean output.
    expect(escapeHtml(escapeHtml('<b>'))).toBe('&amp;lt;b&amp;gt;');
  });
});

describe('isSafeActionUrl', () => {
  it('accepts in-app paths', () => {
    expect(isSafeActionUrl('/tasks/abc')).toBe(true);
    expect(isSafeActionUrl('/')).toBe(true);
    expect(isSafeActionUrl('/admin')).toBe(true);
    expect(isSafeActionUrl('/tasks/j57abc?tab=submissions#top')).toBe(true);
  });

  it('rejects absolute URLs, which point an ORBIT-branded link at another host', () => {
    expect(isSafeActionUrl('https://evil.example/steal')).toBe(false);
    expect(isSafeActionUrl('http://evil.example')).toBe(false);
  });

  it('rejects the schemes that execute rather than navigate', () => {
    expect(isSafeActionUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeActionUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects the two off-origin forms that still start with a slash', () => {
    // A browser resolves both of these against another host despite the leading
    // slash that makes them look like in-app paths.
    expect(isSafeActionUrl('//evil.example')).toBe(false);
    expect(isSafeActionUrl('/\\evil.example')).toBe(false);
  });

  it('rejects anything not anchored at the root', () => {
    expect(isSafeActionUrl('tasks/abc')).toBe(false);
    expect(isSafeActionUrl('')).toBe(false);
    expect(isSafeActionUrl(' /tasks')).toBe(false);
  });
});
