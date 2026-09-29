/**
 * Organisation identity — the single server-side source for "who runs this
 * ORBIT". Every value is a Convex environment variable with a default that
 * reproduces the original operator (Ilorin Innovation Hub) exactly, so an
 * install that sets none of them behaves byte-identically to before.
 *
 * Read at CALL time (not captured in a module constant), like appUrl(), so an
 * env change takes effect without waiting for an isolate to recycle.
 *
 * Frontend counterpart: src/config/org.ts (Vite build-time VITE_ORG_* vars).
 */

export const DEFAULT_ORG_NAME = 'Ilorin Innovation Hub';
export const DEFAULT_ORG_SHORT_NAME = 'IIH';
export const DEFAULT_ORG_ADDRESS = 'Ahmadu Bello Way, GRA, Ilorin, Kwara State';
export const DEFAULT_AGENT_EMAIL = 'orbit.agent@iih.ng';
export const DEFAULT_ICS_UID_DOMAIN = 'orbit.iih.ng';
export const DEFAULT_EMAIL_FROM = 'noreply@orbit2.iih.ng';

function env(name: string): string | undefined {
  const value = typeof process === 'undefined' ? undefined : process.env?.[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Full organisation name, e.g. "Ilorin Innovation Hub". ORBIT_ORG_NAME. */
export const orgName = (): string => env('ORBIT_ORG_NAME') ?? DEFAULT_ORG_NAME;

/** Short form used in running copy, e.g. "IIH". ORBIT_ORG_SHORT_NAME. */
export const orgShortName = (): string => env('ORBIT_ORG_SHORT_NAME') ?? DEFAULT_ORG_SHORT_NAME;

/** Postal address line for the email footer. ORBIT_ORG_ADDRESS. */
export const orgAddress = (): string => env('ORBIT_ORG_ADDRESS') ?? DEFAULT_ORG_ADDRESS;

/** Email of the ORBIT Agent account (platform-voice posts). ORBIT_AGENT_EMAIL. */
// Lowercased: accounts are stored and looked up by lowercased email, so a
// mixed-case ORBIT_AGENT_EMAIL would otherwise make every lookup miss.
export const agentEmail = (): string => (env('ORBIT_AGENT_EMAIL') ?? DEFAULT_AGENT_EMAIL).toLowerCase();

/** Domain used in calendar-feed event UIDs. ORBIT_ICS_UID_DOMAIN. */
export const icsUidDomain = (): string => env('ORBIT_ICS_UID_DOMAIN') ?? DEFAULT_ICS_UID_DOMAIN;

/** The From address for all mail. EMAIL_FROM (existing var). */
export const emailFrom = (): string => env('EMAIL_FROM') ?? DEFAULT_EMAIL_FROM;

/** Domain part of the From address, used for Message-ID. */
export function emailFromDomain(): string {
  const from = emailFrom();
  const at = from.lastIndexOf('@');
  const domain = at >= 0 ? from.slice(at + 1).replace(/[>\s].*$/, '') : '';
  return domain || DEFAULT_EMAIL_FROM.split('@')[1];
}
