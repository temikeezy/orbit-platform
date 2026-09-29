import { internalAction, internalMutation, internalQuery } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { v, type Infer } from 'convex/values';
import { escapeHtml } from './lib/html';
import { appUrl } from './lib/appUrl';
import { agentEmail } from './lib/org';
import type { Id } from './_generated/dataModel';
import {
  taskLooksBroken,
  evidenceLooksUnreadable,
  OUTLIER_MEAN,
} from './lib/markAnomaly';
import { withdrawMark } from './tasks';

type AssessedMark = { taskId: string; title: string; source: string; fraction: number };
type MarkPage = { marks: AssessedMark[]; isDone: boolean; continueCursor: string };
type Bucket = { n: number; sum: number };

const outlierResult = v.object({
  flagged: v.array(v.object({
    kind: v.string(), key: v.string(), label: v.string(), count: v.number(),
    meanFraction: v.number(), detail: v.string(),
  })),
  assessedTotal: v.number(),
});

export const assessedMarkPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<MarkPage> => {
    const page = await ctx.db.query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'approved'))
      .paginate({ numItems: 100, cursor, maximumBytesRead: 2 * 1024 * 1024 });
    const marks: AssessedMark[] = [];
    for (const r of page.page) {
      // Only the agent's own marks. A supervisor's judgement is not an anomaly.
      if (r.reviewedBy !== undefined || r.score === undefined || r.score === null) continue;
      const task = await ctx.db.get(r.taskId);
      if (!task?.points) continue;
      marks.push({
        taskId: String(r.taskId), title: task.title, fraction: r.score / task.points,
        source: r.submissionFileId ? 'file' : r.submissionFileUrl
          ? (r.submissionFileUrl.split('/')[2] ?? 'link') : 'text',
      });
    }
    return { marks, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

async function markBuckets(ctx: ActionCtx) {
  const byTask = new Map<string, Bucket & { title: string }>();
  const byEvidence = new Map<string, Bucket>();
  let assessed = 0;
  let sum = 0;
  let cursor: string | null = null;
  // Each page needs its own query: pagination inside one transaction still
  // shares the 16 MB read ceiling, even when the individual pages are small.
  for (;;) {
    const page: MarkPage = await ctx.runQuery(internal.agentOps.assessedMarkPage, { cursor });
    for (const mark of page.marks) {
      assessed++;
      sum += mark.fraction;
      const task = byTask.get(mark.taskId) ?? { n: 0, sum: 0, title: mark.title };
      byTask.set(mark.taskId, { n: task.n + 1, sum: task.sum + mark.fraction, title: mark.title });
      const evidence = byEvidence.get(mark.source) ?? { n: 0, sum: 0 };
      byEvidence.set(mark.source, { n: evidence.n + 1, sum: evidence.sum + mark.fraction });
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { byTask, byEvidence, assessed, sum };
}

/**
 * The ORBIT agent's unattended upkeep.
 *
 * WHAT BELONGS HERE. Work that can be decided from data already in Convex:
 * counting, comparing, nudging, publishing something already drafted. These run
 * on a schedule with nobody watching, so each one is written to do the smallest
 * defensible thing and to say what it did.
 *
 * WHAT DELIBERATELY DOES NOT. Anything needing judgement about the CONTENT of a
 * submission — reading a document, scoring work, answering a question in prose.
 * Convex has no model to call and no way to open a PDF; the assessment that
 * marked 500 submissions ran outside this deployment entirely. Pretending that
 * half is automated here would hide where the dependency actually is.
 */

/**
 * Looks for marks that are wrong rather than merely low.
 *
 * THIS IS THE CHECK THAT WAS MISSING. Twelve interns were marked at an average
 * of 8% on one task — not because the work was poor, but because they had
 * submitted Google Docs links the assessor could not open, so it marked the
 * sign-in page it saw instead. Nothing errored. The scores were confident, the
 * feedback was fluent and specific, and every one of them was wrong.
 *
 * No assertion catches that, because the output was plausible. What gave it
 * away was the DISTRIBUTION: one task where everybody failed identically, and
 * one evidence type whose mean sat at 8% against 59% for every other. So that
 * is what this measures.
 *
 * Detection only; `respondToMarkOutliers` below acts on it — and acts in the
 * one direction that cannot hurt an intern: a flagged low mark is withdrawn
 * and set aside for settlement at full points, never lowered further.
 */
export const detectMarkOutliers = internalAction({
  args: {},
  returns: outlierResult,
  handler: async (ctx): Promise<Infer<typeof outlierResult>> => {
    const { byTask, byEvidence, assessed } = await markBuckets(ctx);

    const flagged = [];

    for (const [taskId, v2] of byTask) {
      const mean = v2.sum / v2.n;
      if (!taskLooksBroken({ label: v2.title, n: v2.n, mean })) continue;
      flagged.push({
        kind: 'task',
        key: taskId,
        label: v2.title,
        count: v2.n,
        meanFraction: Math.round(mean * 100) / 100,
        detail:
          `Every submission for this task scored near zero. A whole cohort failing one ` +
          `task identically is more often a broken brief or an unreadable submission ` +
          `format than ${v2.n} people failing the same way.`,
      });
    }

    // An evidence source far below the rest is the shape the Google failure had.
    const overall = [...byEvidence.values()].reduce(
      (a, b) => ({ n: a.n + b.n, sum: a.sum + b.sum }),
      { n: 0, sum: 0 },
    );

    for (const [host, b] of byEvidence) {
      const mean = b.sum / b.n;
      // Leave-one-out: the baseline is every mark that is NOT from this source.
      // Including it lets a systemic failure drag the threshold below itself.
      const othersN = overall.n - b.n;
      const others = { n: othersN, mean: othersN > 0 ? (overall.sum - b.sum) / othersN : 0 };
      if (!evidenceLooksUnreadable({ label: host, n: b.n, mean }, others)) continue;
      flagged.push({
        kind: 'evidence',
        key: host,
        label: host,
        count: b.n,
        meanFraction: Math.round(mean * 100) / 100,
        detail:
          `Submissions from this source average ${Math.round(mean * 100)}% against ` +
          `${Math.round(others.mean * 100)}% everywhere else. That gap usually means the ` +
          `assessor could not read them rather than that the work was worse.`,
      });
    }

    return { flagged, assessedTotal: assessed };
  },
});

/**
 * Withdraws the low automatic marks in one flagged group and sets them aside.
 *
 * WHY ACTING IS NOW RIGHT when it was once refused. The objection was that
 * withdrawing on a statistical hunch repeats the original mistake in reverse.
 * That held while a person existed to open a submission and decide; there is
 * no longer one. And the action is asymmetric by construction: only marks at
 * or below the broken-task threshold are touched, they are withdrawn in full
 * (points reversed through the same ledger path as any withdrawal), and the
 * row is recorded as `anomaly`, which the settlement pays IN FULL after the
 * window. The worst this can do to an intern is replace a low mark with full
 * marks a few days later — which is also exactly what should have happened to
 * the twelve interns of 2026-09-07.
 *
 * Only the agent's own marks: `withdrawMark` refuses anything a person reviewed.
 */
export const setAsideOutlierGroup = internalMutation({
  args: { kind: v.string(), key: v.string() },
  returns: v.object({ withdrawn: v.number(), pointsReversed: v.number() }),
  handler: async (ctx, { kind, key }) => {
    const rows =
      kind === 'task'
        ? (await ctx.db
            .query('submissions')
            .withIndex('by_task', (q) => q.eq('taskId', key as Id<'tasks'>))
            .collect()).filter((r) => r.status === 'approved')
        : await ctx.db
            .query('submissions')
            .withIndex('by_status', (q) => q.eq('status', 'approved'))
            .take(1500);

    let withdrawn = 0;
    let pointsReversed = 0;
    for (const r of rows) {
      if (r.reviewedBy !== undefined || r.score === undefined || r.score === null) continue;
      const task = await ctx.db.get(r.taskId);
      if (!task?.points || r.score / task.points > OUTLIER_MEAN) continue;
      if (kind === 'evidence') {
        const source = r.submissionFileId ? 'file'
          : r.submissionFileUrl ? (r.submissionFileUrl.split('/')[2] ?? 'link') : 'text';
        if (source !== key) continue;
      }
      const res = await withdrawMark(ctx, r._id, `marking anomaly (${kind}: ${key})`);
      if (!res.withdrawn) continue;
      const now = Date.now();
      // `at` equal to the withdrawal's `updatedAt`, so the marker does not pick
      // it straight back up and mark it low again; a resubmission still would.
      const fresh = await ctx.db.get(r._id);
      await ctx.db.patch(r._id, {
        agentAssessment: {
          outcome: 'anomaly',
          at: Math.max(now, fresh?.updatedAt ?? now),
          attempts: (r.agentAssessment?.attempts ?? 0) + 1,
          detail: `withdrawn after a ${kind} anomaly on ${key}`,
        },
      });
      withdrawn++;
      pointsReversed += res.pointsReversed;
    }
    return { withdrawn, pointsReversed };
  },
});

/** Detects outliers and withdraws the low marks behind each one. */
export const respondToMarkOutliers = internalAction({
  args: {},
  returns: v.object({ flagged: v.number(), withdrawn: v.number(), queued: v.number() }),
  handler: async (ctx): Promise<{ flagged: number; withdrawn: number; queued: number }> => {
    const result = await ctx.runAction(internal.agentOps.detectMarkOutliers, {});
    if (result.flagged.length === 0) return { flagged: 0, withdrawn: 0, queued: 0 };
    let withdrawn = 0;
    for (const f of result.flagged) {
      const r = await ctx.runMutation(internal.agentOps.setAsideOutlierGroup, { kind: f.kind, key: f.key });
      withdrawn += r.withdrawn;
    }
    // Still told, so the record of what the agent did reaches a human inbox
    // if anyone is reading one — but nothing waits on it.
    const { queued } = withdrawn > 0
      ? await ctx.runMutation(internal.agentOps.queueMarkOutlierReport, { result, withdrawn })
      : { queued: 0 };
    return { flagged: result.flagged.length, withdrawn, queued };
  },
});

/**
 * Tells admins when the marking looks wrong, and says nothing when it does not.
 *
 * A weekly report that always arrives is a weekly report nobody opens. This
 * sends only on a flag, so an email from it means something specific happened.
 */
export const reportMarkOutliers = internalAction({
  args: {},
  returns: v.object({ flagged: v.number(), queued: v.number() }),
  handler: async (ctx): Promise<{ flagged: number; queued: number }> => {
    const result = await ctx.runAction(internal.agentOps.detectMarkOutliers, {});
    if (result.flagged.length === 0) return { flagged: 0, queued: 0 };
    return ctx.runMutation(internal.agentOps.queueMarkOutlierReport, { result });
  },
});

export const queueMarkOutlierReport = internalMutation({
  args: { result: outlierResult, withdrawn: v.optional(v.number()) },
  returns: v.object({ flagged: v.number(), queued: v.number() }),
  handler: async (ctx, { result, withdrawn }): Promise<{ flagged: number; queued: number }> => {
    const rowsHtml = result.flagged
      .map(
        (f: { kind: string; label: string; count: number; meanFraction: number; detail: string }) =>
          `<li><strong>${escapeHtml(f.label)}</strong> (${f.kind}) — ` +
          `${f.count} marks averaging ${Math.round(f.meanFraction * 100)}%.<br>` +
          `<span style="color:#555">${escapeHtml(f.detail)}</span></li>`,
      )
      .join('');
    const rowsText = result.flagged
      .map(
        (f: { kind: string; label: string; count: number; meanFraction: number; detail: string }) =>
          `${f.label} (${f.kind}) — ${f.count} marks averaging ` +
          `${Math.round(f.meanFraction * 100)}%.\n  ${f.detail}`,
      )
      .join('\n\n');

    /**
     * Every user, not a prefix.
     *
     * `take(500)` then filter reads the FIRST 500 users and looks for admins
     * among them — so once the cohort outgrows that, an anomaly report finds
     * nobody and returns `queued: 0` while administrators plainly exist. A
     * report that goes nowhere is the same as no report, except it looks fine.
     */
    const agent = agentEmail();
    const admins = [];
    // Streamed, not paginated: Convex allows ONE paginated query per function,
    // so a page loop threw as soon as the users table passed one page (prod
    // passed 200 users before this report ever fired). The agent is an admin
    // too, but it is the report's author, not an audience for it.
    for await (const u of ctx.db.query('users')) {
      if (!u.isActive || u.isDeleted || !u.email || u.email === agent) continue;
      if (u.roles.some((r) => r === 'admin' || r === 'super_admin')) admins.push(u);
    }

    let queued = 0;
    for (const a of admins) {
      await ctx.db.insert('emailQueue', {
        userId: a._id,
        emailType: 'mark_anomaly',
        recipientEmail: a.email!,
        subject: `Marking looks wrong in ${result.flagged.length} place${result.flagged.length === 1 ? '' : 's'}`,
        bodyHtml:
          `<p>Hi ${escapeHtml(a.fullName ?? 'there')},</p>` +
          `<p>The agent marked ${result.assessedTotal} submissions. These ` +
          `${result.flagged.length} group${result.flagged.length === 1 ? '' : 's'} do not look ` +
          `like harsh marking — they look like the assessor could not read the work:</p>` +
          `<ul>${rowsHtml}</ul>` +
          (withdrawn
            ? `<p>Already handled: ${withdrawn} low automatic mark${withdrawn === 1 ? '' : 's'} ` +
              `in these groups were withdrawn and set aside; they settle at full points after ` +
              `the review window. Nothing needs doing.</p>`
            : `<p>Nothing has been changed.</p>`) +
          `<p>— ORBIT Agent</p>`,
        bodyText:
          `The agent marked ${result.assessedTotal} submissions. ` +
          `${result.flagged.length} group(s) look unreadable rather than poor:\n\n${rowsText}\n\n` +
          (withdrawn
            ? `Already handled: ${withdrawn} low automatic mark(s) withdrawn and set aside.`
            : `Nothing has been changed.`) +
          `\n\n— ORBIT Agent`,
        isDummy: false,
        status: 'pending',
        retryCount: 0,
        createdAt: Date.now(),
      });
      queued++;
    }
    return { flagged: result.flagged.length, queued };
  },
});

/**
 * Link shapes that routinely serve a sign-in page instead of the work.
 *
 * NOT a blocklist of bad services — a list of URLs whose CONTENT the platform
 * cannot see. A Google Doc set to "restricted" returns HTTP 200 with a login
 * shell, so anything reading it gets a page of markup and no work. That is
 * precisely how twelve interns came to be marked at 8%: the assessor read the
 * sign-in page, found no evidence of the task, and said so confidently.
 */
const OPAQUE_HOSTS = ['docs.google.com', 'drive.google.com', 'sheets.google.com'];

/**
 * Whether a submission URL points at one of those hosts.
 *
 * Compares the HOSTNAME, not the whole string. `url.includes('docs.google.com')`
 * also matches `https://example.com/notes/docs.google.com-guide`, and would have
 * told that intern their own page was a Google sign-in screen.
 */
function hasOpaqueHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return OPAQUE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** How long before the same submission may be chased again. */
const RECHASE_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Asks interns to reshare work nobody can open.
 *
 * Runs BEFORE assessment rather than after, which is the whole point. Marking
 * an unreadable submission produces a confident wrong number that then has to
 * be found and withdrawn; asking first costs one message.
 *
 * Deliberately narrow. It only chases links whose host is known to gate on
 * sign-in AND which nobody has marked yet — a supervisor who could open it and
 * scored it is evidence the link is fine, whatever this list thinks.
 */
export const chaseUnreadableSubmissions = internalMutation({
  args: {
    limit: v.optional(v.number()), dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    chased: v.number(), skipped: v.number(), dryRun: v.boolean(),
    isDone: v.boolean(), continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 40), 100));
    const dryRun = args.dryRun === true;
    const now = Date.now();

    const pending = await ctx.db
      .query('submissions')
      // Never-prompted rows come first, so repeat nudges cannot keep spending
      // the daily budget before a growing backlog's newer links are reached.
      .withIndex('by_status_and_reshare_prompted', (q) => q.eq('status', 'submitted'))
      // A page cannot exceed the remaining nudge budget, or its unprocessed
      // tail would be lost when continuing from the page's cursor.
      .paginate({ numItems: limit, cursor: args.cursor ?? null, maximumBytesRead: 2 * 1024 * 1024 });

    let chased = 0;
    let skipped = 0;

    for (const sub of pending.page) {
      const url = sub.submissionFileUrl;
      if (!url) continue;
      if (!hasOpaqueHost(url)) continue;
      if (sub.resharePromptedAt && now - sub.resharePromptedAt < RECHASE_MS) {
        skipped++;
        continue;
      }

      const user = await ctx.db.get(sub.userId);
      if (!user || !user.isActive || user.isDeleted) continue;
      const task = await ctx.db.get(sub.taskId);
      if (!task) continue;

      if (dryRun) {
        chased++;
        continue;
      }

      await ctx.db.insert('notifications', {
        userId: sub.userId,
        type: 'submission_unreadable',
        title: 'We cannot open your submission',
        /**
         * Says what was done and what to check — it does NOT assert the link is
         * broken. Nothing here fetches the URL, so "this opens a sign-in page"
         * would be a claim about something never tested, and wrong for every
         * intern who had already shared the file correctly.
         */
        content:
          `We could not confirm that your link for "${task.title}" is readable without ` +
          `signing in, and a link only you can open cannot be marked. Please open the ` +
          `file, choose Share, set "General access" to "Anyone with the link", and check ` +
          `it. If it is already shared that way, no action is needed — your work is safe ` +
          `either way, this is only a sharing setting.`,
        actionUrl: `/tasks/${sub.taskId}`,
        relatedTaskId: sub.taskId,
        isRead: false,
        isDummy: false,
        createdAt: now,
      });

      await ctx.db.patch(sub._id, { resharePromptedAt: now });
      chased++;
    }

    // Filtered-out rows must not strand newer links behind a fixed prefix.
    // Scheduling also gives the next page a fresh transaction read budget.
    if (!dryRun && !pending.isDone && chased < limit) {
      await ctx.scheduler.runAfter(0, internal.agentOps.chaseUnreadableSubmissions, {
        cursor: pending.continueCursor, limit: limit - chased, dryRun: false,
      });
    }

    /**
     * A single page. For the WHOLE picture, use `chaseUnreadableDryRun`.
     *
     * An earlier version walked the remaining pages inline from here, on the
     * belief that each `ctx.runQuery` got its own read budget. It does not:
     * inside a mutation, `runQuery` runs "within the same transaction", so
     * forty page reads shared one budget and would have thrown past roughly
     * 4,000 documents — while the comment invited a future editor to raise the
     * cap. Only an ACTION gets a fresh transaction per query.
     */
    return { chased, skipped, dryRun, isDone: pending.isDone, continueCursor: pending.continueCursor };
  },
});

