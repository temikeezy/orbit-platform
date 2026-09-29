import { internalMutation, mutation, query, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { appUrl } from './lib/appUrl';
import { SIGN_IN_LINK_PLACEHOLDER } from './lib/conversion';
import { qaEmail, type QaFinding } from './lib/emailQa';
import { asSent } from './lib/emailShell';
import { requireAdmin, requireUser, hasRole, mintMagicLink } from './lib/auth';
import { escapeHtml } from './lib/html';
import { internal } from './_generated/api';
import { EMAIL_DISPATCH_SETTING } from './emailDispatch';

/**
 * Database side of the email queue. Kept separate from email.ts because that
 * file is "use node" and actions cannot touch the database directly.
 */

const MAX_RETRIES = 3;

/**
 * Deletes terminal queue rows after the admin has had a month to investigate
 * delivery failures. Driven by a cron.
 */
export const sweepTerminal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
    const SWEEP_PAGE = 500;
    const now = Date.now();
    const cutoff = now - TERMINAL_RETENTION_MS;
    let removed = 0;
    let attemptsRemoved = 0;

    /**
     * BOUNDED and indexed by the terminal timestamp, not creation time.
     *
     * Queue rows are patched in place as they move through pending and
     * processing, so a message can become terminal long after it was created.
     * Paging by `_creationTime` or `createdAt` would delete a freshly failed
     * old message before an admin could investigate it, while an unordered page
     * could keep returning the wrong end of the table as terminal rows pile up.
     *
     * Status is part of both indexes so pending and processing mail can never
     * enter the deletion set. The explicit lower bound matters too: Convex
     * sorts a missing optional field before every number, so a bare `.lt()`
     * would erase a terminal row with no timestamp instead of retaining it for
     * investigation.
     */
    const sent = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_sent_at', (q) =>
        q.eq('status', 'sent').gt('sentAt', undefined).lt('sentAt', cutoff),
      )
      .take(SWEEP_PAGE);
    const failed = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_failed_at', (q) =>
        q.eq('status', 'failed').gt('failedAt', undefined).lt('failedAt', cutoff),
      )
      .take(SWEEP_PAGE);

    /**
     * Cancelled messages are terminal too, and were swept by nothing.
     *
     * `cancelledAt` rather than `createdAt`: retention has to start when the
     * decision was made, not when the message was queued, or a cancellation of
     * something queued five weeks ago would be swept immediately and the log
     * would never show it happened.
     */
    const cancelled = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_cancelled_at', (q) =>
        q.eq('status', 'cancelled').gt('cancelledAt', undefined).lt('cancelledAt', cutoff),
      )
      .take(SWEEP_PAGE);

    // Imported terminal rows may predate sentAt/failedAt. Backfill rather than
    // delete them: discovery starts their retention clock, guaranteeing an
    // admin still gets the promised month to inspect the body and failure.
    const sentWithoutTimestamp = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_sent_at', (q) =>
        q.eq('status', 'sent').eq('sentAt', undefined),
      )
      .take(SWEEP_PAGE);
    const failedWithoutTimestamp = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_failed_at', (q) =>
        q.eq('status', 'failed').eq('failedAt', undefined),
      )
      .take(SWEEP_PAGE);

    /**
     * Cancellations made before `cancelledAt` existed.
     *
     * `cancelPendingAcknowledgements` stamped `failedAt` on rows it cancelled,
     * so they carry a terminal status with no cancelled-timestamp and the
     * cancelled sweep — which requires one — can never see them. Left alone
     * they keep their bodies forever, against a documented 30-day retention.
     *
     * Backfilled from `failedAt` where there is one, so their original
     * retention clock is preserved rather than restarted; `now` otherwise, on
     * the same principle as the sent/failed arms: discovery starts the clock.
     */
    const cancelledWithoutTimestamp = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_cancelled_at', (q) =>
        q.eq('status', 'cancelled').eq('cancelledAt', undefined),
      )
      .take(SWEEP_PAGE);

    /**
     * The message's attempt log goes with the message.
     *
     * `emailAttempts` is append-only and references `emailQueue` rows that this
     * sweep deletes — so without this the log grows without bound and its rows
     * point at messages that no longer exist. Deleted BEFORE the queue row so a
     * mutation that fails partway leaves attempts without a parent rather than
     * a parent with a half-deleted log; the former is invisible, the latter
     * shows an admin a message whose history has holes in it.
     *
     * Bounded per row for the same reason everything else here is: a message
     * has at most MAX_RETRIES attempts in practice, and a runaway that somehow
     * produced thousands must not make this sweep time out and stop running.
     */
    for (const row of [...sent, ...failed, ...cancelled]) {
      const attempts = await ctx.db
        .query('emailAttempts')
        .withIndex('by_email', (q) => q.eq('emailId', row._id))
        .take(50);
      for (const a of attempts) {
        await ctx.db.delete(a._id);
        attemptsRemoved++;
      }

      await ctx.db.delete(row._id);
      removed++;
    }

    for (const row of sentWithoutTimestamp) {
      await ctx.db.patch(row._id, { sentAt: now });
    }
    for (const row of failedWithoutTimestamp) {
      await ctx.db.patch(row._id, { failedAt: now });
    }
    for (const row of cancelledWithoutTimestamp) {
      await ctx.db.patch(row._id, { cancelledAt: row.failedAt ?? now });
    }

    return {
      removed,
      attemptsRemoved,
      backfilled:
        sentWithoutTimestamp.length +
        failedWithoutTimestamp.length +
        cancelledWithoutTimestamp.length,
    };
  },
});

/**
 * Queues one ad-hoc email to a user. Admin only.
 *
 * Backs the MCP `queue_email_alert` tool. The recipient ADDRESS is read from the
 * user record rather than accepted as an argument — the Supabase version did the
 * same lookup, but the pattern matters: an email-sending endpoint that takes a
 * caller-supplied address is an open relay wearing the platform's domain and
 * reputation.
 *
 * The queue drain (`email.processQueue`) still applies EMAIL_ALLOWLIST, so on a
 * deployment with that set this enqueues but does not deliver.
 */
