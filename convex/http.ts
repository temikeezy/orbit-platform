import { httpRouter } from 'convex/server';
import { appUrl, allowedOrigins } from './lib/appUrl';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import bcrypt from 'bcryptjs';

/**
 * A real bcrypt hash of a value nothing will ever present, so an unknown
 * selector costs the same as a known one. Generated once at module load.
 */
const DUMMY_HASH = bcrypt.hashSync('orbit-timing-equaliser', 8);
import { Id } from './_generated/dataModel';
import { validateApplication, isHoneypotTripped, IntakeError } from './lib/intake';
import { icsUidDomain } from './lib/org';

/**
 * Zoho OAuth endpoints, replacing the zoho-oauth-init / zoho-oauth-callback
 * Supabase edge functions.
 *
 * These are browser navigation targets and carry no Authorization header. On
 * Supabase that was a persistent hazard — a redeploy that defaulted verify_jwt
 * back to true rejected every callback before the handler ran. Convex httpActions
 * have no such gate, so the failure mode is gone. The CSRF defence is the
 * single-use state token, exactly as before.
 */

/**
 * Where the app is served from, PER DEPLOYMENT.
 *
 * It was a hardcoded constant, which meant the dev Convex deployment believed
 * the app lived at the production domain. That is fine for local work —
 * localhost is separately allowlisted below — but it makes a Netlify deploy
 * preview impossible to use: previews get a generated origin like
 * `deploy-preview-12--orbit.netlify.app`, `corsFor` would not recognise it, and
 * every sign-in from a preview would fail CORS against dev.
 *
 * `APP_URL` is the canonical origin (used to build the Zoho redirect, which
 * must match what is registered with Zoho, so it is deliberately NOT a list).
 * `EXTRA_ALLOWED_ORIGINS` is a comma-separated allowlist for anything else that
 * may talk to this deployment — set it on DEV to permit preview domains, and
 * leave it unset on prod so production trusts exactly one origin.
 *
 * Both now come from convex/lib/appUrl.ts, which is the only place either
 * question is answered. These are a cache of that answer, not a second
 * definition — the literal that used to sit here was the third of four
 * disagreeing copies, and the only one that was per-deployment.
 */
const APP_URL = appUrl();
const ALLOWED_ORIGINS = allowedOrigins();
const ZOHO_AUTH_URL = 'https://accounts.zoho.com/oauth/v2/auth';
const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token';
const ZOHO_USERINFO_URL = 'https://accounts.zoho.com/oauth/user/info';

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function failure(message: string): Response {
  const url = new URL(`${APP_URL}/oauthredirect`);
  url.searchParams.set('success', 'false');
  url.searchParams.set('error', message);
  return redirect(url.toString());
}

/**
 * Sign-in and magic-link request.
 *
 * These are httpActions rather than mutations for one reason: a Convex mutation
 * cannot see the client address, so a rate limit inside one can only key on
 * something the caller supplies — which is not a rate limit. An httpAction reads
 * the address Convex's own edge recorded.
 *
 * TRUSTING THE RIGHT ENTRY. `x-forwarded-for` accumulates left to right and the
 * client can seed it, so the FIRST entry is attacker-controlled and the LAST is
 * the one the nearest trusted proxy appended. These routes are called by the
 * browser directly at *.convex.site — deliberately NOT proxied through Netlify —
 * so the last entry is what Convex saw. (The application intake IS proxied, which
 * is why it uses a global ceiling instead of trying to read an address at all.)
 */
function clientAddress(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1];
}

/**
 * Allowed origins for the credentialed routes.
 *
 * Pinned to production alone, sign-in could not work from a dev server at all —
 * the preflight would be refused before the request was sent. Localhost is
 * included deliberately and is not a weakening: an attacker who can serve from
 * the victim's localhost has already won, and these routes carry no cookies, so
 * a permissive origin grants no ambient authority.
 */

