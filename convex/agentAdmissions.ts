import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { canTransition } from './lib/applicationStatus';
import { admitByFallback } from './lib/admissionRules';
import { agentAccount } from './lib/agent';
import { agentEmail } from './lib/org';
import { cohortForNewAdmission } from './lib/cohortRollover';

/**
 * ADMISSIONS WITHOUT AN ADMISSIONS DESK.
 *
 * Until now every application waited for a named admin to approve it, and on
 * 2026-09-29 thirty-five had waited a month with nobody looking. The founder's
 * direction is a portal that runs itself, so admission is now the agent's job:
 *
 *   1. `scripts/agent/admit.py` (on the agent's machine, where the models are)
 *      reads `pendingForScreening` and has two models screen each application
 *      independently, with a third to break a split. It records a verdict with
 *      `recordScreening` — it never admits anyone itself.
 *   2. `admitDue` — the ONLY admission path here — applies the rule in
 *      lib/admissionRules.ts on a cron, and immediately after any `admit`
 *      verdict. Admission writes the same fields a human approval did, with
 *      `reviewedBy` set to the ORBIT Agent account, so the record says plainly
 *      who decided; conversion then takes over unchanged.
 *
 * WHAT THE SCREENERS SEE. The programme, institution, course, level, track
 * interests, skills and motivation. Not the name, email, phone, emergency
 * contact, matric number or documents — none of them bear on whether an
 * application is genuine, and each is personal data that has no business
 * leaving the deployment for a model.
 */

const ADMIT_BATCH = 25;

/** The `+tag`-stripped, lower-cased address intake stores as `canonicalEmail`. */
function canonical(address: string): string {
  const [local, domain] = address.trim().toLowerCase().split('@');
  return domain ? `${local.split('+')[0]}@${domain}` : address.trim().toLowerCase();
}

/**
 * Already admitted, or already a member — either way, admitting again would
 * only link an existing account, overwrite its cohort and programme, and send a
 * second acceptance. Computes the canonical address when the row predates the
 * field, and checks the accounts table too, because staff and existing interns
 * who apply have no approved application to find.
 */
async function isDuplicate(ctx: MutationCtx, app: Doc<'applications'>): Promise<boolean> {
  const key = app.canonicalEmail ?? canonical(app.email);
  const same = await ctx.db
    .query('applications')
    .withIndex('by_canonicalEmail', (q) => q.eq('canonicalEmail', key))
    .collect();
  if (same.some((a) => a._id !== app._id && a.status === 'approved')) return true;
  const account = await ctx.db
    .query('users')
    .withIndex('by_email', (q) => q.eq('email', app.email.trim().toLowerCase()))
    .unique();
  return account !== null && !account.isDeleted;
}

/**
 * The least-loaded active stream in the applicant's first-choice track, and the
 * newest active cohort — the same rule `stageFirstChoicePlacements` used for the
 * bulk intake, so an agent admission lands where a staged one would have.
 * Returns nothing rather than guessing when the first choice maps to no stream;
 * conversion then enrols them without a stream, which they can join themselves.
 */
type Load = Map<string, number>;

/**
 * Current load per active stream: live memberships PLUS approved applications
 * that carry a stream but have not converted yet. Built once per `admitDue`
 * run and updated as it places people — counting memberships alone put every
 * applicant in one batch into the same "least-loaded" stream, because the
 * memberships are only created later, by conversion.
 */
async function streamLoad(ctx: MutationCtx): Promise<Load> {
  const load: Load = new Map();
  for (const s of await ctx.db.query('streams').collect()) {
    if (!s.isActive) continue;
    const members = await ctx.db
      .query('streamMemberships')
      .withIndex('by_stream', (q) => q.eq('streamId', s._id))
      .collect();
    load.set(String(s._id), members.filter((m) => m.isActive).length);
  }
  const pending = await ctx.db
    .query('applications')
    .withIndex('by_status_and_converted', (q) => q.eq('status', 'approved').eq('convertedUserId', undefined))
    .collect();
  for (const a of pending) {
    if (a.assignedStreamId) {
      const k = String(a.assignedStreamId);
      if (load.has(k)) load.set(k, (load.get(k) ?? 0) + 1);
    }
  }
  return load;
}