export const adminEnqueue = mutation({
  args: {
    token: v.string(),
    userId: v.id('users'),
    subject: v.string(),
    bodyText: v.string(),
    bodyHtml: v.optional(v.string()),
    emailType: v.optional(v.string()),
    referenceType: v.optional(v.string()),
    referenceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);

    const target = await ctx.db.get(args.userId);
    if (!target || target.isDeleted || !target.isActive) {
      return { success: false as const, error: 'Recipient is unavailable' };
    }

    const subject = args.subject.trim();
    const bodyText = args.bodyText.trim();
    if (!subject || !bodyText) {
      return { success: false as const, error: 'Subject and body are required' };
    }

    const id = await ctx.db.insert('emailQueue', {
      userId: args.userId,
      emailType: args.emailType ?? 'general',
      recipientEmail: target.email,
      subject,
      bodyText,
      // escapeHtml, not a bare interpolation: the Supabase version built
      // `<p>${body_text.replace(/\n/g,'<br>')}</p>`, so any markup in the text —
      // or an agent relaying a user's words — landed in the email as live HTML.
      //
      // `bodyHtml` is still a passthrough for the app's own templates, which are
      // authored by developers. It is NOT exposed on the MCP tool: an agent's
      // instructions arrive over the same channel as member-written content, so
      // handing it a verbatim-HTML email primitive makes any member able to
      // compose mail from ORBIT's domain by asking the agent nicely.
      bodyHtml: args.bodyHtml ?? `<p>${escapeHtml(bodyText).replace(/\n/g, '<br>')}</p>`,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      status: 'pending',
      retryCount: 0,
      isDummy: false,
      createdAt: Date.now(),
    });

    return { success: true as const, id, recipientEmail: target.email };
  },
});

/**
 * The email log for `admin/EmailLogsPage`. Replaces orbit_get_email_logs.
 *
 * The body is deliberately NOT in the list shape. The Postgres version had a
 * separate `orbit_get_email_body` RPC for exactly that reason, and it is a good
 * instinct: a queue view showing every magic-link email's body renders live
 * sign-in links for every account on one admin screen.
 */
export const adminList = query({
  args: {
    token: v.string(),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, status, limit }) => {
    await requireAdmin(ctx, token);

    const cap = Math.min(Math.max(limit ?? 100, 1), 500);

    // Ordered on an index that carries createdAt. `.take(n)` on an unordered
    // query returns the OLDEST n — sorting them afterwards just sorts the wrong
    // n, so the log showed the first emails ever queued and never a recent one.
    const rows = status
      ? await ctx.db
          .query('emailQueue')
          .withIndex('by_status_and_time', (q) => q.eq('status', status))
          .order('desc')
          .take(cap)
      : await ctx.db.query('emailQueue').withIndex('by_time').order('desc').take(cap);

    // Stats over the WHOLE table, not the page. The Postgres RPC computed them
    // in SQL for the same reason: counted client-side they were capped at
    // whatever had been fetched, so the dashboard read "3 failed" when the
    // page held three failures and there were forty.
    /**
     * Over the most recent window, not all history.
     *
     * These counts existed to stop the dashboard reporting "3 failed" when the
     * page held three of forty — but computing them from the entire table
     * simply moves the failure: the queue grows with every notification, and
     * eventually the admin screen stops loading at all. A bounded window keeps
     * the number useful and the page alive.
     */
    const STATS_WINDOW = 5000;
    const all = await ctx.db.query('emailQueue').withIndex('by_time').order('desc').take(STATS_WINDOW);
    const startOfToday = new Date(new Date().toISOString().slice(0, 10)).getTime();
    const stats = {
      // `capped` says the counts describe the most recent window rather than
      // all history — the same honesty `applications.counts` already applies.
      capped: all.length === STATS_WINDOW,
      windowSize: STATS_WINDOW,
      total: all.length,
      pending: all.filter((e) => e.status === 'pending').length,
      sent: all.filter((e) => e.status === 'sent').length,
      failed: all.filter((e) => e.status === 'failed').length,
      today: all.filter((e) => e.createdAt >= startOfToday).length,
    };

    return {
      stats,
      logs: rows.map((e) => ({
        id: e._id,
        emailType: e.emailType,
        recipientEmail: e.recipientEmail,
        subject: e.subject,
        status: e.status,
        sentAt: e.sentAt,
        failedAt: e.failedAt,
        errorMessage: e.errorMessage,
        retryCount: e.retryCount,
        /**
         * When the next attempt is due, for rows waiting out a backoff.
         *
         * Without it every unsent row reads as "pending" whether it is about to
         * go or is sixteen minutes into a wait, and the two need different
         * responses from whoever is looking.
         */
        nextAttemptAt: e.nextAttemptAt,
        createdAt: e.createdAt,
      })),
    };
  },
});

/**
 * Runs the queue now, instead of waiting for the two-minute cron.
 *
 * The button this backs used to POST to a Supabase edge function with the ANON
 * KEY as its Authorization header — an unauthenticated endpoint that drained
 * the mail queue, callable by anyone who read the bundle. It is admin-gated
 * here, and it SCHEDULES rather than runs: the actual send is an action, a
 * mutation cannot call one inline, and making the admin's request hang for the
 * duration of a batch would time out on a backlog anyway.
 */

/**
 * The delivery history for one message.
 *
 * Admin-only, like every other read on this table: an attempt row carries a
 * recipient address and a provider error, which can quote the address back.
 * Bodies are NOT included — `adminGetBody` remains the single audited route to
 * a message body, because that is the one that can contain a live magic link.
 */

