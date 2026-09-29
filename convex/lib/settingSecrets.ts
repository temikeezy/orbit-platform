/**
 * Which settings rows carry a credential, and what to do about it.
 *
 * In lib/ rather than in adminSettings.ts for the reason sentinels.ts records:
 * a module that also defines queries and mutations drags `_generated/server`
 * along with it, so the rules here could not be unit tested against the shapes
 * actually on disk without standing up a deployment. These are pure functions
 * over plain objects; they deserve a test that says so.
 */

import { SECRET_UNCHANGED } from './sentinels';

/**
 * Settings whose value is a CREDENTIAL, and the field within each that is one.
 *
 * These were returned in plaintext to every admin on every Settings page load,
 * pre-filled into a form input and held in a module-level cache for a minute.
 * The same migration decided an email BODY is a credential and locked
 * `emailQueue.adminGetBody` to super_admin with an audit row — but the SMTP
 * password that sends all of the platform's mail, and the Zoho client secret
 * that backs its SSO, were readable by the much broader `admin` role, unaudited.
 *
 * MASKING THEM ON READ WAS ONLY HALF THE FIX, and the quieter half was the
 * problem: the values were still STORED. Nothing server-side has ever read
 * them — `email.ts` takes `SMTP_PASSWORD` and `http.ts` takes
 * `ZOHO_CLIENT_SECRET`, both from the deployment environment — so these rows
 * held a second, verbatim copy of two live production credentials that no code
 * path consulted. A copy nothing reads cannot be rotated in step with the
 * original, travels into every database export, and on 2026-09-20 was byte
 * identical to both live secrets.
 *
 * So they are no longer written. `stripSecrets` drops these fields on the way
 * in and the rows keep only the non-secret reference fields an admin actually
 * needs to see. `maskSecrets` stays for reads and audit rows, covering any
 * deployment whose stored copy predates `purgeStoredCredentials` below.
 */
export const SECRET_FIELDS: Record<string, string[]> = {
  zeptomail_config: ['pass'],
  zoho_oauth_config: ['clientSecret'],
};

// Re-exported for the server modules that already import it from here. The
// definition lives in lib/sentinels.ts so the browser can share it without
// importing a module full of queries and mutations.
export function maskSecrets(key: string, value: unknown): unknown {
  const fields = SECRET_FIELDS[key];
  if (!fields || typeof value !== 'object' || value === null) return value;

  const out = { ...(value as Record<string, unknown>) };
  for (const field of fields) {
    // A sentinel rather than an empty string: empty would render as "no
    // password set" and invite an admin to retype one they cannot see.
    if (out[field]) out[field] = SECRET_UNCHANGED;
  }
  return out;
}

/**
 * Drops credential fields on the way in, whatever the caller sent.
 *
 * This replaces a `restoreSecrets` that put the stored password back whenever
 * the form returned the mask sentinel. That was the right shape for a design
 * where the row is the source of truth — and it is not one. The deployment
 * environment is, so the only thing keeping a copy here achieved was a second
 * place to leak from and a second place to forget during a rotation.
 *
 * A caller who sends a real secret is not refused, because the Settings screen
 * is not the only writer and failing a whole save over one field would be a
 * worse surprise than ignoring it. The field is simply never stored, and the
 * screen no longer offers an input that invites one.
 */
export function stripSecrets(key: string, incoming: unknown): unknown {
  const fields = SECRET_FIELDS[key];
  if (!fields || typeof incoming !== 'object' || incoming === null) return incoming;

  const out = { ...(incoming as Record<string, unknown>) };
  for (const field of fields) delete out[field];
  return out;
}