/**
 * The least-loaded active stream in the applicant's first-choice track, and the
 * newest active cohort — the rule `stageFirstChoicePlacements` used for the bulk
 * intake. Returns no stream rather than guessing when the first choice maps to
 * none; conversion then enrols them without one, and they can join themselves.
 */
async function firstChoicePlacement(
  ctx: MutationCtx,
  app: Doc<'applications'>,
  load: Load,
): Promise<{ streamId?: Id<'streams'>; cohortId?: Id<'cohorts'> }> {
  // The incoming cohort in the current one's final fortnight — see
  // lib/cohortRollover.ts — so nobody joins a cohort that ends before they start.
  const all = await ctx.db.query('cohorts').collect();
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const cohortId = cohortForNewAdmission(
    all.map((c) => ({ id: String(c._id), name: c.name, status: c.status, startDate: c.startDate, endDate: c.endDate })),
    today,
  );
  const cohort = cohortId ? all.find((c) => String(c._id) === cohortId) : undefined;

  const first = (app.trackInterests ?? [])[0];
  if (!first) return { cohortId: cohort?._id };
  const track = (await ctx.db.query('tracks').collect()).find((t) => t.isActive && t.slug === first);
  if (!track) return { cohortId: cohort?._id };

  const pool = (await ctx.db.query('streams').collect())
    .filter((s) => s.isActive && s.trackId === track._id)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (pool.length === 0) return { cohortId: cohort?._id };

  const pick = pool.reduce((best, s) =>
    (load.get(String(s._id)) ?? 0) < (load.get(String(best._id)) ?? 0) ? s : best,
  );
  load.set(String(pick._id), (load.get(String(pick._id)) ?? 0) + 1);
  return { streamId: pick._id, cohortId: cohort?._id };
}

/** Applications the screener has not yet judged in their current form. */
export const pendingForScreening = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(
      v.object({
        applicationId: v.string(),
        programmeType: v.string(),
        institutionName: v.string(),
        courseOfStudy: v.string(),
        levelOrYear: v.string(),
        trackInterests: v.array(v.string()),
        skillsSummary: v.string(),
        motivation: v.string(),
        hasPortfolio: v.boolean(),
        hasSiwesLetter: v.boolean(),
        siwesStartDate: v.string(),
        siwesEndDate: v.string(),
      }),
    ),
    queueDepth: v.number(),
  }),
  handler: async (ctx, { limit }) => {
    // NEWEST first. Held and duplicate rows stay `submitted` for ever, so an
    // oldest-first window would, after a spam wave, fill with them and never
    // reach a genuine application again.
    const submitted = await ctx.db
      .query('applications')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .order('desc')
      .take(500);
    const due = submitted.filter(
      (a) => !a.agentScreening || a.updatedAt > a.agentScreening.at || a.agentScreening.outcome === 'no-quorum',
    );
    const rows = due.slice(0, Math.max(1, Math.min(limit ?? 10, 50))).map((a) => ({
      applicationId: String(a._id),
      programmeType: a.programmeType,
      institutionName: a.institutionName ?? '',
      courseOfStudy: a.courseOfStudy ?? '',
      levelOrYear: a.levelOrYear ?? '',
      trackInterests: a.trackInterests ?? [],
      skillsSummary: (a.skillsSummary ?? '').slice(0, 3000),
      motivation: (a.motivation ?? '').slice(0, 4000),
      hasPortfolio: Boolean(a.portfolioUrl),
      hasSiwesLetter: Boolean(a.siwesLetterId || a.siwesLetterUrl),
      siwesStartDate: a.siwesStartDate ?? '',
      siwesEndDate: a.siwesEndDate ?? '',
    }));
    return { rows, queueDepth: due.length };
  },
});

/**
 * Records the screener's verdict. Never admits by itself; an `admit` verdict
 * schedules `admitDue`, which is the single place admission happens.
 */