/**
 * A `processing` row whose lease has expired holds no live claim.
 *
 * Stale-claim recovery normally happens inside `claimPending`, which only runs
 * from `processQueue` — behind BOTH pause gates. So a drain that died mid-batch
 * left rows stuck at `processing`, and if an admin paused in response (the
 * obvious reaction), those rows became unactionable: the screen said "Sending
 * now" forever, cancel and requeue both refused them as in-flight, and the only
 * thing that could free them was releasing the pause — the one action the admin
 * was deliberately avoiding.
 *
 * Admin actions therefore treat an EXPIRED claim as no claim. A live one is
 * still refused, because that send may genuinely be in flight.
 */
function claimIsStale(row: { claimedAt?: number }, now: number): boolean {
  return !row.claimedAt || now - row.claimedAt > CLAIM_LEASE_MS;
}

export const adminAttempts = query({
  args: { token: v.string(), emailId: v.id('emailQueue') },
  handler: async (ctx, { token, emailId }) => {
    await requireAdmin(ctx, token);

    const rows = await ctx.db
      .query('emailAttempts')
      .withIndex('by_email', (q) => q.eq('emailId', emailId))
      .order('desc')
      .take(50);

    // Who pressed retry, resolved here so the screen does not have to fetch
    // users one by one. Absent for cron-driven attempts, which is most of them.
    const names = new Map<string, string>();
    for (const r of rows) {
      if (!r.triggeredByUserId || names.has(r.triggeredByUserId)) continue;
      const u = await ctx.db.get(r.triggeredByUserId);
      if (u) names.set(r.triggeredByUserId, u.fullName);
    }

    return rows.map((r) => ({
      id: r._id,
      attempt: r.attempt,
      outcome: r.outcome,
      providerMessageId: r.providerMessageId,
      error: r.error,
      durationMs: r.durationMs,
      triggeredByName: r.triggeredByUserId ? names.get(r.triggeredByUserId) : undefined,
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Stops a message that has not gone out yet.
 *
 * The gap this fills: an admin could requeue a message but never call one off.
 * With the queue held, the only way to stop a wrong email was to release the
 * pause and watch it send, or edit the database directly.
 *
 * Terminal and deliberate — `cancelled` is not `failed`. A failure is something
 * the system did and may retry; a cancellation is a decision a person made, and
 * the two must stay distinguishable in the log or "why did this never arrive"
 * has no answer. Requeue via `adminRetry` if it was cancelled in error.
 *
 * Refuses a row a drain currently owns, for the same reason `adminRetry` does:
 * the send may already be in flight, and marking it cancelled would leave the
 * log asserting something that did not happen.
 */
export const adminCancel = mutation({
  args: { token: v.string(), emailId: v.id('emailQueue'), reason: v.optional(v.string()) },
  handler: async (ctx, { token, emailId, reason }) => {
    const admin = await requireAdmin(ctx, token);

    const row = await ctx.db.get(emailId);
    if (!row) return { success: false as const, error: 'Email not found' };
    if (row.status === 'sent') {
      return { success: false as const, error: 'That email has already been sent.' };
    }
    if (row.status === 'cancelled') {
      return { success: false as const, error: 'That email is already cancelled.' };
    }
    if (row.status === 'processing' && !claimIsStale(row, Date.now())) {
      return { success: false as const, error: 'That email is being sent right now.' };
    }

    await ctx.db.patch(emailId, {
      status: 'cancelled',
      // Any expired claim goes with it, so the reaper cannot later return this
      // cancelled row to pending.
      claimedAt: undefined,
      claimId: undefined,
      // Starts this message's retention clock — see sweepTerminal.
      cancelledAt: Date.now(),
      nextAttemptAt: undefined,
      // Cleared: whoever requeued it is not responsible for it being stopped.
      requeuedByUserId: undefined,
      errorMessage: reason ? `Cancelled: ${reason.slice(0, 300)}` : 'Cancelled by an administrator.',
    });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.email_cancelled',
      tableName: 'emailQueue',
      recordId: emailId,
      newValues: { recipientEmail: row.recipientEmail, emailType: row.emailType, reason },
      success: true,
      createdAt: Date.now(),
    });

    return { success: true as const };
  },
});

/**
 * Queue health, for the top of the admin screen.
 *
 * Counts are over a BOUNDED window for the same reason `adminList`'s are: this
 * table grows with every notification, and a dashboard that collects the whole
 * of it stops loading long before anyone notices it was a bad idea.
 *
 * `heldByPause` is the number that matters most right now and is the one a
 * count of `pending` alone does not give: with a pause engaged, pending rows
 * are not "about to send", they are "waiting for a human".
 */
export const adminQueueHealth = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    const WINDOW = 2000;
    const recent = await ctx.db.query('emailQueue').withIndex('by_time').order('desc').take(WINDOW);

    const now = Date.now();
    const counts = { pending: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
    let retrying = 0;
    let oldestPendingAt: number | undefined;

    for (const r of recent) {
      if (r.status in counts) counts[r.status as keyof typeof counts]++;
      if (r.status === 'pending') {
        // A row waiting out its backoff is scheduled, not stuck. Without this
        // the screen shows "pending" for both and they need different actions.
        if (r.nextAttemptAt && r.nextAttemptAt > now) retrying++;
        if (oldestPendingAt === undefined || r.createdAt < oldestPendingAt) {
          oldestPendingAt = r.createdAt;
        }
      }
    }

    const dispatch = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', EMAIL_DISPATCH_SETTING))
      .unique();
    const dbPaused =
      typeof dispatch?.settingValue === 'object' &&
      dispatch.settingValue !== null &&
      (dispatch.settingValue as Record<string, unknown>).paused === true;

    /**
     * Both brakes, reported together.
     *
     * EITHER holds the queue (convex/email.ts), but only the database one is
     * visible to a query — `EMAIL_PAUSED` is an environment variable and a
     * query cannot read the deployment's environment. Reporting only the half
     * it can see would tell an admin mail is flowing when it is not, so the
     * env brake is surfaced as its own explicitly-unknown field and the screen
     * says so rather than guessing.
     */
    return {
      counts,
      retrying,
      windowSize: recent.length,
      windowTruncated: recent.length === WINDOW,
      oldestPendingAt,
      dbPaused,
      envPauseVisible: false as const,
    };
  },
});

export const adminProcessNow = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const admin = await requireAdmin(ctx, token);

    const pending = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_time', (q) => q.eq('status', 'pending'))
      .take(50);

    await ctx.scheduler.runAfter(0, internal.email.processQueue, { limit: 25 });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.email_queue_processed',
      tableName: 'emailQueue',
      newValues: { pendingAtRequest: pending.length },
      success: true,
      createdAt: Date.now(),
    });

    return { success: true as const, queued: pending.length };
  },
});

