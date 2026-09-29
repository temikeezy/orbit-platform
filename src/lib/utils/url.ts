/**
 * Guards user-supplied strings that are about to become an `href`.
 *
 * React escapes text. It does not escape URLs. `<a href={value}>` with a
 * `javascript:` value renders and executes on click — React 18 logs a warning
 * about it and renders the link anyway. Because the session token lives in
 * localStorage, one click by a reviewer is a full account takeover.
 *
 * The reachable paths were: portfolio links from the PUBLIC application form,
 * read by admins reviewing applicants; evidence links and attachments written by
 * interns, read by their supervisors; submission links, read by peers and
 * reviewers; and the LinkedIn field on a profile, read by anyone. In every one
 * of them the author and the clicker are different people, which is what makes
 * this stored XSS rather than self-XSS.
 *
 * Server-side validation in convex/lib/input.ts rejects these on the way in.
 * This exists because rows written before that landed are still in the database,
 * and because a defence that only works at one end is one deploy away from not
 * working at all.
 */

/** Schemes that may appear in an href. Everything else is refused. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Returns the URL if it is safe to put in an `href`, or null if it is not.
 *
 * A bare host — `github.com/temi`, typed without a scheme, which people do
 * constantly — is upgraded to `https://` rather than refused. Refusing it would
 * turn a working-looking link into plain text for a large number of honest
 * rows; rendering it unchanged would produce a RELATIVE link that silently
 * navigates inside ORBIT. Neither is what the author meant.
 *
 * Callers should render the raw string as text when this returns null, so the
 * reader can still see what was submitted and judge it themselves. Silently
 * dropping the value hides evidence a reviewer may need.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  /**
   * Rejected before parsing, because `new URL()` is not the right question for
   * either of them.
   *
   * A protocol-relative `//evil.example` parses as a valid https URL against
   * our own origin and would pass every check below while pointing off-site.
   * A backslash variant `/\evil.example` is normalised to the same thing by
   * some browsers and not others, which is worse.
   */
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('\\')) {
    return null;
  }

  const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) return null;

  // `https://` alone parses successfully with an empty host.
  if (!parsed.hostname) return null;

  return parsed.toString();
}

/**
 * Whether the string already carries a scheme.
 *
 * Deliberately matches the RFC 3986 shape rather than looking for `://`, so
 * `javascript:alert(1)` and `data:text/html,...` — which have no slashes — are
 * recognised as scheme-bearing and get rejected by the protocol check, instead
 * of being treated as bare hosts and prefixed into
 * `https://javascript:alert(1)`.
 */
function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