const AUTH_CORS = {
  'Access-Control-Allow-Origin': APP_URL,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

/**
 * Echoes the caller's origin when it is one of ours.
 *
 * `Vary` is MERGED, not replaced. /posts/image varies on Authorization for a
 * reason recorded at its call site — the HTTP cache keys on URL and method
 * alone, so without it one user's images were served to the next person to sign
 * in on a shared browser. Overwriting that with a bare `Vary: Origin` would
 * quietly reintroduce the bug, which is exactly the sort of thing a CORS helper
 * has no business doing.
 */
function corsFor(request: Request, base: Record<string, string>): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  if (!ALLOWED_ORIGINS.includes(origin)) return base;

  const vary = [...new Set([...(base.Vary?.split(',') ?? []).map((v) => v.trim()), 'Origin'])]
    .filter(Boolean)
    .join(', ');

  return { ...base, 'Access-Control-Allow-Origin': origin, Vary: vary };
}

function authJson(body: unknown, status = 200, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(request ? corsFor(request, AUTH_CORS) : AUTH_CORS),
    },
  });
}

/** Header-safe, and never empty. */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 80) || 'download';
}

const http = httpRouter();

http.route({
  path: '/zoho/init',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const clientId = process.env.ZOHO_CLIENT_ID;
    const redirectUri = process.env.ZOHO_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      return failure('Zoho OAuth is not configured.');
    }

    const state = await ctx.runMutation(internal.zoho.createStateToken, {
      ipAddress: clientAddress(request),
    });

    // Throttled, and deliberately indistinguishable from a configuration
    // failure: nothing here should tell an unauthenticated caller whether they
    // hit a limit or a missing env var.
    if (!state) return failure('Too many sign-in attempts. Please try again shortly.');

    const authUrl = new URL(ZOHO_AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'AaaServer.profile.READ');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('access_type', 'online');
    authUrl.searchParams.set('state', state);

    return redirect(authUrl.toString());
  }),
});

http.route({
  path: '/zoho/callback',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) return failure(`OAuth error: ${oauthError}`);
    if (!code || !state) return failure('Missing authorization code or state');

    const stateOk = await ctx.runMutation(internal.zoho.consumeStateToken, {
      stateToken: state,
    });
    if (!stateOk) return failure('Invalid or expired state token');

    const clientId = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const redirectUri = process.env.ZOHO_REDIRECT_URI;
    const allowedDomains = (process.env.ALLOWED_OAUTH_DOMAINS ?? 'iih.ng')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    if (!clientId || !clientSecret || !redirectUri) {
      return failure('Zoho OAuth is not configured.');
    }

    const tokenRes = await fetch(ZOHO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });

    if (!tokenRes.ok) {
      console.error('Zoho token exchange failed:', await tokenRes.text());
      return failure('Failed to exchange authorization code');
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) return failure('Zoho did not return an access token');

    const profileRes = await fetch(ZOHO_USERINFO_URL, {
      headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` },
    });
    if (!profileRes.ok) return failure('Failed to fetch user profile');

    const profile = (await profileRes.json()) as Record<string, unknown>;

    const email = String(profile.Email ?? '').toLowerCase();
    if (!email) return failure('Zoho profile did not include an email address');

    // ZUID, not ZASOID — see the note in zoho.ts. ZASOID is simply absent from
    // this endpoint's response, and reading it cost hours of debugging.
    const rawZohoId = profile.ZUID ?? profile.ZASOID;
    if (rawZohoId === undefined || rawZohoId === null || `${rawZohoId}` === '') {
      console.error('Zoho profile missing account id; keys:', Object.keys(profile));
      return failure('Zoho profile did not include an account id');
    }

    const domain = email.split('@')[1] ?? '';
    if (!allowedDomains.includes(domain)) {
      return failure(
        `Email domain ${domain} is not allowed. Only ${allowedDomains.join(', ')} domains are permitted.`,
      );
    }

    const fullName =
      (profile.Display_Name as string) ||
      `${(profile.First_Name as string) ?? ''} ${(profile.Last_Name as string) ?? ''}`.trim() ||
      email.split('@')[0];

    const result = await ctx.runMutation(internal.zoho.completeZohoLogin, {
      email,
      fullName,
      zohoId: String(rawZohoId),
      // LAST entry, not first — see clientAddress(). Reading entry zero meant
      // reading whatever the caller put there, which defeated the limit it fed.
      ipAddress: clientAddress(request),
    });

    if (!result.success) return failure(result.error);

    const success = new URL(`${APP_URL}/oauthredirect`);
    success.searchParams.set('success', 'true');
    success.searchParams.set('code', result.code);
    return redirect(success.toString());
  }),
});

/**
 * ICS calendar feed, replacing the calendar-ics edge function.
 *
 * Kept at a stable path because subscribed URLs live in users' calendar clients
 * indefinitely. netlify.toml must rewrite /api/calendar-ics here.
 */
http.route({
  path: '/calendar.ics',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    // Accepts `token`, or `user_id` for feeds subscribed before the migration.
    const feedToken = url.searchParams.get('token') ?? url.searchParams.get('user_id');

    if (!feedToken) return new Response('Missing token', { status: 400 });

    const data = await ctx.runQuery(internal.calendar.feedForToken, { feedToken });

    // Same response for an unknown and an inactive user, so the endpoint cannot
    // be used to test which ids exist.
    if (!data) return new Response('Not found', { status: 404 });

    const esc = (t: string) =>
      t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

    const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ORBIT//Task Deadlines//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:ORBIT Task Deadlines',
    ];

    for (const t of data.tasks) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:task-${t.id}@${icsUidDomain()}`,
        `DTSTAMP:${stamp(Date.now())}`,
        `DTSTART:${stamp(t.deadline)}`,
        `DTEND:${stamp(t.deadline + 60 * 60 * 1000)}`,
        `SUMMARY:${esc(`${t.streamEmoji} ${t.title}`.trim())}`,
        `DESCRIPTION:${esc(`${t.description}\n\nStream: ${t.streamName}\nPoints: ${t.points}`)}`,
        'END:VEVENT',
      );
    }

    lines.push('END:VCALENDAR');

    return new Response(lines.join('\r\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="orbit-tasks.ics"',
        // No wildcard CORS: this is a private feed, not a public resource.
        'Cache-Control': 'private, max-age=900',
      },
    });
  }),
});

