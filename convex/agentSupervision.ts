import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { agentAccount } from './lib/agent';
import { AGENT_ERA_START } from './lib/agentFallback';

/**
 * LOGBOOK SUPERVISION WITHOUT A SUPERVISOR.
 *
 * On 2026-09-29 production held 180 submitted daily logs and 27 weekly
 * summaries, and not one had ever been reviewed. A SIWES logbook with no
 * supervisor's approval is useless to the student at the end of placement,
 * and the platform no longer has supervisors to give one. So:
 *
 *   - Daily logs are read by the agent's two reviewers (scripts/agent/logbook.py)
 *     and recorded with `applyLogReview`. Approve is the default; a request for
 *     changes needs BOTH reviewers to say the entry does not describe real work,
 *     and it is reversible — the intern edits and resubmits.
 *   - Weekly summaries are signed off by rule in `settleLogbook`: once none of
 *     that week's daily logs is still waiting, the week is signed off.
 *   - Anything the runner split on, or never reached, is approved by
 *     `settleLogbook` on a timer, so nothing waits on a person.
 *
 * Every decision names the ORBIT Agent as reviewer or signatory, and every
 * message to the intern says the agent made it.
 */

const SETTLE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 100;
// Bounded well under the 16 MiB read limit: a log carries up to ~25 KB of text.
const LOG_WINDOW = 300;

/** Today's date in Lagos (UTC+1, no DST), as the YYYY-MM-DD the logbook stores. */
function lagosToday(now: number): string {
  return new Date(now + 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Daily logs awaiting review that the agent has not tried in this form. */
export const pendingLogsForReview = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(
      v.object({
        logId: v.string(),
        logDate: v.string(),
        title: v.string(),
        workDone: v.string(),
        learned: v.string(),
        toolsUsed: v.string(),
        challenges: v.string(),
        nextSteps: v.string(),
        hoursSpent: v.union(v.number(), v.null()),
        updatedAt: v.number(),
      }),
    ),
    queueDepth: v.number(),
  }),
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const submitted = await ctx.db
      .query('dailyLogs')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(LOG_WINDOW);
    const due = submitted.filter((l) => {
      const r = l.agentReview;
      if (!r || l.updatedAt > r.at) return true;
      return r.outcome === 'no-quorum' && now - r.at > 6 * 60 * 60 * 1000;
    });
    const rows = due.slice(0, Math.max(1, Math.min(limit ?? 20, 60))).map((l) => ({
      logId: String(l._id),
      logDate: l.logDate,
      title: l.title.slice(0, 300),
      workDone: l.workDone.slice(0, 4000),
      learned: (l.learned ?? '').slice(0, 2000),
      toolsUsed: (l.toolsUsed ?? '').slice(0, 1000),
      challenges: (l.challenges ?? '').slice(0, 2000),
      nextSteps: (l.nextSteps ?? '').slice(0, 1000),
      hoursSpent: l.hoursSpent ?? null,
      updatedAt: l.updatedAt,
    }));
    return { rows, queueDepth: due.length };
  },
});

/**
 * In-app only for a routine approval; email only when the intern has something
 * to DO. Each `notifySiwes` call also queues an email, and the backlog alone
 * was 180 logs — one email per approved log, per intern, is the fastest way to
 * teach people to filter ORBIT's mail, after which the messages that do need
 * action stop landing too.
 */
async function tellIntern(
  ctx: MutationCtx,
  userId: Doc<'users'>['_id'],
  type: string,
  title: string,
  content: string,
  email: boolean,
) {
  if (email) {
    await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
      userId, type, title, content, actionUrl: '/logbook',
    });
    return;
  }
  const user = await ctx.db.get(userId);
  if (!user || !user.isActive || user.isDeleted) return;
  await ctx.db.insert('notifications', {
    userId, type, title, content, actionUrl: '/logbook',
    isRead: false, isDummy: false, createdAt: Date.now(),
  });
}

async function decideLog(
  ctx: MutationCtx,
  log: Doc<'dailyLogs'>,
  agent: Doc<'users'>,
  status: 'approved' | 'changes_requested',
  comment: string,
) {
  const now = Date.now();
  await ctx.db.patch(log._id, {
    status,
    reviewedBy: agent._id,
    reviewedAt: now,
    supervisorComment: comment,
    updatedAt: now,
  });
  if (status === 'approved') {
    await tellIntern(ctx, log.userId, 'logbook_approved', 'Daily log approved',
      `Your daily log for ${log.logDate} was approved by the ORBIT Agent.`, false);
  } else {
    await tellIntern(ctx, log.userId, 'logbook_changes_requested', 'Changes requested on your daily log',
      `The ORBIT Agent asked for changes to your daily log for ${log.logDate}: ${comment}`, true);
  }
}

