import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { agentAccount } from './lib/agent';
import { seedTasksFor } from './lib/taskSeed';
import { suggestPoints } from './lib/taskComplexity';
import { taskProgrammeDecision } from './lib/taskProgramme';

/**
 * THE WEEK'S WORK, WITHOUT A SUPERVISOR TO WRITE IT.
 *
 * On 2026-09-29 the latest deadline on any task in production was 24 September:
 * five days with nothing live for any intern, because seeding the week was a
 * manual step and the bank it seeds from is the same five titles per stream,
 * which interns had already done.
 *
 * So the agent writes fresh tasks. `scripts/agent/tasks.py` drafts them with
 * one model against the bank's own content rules (lib/taskSeed.ts) and has a
 * second model vet each one for safety and gradeability; the survivors are
 * published here directly. They skip the proposal queue because the queue
 * existed for a supervisor's review, and the second model's vetting is that
 * review now — waiting 48 hours for nobody would only cost the interns a week.
 *
 * `tasks.seedWeeklyProposals` remains as the fallback on a cron, for a week the
 * runner does not reach: repeated titles are worse than fresh ones and better
 * than an empty stream.
 */

const MIN_LEAD_MS = 3 * 86_400_000;

/** Active streams with nothing live and nothing written for them this week. */
export const streamsNeedingTasks = internalQuery({
  args: {},
  returns: v.object({
    allowed: v.boolean(),
    reason: v.optional(v.string()),
    streams: v.array(
      v.object({
        streamId: v.string(),
        name: v.string(),
        description: v.string(),
        recentTitles: v.array(v.string()),
        exemplars: v.array(v.object({ title: v.string(), description: v.string(), submissionType: v.string() })),
      }),
    ),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const programme = await taskProgrammeDecision(ctx, now);
    if (!programme.allowed) return { allowed: false, reason: programme.error, streams: [] };

    const streams = (await ctx.db.query('streams').collect()).filter((s) => s.isActive && !s.isDummy);
    const out = [];
    for (const s of streams) {
      const tasks = await ctx.db
        .query('tasks')
        .withIndex('by_stream', (q) => q.eq('streamId', s._id))
        .collect();
      const live = tasks.some((t) => t.isActive && t.approvalStatus !== 'declined' && (t.deadline ?? 0) > now);
      const writtenThisWeek = tasks.some((t) => t.createdAt > now - 6 * 86_400_000);
      if (live || writtenThisWeek) continue;
      out.push({
        streamId: String(s._id),
        name: s.name,
        description: (s.description ?? '').slice(0, 1500),
        recentTitles: tasks
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 40)
          .map((t) => t.title),
        exemplars: seedTasksFor(s.name).slice(0, 3).map((t) => ({
          title: t.title,
          description: t.description,
          submissionType: t.submissionType,
        })),
      });
    }
    return { allowed: true, streams: out };
  },
});

