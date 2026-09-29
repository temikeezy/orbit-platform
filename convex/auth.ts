import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { emailButton } from './lib/emailShell';
import { v } from 'convex/values';
import bcrypt from 'bcryptjs';

/**
 * A real bcrypt hash of a value nothing will ever present, so a sign-in attempt
 * against an address with no account costs the same as one against a real
 * account. Generated once at module load. Mirrors the equaliser in `http.ts`.
 */
const DUMMY_HASH = bcrypt.hashSync('orbit-timing-equaliser', 8);
import { checkRateLimit, LIMITS } from './lib/rateLimit';
import { appUrl } from './lib/appUrl';
import {
  randomToken,
  magicLinkExpiry,
  startSession,
  userFromToken,
  publicUser,
  recordAuthFailure,
} from './lib/auth';

/**
 * Password, magic-link and session endpoints.
 *
 * Password hashes are bcrypt, carried over verbatim from pgcrypto's
 * crypt(..., gen_salt('bf')). bcryptjs reads those $2a$ hashes directly, so
 * every existing password keeps working — nobody is forced to reset.
 */

const GENERIC_MAGIC_LINK_RESULT = {
  success: true as const,
  message: 'If an account exists with that email, a magic link has been sent.',
};

/**
 * Hashes cheap enough to be worth rehashing when their owner next signs in.
 *
 * Costs 04 through 09 — everything below the 10 that ORBIT writes today. The
 * cost is the two digits after the variant, so this reads it out of the hash
 * rather than keeping a list of which accounts were imported. Matching costs 10
 * and above would rehash on every single login forever, which is why the range
 * is closed rather than "not 10".
 */
export const BCRYPT_COST_TO_UPGRADE = /^\$2[aby]\$0[4-9]\$/;

/**
 * INTERNAL. Sign-in runs behind the `/auth/login` httpAction.
 *
 * It has to, to be rate limited honestly. As a public mutation this took
 * `ipAddress` as an argument — but a Convex mutation cannot see the client
 * address, so the value was whatever the browser chose to send, and the app sent
 * nothing at all. Every attempt hit `checkRateLimit`'s unkeyable free-pass
 * branch, so login throttling never ran: unlimited online guessing against
 * cost-6 bcrypt hashes.
 *
 * An httpAction CAN see the address. `ipAddress` here is the one Convex's own
 * edge recorded, extracted by the route — never a value the caller supplied.
 *
 * TWO limits, because they stop different attacks:
 *  - per IP, which stops one host spraying one password across many accounts;
 *  - per account, which stops many hosts stuffing credentials at one account.
 * Either alone leaves the other open.
 */
