import { MutationCtx } from '../_generated/server';

/**
 * Fixed-window rate limiting.
 *
 * The Convex port initially dropped this entirely: the `rateLimits` table was
 * declared in the schema but nothing read or wrote it, which made the port look
 * protected while offering unlimited online password guessing. Each attempt also
 * burns a bcrypt compare, so an unthrottled login is a cheap CPU amplifier.
 *
 * The stored hashes are pgcrypto cost-6 bcrypt — fast to verify and therefore
 * fast to attack — so throttling matters more here than it would with a modern
 * cost factor.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Migration escape hatch. Set `RATE_LIMITS_DISABLED=true` on a deployment to
 * pass everything.
 *
 * It exists because the limits get in the way while the port is still being
 * built — the verification harness signs in a dozen users per run and tripped
 * its own throttle repeatedly. It is deliberately an ENV VAR rather than a code
 * change, so dev can be relaxed while prod is not: prod holds all 348 real
 * records including bcrypt hashes and its URL is reachable from the internet
 * whether or not the app is serving traffic, so unlimited guessing there is a
 * real exposure regardless of what the frontend points at.
 *
 * MUST be unset before cutover. It is in the runbook.
 */
function limitsDisabled(): boolean {
  return process.env.RATE_LIMITS_DISABLED === 'true';
}

