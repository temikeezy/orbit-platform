import type { ReactNode } from 'react';
import { safeExternalUrl } from '../../lib/utils/url';

interface SafeLinkProps {
  /** A user-supplied string that may or may not be a usable URL. */
  href: string | null | undefined;
  className?: string;
  children: ReactNode;
}

/**
 * An external link whose target came from a user.
 *
 * Seven places render a URL that one person typed and a different person
 * clicks — applicant portfolios read by admins, evidence links and attachments
 * read by supervisors, submission links read by peers and reviewers, LinkedIn
 * on a profile read by anyone. Each of them had the same shape, `<a href={...}>`
 * with no check, and each was a stored-XSS path because React renders
 * `javascript:` hrefs rather than blocking them.
 *
 * A component rather than a call to `safeExternalUrl` at each site, because the
 * interesting part is not the check but what happens when it fails, and that
 * decision should be made once. It renders the raw value as TEXT rather than
 * dropping it: a reviewer looking at a suspicious application needs to see what
 * the applicant actually submitted, and a supervisor needs to know their intern
 * put something unusable in the evidence field. Silently rendering nothing hides
 * evidence from the person whose job is to weigh it.
 */
export function SafeLink({ href, className, children }: SafeLinkProps) {
  const safe = safeExternalUrl(href);

  if (!safe) {
    /**
     * Shows the REJECTED VALUE, not the label.
     *
     * Several call sites pass a label rather than the URL — "Portfolio" with an
     * icon, "SIWES form/letter". Rendering `children` on failure turned the
     * worst case in this whole component's remit, an applicant planting a
     * `javascript:` portfolio link, into a dead `<span>Portfolio</span>`: the
     * attack is stopped and the reviewing admin has no idea anything happened,
     * on the one screen whose entire job is judging what an applicant submitted.
     *
     * `href` is rendered as text by React, so a payload here is inert.
     */
    return (
      <span
        className={className}
        title="This is not a usable web address, so it is shown as text rather than a link."
      >
        {children}
        {href ? (
          <span className="ml-1 break-all font-mono text-xs text-slate-500">({href})</span>
        ) : null}
      </span>
    );
  }

  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
