import { internalMutation, mutation, QueryCtx } from './_generated/server';
import { emailButton } from './lib/emailShell';
import { appUrl } from './lib/appUrl';
import { orgShortName } from './lib/org';
import { v } from 'convex/values';
import { escapeHtml } from './lib/html';
import { ensureInternProfile } from './lib/internProfile';
import { randomToken, startSession, publicUser, recordAuthFailure } from './lib/auth';
import { checkRateLimit, LIMITS } from './lib/rateLimit';

/**
 * Zoho SSO, ported from the Supabase edge functions.
 *
 * Two defects found the hard way on 2026-07-31 are fixed by construction here:
 *
 *  - The account id comes from ZUID. accounts.zoho.com/oauth/user/info does NOT
 *    return ZASOID; reading that key yielded undefined, and the old client
 *    silently dropped the undefined argument, producing a baffling "function not
 *    found" error from PostgREST.
 *
 *  - A new user gets a profileSlug. The Postgres version omitted it from its
 *    INSERT while the column was NOT NULL, so *every* first-time SSO login
 *    failed with a constraint violation that surfaced only as "Login failed".
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_CODE_TTL_MS = 2 * 60 * 1000;

/** Kebab-cases a name and appends -1, -2 … until unused. */
async function uniqueProfileSlug(
  ctx: QueryCtx,
  fullName: string,
  email: string,
): Promise<string> {
  const base =
    fullName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || email.split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');

  let candidate = base || 'member';

  for (let i = 1; ; i++) {
    const clash = await ctx.db
      .query('users')
      .withIndex('by_slug', (q) => q.eq('profileSlug', candidate))
      .unique();

    if (!clash) return candidate;
    candidate = `${base}-${i}`;
  }
}

export const createStateToken = internalMutation({
  args: { ipAddress: v.optional(v.string()) },
  handler: async (ctx, { ipAddress }) => {
    const now = Date.now();

    /**
     * Throttled because this route WRITES.
     *
     * `GET /zoho/init` is unauthenticated and inserts a row per call, which made
     * it a row-insert primitive: sweepExpiredState clears at most 500 rows every
     * six hours, so the table could be filled faster than it drains, by anyone,
     * with no credential. Returning null rather than throwing lets the route
     * answer with its ordinary failure page instead of a stack trace.
     */
    const limit = await checkRateLimit(
      ctx, ipAddress ?? 'unknown', 'oauth_init',
      LIMITS.oauthInitPerIp.max, LIMITS.oauthInitPerIp.windowMs,
    );
    if (!limit.allowed) return null;

    const stateToken = randomToken();

    await ctx.db.insert('oauthStateTokens', {
      stateToken,
      expiresAt: now + STATE_TTL_MS,
      createdAt: now,
    });

    return stateToken;
  },
});

/** Validates and consumes a state token. Single use — this is the CSRF defence. */
export const consumeStateToken = internalMutation({
  args: { stateToken: v.string() },
  handler: async (ctx, { stateToken }) => {
    const row = await ctx.db
      .query('oauthStateTokens')
      .withIndex('by_token', (q) => q.eq('stateToken', stateToken))
      .unique();

    if (!row) return false;

    await ctx.db.delete(row._id);
    return row.expiresAt > Date.now();
  },
});

/**
 * Finds or creates the user for a verified Zoho identity, then mints a one-time
 * exchange code. The session token itself never travels in a URL.
 */