export async function checkRateLimit(
  ctx: MutationCtx,
  /** Any stable bucket key: an IP, a user id, `email:<addr>`, or `global`. */
  key: string,
  endpoint: string,
  maxRequests: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (limitsDisabled()) return { allowed: true, retryAfterMs: 0 };

  const now = Date.now();

  // An unkeyable caller is not blocked, but this branch is a loaded gun: every
  // limit that reaches it is simply off. It existed because a missing IP would
  // otherwise put every caller in one bucket and let one client lock everyone
  // out — still true — but callers must not be able to REACH it at will.
  //
  // `login` and `magic_link` used to: they took the address as a mutation
  // argument that the client never sent, so every attempt landed here and no
  // throttle ran. They key on the email now. Anything keyed on a value the
  // caller chooses belongs in the same category as no limit at all.
  if (!key || key === 'unknown') {
    return { allowed: true, retryAfterMs: 0 };
  }

  // `blockedIps` was declared in the schema and consulted by nothing, so a
  // detected attacker could be recorded and never actually blocked. Checked
  // here, which is the one place every throttled endpoint already passes
  // through.
  const block = await ctx.db
    .query('blockedIps')
    .withIndex('by_ip', (q) => q.eq('ipAddress', key))
    .first();

  if (block && (block.isPermanent || (block.expiresAt ?? 0) > now)) {
    return { allowed: false, retryAfterMs: block.isPermanent ? 0 : (block.expiresAt ?? now) - now };
  }

  const existing = await ctx.db
    .query('rateLimits')
    .withIndex('by_ip_and_endpoint', (q) =>
      q.eq('ipAddress', key).eq('endpoint', endpoint),
    )
    .unique();

  if (!existing) {
    await ctx.db.insert('rateLimits', {
      ipAddress: key,
      endpoint,
      requestCount: 1,
      windowStart: now,
      lastRequest: now,
    });
    return { allowed: true, retryAfterMs: 0 };
  }

  // Window elapsed: reset rather than insert, so a long-lived IP keeps exactly
  // one row per endpoint instead of accumulating them.
  if (now - existing.windowStart >= windowMs) {
    await ctx.db.patch(existing._id, {
      requestCount: 1,
      windowStart: now,
      lastRequest: now,
    });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (existing.requestCount >= maxRequests) {
    return {
      allowed: false,
      retryAfterMs: existing.windowStart + windowMs - now,
    };
  }

  await ctx.db.patch(existing._id, {
    requestCount: existing.requestCount + 1,
    lastRequest: now,
  });

  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Limits.
 *
 * These are ANTI-AUTOMATION BOUNDS, not usage quotas. The distinction decides
 * every number below: a limit exists to make a script uneconomic, and the moment
 * it starts refusing real people it has stopped doing that and started doing
 * harm — a locked-out cohort on a Monday morning is a worse outcome than the
 * spraying it prevented.
 *
 * WHICH LIMITS ACTUALLY PROTECT SOMETHING:
 *  - the per-ACCOUNT and per-EMAIL caps stop a targeted attack on one identity.
 *    They can be tight, because one identity generating that volume is not a
 *    person.
 *  - the per-ADDRESS caps only bound total volume, and an address at ORBIT is
 *    routinely the whole Ilorin hub behind one NAT. They must be loose.
 *
 * Testing found the first draft of loginPerIp (30/15min) locked out a single
 * test run within minutes. A hub full of interns signing in after a session
 * would have done the same on day one.
 */
export const LIMITS = {
  // Per ACCOUNT. Fifteen wrong passwords in a quarter of an hour is not someone
  // who has forgotten theirs.
  login: { max: 15, windowMs: 15 * 60 * 1000 },
  // Per ADDRESS. Loose on purpose — see above. Two hundred attempts is still far
  // too few to spray a password across a member list of any size, and far more
  // than a shared connection produces.
  loginPerIp: { max: 200, windowMs: 15 * 60 * 1000 },

  // Per ACCOUNT. requestMagicLink separately refuses a second link within a
  // minute, so this is the outer bound on someone repeatedly asking because the
  // first email is slow.
  magicLink: { max: 10, windowMs: 15 * 60 * 1000 },
  magicLinkPerIp: { max: 60, windowMs: 15 * 60 * 1000 },

  /**
   * Per ADDRESS, on REDEMPTION rather than on requesting.
   *
   * Redeeming was the one auth route with no limit at all, and it is the one
   * that spends a bcrypt compare per call — deliberately, so that an unknown
   * selector costs the same as a known one and cannot be timed. That anti-oracle
   * measure is also an amplifier: an unauthenticated caller turns one cheap
   * request into a full bcrypt on our side, unbounded.
   *
   * Looser than magicLinkPerIp because a genuine redemption can be retried by a
   * mail client prefetching the link, a user tapping twice, and a corporate link
   * scanner following it first — three hits for one human action, before the
   * person has even seen the page.
   */
  magicLinkVerifyPerIp: { max: 120, windowMs: 15 * 60 * 1000 },

  /**
   * Per ADDRESS, on starting Zoho SSO.
   *
   * `GET /zoho/init` inserts an oauthStateTokens row per call and nothing
   * stopped a caller repeating it — an unauthenticated row-insert primitive
   * against a sweeper that clears at most 500 rows every six hours, so it could
   * be filled faster than it drains. Generous, because this is the primary
   * sign-in path for iih.ng staff and a redirect is cheap; it exists to bound
   * the table, not to ration sign-ins.
   */
  oauthInitPerIp: { max: 300, windowMs: 60 * 60 * 1000 },

  // Per ADDRESS, and this is the PRIMARY sign-in path — iih.ng staff use Zoho
  // SSO. At 10/hour, forty people arriving at the hub on a Monday would have
  // locked the platform for the rest of the hour. That number came straight from
  // the Postgres config and was wrong there too; it was simply never enforced.
  oauthCallback: { max: 200, windowMs: 60 * 60 * 1000 },

  // Per SENDER. Each send queues an email, so this is an anti-amplification
  // limit as much as an anti-spam one — but 30/5min is six a minute, which an
  // ordinary back-and-forth conversation reaches. Doubled.
  messageSend: { max: 60, windowMs: 5 * 60 * 1000 },

  // GLOBAL, because the intake is unauthenticated and no header it can read is
  // trustworthy. Sized for an intake push with room to spare; a global limit is
  // itself a denial-of-service surface, so it is generous.
  /**
   * A CIRCUIT BREAKER, not the gate.
   *
   * At 300/hour this was the denial-of-service surface: one caller spent the
   * whole budget in a minute and every genuine applicant was refused for the
   * rest of the window. The per-address limit below is what actually rations
   * use; this exists only to bound total damage if many addresses are involved,
   * so it is set far above any plausible real intake — thirty places, applying
   * over weeks.
   */
  applicationIntake: { max: 2000, windowMs: 60 * 60 * 1000 },
  // Per canonical address. Nobody fills the same application in three times an
  // hour by accident, and this is what bounds mailing one inbox.
  applicationIntakePerEmail: { max: 3, windowMs: 60 * 60 * 1000 },
  /**
   * Per client address. The global ceiling alone is a denial-of-service
   * surface: one caller can spend all 300 in a minute and every genuine
   * applicant is refused for the rest of the hour. It exists to stop one
   * source consuming the whole intake, not to ration honest use.
   *
   * 100, not 20. The first draft called 20/hour "generous" for "a household or
   * a campus lab", but an address here is routinely the whole Ilorin hub or a
   * university lab behind one NAT — the same reality that sized loginPerIp —
   * and an intake push held AT the hub would refuse applicant #21 for the rest
   * of the hour. That is the exact failure mode this file says a limit must
   * never cause. Found the same way loginPerIp's first draft was: the e2e
   * suite, submitting like a NAT'd cohort from one address, tripped it —
   * applications were refused with "We are receiving a lot of applications"
   * and the two intake specs failed while nothing was wrong with the code
   * under test. At 100/hour one source can still spend at most 5% of the
   * global ceiling, so the anti-amplification purpose is intact.
   */
  applicationIntakePerIp: { max: 100, windowMs: 60 * 60 * 1000 },

  // Per USER. Storage is billed per byte and never reclaimed automatically, so
  // an upload URL is worth bounding — but a member adding images to a post
  // should never meet it.
  fileUpload: { max: 80, windowMs: 10 * 60 * 1000 },
} as const;