/**
 * Serves an applicant's passport photo or SIWES letter to a signed-in reviewer.
 *
 * This exists so `applications.getById` never has to hand out a
 * `ctx.storage.getUrl()` link. Those are capability URLs — no auth, no expiry,
 * revocable only by deleting the file — and the documents behind them are the
 * most sensitive data in the system, belonging to people who are not ORBIT users
 * and cannot revoke anything. Every request here re-checks the session and the
 * caller's role, and the access is audited.
 *
 * The token comes from the Authorization header, NOT a query parameter, so the
 * credential does not end up in browser history, referrers or proxy logs. The
 * client fetches this and turns the response into an object URL.
 */
http.route({
  path: '/applications/document',
  method: 'OPTIONS',
  handler: httpAction(async (_ctx, request) =>
    new Response(null, { status: 204, headers: corsFor(request, FILE_CORS) })),
});

http.route({
  path: '/applications/document',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const applicationId = url.searchParams.get('applicationId');
    const kind = url.searchParams.get('kind');

    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    // A malformed request (no id, unknown kind) is a 400. A MISSING token is
    // treated exactly like an invalid one — both fall through to the 404 below —
    // so nothing distinguishes "you sent no credential" from "your credential
    // was rejected" from "that application does not exist".
    if (!applicationId || (kind !== 'passport' && kind !== 'letter')) {
      return new Response('Bad request', { status: 400 });
    }

    const found = token
      ? await ctx.runQuery(internal.applications.documentFor, {
          token,
          applicationId: applicationId as Id<'applications'>,
          kind,
        })
      : null;

    // One response for "not signed in", "not staff", "no such application" and
    // "no such document". A reviewer-only endpoint should not tell an
    // unauthenticated caller which application ids exist.
    if (!found) return new Response('Not found', { status: 404 });

    const blob = await ctx.storage.get(found.storageId);
    if (!blob) return new Response('Not found', { status: 404 });

    await ctx.runMutation(internal.applications.recordDocumentAccess, {
      viewerId: found.viewerId,
      viewerEmail: found.viewerEmail,
      applicationId: applicationId as Id<'applications'>,
      kind,
    });

    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${found.fileName.replace(/"/g, '')}"`,
        // private, and never by a shared cache: this is one person's document
        // served to one authenticated reviewer.
        //
        // FILE_HEADERS also carries X-Content-Type-Options: nosniff, which this
        // route was the only file route missing — on documents that arrive from
        // the public intake, of all places.
        ...FILE_HEADERS,
        ...corsFor(request, FILE_CORS),
      },
    });
  }),
});

for (const path of ['/auth/login', '/auth/magic-link', '/auth/magic-link/verify']) {
  http.route({
    path,
    method: 'OPTIONS',
    handler: httpAction(async (_ctx, request) =>
      new Response(null, { status: 204, headers: corsFor(request, AUTH_CORS) })),
  });
}

http.route({
  path: '/auth/login',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    let body: { email?: unknown; password?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return authJson({ success: false, error: 'Invalid request' }, 400, request);
    }

    if (typeof body.email !== 'string' || typeof body.password !== 'string') {
      return authJson({ success: false, error: 'Invalid email or password' }, 400, request);
    }

    const result = await ctx.runMutation(internal.auth.loginWithPassword, {
      email: body.email,
      password: body.password,
      userAgent: request.headers.get('user-agent') ?? undefined,
      ipAddress: clientAddress(request),
    });

    // 200 either way. A distinct status for a failed sign-in is one more signal
    // for an automated attempt to key on, and the body already says.
    return authJson(result, 200, request);
  }),
});

http.route({
  path: '/auth/magic-link',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    let body: { email?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return authJson({ success: false, error: 'Invalid request' }, 400, request);
    }

    const result = await ctx.runMutation(internal.auth.requestMagicLink, {
      email: typeof body.email === 'string' ? body.email : '',
      ipAddress: clientAddress(request),
    });

    return authJson(result, 200, request);
  }),
});

/**
 * Redeems a magic link.
 *
 * AN HTTP ACTION, not a mutation, and that is the whole point. Convex records
 * function arguments in its logs and in any configured log drain, so redeeming
 * through `mutation({ token })` wrote the live sign-in credential into the logs
 * for the hour it remained valid — anyone able to read them could sign in as
 * that person. A request body is not recorded the same way.
 *
 * The link is `selector.verifier`. The selector identifies the row and proves
 * nothing; only the bcrypt comparison of the verifier authorises anything, and
 * it happens here rather than in a mutation so the secret never becomes an
 * argument.
 */
http.route({
  path: '/auth/magic-link/verify',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    let body: { token?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return authJson({ success: false, error: 'Invalid request' }, 400, request);
    }

    const raw = typeof body.token === 'string' ? body.token.trim() : '';
    // One refusal for every failure below: an invalid link, an expired one, a
    // wrong verifier and a rate-limited caller must all be indistinguishable.
    const invalid = { success: false as const, error: 'This sign-in link is invalid or has expired.' };

    if (!raw) return authJson(invalid, 200, request);

    // Before the bcrypt below, which runs whether or not the selector exists so
    // that an unknown one cannot be told from a known one by timing. That
    // anti-oracle measure is also an amplifier without a bound here.
    const allowed = await ctx.runMutation(internal.auth.checkMagicLinkVerifyAllowed, {
      ipAddress: clientAddress(request),
    });
    if (!allowed) return authJson(invalid, 200, request);

    const userAgent = request.headers.get('user-agent') ?? undefined;

    /**
     * Exactly two parts, both hex. `split('.')` with destructuring silently
     * accepted `selector.verifier.anything`, which is not a bypass but is a
     * parser that accepts things it does not mean.
     */
    const parts = raw.split('.');
    const hex = /^[0-9a-f]+$/;
    const [selector, verifier] =
      parts.length === 2 && hex.test(parts[0]) && hex.test(parts[1]) ? parts : [null, null];

    let linkId: Id<'magicLinks'> | null = null;

    if (selector && verifier) {
      const link = await ctx.runQuery(internal.auth.magicLinkBySelector, { selector });

      /**
       * A comparison runs either way.
       *
       * Skipping bcrypt when the selector is unknown makes an unknown selector
       * measurably faster than a known one, which is a free oracle for probing
       * which selectors exist. Cheap to remove: hash something and throw the
       * answer away.
       */
      const hash = link?.verifierHash ?? DUMMY_HASH;
      const matches = bcrypt.compareSync(verifier, hash);

      if (link && link.verifierHash && link.expiresAt > Date.now() && matches) {
        linkId = link.id;
      }
    } else {
      // A link emailed before the split. Removed once they have all expired.
      const legacy = await ctx.runQuery(internal.auth.magicLinkByLegacyToken, { token: raw });
      if (legacy && legacy.expiresAt > Date.now()) linkId = legacy.id;
    }

    if (!linkId) return authJson(invalid, 200, request);

    const result = await ctx.runMutation(internal.auth.consumeMagicLink, { linkId, userAgent });
    if (!result) return authJson(invalid, 200, request);

    return authJson({ success: true as const, ...result }, 200, request);
  }),
});

/**
 * Serves a submission file to its author, or to someone who can review it.
 *
 * Same shape as the applicant-document route, and for the same reason: the file
 * is private, so it must not be reachable by a URL that outlives the check.
 */
http.route({
  path: '/submissions/file',
  method: 'OPTIONS',
  handler: httpAction(async (_ctx, request) =>
    new Response(null, { status: 204, headers: corsFor(request, FILE_CORS) })),
});

http.route({
  path: '/submissions/file',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const submissionId = url.searchParams.get('submissionId');

    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!submissionId) return new Response('Bad request', { status: 400 });

    const found = token
      ? await ctx.runQuery(internal.tasks.submissionFileFor, {
          token,
          submissionId: submissionId as Id<'submissions'>,
        })
      : null;

    if (!found) return new Response('Not found', { status: 404 });

    const blob = await ctx.storage.get(found.storageId);
    if (!blob) return new Response('Not found', { status: 404 });

    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${safeFilename(found.fileName)}"`,
        ...FILE_HEADERS,
        ...corsFor(request, FILE_CORS),
      },
    });
  }),
});