/**
 * One email's body. Replaces orbit_get_email_body.
 *
 * Super admin only, and audited. A magic-link body is a live credential for
 * whoever it was addressed to — reading one is impersonation with extra steps,
 * so it leaves a trace naming who looked.
 */
export const adminGetBody = mutation({
  args: { token: v.string(), emailId: v.id('emailQueue') },
  handler: async (ctx, { token, emailId }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can read email bodies.' };
    }

    const row = await ctx.db.get(emailId);
    if (!row) return { success: false as const, error: 'Email not found' };

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.email_body_viewed',
      tableName: 'emailQueue',
      recordId: emailId,
      newValues: { recipientEmail: row.recipientEmail, emailType: row.emailType },
      success: true,
      createdAt: Date.now(),
    });

    return {
      success: true as const,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      bodyText: row.bodyText,
      recipientEmail: row.recipientEmail,
    };
  },
});

/** Requeues a failed email. Was the "retry" button's call to process-email-queue. */
export const adminRetry = mutation({
  args: { token: v.string(), emailId: v.id('emailQueue') },
  handler: async (ctx, { token, emailId }) => {
    const admin = await requireAdmin(ctx, token);

    const row = await ctx.db.get(emailId);
    if (!row) return { success: false as const, error: 'Email not found' };
    if (row.status === 'sent') return { success: false as const, error: 'That email was already sent.' };
    // Requeuing a row a drain run currently owns would have it sent twice: once
    // by that run, once by the next one to claim it.
    if (row.status === 'processing' && !claimIsStale(row, Date.now())) {
      return { success: false as const, error: 'That email is being sent right now.' };
    }

    // Cancelled is requeueable on purpose — cancelling in error should be
    // recoverable by the same button that recovers a failure.
    // retryCount is reset, or MAX_RETRIES would bounce it straight back to
    // failed on the next cron run and the button would appear to do nothing.
    await ctx.db.patch(emailId, {
      status: 'pending',
      retryCount: 0,
      errorMessage: undefined,
      failedAt: undefined,
      // Cleared, or a row requeued during a backoff window sits until the old
      // timer expires and the button looks like it did nothing.
      nextAttemptAt: undefined,
      // Cleared, or a requeued message keeps the timestamp of the cancellation
      // it just came back from and the sweep would treat it as still terminal.
      cancelledAt: undefined,
      // Carried to the attempt that results, so the log can say who caused it.
      requeuedByUserId: admin._id,
      // An expired claim is dropped, or the row goes back to pending still
      // carrying an owner and the next report from that dead run would apply.
      claimedAt: undefined,
      claimId: undefined,
    });

    // Audited, like adminGetBody. Requeuing an unexpired magic-link email
    // re-delivers a live sign-in credential to somebody's mailbox on an admin's
    // say-so, which belongs in the log as much as reading one does.
    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.email_requeued',
      tableName: 'emailQueue',
      recordId: emailId,
      newValues: { recipientEmail: row.recipientEmail, emailType: row.emailType },
      success: true,
      createdAt: Date.now(),
    });

    return { success: true as const };
  },
});

/**
 * Claims a batch for one drain run, atomically.
 *
 * Rows used to be read as `pending`, sent, and only then marked `sent`. Two
 * overlapping runs — the two-minute cron and an admin pressing "process now",
 * or a run that outlives its interval — would both read the same rows and both
 * send them. A send that succeeded followed by a status write that failed did
 * the same thing on retry.
 *
 * Claiming moves the row to `processing` inside a mutation, which takes it out
 * of the pending index before anything is sent. `claimedAt` gives the claim an
 * expiry, so a run that dies mid-batch does not strand its rows forever.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

export const claimPending = internalMutation({
  args: { limit: v.number(), claimId: v.string() },
  handler: async (ctx, { limit, claimId }) => {
    const now = Date.now();

    /**
     * A WIDE read, narrowed by readiness — not a narrow read that backoff can
     * fill up.
     *
     * Taking `limit * 2` oldest rows and then discarding the ones still in
     * backoff meant a cohort of old failing messages could occupy the whole
     * window and hide newer ready mail behind them, every single run. The mail
     * most likely to be starved that way is a magic link, which expires in an
     * hour — someone asks to sign in and the link arrives after it is dead.
     *
     * The scan is bounded and cheap (status is indexed); the cost of looking
     * past the stuck rows is what stops them blocking everything behind them.
     */
    const candidates = await ctx.db
      .query('emailQueue')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .take(Math.max(limit * 20, 200));

    const claimed = [];

    for (const row of candidates) {
      if (claimed.length >= limit) break;
      // Backoff not yet elapsed: skip it, but keep looking behind it.
      if (row.nextAttemptAt && row.nextAttemptAt > now) continue;

      await ctx.db.patch(row._id, { status: 'processing', claimedAt: now, claimId });
      claimed.push(row);
    }

    // Rows whose claim expired: a previous run died between claiming and
    // reporting. Returning them to pending is safe — the alternative is mail
    // that silently never sends.
    for (const stale of await ctx.db
      .query('emailQueue')
      .withIndex('by_status', (q) => q.eq('status', 'processing'))
      .take(50)) {
      if (stale.claimedAt && now - stale.claimedAt > CLAIM_LEASE_MS) {
        // Released, and the claim id goes with it: whoever held it can no
        // longer report on this row.
        await ctx.db.patch(stale._id, {
          status: 'pending',
          claimedAt: undefined,
          claimId: undefined,
        });
      }
    }

    return claimed;
  },
});