/**
 * One page of the reshare chase, counted but never sent.
 *
 * Its own query so the dry run can walk the whole table a page at a time
 * without any single transaction carrying the read budget for all of it.
 */
export const chasePageDryRun = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    chased: v.number(),
    skipped: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db
      .query('submissions')
      .withIndex('by_status_and_reshare_prompted', (q) => q.eq('status', 'submitted'))
      .paginate({ numItems: 100, cursor, maximumBytesRead: 2 * 1024 * 1024 });

    let chased = 0;
    let skipped = 0;
    for (const sub of page.page) {
      const url = sub.submissionFileUrl;
      if (!url || !hasOpaqueHost(url)) continue;
      if (sub.resharePromptedAt && now - sub.resharePromptedAt < RECHASE_MS) {
        skipped++;
        continue;
      }
      /**
       * The same guards the real run applies, or the estimate is not an
       * estimate of anything. Without these the dry run counted nudges that
       * would never be sent — to deleted accounts and vanished tasks — and
       * disagreed with its own first page, which does check them. A blast
       * radius that overstates itself is the one number this function exists
       * to get right.
       */
      const user = await ctx.db.get(sub.userId);
      if (!user || !user.isActive || user.isDeleted) continue;
      if (!(await ctx.db.get(sub.taskId))) continue;
      chased++;
    }
    return { chased, skipped, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * The reshare chase, counted across every page and never sent.
 *
 * An ACTION, deliberately. Each `ctx.runQuery` from an action is its own read
 * transaction with its own budget, which is the property the inline mutation
 * loop wrongly assumed it had. This is the entry point for "how many would you
 * chase?"; the mutation's own `dryRun` answers only for its first page.
 */
export const chaseUnreadableDryRun = internalAction({
  args: {},
  returns: v.object({ chased: v.number(), skipped: v.number(), isDone: v.boolean(), pages: v.number() }),
  handler: async (ctx): Promise<{ chased: number; skipped: number; isDone: boolean; pages: number }> => {
    let chased = 0;
    let skipped = 0;
    let cursor: string | null = null;
    let pages = 0;

    // Bounded so a runaway cursor cannot spin forever; `isDone` reports
    // honestly whether the walk actually finished.
    for (; pages < 200; pages++) {
      const page: { chased: number; skipped: number; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.agentOps.chasePageDryRun, { cursor });
      chased += page.chased;
      skipped += page.skipped;
      cursor = page.continueCursor;
      if (page.isDone) return { chased, skipped, isDone: true, pages: pages + 1 };
    }
    return { chased, skipped, isDone: false, pages };
  },
});

/**
 * Tells each supervisor what is waiting for them, and nobody else.
 *
 * Sends only to moderators with a non-empty queue. A reminder that arrives when
 * there is nothing to do teaches people the reminder is noise, and the next one
 * — the one that mattered — goes unread with the rest.
 */
export const remindReviewers = internalMutation({
  args: {},
  returns: v.object({ queued: v.number(), pendingTotal: v.number() }),
  handler: async (ctx) => {
    const pending = await ctx.db
      .query('submissions')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(1000);

    // stream -> how many of its submissions are unreviewed
    const byStream = new Map<string, { id: Id<'streams'>; count: number }>();
    for (const sub of pending) {
      const task = await ctx.db.get(sub.taskId);
      if (!task) continue;
      const k = String(task.streamId);
      const cur = byStream.get(k);
      byStream.set(k, { id: task.streamId, count: (cur?.count ?? 0) + 1 });
    }
    if (byStream.size === 0) return { queued: 0, pendingTotal: 0 };

    const perReviewer = new Map<string, { name: string; count: number }[]>();
    for (const [, entry] of byStream) {
      const stream = await ctx.db.get(entry.id);
      if (!stream || !stream.isActive) continue;
      const grants = await ctx.db
        .query('streamModerators')
        .withIndex('by_stream', (q) => q.eq('streamId', stream._id))
        .collect();
      for (const g of grants) {
        const k = String(g.userId);
        if (!perReviewer.has(k)) perReviewer.set(k, []);
        perReviewer.get(k)!.push({ name: stream.name, count: entry.count });
      }
    }

    const now = Date.now();
    let queued = 0;

    for (const [userKey, streams] of perReviewer) {
      const reviewer = await ctx.db.get(userKey as Id<'users'>);
      if (!reviewer || !reviewer.email || reviewer.isDeleted || !reviewer.isActive) continue;

      const total = streams.reduce((n, s) => n + s.count, 0);
      const items = streams
        .sort((a, b) => b.count - a.count)
        .map((s) => `<li>${escapeHtml(s.name)} — ${s.count}</li>`)
        .join('');
      const itemsText = streams.map((s) => `  ${s.name} — ${s.count}`).join('\n');

      await ctx.db.insert('emailQueue', {
        userId: reviewer._id,
        emailType: 'review_reminder',
        recipientEmail: reviewer.email,
        subject: `${total} submission${total === 1 ? '' : 's'} waiting for you on ORBIT`,
        bodyHtml:
          `<p>Hi ${escapeHtml(reviewer.fullName ?? 'there')},</p>` +
          `<p>Work your interns submitted is still unmarked:</p><ul>${items}</ul>` +
          `<p>Nothing marks these but you. The agent can chase a broken link and flag a ` +
          `score that looks wrong, but it cannot tell your intern whether the work was ` +
          `any good — and that is the only part they will remember.</p>` +
          `<p><a href="${appUrl()}/review">Open the review queue</a></p>` +
          `<p>— ORBIT Agent</p>`,
        bodyText:
          `Work your interns submitted is still unmarked:\n${itemsText}\n\n` +
          `Nothing marks these but you. The agent cannot judge whether the work was good.\n` +
          `${appUrl()}/review\n\n— ORBIT Agent`,
        status: 'pending',
        isDummy: false,
        retryCount: 0,
        createdAt: now,
      });
      queued++;
    }

    return { queued, pendingTotal: pending.length };
  },
});

/**
 * The raw distribution the detector reasons over.
 *
 * Exists because "flagged: []" is the same answer whether the marking is sound
 * or the query is broken, and one of those is worth knowing about. This returns
 * the buckets themselves so the thresholds can be checked against real numbers
 * rather than trusted.
 */
export const markDistribution = internalAction({
  args: {},
  returns: v.object({
    overallMean: v.number(),
    byEvidence: v.array(v.object({ source: v.string(), n: v.number(), mean: v.number() })),
    worstTasks: v.array(v.object({ title: v.string(), n: v.number(), mean: v.number() })),
  }),
  handler: async (ctx) => {
    const { byEvidence: ev, byTask: tk, assessed: n, sum } = await markBuckets(ctx);

    return {
      overallMean: n ? Math.round((sum / n) * 100) / 100 : 0,
      byEvidence: [...ev.entries()]
        .map(([source, b]) => ({ source, n: b.n, mean: Math.round((b.sum / b.n) * 100) / 100 }))
        .sort((a, b) => a.mean - b.mean),
      worstTasks: [...tk.values()]
        .map((b) => ({ title: b.title, n: b.n, mean: Math.round((b.sum / b.n) * 100) / 100 }))
        .sort((a, b) => a.mean - b.mean)
        .slice(0, 6),
    };
  },
});