/** Publishes the vetted tasks for one stream, named as the agent's. */
export const publishAgentTasks = internalMutation({
  args: {
    streamId: v.id('streams'),
    tasks: v.array(
      v.object({
        title: v.string(),
        description: v.string(),
        submissionType: v.union(v.literal('text'), v.literal('link'), v.literal('file')),
      }),
    ),
  },
  returns: v.object({ published: v.number(), skipped: v.number(), error: v.optional(v.string()) }),
  handler: async (ctx, { streamId, tasks }) => {
    const now = Date.now();
    const agent = await agentAccount(ctx);
    if (!agent) return { published: 0, skipped: tasks.length, error: 'ORBIT Agent account not found' };
    const stream = await ctx.db.get(streamId);
    if (!stream?.isActive) return { published: 0, skipped: tasks.length, error: 'stream inactive' };
    const programme = await taskProgrammeDecision(ctx, now);
    if (!programme.allowed) return { published: 0, skipped: tasks.length, error: programme.error };

    // This week's due instant, unless it is too close to be fair — then next week's.
    const deadline =
      programme.defaultDeadline - now < MIN_LEAD_MS
        ? programme.defaultDeadline + 7 * 86_400_000
        : programme.defaultDeadline;

    const existing = await ctx.db
      .query('tasks')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect();
    // Re-checked here, not trusted from the query: drafting takes minutes, and
    // the bank fallback or a second run may have filled the stream meanwhile.
    if (existing.some((t) => t.createdAt > now - 6 * 86_400_000 || (t.isActive && (t.deadline ?? 0) > now))) {
      return { published: 0, skipped: tasks.length, error: 'stream already has work this week' };
    }
    const seen = new Set(existing.map((t) => t.title.trim().toLowerCase()));

    let published = 0;
    let skipped = 0;
    const titles: string[] = [];
    for (const t of tasks.slice(0, 6)) {
      const title = t.title.trim();
      const description = t.description.trim();
      // Bounds a supervisor's form would have enforced.
      if (title.length < 5 || title.length > 120 || description.length < 60 || description.length > 2500) {
        skipped++;
        continue;
      }
      if (seen.has(title.toLowerCase())) { skipped++; continue; }
      seen.add(title.toLowerCase());

      const { points } = suggestPoints({ description, submissionType: t.submissionType });
      await ctx.db.insert('tasks', {
        streamId,
        title,
        description,
        submissionType: t.submissionType,
        points,
        deadline,
        createdBy: agent._id,
        approvalStatus: 'approved',
        approvedBy: agent._id,
        approvedAt: now,
        isActive: true,
        isFeatured: false,
        isDummy: false,
        createdAt: now,
        updatedAt: now,
      });
      titles.push(title);
      published++;
    }

    if (published > 0) {
      // ONE message per member, scheduled so a fan-out failure cannot roll back
      // the publish. `notifyNewTask` per task sent each intern five or six
      // emails at once.
      await ctx.scheduler.runAfter(0, internal.agentTasks.announceTasks, {
        streamId, titles, deadline,
      });
      await ctx.db.insert('auditLogs', {
        userId: agent._id,
        userEmail: agent.email,
        userRoles: agent.roles,
        action: 'agent.tasks_published',
        tableName: 'tasks',
        recordId: streamId,
        newValues: { stream: stream.name, published, deadline },
        success: true,
        createdAt: now,
      });
    }
    return { published, skipped };
  },
});

/** The week's tasks, announced once to each intern in the stream. */
export const announceTasks = internalMutation({
  args: { streamId: v.id('streams'), titles: v.array(v.string()), deadline: v.number() },
  returns: v.object({ notified: v.number() }),
  handler: async (ctx, { streamId, titles, deadline }) => {
    const stream = await ctx.db.get(streamId);
    if (!stream) return { notified: 0 };
    const members = await ctx.db
      .query('streamMemberships')
      .withIndex('by_stream', (q) => q.eq('streamId', streamId))
      .collect();
    const due = new Date(deadline + 60 * 60 * 1000).toISOString().slice(0, 10);
    let notified = 0;
    for (const m of members) {
      if (!m.isActive) continue;
      const user = await ctx.db.get(m.userId);
      // Interns only, as notifyNewTask does — staff do not take tasks.
      if (!user || !user.isActive || user.isDeleted || !user.roles.includes('intern')) continue;
      if (user.roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'moderator')) continue;
      await ctx.runMutation(internal.notificationsInternal.notifySiwes, {
        userId: user._id,
        type: 'new_task',
        title: `${titles.length} new task${titles.length === 1 ? '' : 's'} in ${stream.name}`,
        content:
          `This week's tasks in ${stream.name}, due ${due}: ` +
          titles.map((t) => `"${t}"`).join(', ') +
          '. Pick the ones you want and accept them on ORBIT.',
        actionUrl: '/tasks',
      });
      notified++;
    }
    return { notified };
  },
});
