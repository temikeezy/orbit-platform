import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const src = readFileSync(join(root, 'convex/notificationsInternal.ts'), 'utf8');

/**
 * The same `textToHtml` the notification email uses.
 *
 * Mirrored rather than imported because notificationsInternal.ts is a Convex
 * module — importing it drags the generated server API into the unit suite, the
 * same reason convex-authz-surface.test.ts reads source off disk. The assertion
 * below pins the copy to the original so the two cannot drift apart silently.
 */
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).split('\n').join('<br>')}</p>`)
    .join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A notification email carries the whole post, with its shape.
 *
 * Two faults, both invisible on a one-line task notification and both ruinous
 * for a feed post. The body was cut to 160 characters, so an announcement
 * arrived truncated mid-sentence — in the version most people read, and the
 * only one that reaches somebody who has not signed in. And it was wrapped in a
 * single `<p>`, so every paragraph break collapsed and a post written in
 * sections became one wall of text.
 */
describe('notification email bodies', () => {
  it('keeps the truncation for the in-app row and not for the email', () => {
    const body = src.slice(src.indexOf('export const notifyNewPost'));
    // The row still gets a preview — a long post would push a notification
    // list off the screen.
    expect(body).toContain('slice(0, 160)');
    expect(body).toContain('content: preview');
    // The email gets the whole thing.
    expect(body).toContain('emailContent: full');
    expect(body).toContain('const full = post.content');
  });

  it('falls back to content, so existing callers are unchanged', () => {
    expect(src).toContain('args.emailContent ?? args.content');
  });

  it('preserves paragraphs instead of collapsing them', () => {
    const post = 'First line.\n\nTHE DEADLINE. Due Thursday.\n\nAnother paragraph.';
    const html = textToHtml(post);
    expect(html.match(/<p>/g)).toHaveLength(3);
    expect(html).toContain('<p>THE DEADLINE. Due Thursday.</p>');
  });

  it('keeps a single newline as a line break', () => {
    // Lists inside a post — "Approved — ...\nRequest changes — ..." — read as
    // one run-on sentence without this.
    const html = textToHtml('Approved — points.\nRejected — closed.');
    expect(html).toBe('<p>Approved — points.<br>Rejected — closed.</p>');
  });

  it('escapes before it marks up, not after', () => {
    /**
     * The property that matters. Content here is member-authored on most
     * paths, and interpolating it raw once let anyone inject markup into mail
     * sent from ORBIT's own domain. The only tags in the output must be the
     * ones this function added.
     */
    const nasty = '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>';
    const html = textToHtml(nasty);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    // Its own paragraph tags survive.
    expect(html.startsWith('<p>')).toBe(true);
  });

  it('drops empty blocks rather than emitting hollow paragraphs', () => {
    expect(textToHtml('One.\n\n\n\n\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
    expect(textToHtml('   ')).toBe('');
  });

  it('has not drifted from the implementation it mirrors', () => {
    // If the real one changes, this copy must change with it.
    expect(src).toContain("split(/\\n{2,}/)");
    expect(src).toContain("split('\\n').join('<br>')");
  });

  it('keeps emailContent out of the notifications insert', () => {
    /**
     * THE BUG THESE TESTS DID NOT CATCH.
     *
     * `createNotification` spread `...args` straight into the notifications
     * insert, so adding a field for the email body sent it into a table whose
     * schema has no such column. Convex rejected the insert, and because the
     * insert happens before the email, the throw took the entire fan-out with
     * it — a post notified nobody.
     *
     * Nothing surfaced. The failure was inside a scheduled function, so
     * `posts.create` still returned success, the queue simply stayed empty, and
     * every test here passed because they read source strings rather than
     * running the mutation. Only posting on dev and reading the queued row
     * found it.
     */
    const fn = src.slice(src.indexOf('async function createNotification'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    // The insert must not receive the raw args object.
    const insert = body.slice(body.indexOf("insert('notifications'"));
    expect(insert).not.toContain('...args');
    expect(body).toContain('emailContent: _emailContent');
  });
});