/** Feed images, behind the same session and stream checks the feed itself uses. */
http.route({
  path: '/posts/image',
  method: 'OPTIONS',
  handler: httpAction(async (_ctx, request) =>
    new Response(null, { status: 204, headers: corsFor(request, FILE_CORS) })),
});

http.route({
  path: '/posts/image',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const postId = url.searchParams.get('postId');

    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!postId) return new Response('Bad request', { status: 400 });

    const found = token
      ? await ctx.runQuery(internal.posts.imageFor, {
          token,
          postId: postId as Id<'posts'>,
        })
      : null;

    if (!found) return new Response('Not found', { status: 404 });

    const blob = await ctx.storage.get(found.storageId);
    if (!blob) return new Response('Not found', { status: 404 });

    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        // Stored, but ALWAYS revalidated. `max-age=300` let the browser answer
        // from cache without the request reaching Convex, so the membership
        // check the response depended on outlived its own result by up to five
        // minutes: someone removed from a private stream kept seeing its images,
        // and on a shared browser the next person to sign in got the previous
        // one's bytes for the same URL. The HTTP cache keys on URL and method,
        // not on the Authorization header, hence the Vary as well.
        'Cache-Control': 'private, no-cache',
        ...corsFor(request, { ...FILE_CORS, Vary: 'Authorization' }),
      },
    });
  }),
});