export const loginWithPassword = internalMutation({
  args: {
    email: v.string(),
    password: v.string(),
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
  },
  handler: async (ctx, { email, password, userAgent, ipAddress }) => {
    const normalised = email.trim().toLowerCase();

    const byIp = await checkRateLimit(
      ctx,
      ipAddress ?? 'unknown',
      'login_ip',
      LIMITS.loginPerIp.max,
      LIMITS.loginPerIp.windowMs,
    );
    if (!byIp.allowed) {
      await recordAuthFailure(ctx, {
        action: 'login', reason: 'Rate limited by address', subject: normalised, ipAddress,
      });
      return {
        success: false as const,
        error: 'Too many sign-in attempts. Please try again later.',
      };
    }

    const limit = await checkRateLimit(
      ctx,
      `email:${normalised}`,
      'login',
      LIMITS.login.max,
      LIMITS.login.windowMs,
    );
    if (!limit.allowed) {
      await recordAuthFailure(ctx, {
        action: 'login', reason: 'Rate limited by account', subject: normalised, ipAddress,
      });
      return {
        success: false as const,
        error: 'Too many sign-in attempts. Please try again later.',
      };
    }

    const user = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', normalised))
      .unique();

    // Same message whether the account is missing or the password is wrong, so
    // this cannot be used to enumerate who has an ORBIT account.
    const invalid = { success: false as const, error: 'Invalid email or password' };

    // Inactive accounts fail as "invalid", before the hash is even compared.
    // Returning a distinct "inactive" message only after a SUCCESSFUL compare
    // confirms both that the account exists and that the supplied password is
    // correct — an oracle the Postgres version avoided by filtering on
    // is_active in the lookup itself.
    if (!user || user.isDeleted || !user.isActive || !user.passwordHash) {
      // Spend the same bcrypt the hit branch spends. The shared message closes
      // the obvious oracle, but skipping the compare left a timing one: a miss
      // returned in microseconds where a real account costs a full verify, so
      // "does this address have an ORBIT account" was answerable with a stopwatch
      // inside the ordinary rate-limit budget. This is the same equaliser the
      // magic-link verify route already uses for unknown selectors.
      bcrypt.compareSync(password, DUMMY_HASH);
      await recordAuthFailure(ctx, {
        action: 'login', reason: 'No such account, or inactive', subject: normalised, ipAddress,
      });
      return invalid;
    }
    if (!bcrypt.compareSync(password, user.passwordHash)) {
      await recordAuthFailure(ctx, {
        action: 'login', reason: 'Wrong password', subject: normalised, ipAddress,
      });
      return invalid;
    }

    const token = await startSession(ctx, user._id, { userAgent });

    /**
     * The only moment the plaintext exists is here, on a correct compare — so
     * it is the only moment an inherited weak hash can be upgraded.
     *
     * Every hash imported from the old pgcrypto database is bcrypt cost 6.
     * ORBIT writes cost 10 for anything it hashes itself, but an account whose
     * owner has never changed their password keeps the cost-6 hash forever;
     * eight of the nine hashes in production were still cost 6 when this was
     * written. Rehashing on a successful sign-in migrates them without asking
     * anyone to do anything.
     *
     * Cost 10, NOT 12. The cost is encoded in the hash, so raising it later is
     * this same three lines — but 12 is roughly four times the CPU of 10 on
     * EVERY sign-in forever, and loginPerIp allows 200 attempts per fifteen
     * minutes, which would make the login endpoint a considerably better CPU
     * amplifier than it is now. 10 also matches what changePassword and
     * adminResetPassword already write, so there is one number rather than two.
     *
     * Inside the same mutation as startSession deliberately: Convex mutations
     * are transactional, so a failure here rolls back the session too and the
     * member simply retries — rather than signing in against a half-written
     * credential.
     */
    if (BCRYPT_COST_TO_UPGRADE.test(user.passwordHash)) {
      await ctx.db.patch(user._id, { passwordHash: bcrypt.hashSync(password, 10) });
    }

    // A temporary password is single-use, and nothing writes one any more — this
    // clears the rows that still carry one from before that changed.
    if (user.tempPassword) {
      await ctx.db.patch(user._id, { tempPassword: undefined });
    }

    const fresh = (await ctx.db.get(user._id))!;
    return { success: true as const, token, user: publicUser(fresh) };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();

    if (session) await ctx.db.delete(session._id);
    return { success: true as const };
  },
});

/**
 * Signs out every device. Used after a password change or admin reset.
 *
 * internalMutation, NOT mutation. As a public mutation this took a bare userId
 * and revoked every session for it with no token check — and user ids are public
 * (publicUser returns `id` in every login and `me` payload), so anyone could
 * force-logout any account, including admins, on a loop. Callers must be
 * server-side code that has already established who is asking.
 */
export const logoutAllSessions = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();

    for (const s of sessions) await ctx.db.delete(s._id);
    return { revoked: sessions.length };
  },
});

export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userFromToken(ctx, token);
    return user ? publicUser(user) : null;
  },
});

/**
 * Issues a magic link and queues the email.
 *
 * Three properties the Postgres version had to be retrofitted with, preserved
 * here by construction: the response never reveals whether the account exists,
 * requesting a link does not disturb an existing session (links are their own
 * rows), and the link is single-use.
 */