/**
 * Reports a send, but ONLY if this run still owns the row.
 *
 * A run whose lease expired mid-send would otherwise overwrite whatever the
 * new owner did — including marking `sent` a message the new owner has already
 * sent again, or worse, stamping `failed` over a successful send. Conditioning
 * on the claim id makes a late report a no-op instead of a corruption.
 */

/** Provider errors can be enormous; a log entry is a summary, not a dump. */
const ATTEMPT_ERROR_MAX = 1000;

/**
 * Appends one attempt to the delivery log.
 *
 * Called from every place a send RESOLVES — success or failure, cron or admin,
 * queued path or direct path. Deliberately takes the attempt number from the
 * caller rather than counting rows: the queue row's `retryCount` is the number
 * the rest of the system reasons about, and a log that numbered attempts
 * independently would disagree with the screen showing it.
 *
 * Never throws. A delivery log that can fail a delivery is worse than no log:
 * this runs after the mail is already out of the door, and an exception here
 * would roll back the very transition that records the mail was sent.
 */
async function recordAttempt(
  ctx: MutationCtx,
  args: {
    emailId: Id<'emailQueue'>;
    outcome: 'sent' | 'failed';
    providerMessageId?: string;
    error?: string;
    durationMs?: number;
    claimId?: string;
    triggeredByUserId?: Id<'users'>;
  },
): Promise<void> {
  try {
    /**
     * NUMBERED FROM THE LOG ITSELF, not from the caller's `retryCount`.
     *
     * Four call sites each computed this differently, and all of them were
     * wrong after an `adminRetry`: that resets `retryCount` to 0 by design, so
     * a requeued message started numbering at 1 again and one message could
     * hold several rows all claiming to be "Attempt 1" with different
     * outcomes. Counting what is already logged makes the sequence continuous
     * across requeue cycles, which is what "Attempt 3" means to someone reading
     * a delivery history.
     *
     * Safe to count here: mutations are serializable, so two attempts cannot
     * read the same count and both write it.
     */
    const existing = await ctx.db
      .query('emailAttempts')
      .withIndex('by_email', (q) => q.eq('emailId', args.emailId))
      .collect();

    await ctx.db.insert('emailAttempts', {
      emailId: args.emailId,
      attempt: existing.length + 1,
      outcome: args.outcome,
      providerMessageId: args.providerMessageId,
      error: args.error ? args.error.slice(0, ATTEMPT_ERROR_MAX) : undefined,
      durationMs: args.durationMs,
      claimId: args.claimId,
      triggeredByUserId: args.triggeredByUserId,
      createdAt: Date.now(),
    });
  } catch {
    // Logging is best-effort by design — see above.
  }
}

export const markSent = internalMutation({
  args: {
    id: v.id('emailQueue'),
    claimId: v.string(),
    providerMessageId: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, { id, claimId, providerMessageId, durationMs }) => {
    const row = await ctx.db.get(id);
    if (!row || row.claimId !== claimId) return { applied: false };

    await ctx.db.patch(id, {
      status: 'sent',
      sentAt: Date.now(),
      errorMessage: undefined,
      claimedAt: undefined,
      claimId: undefined,
      // Consumed: this attempt is the one they asked for.
      requeuedByUserId: undefined,
    });

    // The attempt that succeeded is `retryCount` failures plus this one.
    await recordAttempt(ctx, {
      emailId: id,
      outcome: 'sent',
      providerMessageId,
      durationMs,
      claimId,
      triggeredByUserId: row.requeuedByUserId,
    });
    return { applied: true };
  },
});

/**
 * Hands a claimed row back unsent, so the next run can take it.
 *
 * Used when a drain stops short because its lease is running out — twenty-five
 * messages at the SMTP socket timeout is far longer than the five-minute claim
 * covers, and a batch that outlives its own lease gets its rows reaped and
 * resent by the next run, which is how people receive the same mail twice.
 *
 * Distinct from markFailed on purpose: nothing was attempted, so retryCount must
 * not move. Counting an abandoned row as a failure would walk it towards the
 * retry ceiling and eventually discard mail that was never sent even once.
 */
export const releaseClaim = internalMutation({
  args: { id: v.id('emailQueue'), claimId: v.string() },
  handler: async (ctx, { id, claimId }) => {
    const row = await ctx.db.get(id);
    // Same ownership rule as markSent — a run whose lease already expired must
    // not release a row another run has since claimed.
    if (!row || row.claimId !== claimId) return { applied: false };

    await ctx.db.patch(id, {
      status: 'pending',
      claimedAt: undefined,
      claimId: undefined,
    });
    return { applied: true };
  },
});


/**
 * How long to wait before attempt N+1, after N failures.
 *
 * Exponential, so a brief provider outage does not consume every attempt in
 * four minutes. Retries used to go straight back to `pending` and the
 * two-minute cron picked them up immediately: three attempts, four minutes,
 * then permanent failure — ZeptoMail being unreachable for five minutes lost
 * the mail. At MAX_RETRIES 3 this spreads the same attempts over about six
 * minutes (2m + 4m), which clears that outage; the cap below is what keeps the
 * sequence sane if the ceiling is ever raised.
 *
 * Capped at 16 minutes so the sequence cannot run away if MAX_RETRIES is ever
 * raised: without the cap, a tenth retry would wait seventeen hours and the
 * message would look abandoned.
 *
 * Exported for the unit test — the schedule is a claim this file makes in
 * prose ("roughly half an hour"), and prose is not checked by anything.
 */
export function backoffFor(retryCount: number): number {
  return Math.min(2 ** retryCount, 16) * 60 * 1000;
}