export const recordScreening = internalMutation({
  args: {
    applicationId: v.id('applications'),
    outcome: v.union(
      v.literal('admit'),
      v.literal('hold'),
      v.literal('contested'),
      v.literal('no-quorum'),
    ),
    detail: v.optional(v.string()),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, { applicationId, outcome, detail }) => {
    const app = await ctx.db.get(applicationId);
    if (!app || app.status !== 'submitted') return { recorded: false };
    /**
     * A FAILED re-screen never replaces a verdict. Without this, anything that
     * moved `updatedAt` re-queued a held application, a model timeout recorded
     * `no-quorum` over the `hold`, and the unscreened timer — long since run out
     * — admitted it within the hour. The same path let `contested` skip its
     * wait. The verdict stays; only the attempt time moves.
     */
    const prior = app.agentScreening;
    const keep = outcome === 'no-quorum' && prior && prior.outcome !== 'no-quorum';
    // Not `updatedAt` — see the schema note on agentScreening.
    await ctx.db.patch(applicationId, {
      agentScreening: keep
        ? { ...prior, at: Date.now() }
        : { outcome, at: Date.now(), detail: detail?.slice(0, 500) },
    });
    if (outcome === 'admit') {
      await ctx.scheduler.runAfter(0, internal.agentAdmissions.admitDue, {});
    }
    return { recorded: true };
  },
});

/**
 * Admits every application the rule allows. Hourly, and after each `admit`.
 *
 * Idempotent: it only ever reads `submitted` rows, and admission moves them to
 * `approved`, which `canTransition` makes one-way.
 */
export const admitDue = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    admitted: v.number(),
    duplicates: v.number(),
    held: v.number(),
    waiting: v.number(),
    dryRun: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { dryRun }) => {
    const agent = await agentAccount(ctx);
    const result = { admitted: 0, duplicates: 0, held: 0, waiting: 0, dryRun: Boolean(dryRun) };
    if (!agent) {
      // Loud rather than silent: without the agent there is nobody to name as
      // the decider, and an unattributed admission is what this design forbids.
      return { ...result, error: `ORBIT Agent account (${agentEmail()}) not found.` };
    }

    const now = Date.now();
    // Newest first, for the reason given in pendingForScreening.
    const submitted = await ctx.db
      .query('applications')
      .withIndex('by_status', (q) => q.eq('status', 'submitted'))
      .order('desc')
      .take(500);

    let admittedAny = false;
    let load: Load | null = null;
    for (const app of submitted) {
      const s = app.agentScreening;
      if (s?.outcome === 'hold') { result.held++; continue; }
      if (!admitByFallback(s?.outcome, s?.at, app.createdAt, now)) { result.waiting++; continue; }
      if (result.admitted >= ADMIT_BATCH) { result.waiting++; continue; }
      if (!canTransition(app.status, 'approved')) continue;

      if (await isDuplicate(ctx, app)) {
        result.duplicates++;
        if (!dryRun) {
          await ctx.db.patch(app._id, {
            agentScreening: { outcome: 'duplicate', at: now, detail: 'An application from this inbox is already approved.' },
          });
        }
        continue;
      }

      if (dryRun) { result.admitted++; continue; }

      load ??= await streamLoad(ctx);
      const placement = app.assignedStreamId ? {} : await firstChoicePlacement(ctx, app, load);
      const how = s?.outcome === 'admit'
        ? 'screened and admitted by the ORBIT Agent'
        : s?.outcome === 'contested'
          ? 'admitted by the ORBIT Agent after its screeners split and the waiting period passed'
          : 'admitted by the ORBIT Agent after the screening window passed';

      await ctx.db.patch(app._id, {
        status: 'approved',
        reviewedBy: agent._id,
        reviewedAt: now,
        ...(placement.streamId ? { assignedStreamId: placement.streamId } : {}),
        ...(placement.cohortId && !app.assignedCohortId ? { assignedCohortId: placement.cohortId } : {}),
        ...(placement.streamId || placement.cohortId ? { assignedBy: agent._id, assignedAt: now } : {}),
        updatedAt: now,
      });

      await ctx.db.insert('auditLogs', {
        userId: agent._id,
        userEmail: agent.email,
        userRoles: agent.roles,
        action: 'agent.application_admitted',
        tableName: 'applications',
        recordId: app._id,
        oldValues: { status: app.status },
        newValues: {
          status: 'approved',
          referenceCode: app.referenceCode,
          how,
          screening: s?.outcome ?? 'unscreened',
          streamId: placement.streamId ?? app.assignedStreamId ?? null,
        },
        success: true,
        createdAt: now,
      });

      result.admitted++;
      admittedAny = true;
    }

    if (admittedAny) {
      await ctx.scheduler.runAfter(0, internal.applications.convertApprovedApplications, {});
    }
    return result;
  },
});