/** INTERNAL, behind `/auth/magic-link`, for the same reason as sign-in. */
export const requestMagicLink = internalMutation({
  args: { email: v.string(), ipAddress: v.optional(v.string()) },
  handler: async (ctx, { email, ipAddress }) => {
    const normalised = email.trim().toLowerCase();
    if (!normalised) return { success: false as const, error: 'Email is required' };

    // Per address AND per account. Each link sends mail, so an unthrottled
    // endpoint is an email-bombing primitive against anyone with an account —
    // and the per-account cap alone does not stop one host cycling through many
    // addresses to farm valid-account signals.
    const byIp = await checkRateLimit(
      ctx, ipAddress ?? 'unknown', 'magic_link_ip',
      LIMITS.magicLinkPerIp.max, LIMITS.magicLinkPerIp.windowMs,
    );
    if (!byIp.allowed) return GENERIC_MAGIC_LINK_RESULT;

    const limit = await checkRateLimit(
      ctx,
      `email:${normalised}`,
      'magic_link',
      LIMITS.magicLink.max,
      LIMITS.magicLink.windowMs,
    );
    if (!limit.allowed) return GENERIC_MAGIC_LINK_RESULT;

    const user = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', normalised))
      .unique();

    if (!user || !user.isActive || user.isDeleted) return GENERIC_MAGIC_LINK_RESULT;

    const now = Date.now();

    // One link per minute per account. Returns the same generic result rather
    // than an error, so the throttle itself leaks nothing.
    const existing = await ctx.db
      .query('magicLinks')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    if (existing.some((l) => l.sentAt > now - 60_000)) return GENERIC_MAGIC_LINK_RESULT;

    // Only one live link at a time.
    for (const l of existing) await ctx.db.delete(l._id);

    /**
     * A SELECTOR and a VERIFIER, not one opaque token.
     *
     * The link still carries one string, but only the selector is stored in
     * readable form; the verifier is bcrypt-hashed. That means redemption can
     * look the row up by a value that is not a credential, and the secret half
     * never has to be passed to a mutation — where it would be recorded in
     * Convex's function logs, readable by anyone with log access for as long as
     * the link lives.
     */
    const selector = randomToken().slice(0, 24);
    const verifier = randomToken();

    await ctx.db.insert('magicLinks', {
      userId: user._id,
      selector,
      verifierHash: bcrypt.hashSync(verifier, 8),
      expiresAt: magicLinkExpiry(now),
      sentAt: now,
    });

    const token = `${selector}.${verifier}`;

    const base = appUrl();
    /**
     * The token goes in the FRAGMENT, not the query string.
     *
     * A query string is sent to the web server on every request for the page
     * and its assets, so it lands in Netlify's request logs, and under the
     * default referrer policy it can travel in the `Referer` header too. That
     * is a live sign-in credential in third-party logs for the hour it is
     * valid. A fragment never leaves the browser.
     */
    const link = `${base}/magic#token=${token}`;

    await ctx.db.insert('emailQueue', {
      userId: user._id,
      emailType: 'magic_link',
      recipientEmail: user.email,
      subject: 'Your ORBIT Magic Link',
      bodyHtml:
        '<p>Click the link below to sign in to ORBIT. This link expires in 24 hours and can be used once.</p>' +
        emailButton(link, 'Sign in to ORBIT') +
        '<p style="color:#666;font-size:12px">If you did not request this, you can ignore ' +
        'this email — your current session is unaffected.</p>',
      bodyText: `Sign in to ORBIT: ${link} (expires in 24 hours, single use)`,
      status: 'pending',
      retryCount: 0,
      isDummy: false,
      createdAt: now,
    });

    return GENERIC_MAGIC_LINK_RESULT;
  },
});

/**
 * Looks a link up by its PUBLIC half.
 *
 * The selector is not a credential — knowing it proves nothing without the
 * verifier — so it is safe to pass as a function argument and to index. This
 * returns the stored hash so the caller can compare; the comparison happens in
 * the HTTP action, which is the only place the secret exists.
 */
/**
 * Throttles redemption, before any bcrypt work happens.
 *
 * Redeeming was the only auth route with no limit at all, and it is the one that
 * spends a bcrypt compare per call whether or not the selector exists — that is
 * deliberate, so an unknown selector cannot be told from a known one by timing.
 * The cost of removing the oracle is that an unauthenticated caller turns one
 * cheap HTTP request into a full bcrypt on our side, so it needs a bound.
 *
 * A mutation because checkRateLimit writes its counter, and the redemption route
 * is an httpAction that cannot. Returns a boolean rather than throwing so the
 * caller can answer with the same generic refusal it gives an invalid link —
 * being rate limited must not be distinguishable from being wrong.
 */
export const checkMagicLinkVerifyAllowed = internalMutation({
  args: { ipAddress: v.optional(v.string()) },
  handler: async (ctx, { ipAddress }) => {
    const limit = await checkRateLimit(
      ctx, ipAddress ?? 'unknown', 'magic_link_verify',
      LIMITS.magicLinkVerifyPerIp.max, LIMITS.magicLinkVerifyPerIp.windowMs,
    );
    return limit.allowed;
  },
});

export const magicLinkBySelector = internalQuery({
  args: { selector: v.string() },
  handler: async (ctx, { selector }) => {
    const link = await ctx.db
      .query('magicLinks')
      .withIndex('by_selector', (q) => q.eq('selector', selector))
      .unique();

    if (!link) return null;

    return {
      id: link._id,
      userId: link.userId,
      verifierHash: link.verifierHash ?? null,
      expiresAt: link.expiresAt,
    };
  },
});