/** Records the runner's verdict on one daily log. */
export const applyLogReview = internalMutation({
  args: {
    logId: v.id('dailyLogs'),
    verdict: v.union(
      v.literal('approve'),
      v.literal('changes'),
      v.literal('contested'),
      v.literal('no-quorum'),
    ),
    comment: v.optional(v.string()),
    expectUpdatedAt: v.optional(v.number()),
  },
  returns: v.object({ applied: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { logId, verdict, comment, expectUpdatedAt }) => {
    const log = await ctx.db.get(logId);
    if (!log || log.status !== 'submitted') return { applied: false, reason: 'not submitted' };
    if (expectUpdatedAt !== undefined && log.updatedAt !== expectUpdatedAt) {
      return { applied: false, reason: 'edited while it was being reviewed' };
    }
    const agent = await agentAccount(ctx);
    if (!agent) return { applied: false, reason: 'ORBIT Agent account not found' };

    if (verdict === 'approve') {
      await decideLog(ctx, log, agent, 'approved', (comment ?? '').slice(0, 1000));
      return { applied: true };
    }
    if (verdict === 'changes') {
      const why = (comment ?? '').trim() || 'Please describe the work you did that day in more detail.';
      await decideLog(ctx, log, agent, 'changes_requested', why.slice(0, 1000));
      return { applied: true };
    }
    const now = Date.now();
    const same = log.agentReview !== undefined && log.updatedAt <= log.agentReview.at;
    const firstAt = same && log.agentReview?.firstAt !== undefined
      ? log.agentReview.firstAt
      : verdict === 'contested' ? now : undefined;
    await ctx.db.patch(logId, {
      agentReview: { outcome: verdict, at: now, ...(firstAt !== undefined ? { firstAt } : {}) },
    });
    return { applied: true };
  },
});

function summaryHasContent(s: Doc<'weeklySummaries'>): boolean {
  return `${s.goals ?? ''}${s.summary ?? ''}${s.keyLearnings ?? ''}`.replace(/\s+/g, '').length >= 40;
}

/**
 * The timer half: settles what the runner split on or never reached, and signs
 * off every week whose daily logs are all settled. Six-hourly.
 */
export const settleLogbook = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    logsApproved: v.number(),
    weeksSignedOff: v.number(),
    weeksReturned: v.number(),
    dryRun: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { dryRun }) => {
    const result = { logsApproved: 0, weeksSignedOff: 0, weeksReturned: 0, dryRun: Boolean(dryRun) };
    const agent = await agentAccount(ctx);
    if (!agent) return { ...result, error: 'ORBIT Agent account not found' };
    const now = Date.now();

    // 1. Daily logs: split verdicts after five days; anything after two weeks.
    const logs = await ctx.db
      .query('dailyLogs')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(LOG_WINDOW);
    for (const log of logs) {
      if (result.logsApproved >= SWEEP_BATCH) break;
      const r = log.agentReview;
      const submitted = log.submittedAt ?? log.createdAt;
      const contestedDue = r?.outcome === 'contested' && r.firstAt !== undefined && now - r.firstAt > SETTLE_AFTER_MS;
      const absoluteDue = now - Math.max(submitted, AGENT_ERA_START) > ABSOLUTE_MS;
      if (!contestedDue && !absoluteDue) continue;
      if (!dryRun) {
        await decideLog(
          ctx, log, agent, 'approved',
          'Approved automatically by the ORBIT Agent after the review window; it was not individually assessed.',
        );
      }
      result.logsApproved++;
    }

    // 2. Weekly summaries: sign off once no daily log in that week is waiting.
    const summaries = await ctx.db
      .query('weeklySummaries')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .take(500);
    for (const s of summaries) {
      if (result.weeksSignedOff + result.weeksReturned >= SWEEP_BATCH) break;

      if (!summaryHasContent(s)) {
        if (!dryRun) {
          const comment = 'Please add what you worked on and learned this week before it can be signed off.';
          await ctx.db.patch(s._id, { status: 'changes_requested', supervisorComment: comment, updatedAt: now });
          await tellIntern(ctx, s.userId, 'logbook_changes_requested',
            'Changes requested on your weekly summary',
            `The ORBIT Agent returned your weekly summary (${s.weekStart} to ${s.weekEnd}): ${comment}`, true);
        }
        result.weeksReturned++;
        continue;
      }

      const week = await ctx.db
        .query('dailyLogs')
        .withIndex('by_user_and_date', (q) =>
          q.eq('userId', s.userId).gte('logDate', s.weekStart).lte('logDate', s.weekEnd),
        )
        .collect();
      /**
       * What a supervisor would actually sign, not merely "nothing pending":
       *  - the week is OVER (a Thursday summary is not signed before Friday's
       *    log can exist);
       *  - at least one daily log in it was APPROVED — a week with no logs, or
       *    only drafts, is not a week of evidence, and this logbook goes to the
       *    student's institution;
       *  - nothing in it is waiting or was sent back, unless the week is two
       *    weeks overdue, when a returned log the intern never fixed should not
       *    hold the rest of the week hostage.
       * A week with no approved log is never signed off by a timer.
       */
      const weekOver = s.weekEnd < lagosToday(now);
      const approved = week.some((l) => l.status === 'approved');
      const unsettled = week.some((l) => l.status === 'submitted' || l.status === 'changes_requested');
      const submitted = s.submittedAt ?? s.createdAt;
      const overdue = now - Math.max(submitted, AGENT_ERA_START) > ABSOLUTE_MS;
      if (!weekOver || !approved || (unsettled && !overdue)) continue;

      if (!dryRun) {
        await ctx.db.patch(s._id, {
          status: 'signed_off',
          signedOffBy: agent._id,
          signedOffAt: now,
          updatedAt: now,
        });
        await tellIntern(ctx, s.userId, 'weekly_summary_signed_off', 'Weekly summary signed off',
          `Your weekly summary (${s.weekStart} to ${s.weekEnd}) was signed off by the ORBIT Agent.`, false);
      }
      result.weeksSignedOff++;
    }

    return result;
  },
});