export const completeZohoLogin = internalMutation({
  args: {
    email: v.string(),
    fullName: v.string(),
    zohoId: v.string(),
    ipAddress: v.optional(v.string()),
  },
  handler: async (ctx, { email, fullName, zohoId, ipAddress }) => {
    const now = Date.now();
    const normalised = email.trim().toLowerCase();

    // The one auth path that had no throttle. Login and magic link were both
    // rate limited from the start; the Zoho callback creates accounts, so an
    // unthrottled loop against it is an account-creation primitive for anyone
    // who can drive the OAuth dance with an allowed domain.
    const limit = await checkRateLimit(
      ctx, ipAddress ?? 'unknown', 'oauth_callback',
      LIMITS.oauthCallback.max, LIMITS.oauthCallback.windowMs,
    );
    if (!limit.allowed) {
      await recordAuthFailure(ctx, {
        action: 'zoho_callback', reason: 'Rate limited', subject: normalised, ipAddress,
      });
      return { success: false as const, error: 'Too many sign-in attempts. Please try again later.' };
    }

    let user = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', normalised))
      .unique();

    let isNewUser = false;

    if (!user) {
      // Guard the reverse direction too: the same Zoho identity must not be
      // attached to two ORBIT accounts.
      const byZoho = await ctx.db
        .query('users')
        .withIndex('by_zohoId', (q) => q.eq('zohoId', zohoId))
        .unique();

      if (byZoho) {
        return {
          success: false as const,
          error: 'This Zoho account is already linked to another ORBIT user.',
        };
      }

      isNewUser = true;
      const id = await ctx.db.insert('users', {
        email: normalised,
        fullName,
        profileSlug: await uniqueProfileSlug(ctx, fullName, normalised),
        zohoId,
        /**
         * MODERATOR, not intern.
         *
         * Zoho sign-in is gated to ALLOWED_OAUTH_DOMAINS (iih.ng), so everyone
         * who arrives this way is IIH staff — this is the staff door. Creating
         * them as interns put colleagues in the intern directory, in review
         * queues as subjects rather than reviewers, and denied them the
         * moderator screens they signed in to use.
         *
         * Admin and super_admin stay manual: those are grants, not a
         * consequence of holding a work email.
         */
        roles: ['moderator'],
        totalPoints: 0,
        currentLevel: 1,
        loginStreakCount: 0,
        isActive: true,
        mcpEnabled: false,
        profileVisibility: 'public',
        showEmail: false,
        showActivityOnFeed: true,
        showOnLeaderboard: true,
        isDummy: false,
        createdAt: now,
        updatedAt: now,
      });
      user = (await ctx.db.get(id))!;

      // Every account is usable as an intern profile from the moment it exists —
      // see lib/internProfile.ts. There is no second step to forget.
      await ensureInternProfile(ctx, id);

      // Welcome email on FIRST Zoho sign-in. The Supabase flow sent one; the
      // port created the account silently, so someone whose ORBIT account came
      // into existence through SSO was never told it existed or what to do next.
      await ctx.db.insert('emailQueue', {
        userId: user._id,
        emailType: 'welcome',
        recipientEmail: user.email,
        subject: 'Welcome to ORBIT',
        bodyHtml:
          `<p>Hi ${escapeHtml(user.fullName)},</p>` +
          `<p>Your ORBIT account is ready. You signed in with your ${escapeHtml(orgShortName())} Zoho account, ` +
          'so there is no separate password to remember — use the same button next time.</p>' +
          emailButton(appUrl(), 'Open ORBIT'),
        bodyText:
          `Hi ${user.fullName},\n\nYour ORBIT account is ready. You signed in with your ` +
          `${orgShortName()} Zoho account, so there is no separate password to remember — use the ` +
          `"Sign in with Zoho" button next time.\n\n` +
          appUrl(),
        status: 'pending',
        retryCount: 0,
        isDummy: false,
        createdAt: now,
      });
    } else {
      if (!user.isActive || user.isDeleted) {
        return {
          success: false as const,
          error: 'Account is inactive. Please contact an administrator.',
        };
      }
      // Guard the link path too, not just creation. Without this, a second
      // ORBIT account could be given a zohoId another account already holds —
      // Convex has no unique constraints, so nothing else would stop it. Once
      // two rows share a zohoId, the by_zohoId .unique() lookup above throws an
      // unhandled server error on every subsequent first-time SSO login.
      if (!user.zohoId) {
        const clash = await ctx.db
          .query('users')
          .withIndex('by_zohoId', (q) => q.eq('zohoId', zohoId))
          .first();

        if (clash && clash._id !== user._id) {
          return {
            success: false as const,
            error: 'This Zoho account is already linked to another ORBIT user.',
          };
        }
        await ctx.db.patch(user._id, { zohoId, updatedAt: now });
      }

      // Backfills the Postgres version performed and this port had dropped.
      const patch: Record<string, unknown> = {};
      if (!user.fullName || user.fullName === user.email) patch.fullName = fullName;
      if (!user.profileSlug) {
        patch.profileSlug = await uniqueProfileSlug(ctx, fullName, normalised);
      }
      if (Object.keys(patch).length) {
        await ctx.db.patch(user._id, { ...patch, updatedAt: now });
      }
    }

    const sessionToken = await startSession(ctx, user._id);

    const code = randomToken();
    await ctx.db.insert('oauthExchangeCodes', {
      code,
      userId: user._id,
      token: sessionToken,
      isNewUser,
      expiresAt: now + EXCHANGE_CODE_TTL_MS,
      createdAt: now,
    });

    return { success: true as const, code, isNewUser };
  },
});

/** Redeems the one-time code from the callback redirect for a real session. */
export const exchangeOAuthCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const row = await ctx.db
      .query('oauthExchangeCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique();

    const invalid = {
      success: false as const,
      error: 'Failed to complete authentication. Please try again.',
    };

    if (!row || row.usedAt || row.expiresAt <= Date.now()) return invalid;

    // isActive/isDeleted are re-checked at redemption, not just at issue: an
    // account can be deactivated in the window between the callback minting this
    // code and the browser redeeming it. orbit_exchange_oauth_code required
    // is_active = true for the same reason.
    const user = await ctx.db.get(row.userId);
    if (!user || !user.isActive || user.isDeleted) return invalid;

    // Single use.
    await ctx.db.delete(row._id);

    return {
      success: true as const,
      token: row.token,
      isNewUser: row.isNewUser,
      user: publicUser(user),
    };
  },
});
