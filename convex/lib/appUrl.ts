/**
 * WHERE THE APP LIVES. One answer, per deployment.
 *
 * There were four independent answers to this question and they disagreed: a
 * literal in lib/conversion.ts (every email footer, the acknowledgement and
 * approval bodies, the deadline reminder, the List-Unsubscribe header), a
 * second literal in notificationsInternal.ts (new task, new message, review,
 * badge, level-up), a third pair in zoho.ts (the welcome mail), and an
 * env-aware constant in http.ts that fed CORS and the Zoho redirect but no
 * email at all.
 *
 * Only http.ts was per-deployment. So mail sent from the dev deployment
 * (your-dev-deployment) posted PRODUCTION links to real people — the dev
 * deployment holds a copy of the real user table, which is what made that
 * more than a cosmetic problem.
 *
 * NO CONVEX IMPORTS AND NO NODE IMPORTS. This is read by the default V8 isolate
 * (queries, mutations, httpActions), by the one `"use node"` action
 * (convex/email.ts), and transitively by vitest, which runs in neither. Five
 * modules under convex/lib/ are already imported by the browser bundle, so it
 * must survive that too — hence the guarded `process` read below.
 */

/**
 * The fallback, and deliberately PRODUCTION.
 *
 * Production runs with APP_URL unset today, so a default of anything else — or
 * a throw — would break the deployment that is currently correct in order to
 * fix the one that is not. The consequence is that this module alone fixes
 * nothing: setting APP_URL on the dev deployment is the fix. This just makes
 * that env var mean something.
 */
export const DEFAULT_APP_URL = 'https://orbit2.iih.ng';

/**
 * Reduces a configured value to a bare origin, or refuses it.
 *
 * Exported for its own sake so the refusals are testable without a deployment.
 * This is the function that decides where a live sign-in credential is mailed,
 * and "it looked right" is not a test.
 */
export function normaliseOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Bare hosts ('orbit2.iih.ng'), protocol-relative ('//evil.example') and
    // anything else the parser rejects. Deliberately NOT repaired by prefixing
    // a scheme — guessing at a malformed origin is how you invent one.
    return null;
  }

  // BEFORE `.origin` is consulted. For a non-special scheme — javascript:,
  // data:, mailto: — `.origin` is the literal STRING "null", which is truthy
  // and would sail straight through a presence check into an href.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  // Plaintext only for a local machine. A typo'd 'http://orbit2.iih.ng' would
  // otherwise put magic-link tokens on a scheme every hop can read — the same
  // exposure `requireTLS` in convex/email.ts exists to prevent on the way out.
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol === 'http:' && !local) return null;

  /**
   * `.origin`, never the input string.
   *
   * It drops path, query, fragment, trailing slash and — the one that matters —
   * userinfo: 'https://orbit2.iih.ng@evil.example/' reduces to
   * 'https://evil.example', so the value is judged on where a browser would
   * actually go rather than on what it reads like at a glance. The trailing
   * slash matters mechanically too: browsers send a bare origin in the `Origin`
   * header, so 'https://x/' in an allowlist would never match anything.
   */
  return parsed.origin;
}

/** Guarded: this module is reachable from vitest and, in principle, from a Vite
 *  browser bundle, where a bare `process` is a ReferenceError. */
function env(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env?.[name];
}

/**
 * THE canonical origin. Exactly one value, for every link ORBIT mails and for
 * the Zoho OAuth browser redirect.
 *
 * Read at CALL time rather than captured in a module constant, so changing the
 * env var does not need an isolate to recycle before the next email is right.
 */
export function appUrl(): string {
  const configured = env('APP_URL');
  const origin = normaliseOrigin(configured);

  // Loud, because the alternative is a deployment silently mailing the wrong
  // domain — which is the bug this module exists to close.
  if (configured && !origin) {
    console.error(
      `APP_URL is set to something unusable (${configured}) — falling back to ` +
        `${DEFAULT_APP_URL}. It must be a bare http(s) origin, e.g. https://orbit2.iih.ng, ` +
        `and http:// is accepted only for localhost.`,
    );
  }

  return origin ?? DEFAULT_APP_URL;
}

/**
 * Origins allowed to CALL this deployment. A SET, and deliberately NOT the same
 * question as appUrl().
 *
 * NEVER a source for an email link. CORS legitimately needs several origins — a
 * local dev server, a Netlify deploy preview — while a sign-in link needs
 * exactly one. Merging the two would quietly promote a list whose stated
 * purpose is "let a preview talk to dev" into a list of places a live
 * credential may be mailed. They are two functions with two contracts so that
 * stays impossible by construction rather than by remembering.
 *
 * localhost is not a weakening: an attacker who can serve from the victim's own
 * localhost has already won, and these routes carry no cookies, so a permissive
 * origin grants no ambient authority. Both ports are also load-bearing for the
 * e2e suite, which pins its preview server to 5173.
 */
export function allowedOrigins(): string[] {
  const extra = (env('EXTRA_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map(normaliseOrigin)
    .filter((o): o is string => o !== null);

  return [...new Set([appUrl(), 'http://localhost:3000', 'http://localhost:5173', ...extra])];
}