/**
 * Public application intake, replacing netlify/functions/orbit-application.mts.
 *
 * The only unauthenticated WRITE endpoint on the deployment, so it is the one
 * worth being paranoid about. What it carries over: the honeypot, every field
 * limit, the mime allow-lists and size caps, and the Ilorin participation
 * policy. What it adds: a rate limit (the Netlify version had none, on an
 * endpoint accepting 8 MB of files per request), a mime-vs-data-URL consistency
 * check, and a reference-code collision retry.
 *
 * Files go to Convex storage rather than a public Supabase bucket. Nothing hands
 * out a URL for them — see the `/applications/document` route above.
 */

/**
 * Shared by the two authenticated file routes.
 *
 * Without these they were unreachable from the browser at all: a fetch carrying
 * `Authorization` triggers a preflight, and with no OPTIONS route the preflight
 * 404s and the request is never sent. `applications.getById` had already stopped
 * returning storage URLs, so the replacement was in place and could not run.
 *
 * `Authorization` must be allowed explicitly — it is not a CORS-safelisted
 * request header.
 */
const FILE_CORS = {
  /**
   * The fallback for a caller whose Origin is not one of ours; `corsFor`
   * replaces it with the real origin for every caller who is.
   *
   * It used to be spread RAW into the GET responses while only the OPTIONS
   * preflight went through `corsFor`. The effect was that preflight succeeded
   * from localhost and from Netlify deploy previews and the actual GET then
   * failed the origin check — so every private file was unreachable anywhere
   * except production, and the symptom ("images are broken on the preview") did
   * not look like a CORS bug at all. APP_URL rather than the literal for the
   * same reason the literal was wrong in the first place.
   */
  'Access-Control-Allow-Origin': APP_URL,
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '600',
};