export const markFailed = internalMutation({
  args: {
    id: v.id('emailQueue'),
    error: v.string(),
    claimId: v.string(),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, { id, error, claimId, durationMs }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    // Same ownership rule as markSent — a stale run must not report.
    if (row.claimId !== claimId) return;

    const retryCount = row.retryCount + 1;
    const now = Date.now();
    const backoffMs = backoffFor(retryCount);

    // Give up after MAX_RETRIES rather than retrying forever. A permanently bad
    // recipient would otherwise be picked up by every single cron run, and the
    // queue would never drain.
    await ctx.db.patch(id, {
      retryCount,
      errorMessage: error,
      failedAt: now,
      status: retryCount >= MAX_RETRIES ? 'failed' : 'pending',
      nextAttemptAt: retryCount >= MAX_RETRIES ? undefined : now + backoffMs,
      claimedAt: undefined,
      claimId: undefined,
      // Consumed even on failure: the human asked for ONE attempt, and the
      // automatic retries that follow are the system's doing, not theirs.
      requeuedByUserId: undefined,
    });

    // `retryCount` was just incremented, so it IS this attempt's number.
    await recordAttempt(ctx, {
      emailId: id,
      outcome: 'failed',
      error,
      durationMs,
      claimId,
      triggeredByUserId: row.requeuedByUserId,
    });
  },
});

/**
 * A sign-in link minted at the moment of sending.
 *
 * Lives here rather than in auth.ts because it is a queue concern: the drain
 * needs it, and the drain is an action, which cannot mint one itself. Returns a
 * full URL so the caller only has to substitute a string.
 */
export const freshSignInLink = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const token = await mintMagicLink(ctx, userId, Date.now());
    return `${appUrl()}/magic#token=${token}`;
  },
});

/**
 * Cancels queued acknowledgement emails that should no longer be sent.
 *
 * "We received your application" was switched off at intake, but switching off
 * the SOURCE does not empty the QUEUE: 33 of these were already pending, the
 * oldest more than a week old, and every one would have gone out the moment mail
 * was released — telling people we had received an application we have since
 * accepted or declined. Events overtook them, which is exactly why the email was
 * retired.
 *
 * Marks them `cancelled` rather than deleting: the row is the record that a
 * message was queued and deliberately not sent, and the sweep already retires
 * terminal rows on its own schedule.
 */
export const cancelPendingAcknowledgements = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const pending = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_sent_at', (q) => q.eq('status', 'pending'))
      .take(1000);

    /**
     * Two retired types. `application_received` was switched off at intake but
     * left 34 already queued. `task_proposed` sent one email per proposal — with
     * five per stream per week that is how a reviewer learns to ignore the
     * notification that matters; `notifyProposalSummary` replaces the lot with
     * one message per supervisor.
     */
    const RETIRED = new Set(['application_received', 'task_proposed']);
    const stale = pending.filter((r) => RETIRED.has(r.emailType));

    if (!dryRun) {
      const now = Date.now();
      for (const row of stale) {
        await ctx.db.patch(row._id, {
          status: 'cancelled',
          errorMessage: 'Retired — superseded by the acceptance email or the proposal summary.',
          /**
           * `cancelledAt`, not `failedAt`.
           *
           * This stamped the failure clock on a cancellation, which was
           * harmless while nothing swept cancelled rows and became a permanent
           * leak the moment something did: `sweepTerminal`'s cancelled branch
           * requires `cancelledAt`, so these rows — bodies and all — would have
           * been kept forever against a documented 30-day retention. It also
           * counted them as failures in the health summary.
           */
          cancelledAt: now,
        });
      }
    }

    return { dryRun: Boolean(dryRun), cancelled: stale.length, stillPending: pending.length - stale.length };
  },
});

/**
 * QA every message currently waiting, without sending anything.
 *
 * Run this before releasing the hold. The drain applies the same checks at send
 * time and refuses anything that fails, but by then the answer arrives as a
 * failed row rather than as something you can fix first.
 *
 * The sign-in link is substituted and the letter built at send time, so both are
 * simulated here: the placeholder is treated as if it had been replaced, and an
 * approval that references an application is assumed to get its attachment. The
 * point is to catch wording, links and structure, which is what actually goes
 * wrong.
 */
export const qaPending = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query('emailQueue')
      .withIndex('by_status_and_sent_at', (q) => q.eq('status', 'pending'))
      .take(500);

    const report: { id: string; emailType: string; findings: QaFinding[] }[] = [];

    for (const row of pending) {
      const substituted = (v: string) =>
        v.split(SIGN_IN_LINK_PLACEHOLDER).join(`${appUrl()}/magic#token=simulated.forqa`);

      const findings = qaEmail({
        emailType: row.emailType,
        subject: row.subject,
        bodyHtml: asSent(substituted(row.bodyHtml)),
        bodyText: substituted(row.bodyText),
        recipientEmail: row.recipientEmail,
        expectsAttachment: false,
        hasAttachment: true,
      });

      if (findings.length) report.push({ id: String(row._id), emailType: row.emailType, findings });
    }

    const blocking = report.filter((r) => r.findings.some((f) => f.severity === 'block'));

    return {
      pending: pending.length,
      withFindings: report.length,
      blocking: blocking.length,
      report: report.slice(0, 40),
    };
  },
});

