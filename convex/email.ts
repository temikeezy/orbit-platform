'use node';

import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { asSent } from './lib/emailShell';
import { appUrl } from './lib/appUrl';
import { SIGN_IN_LINK_PLACEHOLDER } from './lib/conversion';
import { qaEmail, qaBlocks } from './lib/emailQa';
import nodemailer from 'nodemailer';
import { emailFrom, emailFromDomain } from './lib/org';

/**
 * ZeptoMail sender.
 *
 * "use node" because SMTP needs raw sockets, which the default Convex V8
 * isolate does not provide. That makes this an action — it cannot touch the
 * database directly, so queue reads and status writes go through mutations.
 *
 * Sends as noreply@orbit2.iih.ng. That SUBDOMAIN is verified in ZeptoMail; the
 * apex iih.ng is not, and ZeptoMail rejects it outright with
 * "553 Sender is not allowed to relay emails". Do not simplify the sender to the
 * apex without publishing DKIM for it first.
 */

function transport() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!user || !pass) {
    throw new Error('ZeptoMail is not configured: SMTP_USER/SMTP_PASSWORD are unset');
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.zeptomail.com',
    /**
     * Timeouts BELOW the claim lease (5 minutes).
     *
     * A send that hangs longer than the lease loses its claim while still
     * running, and the next drain sends the same message again. Failing fast
     * keeps a stuck connection inside the window its claim covers.
     */
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false, // STARTTLS upgrade on 587
    /**
     * FAIL CLOSED if STARTTLS is unavailable.
     *
     * Without this, `secure: false` means nodemailer upgrades opportunistically
     * and carries on in plaintext if the upgrade does not happen. What travels
     * over this connection is magic-link sign-in tokens, applicant personal
     * data and the SMTP password itself — none of which should ever cross the
     * wire unencrypted because a middlebox stripped a capability.
     */
    requireTLS: true,
    auth: { user, pass },
  });
}

/**
 * Migration safety valve.
 *
 * While ORBIT still runs on Supabase, this deployment holds a full copy of the
 * real user table — 39 genuine addresses. A cron draining the queue would post
 * live sign-in links to real people who never asked for them. If
 * EMAIL_ALLOWLIST is set, only those addresses can receive mail; everything else
 * is refused loudly rather than delivered.
 *
 * Unset the variable at cutover, when mail is supposed to reach real users.
 */
function assertDeliverable(to: string) {
  /**
   * A SINK DEPLOYMENT SENDS NOTHING, to anyone.
   *
   * `EMAIL_ALLOWLIST` was the only thing stopping dev — which holds real
   * ZeptoMail credentials and no pause — from mailing real people, and its own
   * documentation says to unset it "at cutover". A guard you are told to remove
   * is not a guard to leave a few thousand queued messages behind.
   *
   * This one has no cutover. `EMAIL_SINK` is set on non-production deployments
   * and nothing asks anyone to unset it; production has never had it, so this
   * cannot quietly gag live mail. Refusing at the SMTP boundary means it holds
   * however the send was reached — the cron, a targeted drain, or a one-off
   * `convex run` — rather than only on the paths that remember to check.
   */
  if (process.env.EMAIL_SINK === '1') {
    throw new Error(
      `Refusing to send to ${to}: EMAIL_SINK is set on this deployment. ` +
        'Queued mail here is for inspection only and is purged automatically.',
    );
  }

  const allowlist = process.env.EMAIL_ALLOWLIST;
  if (!allowlist) return;

  const permitted = allowlist
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  if (!permitted.includes(to.trim().toLowerCase())) {
    throw new Error(
      `Refusing to send to ${to}: EMAIL_ALLOWLIST is active (migration mode). ` +
        `Only ${permitted.join(', ')} may receive mail from this deployment.`,
    );
  }
}

/**
 * Mail a recipient can legitimately not want.
 *
 * Magic links, application receipts, approvals and the first-SSO welcome are
 * transactional — someone asked for them, and an unsubscribe header on a
 * sign-in link is nonsense. Everything else is activity mail: task deadlines,
 * new tasks, messages, logbook nudges. Gmail and Outlook increasingly treat
 * bulk-shaped mail without `List-Unsubscribe` as a spam signal, and it is the
 * activity mail that arrives repeatedly.
 */