/** Applied to every file response. */
const FILE_HEADERS = {
  // These are served from *.convex.site, which netlify.toml's security headers
  // do not cover, so the hardening has to travel with the response.
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
};

const INTAKE_CORS = {
  // Wide open by necessity: the form is served from the marketing site as well
  // as the app, and this endpoint holds nothing to steal — it only accepts.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function intakeJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...INTAKE_CORS },
  });
}

http.route({
  path: '/applications/submit',
  method: 'OPTIONS',
  handler: httpAction(async () => new Response(null, { status: 204, headers: INTAKE_CORS })),
});

http.route({
  path: '/applications/submit',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    /**
     * Refused on Content-Length, BEFORE the body is parsed.
     *
     * The size limits inside `decodeFile` bound the decoding work but cannot
     * undo parsing: an oversized JSON body is allocated and parsed first, and
     * only then found to be too big. The ceiling here is the largest legitimate
     * payload — a 3MB photo plus a 5MB letter, base64-inflated by a third, plus
     * the form fields — with room to spare.
     */
    const MAX_INTAKE_BYTES = 12 * 1024 * 1024;
    const declared = Number(request.headers.get('content-length') ?? '0');

    if (Number.isFinite(declared) && declared > MAX_INTAKE_BYTES) {
      return intakeJson(
        { error: 'Your attachments are too large. The photo must be under 3 MB and the letter under 5 MB.' },
        413,
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return intakeJson({ error: 'Invalid application' }, 400);
    }

    // Answered as a success, deliberately. Telling a bot it was detected just
    // tells it which field to stop filling in.
    if (isHoneypotTripped(payload)) return intakeJson({ success: true });

    let validated;
    try {
      validated = validateApplication(payload);
    } catch (error) {
      // IntakeError messages are written for the applicant. Anything else is a
      // bug and must not be echoed back.
      const message = error instanceof IntakeError ? error.message : 'Invalid application';
      return intakeJson({ error: message }, 400);
    }

    /**
     * Throttled BEFORE anything is written to storage.
     *
     * The limits used to live only inside the mutation, which runs after both
     * files are stored — so a refused request still cost two storage writes and
     * relied on the cleanup below to undo them. Checking first means a flood
     * costs a counter increment.
     */
    const gate = await ctx.runMutation(internal.applications.checkIntakeAllowed, {
      ipAddress: clientAddress(request),
    });

    if (!gate.allowed) return intakeJson({ error: gate.error }, 429);

    let passportPhotoId: Id<'_storage'> | undefined;
    let siwesLetterId: Id<'_storage'> | undefined;

    // try/finally, because the objects are written BEFORE the row and Convex
    // never reclaims storage. Cleaning up only on `success === false` missed two
    // paths: a THROW from the mutation (schema rejection, OCC conflict, read
    // limit) left both files behind, and so did every refusal that reported
    // success. On an unauthenticated endpoint that is 8 MB of permanent,
    // anonymous, billed-forever storage per request.
    let stored = true;

    try {
      /**
       * Both stores INSIDE the try, so a failure on the second does not orphan
       * the first. Convex never reclaims storage on its own, and the previous
       * shape — store, store, then open the try — left the passport photo
       * permanently billed if the letter failed.
       */
      passportPhotoId = await ctx.storage.store(
        new Blob([validated.photo.bytes as BlobPart], { type: validated.photo.mimeType }),
      );

      if (validated.letter) {
        siwesLetterId = await ctx.storage.store(
          new Blob([validated.letter.bytes as BlobPart], { type: validated.letter.mimeType }),
        );
      }

      const result = await ctx.runMutation(internal.applications.submitFromIntake, {
        row: validated.row,
        passportPhotoId,
        siwesLetterId,
      });

      if (!result.success) {
        // 429 only for the limits; anything else is a server-side failure and
        // telling the applicant to wait does not help.
        const status = /try again shortly|received recently/.test(result.error) ? 429 : 500;
        return intakeJson({ error: result.error }, status);
      }

      stored = false; // the row owns them now
      return intakeJson({ success: true, reference_code: result.referenceCode });
    } finally {
      if (stored) {
        if (passportPhotoId) await ctx.storage.delete(passportPhotoId).catch(() => {});
        if (siwesLetterId) await ctx.storage.delete(siwesLetterId).catch(() => {});
      }
    }
  }),
});

export default http;