/**
 * Legacy lookup, for links emailed before the selector/verifier split.
 *
 * Still takes the raw token as an argument, which is the very thing being fixed
 * — so it exists only for the hour it takes the last old link to expire, and
 * `sweepExpired` removes the rows. Delete this and the `by_token` index once no
 * `token` field remains.
 */
export const magicLinkByLegacyToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query('magicLinks')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();

    if (!link) return null;
    return { id: link._id, userId: link.userId, expiresAt: link.expiresAt };
  },
});

/**
 * Consumes a verified link and issues a session.
 *
 * Takes an id, never a secret. Single use: the row is deleted on redemption so
 * the emailed URL cannot be replayed.
 */
export const consumeMagicLink = internalMutation({
  args: { linkId: v.id('magicLinks'), userAgent: v.optional(v.string()) },
  handler: async (ctx, { linkId, userAgent }) => {
    const link = await ctx.db.get(linkId);
    if (!link || link.expiresAt <= Date.now()) return null;

    const user = await ctx.db.get(link.userId);
    if (!user || !user.isActive || user.isDeleted) return null;

    await ctx.db.delete(link._id);

    const session = await startSession(ctx, user._id, { userAgent });
    const fresh = (await ctx.db.get(user._id))!;

    return { token: session, user: publicUser(fresh) };
  },
});

/** Deletes expired sessions, magic links and OAuth state. Driven by a cron. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let removed = 0;

    const SWEEP_PAGE = 500;

    /**
     * BOUNDED, like everything below it.
     *
     * The index makes this read only expired rows, which is why it was left
     * uncapped — but "only the expired ones" is not a bound. Every sibling table
     * here takes a fixed page for exactly this reason, and the one table that
     * grows with every sign-in was the one that could return more rows than a
     * transaction can hold. When that happens the whole sweep rolls back, so the
     * tables it had been draining stop draining too: one bad day disables all of
     * the cleanup, permanently, and nothing says so.
     */
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_expiry', (q) => q.lt('expiresAt', now))
      .take(SWEEP_PAGE);
    for (const s of sessions) {
      await ctx.db.delete(s._id);
      removed++;
    }

    /**
     * BOUNDED. This used to collect three whole tables to find the expired
     * rows in them, so once they grew past the transaction limit the cleanup
     * rolled back on every run — and the tables it had stopped draining kept
     * growing. A sweep that fails silently as it gets more necessary.
     *
     * These have no expiry index, so they take a fixed page and the cron catches
     * up over runs.
     */
    for (const table of ['magicLinks', 'oauthStateTokens', 'oauthExchangeCodes'] as const) {
      // Oldest first is deliberate here, and the opposite of the list queries:
      // the expired rows are the old ones, so this is the right end to read.
      const rows = await ctx.db.query(table).take(SWEEP_PAGE);
      for (const row of rows) {
        if ((row as { expiresAt: number }).expiresAt <= now) {
          await ctx.db.delete(row._id);
          removed++;
        }
      }
    }

    /**
     * rateLimits, which nothing swept at all.
     *
     * The schema comment on this table already says it grows faster than any
     * other — every sign-in, upload and application submission touches it — and
     * that it was measured at 15.7MB of a 16MB transaction limit on a deployment
     * with a few hundred accounts. It had no sweep, so that was a one-way trip.
     *
     * It is also the only table an unauthenticated caller can add rows to at
     * will: bucket keys include caller-chosen values like `email:<address>`, so
     * a request to /auth/magic-link with a fresh address each time mints a
     * permanent row. Retention is generous — a day, against a longest window of
     * an hour — so a live counter is never deleted out from under a limit that
     * is still doing its job.
     */
    const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
    const limitRows = await ctx.db
      .query('rateLimits')
      // BY IDLENESS, not by creation. See the index comment in schema.ts: the
      // limiter patches an elapsed window rather than re-inserting, so an
      // active bucket keeps its original creation time and an unordered page
      // reads the same busy rows every run while stale ones pile up behind
      // them.
      .withIndex('by_last_request', (q) => q.lt('lastRequest', now - STALE_AFTER_MS))
      .take(SWEEP_PAGE);

    for (const row of limitRows) {
      await ctx.db.delete(row._id);
      removed++;
    }

    return { removed };
  },
});