/**
 * CLAIMS pending rows of one type, for the targeted drain.
 *
 * This was `pendingOfType`, an internalQuery that read rows and claimed
 * nothing — while `drainType`'s own docstring asserted "each row is claimed so
 * a second run cannot double-send". The code did not do that, and the two ways
 * it went wrong both end in a real person receiving the same email twice:
 *
 *   - Two overlapping `drainType` calls for one type — an impatient
 *     re-invocation is enough — each read the same pending rows and each sent
 *     all of them. Up to `limit` duplicate deliveries from one double-click,
 *     during exactly the release-one-type-at-a-time procedure this function
 *     exists for.
 *   - Racing the cron: `markSentDirect` stamped `sent` while leaving the cron's
 *     `claimId` on the row, so the cron's own `markFailed` still passed its
 *     ownership check and could resurrect an already-sent message to `pending`
 *     for a third delivery.
 *
 * A mutation now, not a query, because claiming is a write. Same model as
 * `claimPending`: the row moves to `processing` before anything is sent, which
 * takes it out of the pending set every other reader uses. Stale claims are
 * reaped by `claimPending`'s existing sweep, which keys on `claimedAt` and does
 * not care which run made the claim.
 */
export const claimPendingOfType = internalMutation({
  args: { emailType: v.string(), limit: v.number(), claimId: v.string() },
  handler: async (ctx, { emailType, limit, claimId }) => {
    const now = Date.now();

    const candidates = await ctx.db
      .query('emailQueue')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .take(600);

    const claimed = [];
    for (const r of candidates) {
      if (claimed.length >= limit) break;
      if (r.emailType !== emailType) continue;
      // Honoured here too. Without it the targeted drain would ignore the
      // backoff the cron path respects and hammer a failing recipient.
      if (r.nextAttemptAt && r.nextAttemptAt > now) continue;

      await ctx.db.patch(r._id, { status: 'processing', claimedAt: now, claimId });
      claimed.push({
        id: String(r._id),
        recipientEmail: r.recipientEmail,
        subject: r.subject,
        bodyHtml: r.bodyHtml,
        bodyText: r.bodyText,
        emailType: r.emailType,
        /**
         * Everything the SEND needs, not just what a list needs.
         *
         * Omitting these made `drainType` structurally incapable of producing a
         * correct acceptance: with no `userId` it cannot mint a sign-in link,
         * and with no `referenceId` it cannot build the SIWES letter. It sent
         * the stored body verbatim — placeholder text where the link belongs,
         * and no attachment — and only the QA placeholder rule stopped that
         * reaching 240 applicants.
         */
        userId: r.userId ? String(r.userId) : undefined,
        referenceType: r.referenceType,
        referenceId: r.referenceId ? String(r.referenceId) : undefined,
      });
    }

    return claimed;
  },
});

/** Marks sent without a claim id — the targeted drain claims nothing. */
/**
 * Reports a targeted-drain send, but ONLY if this run still owns the row.
 *
 * `claimId` is required for the same reason `markSent` requires it: without an
 * ownership check this patched status unconditionally, so a run whose lease had
 * expired could stamp `sent` over a row another run had since claimed — and,
 * by leaving `claimId` in place, leave the new owner's `markFailed` free to
 * resurrect an already-delivered message.
 */
export const markSentDirect = internalMutation({
  args: {
    id: v.string(),
    claimId: v.string(),
    providerMessageId: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, { id, claimId, providerMessageId, durationMs }) => {
    const emailId = id as Id<'emailQueue'>;
    const row = await ctx.db.get(emailId);
    if (!row || row.claimId !== claimId) return { applied: false as const };

    await ctx.db.patch(emailId, {
      status: 'sent',
      sentAt: Date.now(),
      // Released with the report, or the row keeps a claim nobody holds and
      // the reaper eventually returns a SENT message to pending.
      claimedAt: undefined,
      claimId: undefined,
      requeuedByUserId: undefined,
    });

    // `drainType` bypasses the claim/lease path, but its sends are still real
    // deliveries and belong in the same log — otherwise the targeted drains
    // (the ones used to release one email type while the rest stay held) are
    // the only sends with no record of having happened.
    await recordAttempt(ctx, {
      emailId,
      outcome: 'sent',
      providerMessageId,
      durationMs,
      claimId,
      triggeredByUserId: row.requeuedByUserId,
    });
    return { applied: true as const };
  },
});

export const markFailedDirect = internalMutation({
  args: {
    id: v.string(),
    error: v.string(),
    claimId: v.string(),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, { id, error, claimId, durationMs }) => {
    const emailId = id as Id<'emailQueue'>;
    const row = await ctx.db.get(emailId);
    if (!row || row.claimId !== claimId) return { applied: false as const };

    /**
     * The increment is PERSISTED, not just logged.
     *
     * This recorded `retryCount + 1` on the attempt row while leaving the queue
     * row's own `retryCount` untouched — so the log said "attempt 1 happened"
     * and the message said "no attempts yet", which is exactly the screen/log
     * disagreement the delivery log exists to remove.
     */
    const retryCount = row.retryCount + 1;

    await ctx.db.patch(emailId, {
      status: 'failed',
      failedAt: Date.now(),
      retryCount,
      errorMessage: error.slice(0, 500),
      claimedAt: undefined,
      claimId: undefined,
      requeuedByUserId: undefined,
    });

    await recordAttempt(ctx, {
      emailId,
      outcome: 'failed',
      error,
      durationMs,
      claimId,
      triggeredByUserId: row.requeuedByUserId,
    });
    return { applied: true as const };
  },
});

/**
 * The most recently queued message of a type, body included.
 *
 * `adminList` returns oldest first and has no ordering argument, so on a
 * deployment with a backlog the message you just caused is the one you cannot
 * reach — which is exactly the message worth reading before a change ships.
 *
 * Internal, so it needs deployment credentials rather than a session: bodies
 * carry sign-in links, which is why `adminGetBody` is super-admin-only.
 */
export const newestOfType = internalQuery({
  args: { emailType: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      subject: v.string(),
      bodyHtml: v.string(),
      bodyText: v.string(),
      recipientEmail: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { emailType }) => {
    const rows = await ctx.db
      .query('emailQueue')
      .withIndex('by_time')
      .order('desc')
      .take(400);

    const hit = rows.find((r) => r.emailType === emailType);
    if (!hit) return null;

    return {
      id: String(hit._id),
      subject: hit.subject,
      bodyHtml: hit.bodyHtml,
      bodyText: hit.bodyText,
      recipientEmail: hit.recipientEmail,
      createdAt: hit.createdAt,
    };
  },
});

