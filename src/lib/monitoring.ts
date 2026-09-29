import * as Sentry from '@sentry/react';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const IS_PROD = import.meta.env.PROD;

/**
 * auth.ts's localStorage key, duplicated rather than imported.
 *
 * auth.ts owns this constant; pulling it in here would make monitoring
 * depend on the auth module just for a string literal. Matching by key NAME
 * below (SENSITIVE_KEY) already covers a future rename — this is
 * belt-and-braces for the exact key in use today.
 */
const AUTH_TOKEN_KEY = 'orbit_auth_token_v2';

/** Key names whose value is redacted outright, wherever they turn up. */
const SENSITIVE_KEY = /token|authorization|cookie|password|secret/i;

/** `?token=…`, `&code=…`, `#access_token=…` — query/fragment auth params inside any string, not just a full URL. */
const TOKEN_PARAM = /([?&#](?:token|code|access_token|refresh_token)=)[^&#\s"']+/gi;

const REDACTED = '[redacted]';

function looksLikeUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/');
}

function stripUrlParts(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Strips URL query/fragment first, then redacts any token-shaped param left over in plain text. */
function scrubStringValue(value: string): string {
  const withoutUrlParts = looksLikeUrl(value) ? stripUrlParts(value) : value;
  return withoutUrlParts.replace(TOKEN_PARAM, `$1${REDACTED}`);
}

/**
 * Recursively walks whatever Sentry captured — breadcrumb `data`, `extra`,
 * even a raw localStorage-shaped dump if some integration ever adds one —
 * and redacts by key name or by content. Bounded depth so a malformed or
 * cyclic structure cannot hang the scrubber that is meant to protect the
 * send, not block it.
 */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubStringValue(value);
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = key === AUTH_TOKEN_KEY || SENSITIVE_KEY.test(key) ? REDACTED : scrubDeep(val, depth + 1);
  }
  return result;
}

/**
 * Runs before every event leaves the browser. Load-bearing, not defensive:
 * MagicLinkPage reads the magic-link token from `searchParams` as well as
 * the URL fragment — a fallback kept for links emailed before the
 * fragment-only change (see MagicLinkPage.tsx) — so the query string CAN
 * legitimately carry `?token=<live one-time credential>` for the moment
 * before it is stripped from the address bar. The instant a DSN makes Sentry
 * actually send events, breadcrumbs and request URLs would otherwise ship
 * that credential to a third party. Registered as `beforeSend` specifically
 * so nothing else in the pipeline touches an event first.
 *
 * Exported for its test. This is the one function here whose failure mode is
 * silent and external — a regression ships credentials to a third party and
 * nothing in ORBIT looks any different — so it needs a test that fails loudly
 * rather than a comment saying it is important.
 */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    if (event.request.url) event.request.url = stripUrlParts(event.request.url);
    // Stripping the URL above is pointless if the same params ship separately here.
    delete event.request.query_string;
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      message: crumb.message ? scrubStringValue(crumb.message) : crumb.message,
      data: crumb.data ? (scrubDeep(crumb.data) as typeof crumb.data) : crumb.data,
    }));
  }

  if (event.message) {
    event.message = scrubStringValue(event.message);
  }

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => ({
      ...exception,
      value: exception.value ? scrubStringValue(exception.value) : exception.value,
    }));
  }

  if (event.extra) {
    event.extra = scrubDeep(event.extra) as typeof event.extra;
  }

  return event;
}

export function initMonitoring() {
  if (!SENTRY_DSN) {
    // A no-op here used to be completely silent, which meant a deploy that
    // forgot to set VITE_SENTRY_DSN looked identical — from the browser, in
    // the dashboard, everywhere that matters to whoever is debugging it — to
    // a deploy where monitoring was working and nothing had gone wrong yet.
    // Only warn in production: not having a DSN locally is the normal,
    // expected state for every developer's machine.
    if (IS_PROD) {
      console.warn('[ORBIT] VITE_SENTRY_DSN is not set — errors are not being reported.');
    }
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: IS_PROD ? 'production' : 'development',
    beforeSend,
    /**
     * TRACING IS NOT ON, and this rate is inert until it is.
     *
     * The comment here used to say "capture 10% of transactions for performance
     * monitoring", which never happened: on @sentry/react v10 a sample rate
     * alone creates nothing — `browserTracingIntegration()` has to be
     * registered, and it appears nowhere in src/. Anyone opening Sentry to
     * diagnose a slow page found no transactions and concluded the problem lay
     * elsewhere.
     *
     * Left off rather than switched on, deliberately. `beforeSend` below scrubs
     * ERROR events only; Sentry routes transactions through `beforeSendTransaction`,
     * which is not implemented here — so enabling tracing today would start
     * shipping URLs and spans past the one scrubber that keeps session tokens
     * out of Sentry. Turning it on means adding the integration AND extending
     * the scrubbing to transactions, in that order.
     */
    tracesSampleRate: IS_PROD ? 0.1 : 1.0,
    // Ignore browser extension errors
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
    ],
  });
}

/** Structured error logging — replaces console.error in production */

/**
 * Sends an error to Convex, best-effort.
 *
 * Deliberately silent on failure: if the platform cannot record an error, the
 * one thing that must not happen is a second error about the recording. Also
 * throttled in-process, because a fault inside a render loop fires far faster
 * than any server-side limit should have to absorb.
 */
const recentlySent = new Map<string, number>();
const REPEAT_WINDOW_MS = 30_000;

async function reportErrorToConvex(error: unknown, context?: Record<string, unknown>): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const where = typeof context?.context === 'string' ? context.context : undefined;

    // Same message from the same place, twice in half a minute, is one fault.
    const key = `${message}|${where ?? ''}`;
    const last = recentlySent.get(key) ?? 0;
    if (Date.now() - last < REPEAT_WINDOW_MS) return;
    recentlySent.set(key, Date.now());

    const { convexHttp } = await import('./convex');
    const { api } = await import('../../convex/_generated/api');
    const { authService } = await import('./auth');

    await convexHttp.mutation(api.errorReports.report, {
      token: authService.getToken() ?? undefined,
      source: 'caught',
      message,
      stack: error instanceof Error ? error.stack : undefined,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      context: where,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });
  } catch {
    // See above.
  }
}

export function logError(error: unknown, context?: Record<string, unknown>) {
  /**
   * ALWAYS RECORDED, whatever else happens.
   *
   * This used to send to Sentry when a DSN was configured and to the console
   * otherwise — and then only when NOT in production. Production has no DSN, so
   * on the one deployment that matters every caught error went nowhere: no
   * trace, no count, no way to answer "is this happening to anyone else". The
   * first anyone heard of a fault was a member saying the app was broken.
   *
   * Fire and forget. A logger that can throw turns one fault into two, and a
   * logger that can block delays the handler that called it.
   */
  void reportErrorToConvex(error, context);

  if (SENTRY_DSN) {
    Sentry.withScope((scope) => {
      if (context) scope.setExtras(context);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  } else if (!IS_PROD) {
    // Only log in non-production when Sentry is not configured
    console.error('[ORBIT]', error, context);
  }
}

/** Structured info logging — replaces console.log */
export function logInfo(message: string, context?: Record<string, unknown>) {
  if (!IS_PROD && !SENTRY_DSN) {
    console.info('[ORBIT]', message, context ?? '');
  }
}
