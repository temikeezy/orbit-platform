/**
 * Checks a message is fit to send, before it is sent.
 *
 * Everything here has already gone wrong at least once in this codebase or was
 * one deploy away from doing so: a sign-in link left as its placeholder because
 * substitution silently failed, a template variable shipped unrendered, a
 * commencement date naming a day already past, an acceptance telling a volunteer
 * to start a logbook they do not have. None of those break a send — they all
 * arrive, look plausible, and are read by someone who then acts on them or
 * cannot.
 *
 * Pure so it can be unit tested and run in either runtime.
 */

export type QaSeverity = 'block' | 'warn';

export interface QaFinding {
  severity: QaSeverity;
  code: string;
  detail: string;
}

export interface QaSubject {
  emailType: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  recipientEmail: string;
  /** True when this message is expected to carry an attachment. */
  expectsAttachment?: boolean;
  hasAttachment?: boolean;
}

/** Anything that looks like an unrendered placeholder. */
const PLACEHOLDER = /\{\{[^}]+\}\}|ORBIT_SIGN_IN_LINK_PENDING|%[A-Z_]{3,}%|__[A-Z_]{3,}__/;


/**
 * A URL safe to quote in a finding.
 *
 * QA runs AFTER the sign-in link is substituted, so the href it is complaining
 * about can be a live magic-link credential — and a finding travels further
 * than the message does: into `emailQueue.errorMessage` and `emailAttempts.error`
 * (both readable by any admin, not just the super admins allowed to read
 * bodies), and into the Convex function log via `console.error`.
 *
 * The path is what makes a finding actionable; the query and fragment are where
 * the token lives. `#token=…` in particular is how magic links are carried
 * precisely so the secret never reaches a server log — quoting it whole would
 * undo that.
 */
function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}[redacted]`;
}

export function qaEmail(m: QaSubject): QaFinding[] {
  const out: QaFinding[] = [];
  const block = (code: string, detail: string) => out.push({ severity: 'block', code, detail });
  const warn = (code: string, detail: string) => out.push({ severity: 'warn', code, detail });

  if (!m.recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.recipientEmail)) {
    block('recipient', `Not a deliverable address: "${m.recipientEmail}"`);
  }

  if (!m.subject.trim()) block('subject', 'Empty subject.');
  if (m.subject.length > 120) warn('subject-long', `Subject is ${m.subject.length} characters; clients truncate.`);

  if (!m.bodyHtml.trim()) block('body', 'Empty HTML body.');
  if (!m.bodyText.trim()) warn('no-text-part', 'No plain-text alternative; some clients and filters penalise that.');

  // The one that has actually bitten: a placeholder that survived to delivery.
  for (const [where, value] of [['subject', m.subject], ['html', m.bodyHtml], ['text', m.bodyText]] as const) {
    const hit = PLACEHOLDER.exec(value);
    if (hit) block('placeholder', `Unrendered placeholder in ${where}: "${hit[0]}"`);
  }

  // Tag soup: a body that lost its shell, or an unclosed anchor swallowing the rest.
  const opens = (m.bodyHtml.match(/<a\b/gi) ?? []).length;
  const closes = (m.bodyHtml.match(/<\/a>/gi) ?? []).length;
  if (opens !== closes) block('html', `Unbalanced anchors: ${opens} <a> vs ${closes} </a>.`);

  // Any link must be absolute and https — a relative href in mail goes nowhere.
  for (const href of m.bodyHtml.match(/href="([^"]*)"/gi) ?? []) {
    const url = href.slice(6, -1);
    if (url.startsWith('mailto:') || url.startsWith('#')) continue;
    if (!/^https:\/\//i.test(url)) block('link', `Link is not absolute https: "${redactUrl(url)}"`);
  }

  if (!/<img[^>]+src="https:\/\//i.test(m.bodyHtml)) {
    warn('no-logo', 'No absolute https image — the ORBIT header logo may be missing.');
  }

  if (m.expectsAttachment && !m.hasAttachment) {
    block('attachment', 'A SIWES acceptance must carry its letter, and none was produced.');
  }

  // A date already gone reads as a system that has lost track of the calendar.
  if (/begins on/i.test(m.bodyText) && !/begins immediately/i.test(m.bodyText)) {
    warn('commencement', 'Names a commencement date; policy is "begins immediately".');
  }

  return out;
}

export function qaBlocks(findings: QaFinding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}