/**
 * Deletes queued mail on a deployment that must never send it.
 *
 * WHY THIS EXISTS. Dev carries real ZeptoMail credentials and no pause, so the
 * only thing standing between a test run and a few thousand messages to real
 * `@iih.ng` addresses was `EMAIL_ALLOWLIST` — one environment variable, whose
 * whole documented purpose is to be unset "at cutover, when mail is supposed to
 * reach real users". Somebody unsetting it to try something would discharge the
 * entire accumulated backlog at once. A queue nobody intends to send should not
 * sit there waiting for one variable to change.
 *
 * GATED ON `EMAIL_SINK`, an explicit opt-in set only on non-production
 * deployments. Production does not have the variable, so this is a no-op there —
 * it cannot delete mail somebody is deliberately holding. That is the important
 * property: the guard is something prod must OPT INTO to be harmed by, rather
 * than something it must remember to opt out of.
 *
 * Keeps a short window so a developer can still inspect what a change would
 * have sent — which is the only reason to queue on dev at all.
 */
export const purgeSink = internalMutation({
  args: { olderThanMinutes: v.optional(v.number()), chain: v.optional(v.boolean()) },
  returns: v.object({ sink: v.boolean(), deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, { olderThanMinutes, chain }) => {
    if (process.env.EMAIL_SINK !== '1') {
      return { sink: false, deleted: 0, more: false };
    }

    const cutoff = Date.now() - (olderThanMinutes ?? 60) * 60 * 1000;

    /**
     * Bounded per run and rescheduled, like every other sweep here. Deleting a
     * few thousand rows in one transaction is how a cleanup becomes the outage.
     */
    const BATCH = 200;
    const rows = await ctx.db
      .query('emailQueue')
      .withIndex('by_time')
      .order('asc')
      .take(BATCH);

    let deleted = 0;
    for (const row of rows) {
      if (row.createdAt > cutoff) continue;
      await ctx.db.delete(row._id);
      deleted++;
    }

    /**
     * Continues only when the CRON drove it.
     *
     * Self-rescheduling on every call meant a manual run and the chain it had
     * just spawned both read the same 200 rows and both tried to delete them,
     * which Convex correctly refuses with an OptimisticConcurrencyControlFailure
     * — on every retry, because the contention is continuous. A caller looping
     * by hand now gets one batch per call and can see progress; the cron gets
     * the chain.
     */
    if (deleted === BATCH && chain !== false) {
      await ctx.scheduler.runAfter(0, internal.emailQueue.purgeSink, {
        olderThanMinutes,
        chain: true,
      });
    }

    /**
     * NOT A COUNT, and it no longer pretends to be one.
     *
     * This first returned `take(1).length` — 1 whenever anything remained —
     * under the name `remaining`, which reads as a number and is not one.
     * Replacing it with `take(10_000).length` was worse: an email row carries
     * its rendered body, so counting ten thousand of them read past the 16MB
     * limit and the purge stopped working entirely. Counting by loading every
     * document is the wrong instinct on a table whose rows are large.
     *
     * `deleted` is the honest progress signal — a full batch means there is
     * more, an empty one means there is not, and a caller can loop on it.
     */
    return { sink: true, deleted, more: deleted === BATCH };
  },
});

/**
 * Tallies one email type per recipient, to answer "did anyone get it twice?".
 *
 * `adminList` caps at 300 rows and `adminQueueHealth` counts a window, so
 * neither can answer a duplication question on a queue of a few thousand — and
 * a duplicate that only shows up beyond the window is exactly the one nobody
 * notices. Reads ids and addresses only, never bodies, so it stays well inside
 * the read limit on a table whose rows carry rendered HTML.
 */
export const countByRecipient = internalQuery({
  args: { emailType: v.string() },
  returns: v.object({
    total: v.number(),
    recipients: v.number(),
    duplicated: v.number(),
    worst: v.array(v.object({ email: v.string(), count: v.number(), subjects: v.array(v.string()) })),
  }),
  handler: async (ctx, { emailType }) => {
    const rows = await ctx.db
      .query('emailQueue')
      .withIndex('by_time')
      .order('desc')
      .take(3000);

    const mine = rows.filter((r) => r.emailType === emailType);
    const byEmail = new Map<string, string[]>();
    for (const r of mine) {
      const k = r.recipientEmail.toLowerCase();
      byEmail.set(k, [...(byEmail.get(k) ?? []), r.subject]);
    }

    const dupes = [...byEmail.entries()].filter(([, subs]) => subs.length > 1);
    return {
      total: mine.length,
      recipients: byEmail.size,
      duplicated: dupes.length,
      worst: dupes
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 5)
        .map(([email, subjects]) => ({ email, count: subjects.length, subjects })),
    };
  },
});

/**
 * One recipient's messages of a type, fingerprinted by body.
 *
 * Counting alone cannot tell "two different posts" from "one post sent twice" —
 * both give the same totals, and the subject is identical either way because
 * every agent post is titled "ORBIT Agent posted". The body is the only thing
 * that distinguishes them.
 */
export const bodiesFor = internalQuery({
  args: { emailType: v.string(), recipientEmail: v.string() },
  returns: v.array(v.object({ createdAt: v.number(), subject: v.string(), head: v.string(), length: v.number() })),
  handler: async (ctx, { emailType, recipientEmail }) => {
    const rows = await ctx.db
      .query('emailQueue')
      .withIndex('by_recipient', (q) => q.eq('recipientEmail', recipientEmail.toLowerCase()))
      .collect();

    return rows
      .filter((r) => r.emailType === emailType)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        createdAt: r.createdAt,
        subject: r.subject,
        head: r.bodyText.replace(/\s+/g, ' ').slice(0, 90),
        length: r.bodyText.length,
      }));
  },
});
