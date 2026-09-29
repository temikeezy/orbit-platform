import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { agentAccount } from './lib/agent';
import { planCohorts } from './lib/cohortRollover';

/**
 * Runs the cohort calendar daily. The rules, and why a new cohort starts as a
 * draft, are in lib/cohortRollover.ts. Each change is audited under the ORBIT
 * Agent, so the admin screen's cohort list still says who opened and closed
 * each cohort.
 */
export const rollover = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    created: v.union(v.string(), v.null()),
    activated: v.array(v.string()),
    completed: v.array(v.string()),
    carriedOver: v.number(),
    dryRun: v.boolean(),
  }),
  handler: async (ctx, { dryRun }) => {
    const now = Date.now();
    // Lagos date (UTC+1, no DST), matching how cohort dates are entered.
    const today = new Date(now + 3_600_000).toISOString().slice(0, 10);
    const all = await ctx.db.query('cohorts').collect();
    const agent = await agentAccount(ctx);
    const plan = planCohorts(
      all.map((c) => ({
        id: String(c._id), name: c.name, status: c.status, startDate: c.startDate, endDate: c.endDate,
        byAgent: agent !== null && c.createdBy === agent._id,
      })),
      today,
    );
    const names = (ids: string[]) => ids.map((id) => all.find((c) => String(c._id) === id)?.name ?? id);
    const result = {
      created: plan.create?.name ?? null,
      activated: names(plan.activate),
      completed: names(plan.complete),
      carriedOver: 0,
      dryRun: Boolean(dryRun),
    };
    if (dryRun) return result;

    const audit = async (action: string, recordId: string, newValues: Record<string, unknown>) => {
      if (!agent) return;
      await ctx.db.insert('auditLogs', {
        userId: agent._id, userEmail: agent.email, userRoles: agent.roles,
        action, tableName: 'cohorts', recordId, newValues, success: true, createdAt: now,
      });
    };

    // Activate before completing, so there is never a moment with no active
    // cohort on a day one ends and the next begins.
    for (const id of plan.activate) {
      await ctx.db.patch(id as Id<'cohorts'>, { status: 'active', updatedAt: now });
      await audit('agent.cohort_activated', id, { status: 'active' });
    }
    // The successor every completing cohort hands over to: the newest active one.
    const successor = (await ctx.db
      .query('cohorts')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .collect())
      .filter((c) => !plan.complete.includes(String(c._id)))
      .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];

    for (const id of plan.complete) {
      await ctx.db.patch(id as Id<'cohorts'>, { status: 'completed', updatedAt: now });
      await audit('agent.cohort_completed', id, { status: 'completed' });

      /**
       * CARRY OVER anyone whose placement outlives the cohort. A SIWES student
       * whose industrial training ends after the cohort does would otherwise
       * stop receiving logbook reminders and attendance — both fan out to
       * active cohorts only — for the rest of a placement their institution is
       * still assessing. Everyone else's programme ended with the cohort.
       */
      if (!successor) continue;
      const members = await ctx.db
        .query('users')
        .withIndex('by_cohort', (q) => q.eq('cohortId', id as Id<'cohorts'>))
        .collect();
      for (const u of members) {
        if (!u.isActive || u.isDeleted || !u.siwesEndDate || u.siwesEndDate <= today) continue;
        await ctx.db.patch(u._id, { cohortId: successor._id, updatedAt: now });
        result.carriedOver++;
      }
      if (result.carriedOver > 0) {
        await audit('agent.cohort_carried_over', id, { to: String(successor._id), interns: result.carriedOver });
      }
    }
    if (plan.create) {
      const from = await ctx.db.get(plan.create.copyFrom as Id<'cohorts'>);
      if (from) {
        const id = await ctx.db.insert('cohorts', {
          name: plan.create.name,
          description: `Opened automatically by the ORBIT Agent to follow ${from.name}.`,
          startDate: plan.create.startDate,
          endDate: plan.create.endDate,
          status: 'draft',
          defaultParticipationMode: from.defaultParticipationMode,
          defaultPhysicalDay: from.defaultPhysicalDay,
          dailyLogsRequired: from.dailyLogsRequired,
          weeklySummaryRequired: from.weeklySummaryRequired,
          signoffRequired: from.signoffRequired,
          weeklySummaryDueDay: from.weeklySummaryDueDay,
          weeklySummaryDueHourWat: from.weeklySummaryDueHourWat,
          signoffDueDay: from.signoffDueDay,
          signoffDueHourWat: from.signoffDueHourWat,
          dailyLogDays: from.dailyLogDays,
          physicalAttendanceRequired: from.physicalAttendanceRequired,
          createdBy: agent?._id,
          createdAt: now,
          updatedAt: now,
        });
        await audit('agent.cohort_created', String(id), { ...plan.create });
      }
    }
    return result;
  },
});