const TRANSACTIONAL = new Set([
  'magic_link',
  'application_received',
  'application_approved',
  'welcome',
  'password_reset',
]);

export const sendOne = internalAction({
  args: {
    to: v.string(),
    subject: v.string(),
    html: v.string(),
    text: v.optional(v.string()),
    emailType: v.optional(v.string()),
    /** The queue row id, used to build a stable Message-ID. */
    messageKey: v.optional(v.string()),
    /**
     * A file to send with the message, base64 encoded.
     *
     * Used for the SIWES acceptance letter. A university's Industrial Liaison
     * Unit will not accept a placement without one, and producing it used to
     * mean an admin opening the print view per applicant — 71 manual steps
     * between someone being accepted and being able to register.
     *
     * Base64 rather than bytes because Convex action arguments have to survive
     * serialisation; it is decoded to a Buffer at the nodemailer boundary.
     */
    attachment: v.optional(
      v.object({ filename: v.string(), contentBase64: v.string(), contentType: v.string() }),
    ),
  },
  handler: async (_ctx, { to, subject, html, text, emailType, messageKey, attachment }) => {
    assertDeliverable(to);

    const from = emailFrom();
    const fromName = process.env.EMAIL_FROM_NAME ?? 'ORBIT Team';

    /**
     * One-click unsubscribe points at the notification preferences the platform
     * already has, rather than a dead mailto. `List-Unsubscribe-Post` is what
     * makes Gmail render the native "Unsubscribe" control instead of guessing.
     */
    const bulk = Boolean(emailType) && !TRANSACTIONAL.has(emailType as string);
    const headers: Record<string, string> = {
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
    };

    if (bulk) {
      headers['List-Unsubscribe'] = `<${appUrl()}/settings>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    /**
     * The shell is applied HERE, once, rather than in each template.
     *
     * Every template is a body fragment; wrapping at the send point means a
     * layout change reaches all of them and no template can forget. A body
     * that already carries a full document is passed through untouched, so
     * anything hand-composed still works.
     */
    const wrapped = asSent(html);

    const info = await transport().sendMail({
      from: `"${fromName}" <${from}>`,
      to,
      subject,
      html: wrapped,
      text: text ?? html.replace(/<[^>]+>/g, ' '),
      headers,
      /**
       * A STABLE Message-ID, derived from the queue row.
       *
       * The queue is at-least-once: a send that succeeds and then fails to
       * report is retried. With a random id each attempt, the recipient sees
       * two separate emails; with the same id, conforming clients and the
       * provider can recognise the retry as the same message. It does not make
       * delivery exactly-once — nothing at this layer can — but it makes a
       * duplicate detectable rather than invisible.
       */
      ...(messageKey ? { messageId: `<${messageKey}@${emailFromDomain()}>` } : {}),
      /**
       * The SIWES acceptance letter, when there is one. Decoded here rather
       * than carried as a Buffer because Convex action arguments must be
       * serialisable, and base64 is what survives that boundary.
       */
      ...(attachment
        ? {
            attachments: [
              {
                filename: attachment.filename,
                content: Buffer.from(attachment.contentBase64, 'base64'),
                contentType: attachment.contentType,
              },
            ],
          }
        : {}),
    });

    return { messageId: info.messageId };
  },
});

/**
 * Drains the pending queue.
 *
 * Replaces the Netlify hourly function -> process-email-queue -> send-email
 * chain with a single Convex cron. Each message is marked terminally (sent or
 * failed) before the next is attempted, so a crash mid-batch cannot cause the
 * survivors to be resent.
 */
export const processQueue = internalAction({
  args: { limit: v.optional(v.number()) },
  // Annotated for the same reason as tasks.create: this action calls itself
  // indirectly through `internal.email.sendOne`, and an inferred return type
  // makes TS report a circular reference. Untyped, `pending` degraded to `any`
  // and nothing in this loop was being checked at all.
  handler: async (
    ctx,
    { limit },
  ): Promise<{ sent: number; failed: number; considered: number; abandoned: number }> => {
    /**
     * PAUSE SWITCH. Holds the queue without consuming it.
     *
     * Set `EMAIL_PAUSED` on the deployment and this drain returns before
     * claiming anything, so every queued message stays `pending` and goes out
     * in order once the variable is removed. Nothing is discarded, nothing is
     * marked failed, and no retry budget is spent.
     *
     * Deliberately NOT `EMAIL_ALLOWLIST`, which is the other lever here: that
     * one throws per recipient, which marks the message failed and eventually
     * abandons it. Fine as a migration guard, wrong for a temporary hold —
     * it would silently destroy the mail it was meant to protect people from.
     *
     *   npx convex env set EMAIL_PAUSED 1      # hold
     *   npx convex env remove EMAIL_PAUSED     # release, queue drains itself
     */
    if (process.env.EMAIL_PAUSED) {
      console.warn('email.processQueue: EMAIL_PAUSED is set — holding the queue, sending nothing.');
      return { sent: 0, failed: 0, considered: 0, abandoned: 0 };
    }

    /**
     * The same brake, operated from the Settings screen.
     *
     * Two independent switches on purpose. The environment variable needs a
     * terminal and a deploy key, which is the wrong tool when a super admin
     * simply needs mail to stop; this one is a toggle they can reach. The env
     * var stays because it works without a database read and without a session,
     * which is what you want when something is actually going wrong.
     *
     * Read AFTER the env check so a paused deployment costs no query at all.
     */
    const dispatch = await ctx.runQuery(internal.emailDispatch.dispatchState, {});
    if (dispatch.paused) {
      console.warn('email.processQueue: dispatch paused in settings — holding the queue.');
      return { sent: 0, failed: 0, considered: 0, abandoned: 0 };
    }

    /**
     * CLAIMED, not merely listed — see emailQueue.claimPending. Reading rows
     * and sending them is how the same message goes out twice.
     *
     * The claim id identifies THIS run, so a run whose lease expires cannot
     * later report on rows another run has taken over.
     */
    const claimId = crypto.randomUUID();

    const pending = await ctx.runMutation(internal.emailQueue.claimPending, {
      limit: limit ?? 25,
      claimId,
    });

    let sent = 0;
    let failed = 0;
    let abandoned = 0;

    /**
     * THE LEASE COVERS THE BATCH, NOT ONE MESSAGE.
     *
     * The SMTP timeouts in transport() are each set below the five-minute claim
     * lease, and the comment there reasons carefully about a single hung send.
     * It does not hold for a batch: twenty-five messages at the sixty-second
     * socket timeout is twenty-five minutes, five times the lease. Long before
     * the batch finished, its claims would expire, the stale-claim reaper would
     * release the rows, the next drain would pick up the ones already sent, and
     * people would receive the same mail twice — worst on exactly the runs where
     * the provider is struggling, which is when duplicate mail is least welcome.
     *
     * So: stop while there is still lease left to cover the next send, and hand
     * the rest back. They are picked up by the following run two minutes later,
     * which is a delay rather than a duplicate.
     */
    const startedAt = Date.now();
    const LEASE_MS = 5 * 60 * 1000;
    const WORST_CASE_SEND_MS = 60_000 + 20_000;

    /**
     * Re-read before EVERY message, not once before the batch.
     *
     * A single check at the top made the pause take effect only from the next
     * run: a super admin pausing mid-drain still watched up to twenty-five
     * already-claimed messages go out, while the screen told them nothing would
     * be sent. Rechecking costs one indexed read per message and makes the
     * button mean what it says.
     *
     * What it still cannot do is recall an SMTP send already in flight — at
     * most one message. The claim is released rather than failed, so anything
     * held this way is picked up in order when sending resumes.
     */
    for (const item of pending) {
      if (Date.now() - startedAt > LEASE_MS - WORST_CASE_SEND_MS) {
        await ctx.runMutation(internal.emailQueue.releaseClaim, { id: item._id, claimId });
        abandoned++;
        continue;
      }

      const stillRunning = await ctx.runQuery(internal.emailDispatch.dispatchState, {});
      if (stillRunning.paused || process.env.EMAIL_PAUSED) {
        await ctx.runMutation(internal.emailQueue.releaseClaim, { id: item._id, claimId });
        abandoned++;
        continue;
      }

      /**
       * A sign-in link that starts its 24 hours NOW, not when the row was made.
       *
       * The acceptance email carries a link so that acceptance and sign-in are
       * one message. Minting it at conversion meant the clock started while the
       * message was still queued — and with mail paused, or a backlog, it would
       * have been delivered already expired. Substituting here is what makes the
       * promise in the copy ("works for 24 hours") true of the moment it lands.
       */
      let html = item.bodyHtml;
      let text = item.bodyText;

      if (item.userId && html.includes(SIGN_IN_LINK_PLACEHOLDER)) {
        const link = await ctx.runMutation(internal.emailQueue.freshSignInLink, {
          userId: item.userId,
        });
        html = html.split(SIGN_IN_LINK_PLACEHOLDER).join(link);
        text = text.split(SIGN_IN_LINK_PLACEHOLDER).join(link);
      }

      /**
       * The SIWES acceptance letter, built fresh at send time.
       *
       * Built here rather than stored because the letter is a pure function of
       * the application row — storing one would go stale the moment an admin
       * corrected a misspelt institution, which is exactly the correction most
       * likely to happen. `buildForApplication` returns null for anyone who is
       * not SIWES, and null on any failure, so a letter that cannot be built
       * costs the applicant an attachment rather than the acceptance itself.
       */
      let attachment:
        | { filename: string; contentBase64: string; contentType: string }
        | undefined;
      // Whether this row is one a letter SHOULD have been produced for. Null
      // from the builder means "not SIWES", which is a legitimate no-attachment.
      let siwesExpected = false;

      if (item.emailType === 'application_approved' && item.referenceType === 'application' && item.referenceId) {
        const built = await ctx.runAction(internal.letterAttachment.buildForApplication, {
          applicationId: item.referenceId as Id<'applications'>,
        });
        attachment = built ?? undefined;
        siwesExpected = built !== null;
      }

      /**
       * QA, immediately before the handover to SMTP.
       *
       * Checked here rather than at queue time because the two things most
       * likely to be wrong are decided here: the sign-in link is substituted a
       * few lines above, and the letter is built just before this. A message
       * that fails a blocking check is marked failed rather than sent — every
       * one of those failures is a message that would have arrived looking
       * plausible and been acted on, which is worse than not arriving.
       */
      const findings = qaEmail({
        emailType: item.emailType,
        subject: item.subject,
        bodyHtml: asSent(html),
        bodyText: text,
        recipientEmail: item.recipientEmail,
        expectsAttachment: item.emailType === 'application_approved' && Boolean(item.referenceId) && siwesExpected,
        hasAttachment: Boolean(attachment),
      });

      if (qaBlocks(findings)) {
        const detail = findings.filter((f) => f.severity === 'block').map((f) => `${f.code}: ${f.detail}`).join('; ');
        console.error(`email QA blocked ${item._id}: ${detail}`);
        await ctx.runMutation(internal.emailQueue.markFailed, {
          id: item._id,
          claimId,
          error: `QA blocked: ${detail}`,
        });
        failed++;
        continue;
      }

      // Timed so the delivery log can show a provider getting slower before it
      // starts refusing outright — the failure mode that looks like nothing at
      // all until the queue stops draining inside its lease.
      //
      // NOT `startedAt`: that name is taken by the batch's own lease clock
      // above, and shadowing it inside the loop would break the lease check.
      const attemptStartedAt = Date.now();
      try {
        const result = await ctx.runAction(internal.email.sendOne, {
          to: item.recipientEmail,
          subject: item.subject,
          html,
          text,
          attachment,
          emailType: item.emailType,
          messageKey: String(item._id),
        });
        await ctx.runMutation(internal.emailQueue.markSent, {
          id: item._id,
          claimId,
          providerMessageId: result?.messageId,
          durationMs: Date.now() - attemptStartedAt,
        });
        sent++;
      } catch (err) {
        // Recorded rather than thrown: one bad recipient must not stop the
        // rest of the batch. retryCount is bounded in markFailed.
        await ctx.runMutation(internal.emailQueue.markFailed, {
          id: item._id,
          error: err instanceof Error ? err.message : String(err),
          claimId,
          durationMs: Date.now() - attemptStartedAt,
        });
        failed++;
      }
    }

    return { sent, failed, considered: pending.length, abandoned };
  },
});

/**
 * Sends ONE email type, deliberately, while the global hold stays on.
 *
 * `EMAIL_PAUSED` exists so that nothing goes out by accident, and the ordinary
 * drain respects it absolutely. This does not — which is the whole point, and
 * why it is narrow: it is invoked by hand, for a single named type, by someone
 * who has decided that specific batch should go now. Releasing the global hold
 * to achieve the same thing would also release everything else queued behind
 * it, which is exactly the accident the switch was installed to prevent.
 *
 * Every other protection still applies: the same QA runs before each send, a
 * blocked message is failed rather than delivered, and each row is claimed so a
 * second run cannot double-send.
 */
export const drainType = internalAction({
  args: { emailType: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { emailType, limit }): Promise<{ sent: number; failed: number; blocked: number }> => {
    /**
     * One claim id per run, so this run's reports can be told from anyone
     * else's — including a concurrent invocation of this same function.
     */
    const claimId = `drain-${emailType}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const rows = await ctx.runMutation(internal.emailQueue.claimPendingOfType, {
      emailType,
      limit: Math.min(limit ?? 300, 300),
      claimId,
    });

    let sent = 0;
    let failed = 0;
    let blocked = 0;

    for (const row of rows) {
      /**
       * The SAME preparation the cron path does, for the same reasons.
       *
       * This used to QA and send the STORED body. That body still holds
       * `ORBIT_SIGN_IN_LINK_PENDING` where the sign-in link belongs, and it has
       * no letter attached — both are produced here, at send time, deliberately
       * (see processQueue). So a targeted drain of `application_approved` would
       * have delivered an acceptance whose only way in was placeholder text,
       * with the letter a university requires missing. The placeholder rule in
       * QA blocked it, which is the one reason this was caught rather than
       * mailed to 240 people.
       */
      let html = row.bodyHtml;
      let text = row.bodyText;

      if (row.userId && html.includes(SIGN_IN_LINK_PLACEHOLDER)) {
        const link = await ctx.runMutation(internal.emailQueue.freshSignInLink, {
          userId: row.userId as Id<'users'>,
        });
        html = html.split(SIGN_IN_LINK_PLACEHOLDER).join(link);
        text = text.split(SIGN_IN_LINK_PLACEHOLDER).join(link);
      }

      let attachment:
        | { filename: string; contentBase64: string; contentType: string }
        | undefined;
      let siwesExpected = false;

      if (row.emailType === 'application_approved' && row.referenceType === 'application' && row.referenceId) {
        const built = await ctx.runAction(internal.letterAttachment.buildForApplication, {
          applicationId: row.referenceId as Id<'applications'>,
        });
        attachment = built ?? undefined;
        siwesExpected = built !== null;
      }

      const findings = qaEmail({
        emailType: row.emailType,
        subject: row.subject,
        bodyHtml: asSent(html),
        bodyText: text,
        recipientEmail: row.recipientEmail,
        expectsAttachment: siwesExpected,
        hasAttachment: Boolean(attachment),
      });

      if (qaBlocks(findings)) {
        const detail = findings.filter((f) => f.severity === 'block').map((f) => `${f.code}: ${f.detail}`).join('; ');
        await ctx.runMutation(internal.emailQueue.markFailedDirect, {
          id: row.id,
          claimId,
          error: `QA blocked: ${detail}`,
        });
        blocked++;
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await ctx.runAction(internal.email.sendOne, {
          to: row.recipientEmail,
          subject: row.subject,
          html,
          text,
          attachment,
          emailType: row.emailType,
          messageKey: row.id,
        });
        await ctx.runMutation(internal.emailQueue.markSentDirect, {
          id: row.id,
          claimId,
          providerMessageId: result?.messageId,
          durationMs: Date.now() - startedAt,
        });
        sent++;
      } catch (error) {
        await ctx.runMutation(internal.emailQueue.markFailedDirect, {
          id: row.id,
          claimId,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
        failed++;
      }
    }

    return { sent, failed, blocked };
  },
});
