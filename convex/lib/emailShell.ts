import { escapeHtml } from './html';
import { appUrl } from './appUrl';
import { orgAddress, orgName } from './org';

/**
 * One layout for every email ORBIT sends.
 *
 * Templates were bare HTML fragments — no wrapper, no width, no dark-mode
 * handling — so each rendered differently depending on the client's defaults,
 * and calls-to-action were styled as a padded `<a>`, which desktop Outlook
 * strips. The link still worked, which is why this stayed cosmetic for a long
 * time; it stops being cosmetic the week thirty interns start receiving
 * task and deadline mail.
 *
 * Deliberately table-based and inline-styled. Email clients are not browsers:
 * flexbox, external stylesheets and most modern CSS are unavailable or
 * stripped, and a `<table>` is the only layout primitive that behaves the same
 * in Outlook, Gmail and Apple Mail.
 */

/** Brand green, and a text colour that reads on it. */
const ACCENT = '#2DD881';
const INK = '#1a1a1a';
const MUTED = '#666666';
const BORDER = '#e2e8e5';

/**
 * A call-to-action Outlook will render.
 *
 * Padding and border-radius on an anchor are dropped there, leaving a bare
 * link. A single-cell table with a background colour is the shape that
 * survives everywhere; the MSO conditional gives Outlook a square button
 * rather than nothing.
 */
export function emailButton(href: string, label: string): string {
  const url = escapeHtml(href);

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="margin:24px 0;border-collapse:separate;">` +
    `<tr><td align="center" bgcolor="${ACCENT}" ` +
    `style="border-radius:6px;background-color:${ACCENT};">` +
    `<a href="${url}" ` +
    `style="display:inline-block;padding:12px 24px;font-family:-apple-system,` +
    `'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;` +
    `color:${INK};text-decoration:none;border-radius:6px;">` +
    `${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

/**
 * Wraps a template's body in the shell.
 *
 * `body` is trusted HTML built by a template in this repo — every value a user
 * or applicant supplied is escaped at the point it is interpolated, not here.
 * Passing unescaped external text into this function would defeat that, which
 * is why no caller does.
 */
export function emailShell(body: string, options: { preheader?: string } = {}): string {
  /**
   * The preheader is the grey line a mail client shows next to the subject.
   * Left empty, clients invent one from the first words of the body, which for
   * a template starting "Hi Aisha," reads as nothing at all.
   */
  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">` +
      `${escapeHtml(options.preheader)}</div>`
    : '';

  return (
    `<!DOCTYPE html>` +
    `<html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // Tells clients that support it the mail is legible either way, rather than
    // letting them invert colours and produce unreadable combinations.
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="supported-color-schemes" content="light dark">` +
    `<title>ORBIT</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:#f5f6f7;">` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background-color:#f5f6f7;padding:24px 12px;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:560px;background-color:#ffffff;border:1px solid ${BORDER};` +
    `border-radius:10px;">` +
    /*
     * THE MASTHEAD: logo, with the wordmark as its fallback.
     *
     * The real 280x80 wordmark, not the PWA app icon. Absolute HTTPS, never a data URI — Gmail strips those, so an inlined logo
     * shows as nothing at all. Served from the app's own origin, which is also
     * why the nav logo was moved off a third-party URL that 404s: this header
     * and that one now point at the same asset, so a broken logo is visible in
     * the product rather than only in someone's inbox.
     *
     * Most clients block remote images until the reader allows them, so the
     * `alt` text is doing real work: it is the wordmark, styled to look
     * deliberate rather than like a failed image. Height is set inline because
     * Outlook ignores CSS on images.
     */
    `<tr><td style="padding:24px 28px 8px;">` +
    `<img src="${escapeHtml(appUrl())}/orbit-logo.png" width="87" height="72" alt="ORBIT" ` +
    `style="display:block;border:0;outline:none;text-decoration:none;height:72px;width:72px;` +
    `border-radius:8px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:13px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;` +
    `color:${ACCENT};">` +
    `</td></tr>` +
    `<tr><td style="padding:0 28px 24px;font-family:-apple-system,'Segoe UI',Roboto,` +
    `Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#16181a;">` +
    body +
    `</td></tr>` +
    `<tr><td style="padding:16px 28px 24px;border-top:1px solid ${BORDER};` +
    `font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:12px;line-height:1.5;color:${MUTED};">` +
    `${escapeHtml(orgName())} &middot; ${escapeHtml(orgAddress())}<br>` +
    `<a href="${escapeHtml(appUrl())}" style="color:${MUTED};">${escapeHtml(appUrl())}</a>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/**
 * The body as `sendOne` will actually transmit it.
 *
 * sendOne wraps anything that is not already a full document, so a queue row
 * holds a fragment while the recipient receives the shell — logo, footer and
 * all. QA that inspects the stored fragment reports every notification as
 * missing its logo, which is false and is how a check earns its way onto the
 * list of things people ignore. Both call sites use this so the rule lives once.
 */
export function asSent(bodyHtml: string): string {
  return /<html[\s>]/i.test(bodyHtml) ? bodyHtml : emailShell(bodyHtml);
}
